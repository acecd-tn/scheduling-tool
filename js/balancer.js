/*
 * PSAP Scheduler — schedule balancer.
 *
 * The center's rotation rules are the defaults:
 *   - Lines are 3 twelve-hour shifts plus one 4-hour shift a week: exactly 40 hours
 *     in every work week, never more.
 *   - People keep their shift (days stay days, nights stay nights). Only days off move.
 *   - Days off move one day later each week, through every combination in 7 weeks.
 *   - Nobody works more than 4 days in a row (the 4-hour shift counts); a 5th only as
 *     a supervisor-marked emergency, flagged on the schedule.
 *   - 4-hour shifts are spread across the week so they don't thin the same day.
 *
 * suggestLines(): for a job class, picks each person's place in the rotation (which
 *   week of the 7 they start on) so every hour is covered to minimum, extra hours are
 *   kept to the relief margin and 4-hour days are spread. Holders keep their shift.
 *   With center.lineMode 'weekly' it builds fixed 7-day, 40-hour lines instead.
 * balanceWeek(): for one week, moves days off from days with extra staff to days with
 *   gaps (same shift, same work week, rest rules, notice, days-in-a-row limit), then
 *   offers gaps to part-timers under their cap, then 4-hour shifts that can go to
 *   training, then lists what's left for overtime.
 * planCoverage(): balanceWeek over several weeks, grouped into a short plain-language
 *   list ("Fri nights are 1 short for 3 weeks: move Smith's day off from Tue to Fri").
 */
(function (global) {
  'use strict';
  const P = global.PSAP || (typeof require !== 'undefined' ? require('./core.js') : null);
  const WEEK = 168;
  const mod = P.mod;

  // ------------------------------------------------------------ profiles
  /** Add a shift starting `startMin` minutes into a cyclic profile of v.length hours. */
  function addShift(v, startMin, hours, w = 1) {
    const end = startMin + hours * 60;
    for (let m = Math.floor(startMin / 60) * 60; m < end; m += 60) {
      const ov = Math.min(end, m + 60) - Math.max(startMin, m);
      if (ov > 0) v[mod(m / 60, v.length)] += w * ov / 60;
    }
  }

  /** Weekly minimum (sum over consoles) and how many consoles need someone, per hour of the week (Sunday 0000 first). */
  function weeklyMinimum(state, pids) {
    const min = new Float64Array(WEEK), cnt = new Float64Array(WEEK);
    for (let dw = 0; dw < 7; dw++) for (let h = 0; h < 24; h++) for (const pid of pids) {
      const v = +(((state.minimums[pid] || [])[dw] || [])[h]) || 0;
      min[dw * 24 + h] += v;
      if (v > 0) cnt[dw * 24 + h]++;
    }
    return { min, cnt };
  }

  /** Minimum and console count for each hour of `days` days from `start`. */
  function cycleMinimum(state, pids, start, days) {
    const w = weeklyMinimum(state, pids);
    const min = new Float64Array(days * 24), cnt = new Float64Array(days * 24);
    for (let d = 0; d < days; d++) {
      const dw = P.dow(start + d);
      for (let h = 0; h < 24; h++) { min[d * 24 + h] = w.min[dw * 24 + h]; cnt[d * 24 + h] = w.cnt[dw * 24 + h]; }
    }
    return { min, cnt };
  }

  /** Hours worked by a line over `days` days from `start` (cyclic), as if it ran the whole time. */
  function lineVector(state, line, start, days, ix) {
    const v = new Float64Array(days * 24);
    const shorts = [];
    const l = Object.assign({}, line, { effectiveFrom: P.fmtDate(start - 400), effectiveTo: null });
    for (let d = start; d < start + days; d++) {
      const tpl = P.lineShiftOn(l, d, ix);
      if (!tpl) continue;
      addShift(v, (d - start) * 1440 + P.parseTime(tpl.start), +tpl.hours);
      if (+tpl.hours < 8) shorts.push(d - start);
    }
    return { v, shorts };
  }

  function sparse(v) {
    const idx = [], w = [];
    for (let h = 0; h < v.length; h++) if (v[h] > 1e-9) { idx.push(h); w.push(v[h]); }
    return { idx: Int32Array.from(idx), w: Float64Array.from(w) };
  }

  /** Average weekly profile of a set of lines over `weeks` weeks from a day. */
  function linesProfile(state, lines, sunday, weeks = 4) {
    const ix = P.index(state);
    const v = new Float64Array(WEEK);
    for (const l of lines) {
      const lv = lineVector(state, l, sunday, 7 * weeks, ix).v;
      for (let h = 0; h < lv.length; h++) v[h % WEEK] += lv[h] / weeks;
    }
    return v;
  }

  function scoreOf(stf, min, target) {
    let uncov = 0, surplus = 0;
    for (let h = 0; h < stf.length; h++) {
      const u = min[h] - stf[h];
      if (u > 1e-9) uncov += u;
      const sp = stf[h] - target[h];
      if (sp > 1e-9) surplus += sp;
    }
    return { uncov, surplus };
  }

  /** Fold a multi-week profile into one week: the lowest staffing at each hour of the week. */
  function worstWeek(v, start) {
    const out = new Float64Array(WEEK).fill(Infinity);
    for (let h = 0; h < v.length; h++) {
      const dw = P.dow(start + Math.floor(h / 24));
      const k = dw * 24 + (h % 24);
      out[k] = Math.min(out[k], v[h]);
    }
    for (let k = 0; k < WEEK; k++) if (out[k] === Infinity) out[k] = 0;
    return out;
  }

  // ---------------------------------------------------------- candidates
  function rotationPattern(state) {
    const ix = P.index(state);
    const pat = ix.pat[state.center.rotationPatternId || 'p_rot'] || state.patterns.find((p) => p.rotation);
    return pat && pat.cycle && pat.cycle.length % 7 === 0 ? pat : null;
  }

  /** The shifts that make a 40-hour week on a pattern (e.g. 12-hour shifts on the rotation). */
  function fortyHourTemplates(state, pat, allowed) {
    const threshold = +state.center.otThresholdHours || 40;
    return state.shiftTemplates.filter((t) => (!allowed || allowed.has(t.id)) && Math.abs(P.patternWeeklyHours(state, pat, t.id) - threshold) < 0.01);
  }

  /**
   * Candidate lines: { tplId, patId, offset (days), line } over a cycle of `days` days
   * from `start`. Rotation: one per shift and week of the cycle. Weekly: every 7-day,
   * 40-hour pattern × shift × start day.
   */
  function candidateLines(state, mode, jcId, start, allowedIds) {
    const allowed = allowedIds && allowedIds.length ? new Set(allowedIds) : null;
    const out = [];
    if (mode === 'rotation') {
      const pat = rotationPattern(state);
      if (!pat) return { days: 7, cands: out };
      const L = pat.cycle.length;
      for (const t of fortyHourTemplates(state, pat, allowed)) for (let o = 0; o < L; o += 7) out.push({ tplId: t.id, patId: pat.id, offset: o });
      return { days: L, cands: out, pattern: pat };
    }
    const threshold = +state.center.otThresholdHours || 40;
    for (const pat of state.patterns) {
      if (!pat.cycle || pat.cycle.length !== 7) continue;
      const explicit = pat.cycle.filter((t) => t && t !== 1 && t !== '1' && t !== '0' && !P.isShortTok(t));
      if (allowed && explicit.some((t) => !allowed.has(t))) continue;
      const hasW = pat.cycle.some((t) => t === 1 || t === '1' || P.isShortTok(t));
      const tplOptions = hasW ? state.shiftTemplates.filter((t) => !allowed || allowed.has(t.id)).map((t) => t.id) : [explicit[0] || null];
      for (const tplId of tplOptions) {
        if (Math.abs(P.patternWeeklyHours(state, pat, tplId) - threshold) > 0.01) continue; // only lines that never build in OT
        for (let o = 0; o < 7; o++) out.push({ tplId, patId: pat.id, offset: o });
      }
    }
    return { days: 7, cands: out };
  }

  /** Backward-compatible list of 7-day candidates as weekly profiles. */
  function lineCandidates(state, templateIds) {
    const sunday = P.parseDate('2026-01-04');
    const ix = P.index(state);
    return candidateLines(state, 'weekly', null, sunday, templateIds).cands.map((c) => Object.assign(c, {
      v: lineVector(state, { shiftTemplateId: c.tplId, patternId: c.patId, anchorDate: P.fmtDate(sunday + c.offset) }, sunday, 7, ix).v,
    }));
  }

  const startOf = (state, id) => { const t = state.shiftTemplates.find((x) => x.id === id); return t ? P.parseTime(t.start) : 0; };
  /** The closest shift to someone's current one by start time: day people stay on days, nights on nights. */
  function closestTemplate(state, currentId, ids) {
    if (ids.includes(currentId)) return currentId;
    const s0 = startOf(state, currentId);
    let best = ids[0], bd = Infinity;
    for (const id of ids) { const d = Math.abs(mod(startOf(state, id) - s0 + 720, 1440) - 720); if (d < bd) { bd = d; best = id; } }
    return best;
  }

  // ------------------------------------------------------------ optimizer
  /**
   * people: [{ cands: [{ idx, w, shorts, group, extra }] }]. Minimizes
   *   1000 × uncovered + hours above target + 20 × Σ(daily uncovered)² (spread)
   *   + 0.3 × Σ(4-hour shifts per day per shift)² + per-candidate extra.
   */
  function optimize(people, base, min, target, opts) {
    const H = min.length, D = H / 24;
    const spread = !!opts.spread, wS = opts.shortWeight != null ? opts.shortWeight : 0.3;
    const stf = Float64Array.from(base);
    const dayU = new Float64Array(D);
    const groups = {};
    const shortsOf = (g) => groups[g] || (groups[g] = new Float64Array(D));
    const hc = (h, s) => (s < min[h] - 1e-9 ? 1000 * (min[h] - s) : 0) + (s > target[h] + 1e-9 ? s - target[h] : 0);
    for (let h = 0; h < H; h++) dayU[Math.floor(h / 24)] += Math.max(0, min[h] - stf[h]);
    const du = new Float64Array(D);
    const delta = (c, sign) => {
      let d = sign * (c.extra || 0);
      for (let k = 0; k < c.idx.length; k++) {
        const h = c.idx[k], s0 = stf[h], s1 = s0 + sign * c.w[k];
        d += hc(h, s1) - hc(h, s0);
        if (spread) du[Math.floor(h / 24)] += Math.max(0, min[h] - s1) - Math.max(0, min[h] - s0);
      }
      if (spread) for (let k = 0; k < c.idx.length; k++) {
        const day = Math.floor(c.idx[k] / 24);
        if (du[day] !== 0) { d += 20 * ((dayU[day] + du[day]) ** 2 - dayU[day] ** 2); du[day] = 0; }
      }
      if (c.shorts.length && wS) { const g = shortsOf(c.group); for (const day of c.shorts) d += wS * (sign > 0 ? 2 * g[day] + 1 : -2 * g[day] + 1); }
      return d;
    };
    const apply = (c, sign) => {
      for (let k = 0; k < c.idx.length; k++) {
        const h = c.idx[k], s0 = stf[h], s1 = s0 + sign * c.w[k];
        dayU[Math.floor(h / 24)] += Math.max(0, min[h] - s1) - Math.max(0, min[h] - s0);
        stf[h] = s1;
      }
      if (c.shorts.length) { const g = shortsOf(c.group); for (const day of c.shorts) g[day] += sign; }
    };
    const N = people.length;
    const cur = new Array(N).fill(-1);
    // Greedy start.
    for (let i = 0; i < N; i++) {
      const cs = people[i].cands;
      let bi = 0, bv = Infinity;
      for (let j = 0; j < cs.length; j++) { const v = delta(cs[j], 1); if (v < bv - 1e-9) { bv = v; bi = j; } }
      cur[i] = bi; apply(cs[bi], 1);
    }
    const localSearch = () => {
      let any = false;
      for (let pass = 0; pass < 10; pass++) {
        let improved = false;
        for (let i = 0; i < N; i++) {
          const cs = people[i].cands;
          if (cs.length < 2) continue;
          apply(cs[cur[i]], -1);
          let bi = cur[i], bv = delta(cs[cur[i]], 1);
          for (let j = 0; j < cs.length; j++) { if (j === cur[i]) continue; const v = delta(cs[j], 1); if (v < bv - 1e-9) { bv = v; bi = j; } }
          if (bi !== cur[i]) { improved = any = true; cur[i] = bi; }
          apply(cs[cur[i]], 1);
        }
        if (!improved) break;
      }
      return any;
    };
    // Change two people together: fixes the case where no single change helps but two do.
    const pairSearch = () => {
      let improved = false;
      for (let i = 0; i < N; i++) for (let j = i + 1; j < N; j++) {
        const ci = people[i].cands, cj = people[j].cands;
        if (ci.length < 2 || cj.length < 2) continue;
        apply(ci[cur[i]], -1); apply(cj[cur[j]], -1);
        const pairVal = (a, b) => { const v1 = delta(ci[a], 1); apply(ci[a], 1); const v2 = delta(cj[b], 1); apply(ci[a], -1); return v1 + v2; };
        let best = [cur[i], cur[j]], bv = pairVal(cur[i], cur[j]);
        for (let a = 0; a < ci.length; a++) {
          const v1 = delta(ci[a], 1);
          apply(ci[a], 1);
          for (let b = 0; b < cj.length; b++) { const v = v1 + delta(cj[b], 1); if (v < bv - 1e-9) { bv = v; best = [a, b]; } }
          apply(ci[a], -1);
        }
        if (best[0] !== cur[i] || best[1] !== cur[j]) improved = true;
        cur[i] = best[0]; cur[j] = best[1];
        apply(ci[cur[i]], 1); apply(cj[cur[j]], 1);
      }
      return improved;
    };
    const total = () => {
      let v = 0;
      for (let h = 0; h < H; h++) v += hc(h, stf[h]);
      if (spread) for (let d = 0; d < D; d++) v += 20 * dayU[d] ** 2;
      for (const g of Object.values(groups)) for (let d = 0; d < D; d++) v += wS * g[d] ** 2;
      for (let i = 0; i < N; i++) v += people[i].cands[cur[i]].extra || 0;
      return v;
    };
    const search = () => { localSearch(); for (let k = 0; k < 4 && pairSearch(); k++) localSearch(); return total(); };
    let bestVal = search(), bestSet = cur.slice();
    let seed = 12345;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    const rounds = opts.effort != null ? +opts.effort : 20;
    const movable = people.map((p, i) => (p.cands.length > 1 ? i : -1)).filter((i) => i >= 0);
    const setTo = (arr) => { for (let i = 0; i < N; i++) if (cur[i] !== arr[i]) { apply(people[i].cands[cur[i]], -1); cur[i] = arr[i]; apply(people[i].cands[cur[i]], 1); } };
    for (let it = 0; it < rounds && movable.length; it++) {
      const kick = Math.max(1, Math.round(movable.length * 0.15));
      for (let k = 0; k < kick; k++) {
        const i = movable[Math.floor(rnd() * movable.length)];
        apply(people[i].cands[cur[i]], -1);
        cur[i] = Math.floor(rnd() * people[i].cands.length);
        apply(people[i].cands[cur[i]], 1);
      }
      const v = search();
      if (v < bestVal - 1e-9) { bestVal = v; bestSet = cur.slice(); } else setTo(bestSet);
    }
    setTo(bestSet);
    return { choice: cur.slice(), stf };
  }

  // -------------------------------------------------------- suggest lines
  const offDaysText = (state, line, from, ix) => {
    const days = [];
    for (let d = from; d < from + 7; d++) if (!P.lineShiftOn(Object.assign({}, line, { effectiveFrom: P.fmtDate(from - 400), effectiveTo: null }), d, ix)) days.push(P.DOW[P.dow(d)]);
    return days.join('/');
  };

  /**
   * opts: { headcount, templateIds, reliefMargin, effectiveDate, mode, keepShifts }
   * Returns { lines, people, before, after, min, target (one week, worst week), level, margin,
   *   headcount, start, cycleDays, mode } or { error }.
   */
  function suggestLines(state, jobClassId, opts = {}) {
    const jc = P.jobClassById(state, jobClassId);
    if (!jc) return { error: 'Unknown job class' };
    const pids = P.classConsoles(state, jc);
    if (!pids.length) return { error: 'This job class staffs no consoles (Staff → Consoles → Staffed by).' };
    const ix = P.index(state);
    const ref = opts.effectiveDate != null ? P.parseDate(opts.effectiveDate) : P.todayNum();
    let mode = opts.mode || (state.center.lineMode === 'weekly' ? 'weekly' : 'rotation');
    if (mode === 'rotation' && !rotationPattern(state)) mode = 'weekly';
    // Lines start on a work-week boundary so every work week is 40 hours.
    const wk = P.workWeek(state, ref);
    const start = wk.start === ref ? ref : wk.start + 7;
    const lvl = P.staffingLevel(state, jc, ref);
    const rule = P.levelRule(state, lvl.level);
    const margin = opts.reliefMargin != null && opts.reliefMargin !== '' ? +opts.reliefMargin : (lvl.level === 'normal' ? rule.reliefMargin : 0);
    const spread = lvl.level === 'critical';
    const { cands, days, pattern } = candidateLines(state, mode, jc.id, start, opts.templateIds);
    if (!cands.length) return { error: mode === 'rotation' ? 'No 12-hour shifts fit the rotation (3 × 12 + one 4-hour = 40 hours).' : 'No 40-hour, 7-day patterns fit the chosen shifts.' };
    const { min, cnt } = cycleMinimum(state, pids, start, days);
    const target = new Float64Array(min.length);
    for (let h = 0; h < min.length; h++) target[h] = min[h] + margin * cnt[h];

    const members = P.classMembers(state, jc);
    const ftMembers = members.filter((e) => !P.isPartTime(e));
    const ptIds = new Set(members.filter((e) => P.isPartTime(e)).map((e) => e.id));
    const classLines = state.lines.filter((l) => (P.lineClass(state, l) || {}).id === jc.id && (P.lineActiveOn(l, start) || (!l.effectiveTo && P.parseDate(l.effectiveFrom) <= start + days)));
    const base = new Float64Array(days * 24);
    if (state.center.partTimeOnLines !== 'extra') for (const l of classLines.filter((x) => x.employeeId && ptIds.has(x.employeeId))) {
      const lv = lineVector(state, l, start, days, ix).v;
      for (let h = 0; h < lv.length; h++) base[h] += lv[h];
    }
    const sen = (e) => P.parseDate(e.seniorityDate || e.hireDate || '2000-01-01');
    const ftIds = new Set(ftMembers.map((e) => e.id));
    const holderLines = classLines.filter((l) => l.employeeId && ftIds.has(l.employeeId))
      .sort((a, b) => sen(ix.emp[a.employeeId]) - sen(ix.emp[b.employeeId]));
    const seenHolder = new Set();
    const holders = holderLines.filter((l) => (seenHolder.has(l.employeeId) ? false : seenHolder.add(l.employeeId)));
    const beforeV = Float64Array.from(base);
    for (const l of holders) { const lv = lineVector(state, l, start, days, ix).v; for (let h = 0; h < lv.length; h++) beforeV[h] += lv[h]; }

    const N = Math.max(holders.length, Math.round(opts.headcount != null && opts.headcount !== '' ? +opts.headcount : ftMembers.length));
    const keep = opts.keepShifts !== false;
    const tplIds = [...new Set(cands.map((c) => c.tplId))];
    const vecCache = {};
    const candFor = (c, holder) => {
      const line = { shiftTemplateId: c.tplId, patternId: c.patId, anchorDate: P.fmtDate(start + c.offset), jobClassId: jc.id, shortTemplateId: holder ? holder.shortTemplateId || null : null };
      const key = `${c.tplId}|${c.patId}|${c.offset}|${line.shortTemplateId || ''}`;
      const lv = vecCache[key] || (vecCache[key] = Object.assign(lineVector(state, line, start, days, ix), {}));
      const sp = lv.sp || (lv.sp = sparse(lv.v));
      return { idx: sp.idx, w: sp.w, shorts: lv.shorts, group: c.tplId, extra: 0, c };
    };
    const people = [];
    for (const h of holders) {
      const tpl = keep ? closestTemplate(state, h.shiftTemplateId, tplIds) : null;
      const curOff = h.patternId && cands.some((c) => c.patId === h.patternId) ? mod(P.parseDate(h.anchorDate || h.effectiveFrom) - start, days) : null;
      const list = cands.filter((c) => !tpl || c.tplId === tpl).map((c) => {
        const x = candFor(c, h);
        // Small cost for changing someone's line, so unchanged lines win ties.
        x.extra = c.tplId === h.shiftTemplateId && c.patId === h.patternId && c.offset === curOff ? 0 : 3;
        return x;
      });
      people.push({ holder: h, cands: list });
    }
    for (let k = holders.length; k < N; k++) people.push({ holder: null, cands: cands.map((c) => candFor(c, null)) });

    const res = optimize(people, base, min, target, { spread, effort: opts.effort });
    const stf = res.stf;
    const weeks = days / 7;
    const sc0 = scoreOf(beforeV, min, target), sc1 = scoreOf(stf, min, target);
    const before = { v: worstWeek(beforeV, start), lines: holders.length, uncov: sc0.uncov / weeks, surplus: sc0.surplus / weeks, totalUncov: sc0.uncov };
    const after = { v: worstWeek(stf, start), uncov: sc1.uncov / weeks, surplus: sc1.surplus / weeks, totalUncov: sc1.uncov };
    const lines = [], changes = [];
    people.forEach((p, i) => {
      const c = p.cands[res.choice[i]].c;
      const l = { employeeId: p.holder ? p.holder.employeeId : null, shiftTemplateId: c.tplId, patternId: c.patId, offset: c.offset, anchorDate: P.fmtDate(start + c.offset), shortTemplateId: p.holder ? p.holder.shortTemplateId || null : null, fromLineId: p.holder ? p.holder.id : null };
      if (p.holder) {
        const h = p.holder;
        l.changed = !(h.shiftTemplateId === l.shiftTemplateId && h.patternId === l.patternId && mod(P.parseDate(h.anchorDate || h.effectiveFrom) - P.parseDate(l.anchorDate), (ix.pat[l.patternId] || { cycle: [0] }).cycle.length || 1) === 0);
        if (l.changed) changes.push({ employeeId: l.employeeId, from: { tplId: h.shiftTemplateId, off: offDaysText(state, h, start, ix) }, to: { tplId: l.shiftTemplateId, off: offDaysText(state, Object.assign({ jobClassId: jc.id }, l), start, ix) } });
      }
      lines.push(l);
    });
    lines.sort((a, b) => String(a.shiftTemplateId).localeCompare(String(b.shiftTemplateId)) || a.patternId.localeCompare(b.patternId) || a.offset - b.offset);
    // Hours: one week's minimum vs one week of lines.
    let minTotal = 0; for (let h = 0; h < min.length; h++) minTotal += min[h];
    const wMin = worstWeek(min, start), wTarget = worstWeek(target, start);
    return {
      jobClass: jc, consoles: pids, mode, pattern: pattern || null, cycleDays: days, start, sunday: start, lines, changes,
      before, after, min: wMin, target: wTarget, level: lvl, margin, headcount: N, minHours: minTotal / weeks,
      lineHours: N * (+state.center.otThresholdHours || 40), keepShifts: keep,
    };
  }

  /** Name and shape suggested lines as (vacant) line records for a job class, e.g. for a bid. */
  function toLineRecords(state, result, effectiveDate) {
    const ix = P.index(state);
    const count = {};
    return result.lines.map((l) => {
      const pat = ix.pat[l.patternId];
      const t = ix.tpl[l.shiftTemplateId] || (pat ? ix.tpl[pat.cycle.find((x) => x && x !== 1 && x !== '1' && x !== '0' && !P.isShortTok(x))] : null);
      const code = t ? t.code : 'L';
      count[code] = (count[code] || 0) + 1;
      return { id: P.uid('ln'), name: `${code} ${count[code]}`, jobClassId: result.jobClass.id, positionId: null, shiftTemplateId: l.shiftTemplateId || (t && t.id), patternId: l.patternId, anchorDate: l.anchorDate, shortTemplateId: l.shortTemplateId || null, effectiveFrom: effectiveDate || l.anchorDate, effectiveTo: null, employeeId: null };
    });
  }

  /**
   * Re-line a job class without a bid. Each holder gets their own suggested line (same
   * shift; only days off change). Unchanged lines are left alone; changed and vacant
   * lines end the day before `effectiveDate`. Returns the holders whose schedule changes.
   */
  function applyToCurrentLines(state, result, effectiveDate) {
    const eff = P.parseDate(effectiveDate);
    const jc = result.jobClass;
    const ix = P.index(state);
    const isPT = (id) => { const e = ix.emp[id]; return !!e && P.isPartTime(e); };
    const current = state.lines.filter((l) => (P.lineClass(state, l) || {}).id === jc.id && (P.lineActiveOn(l, eff) || (!l.effectiveTo && P.parseDate(l.effectiveFrom) <= eff)) && !(l.employeeId && isPT(l.employeeId)));
    const byId = {}; for (const l of current) byId[l.id] = l;
    const fresh = toLineRecords(state, result, P.fmtDate(eff));
    const changed = [], ending = new Set();
    const used = new Set();
    result.lines.forEach((sl, i) => {
      const nl = fresh[i];
      const old = sl.fromLineId ? byId[sl.fromLineId] : null;
      if (old && sl.employeeId) {
        used.add(old.id);
        if (!sl.changed) { nl.skip = true; return; }
        nl.employeeId = sl.employeeId; nl.name = old.name;
        ending.add(old.id); changed.push(sl.employeeId);
      }
    });
    // Holders the result didn't place (older results), and every vacant line, end too.
    for (const l of current) if (!used.has(l.id) && !(l.employeeId && result.lines.some((x) => x.employeeId === l.employeeId && !x.changed))) ending.add(l.id);
    const holdersLeft = current.filter((l) => l.employeeId && ending.has(l.id) && !changed.includes(l.employeeId));
    for (const old of holdersLeft) {
      const nl = fresh.find((x) => !x.skip && !x.employeeId && x.shiftTemplateId === old.shiftTemplateId) || fresh.find((x) => !x.skip && !x.employeeId);
      if (!nl) break;
      nl.employeeId = old.employeeId; nl.name = old.name; changed.push(old.employeeId);
    }
    for (const id of ending) {
      const l = byId[id];
      if (P.parseDate(l.effectiveFrom) >= eff) state.lines = state.lines.filter((x) => x.id !== l.id);
      else l.effectiveTo = P.fmtDate(eff - 1);
    }
    const created = fresh.filter((x) => !x.skip).map((x) => { delete x.skip; return x; });
    state.lines.push(...created);
    return { changed, created: created.length, kept: fresh.length - created.length, vacant: created.filter((l) => !l.employeeId).length };
  }

  // --------------------------------------------------------- balance week
  function restOk(state, ivs, start, end) {
    const c = state.center;
    const minRest = (+c.minRestHours || 8) * 60;
    for (const iv of ivs) {
      if (iv.end <= iv.start) continue;
      if (iv.start < end && iv.end > start) return false;
      if (iv.end <= start && start - iv.end < minRest) return false;
      if (iv.start >= end && iv.start - end < minRest) return false;
    }
    return true;
  }

  const moveKey = (m) => `m|${m.employeeId}|${m.offDate}|${m.workDate}`;
  const ptKey = (o) => `p|${o.employeeId}|${o.fill.date}|${o.fill.start}`;
  const trainKey = (t) => `t|${t.employeeId}|${t.date}`;

  function cloneForPlan(state) {
    return Object.assign({}, state, { shiftMoves: (state.shiftMoves || []).slice(), fills: state.fills.slice(), exceptions: state.exceptions.slice() });
  }

  /**
   * opts: { today, now, allowShortNotice, allowEmergency, skip: Set of keys, training, temp }
   * Returns { from, to, classes, moves, ptOffers, training, remaining: { slots, hours, cost },
   *   skippedForNotice, blockedByRun, state (the working copy with everything applied) }.
   */
  function balanceWeek(state, fromDay, opts = {}) {
    const today = opts.today != null ? opts.today : P.todayNum();
    const to = fromDay + 6;
    const c = state.center;
    const notice = Math.max(0, +c.dayOffNoticeDays || 0);
    const maxRun = +c.maxConsecutiveDays || 0;
    const skip = opts.skip || new Set();
    const temp = opts.temp ? state : cloneForPlan(state);
    const classes = P.jobClasses(state).map((jc) => {
      const lvl = P.staffingLevel(state, jc, fromDay);
      const rule = P.levelRule(state, lvl.level);
      return { jobClass: jc, level: lvl, margin: lvl.level === 'normal' ? rule.reliefMargin : 0, consoles: P.classConsoles(state, jc) };
    }).filter((x) => x.consoles.length);
    const classOfEmp = {};
    for (const e of state.employees) { const jc = P.empClass(state, e); if (jc) classOfEmp[e.id] = jc.id; }
    const info = {}; for (const x of classes) info[x.jobClass.id] = x;

    // Per class, per scheduling day: uncovered person-hours on the class's consoles.
    const startMin = P.schedulingDayStart(state, fromDay);
    const classScore = (st, d0, d1) => {
      const cov = P.coverage(st, d0, d1 + 1);
      const out = {};
      for (const x of classes) {
        let total = 0, sq = 0;
        const perDay = [];
        for (let d = d0; d <= d1; d++) {
          let u = 0;
          const h0 = Math.floor(((d - d0) * 1440 + startMin) / 60);
          for (let h = h0; h < h0 + 24; h++) for (const pid of x.consoles) {
            const g = (cov.required[pid][h] || 0) - (cov.staffed[pid][h] || 0);
            if (g > 1e-6) u += Math.ceil(g - 1e-6);
          }
          perDay.push(u); total += u; sq += u * u;
        }
        out[x.jobClass.id] = { total, sq, perDay, value: x.level.level === 'critical' ? sq : total };
      }
      return { out, cov };
    };

    const moves = [];
    let skippedForNotice = 0, blockedByRun = 0;
    const firstAllowed = opts.allowShortNotice ? today : today + notice;
    for (let iter = 0; iter < 40; iter++) {
      const base = classScore(temp, fromDay, to);
      const cov = base.cov;
      const regs = P.regularShifts(temp, fromDay - 1, to + 1);
      const wi = P.workIntervals(temp, fromDay - 8, to + 8);
      const ivBy = P.groupBy(wi.intervals, 'employeeId');
      const daysBy = {};
      for (const iv of wi.intervals) if (iv.end > iv.start) (daysBy[iv.employeeId] ||= new Set()).add(iv.day);
      const leaveDays = new Set();
      for (const e of temp.exceptions) {
        if (e.status !== 'approved' && e.status !== 'pending') continue;
        const [a, b] = P.exceptionRange(e);
        for (let d = Math.max(a, fromDay); d <= Math.min(b, to); d++) leaveDays.add(e.employeeId + '|' + d);
      }
      const hourIdx = (abs) => Math.floor((abs - cov.base) / 60);
      const aggAt = (x, h, kind) => x.consoles.reduce((t, pid) => t + ((cov[kind][pid] || [])[h] || 0), 0);
      let best = null;
      for (const e of temp.employees) {
        if (!P.countable(e) || P.isPartTime(e) || e.status !== 'active' && e.status !== 'trainee') continue;
        const x = info[classOfEmp[e.id]];
        if (!x || base.out[x.jobClass.id].total === 0) continue;
        const mine = regs.filter((r) => r.employeeId === e.id && r.day >= fromDay && r.day <= to && !r.moveId);
        const workDays = new Set(regs.filter((r) => r.employeeId === e.id).map((r) => r.day));
        const certs = P.certifications(e).filter((pid) => x.consoles.includes(pid));
        if (!certs.length) continue;
        for (const r of mine) {
          if (r.day < today || leaveDays.has(e.id + '|' + r.day)) continue;
          // Taking them off this day must not open a gap (except at Critical, where gaps
          // are spread evenly). Days that keep the relief margin are preferred.
          let keepsMargin = true;
          if (x.level.level !== 'critical') {
            let ok = true;
            for (let h = hourIdx(r.start); h < hourIdx(r.end) && ok; h++) {
              const cnt = x.consoles.filter((pid) => ((cov.required[pid] || [])[h] || 0) > 0).length;
              const left = aggAt(x, h, 'staffed') - 1, req = aggAt(x, h, 'required');
              if (left < req - 1e-6) ok = false;
              if (left < req + x.margin * cnt - 1e-6) keepsMargin = false;
            }
            if (!ok) continue;
          }
          const tplStart = r.start - r.day * 1440, hours = (r.end - r.start) / 60;
          for (let g = fromDay; g <= to; g++) {
            if (g === r.day || workDays.has(g) || g < today || leaveDays.has(e.id + '|' + g)) continue;
            const wk1 = P.workWeek(temp, r.day), wk2 = P.workWeek(temp, g);
            if (wk1.start !== wk2.start) continue; // stay within the work week: still 40 hours
            const gs = g * 1440 + tplStart, ge = gs + hours * 60;
            // Only worth it if the new day has a gap they could fill.
            let helps = false;
            for (let h = hourIdx(gs); h < hourIdx(ge) && !helps; h++) for (const pid of certs) if (((cov.required[pid] || [])[h] || 0) - ((cov.staffed[pid] || [])[h] || 0) > 1e-6) { helps = true; break; }
            if (!helps) continue;
            const others = (ivBy[e.id] || []).filter((iv) => !(iv.kind === 'regular' && iv.day === r.day));
            if (!restOk(temp, others, gs, ge)) continue;
            // Days in a row (the 4-hour shift counts as a day worked).
            // A line that already runs longer (e.g. 5 x 8) sets that person's own limit.
            let emergency = false;
            if (maxRun) {
              const had = daysBy[e.id] || new Set();
              const limit = Math.max(maxRun, P.runThrough(had, r.day));
              const days = new Set(had);
              days.delete(r.day); days.add(g);
              const run = P.runThrough(days, g);
              if (run > limit) {
                if (opts.allowEmergency && run === limit + 1) emergency = true;
                else { blockedByRun++; continue; }
              }
            }
            if (Math.min(r.day, g) < firstAllowed) { skippedForNotice++; continue; }
            const mv = { id: '__try', employeeId: e.id, offDate: P.fmtDate(r.day), workDate: P.fmtDate(g), templateId: r.templateId, status: 'approved' };
            if (skip.has(moveKey(mv))) continue;
            // Exact effect.
            const trial = Object.assign({}, temp, { shiftMoves: temp.shiftMoves.concat([mv]) });
            const d0 = Math.min(r.day, g), d1 = Math.max(r.day, g);
            const pre = classScore(temp, d0, d1).out[x.jobClass.id];
            const post = classScore(trial, d0, d1).out[x.jobClass.id];
            const raw = (x.level.level === 'critical' ? pre.sq - post.sq : pre.total - post.total);
            if (raw <= 0) continue;
            if (x.level.level !== 'critical' && post.perDay[r.day - d0] > pre.perDay[r.day - d0]) continue; // no new gap on the day off
            // Prefer days that keep the relief margin, spread changes across people, and
            // use a 5th day in a row only when nothing else works.
            const gain = raw + (keepsMargin ? 0.5 : 0) - 0.1 * moves.filter((m) => m.employeeId === e.id).length - (emergency ? 0.75 : 0);
            if (!best || gain > best.gain) best = { gain, closed: pre.total - post.total, move: mv, jobClassId: x.jobClass.id, emergency };
          }
        }
      }
      if (!best) break;
      best.move.id = P.uid('mv');
      if (best.emergency) best.move.emergency = true;
      temp.shiftMoves.push(best.move);
      moves.push({ employeeId: best.move.employeeId, offDate: best.move.offDate, workDate: best.move.workDate, templateId: best.move.templateId, jobClassId: best.jobClassId, gapHoursClosed: best.closed, emergency: best.emergency });
    }

    // Part-timers under their cap, before any overtime (never past the days-in-a-row limit).
    const ptOffers = [];
    const now = opts.now != null ? opts.now : P.nowAbs();
    let slots = P.openings(temp, fromDay, to).slots.filter((s) => s.end > now);
    for (const slot of slots) {
      const cands = P.fillCandidates(temp, slot, { order: 'voluntary' }).filter((x) => x.partTime && x.eligible && !x.warnings.some((w) => /in a row/.test(w)));
      for (const pick of cands) {
        const fill = { id: P.uid('ot'), date: P.fmtDate(Math.floor(slot.start / 1440)), start: P.timeStr(slot.start), hours: slot.hours, positionId: slot.positionId, employeeId: pick.emp.id, type: 'voluntary', reason: P.slotReason(slot), status: 'scheduled' };
        const offer = { employeeId: pick.emp.id, slot, fill, cost: pick.cost, weekHours: pick.weekHours, cap: pick.cap };
        if (skip.has(ptKey(offer))) continue;
        temp.fills.push(fill);
        ptOffers.push(offer);
        break;
      }
    }

    // Cut scheduled overtime: someone scheduled over 40 hours in a work week (e.g. the
    // 48-hour week of a 2-week template) works part of one shift, and a part-timer under
    // their cap works the rest at straight time. They land at exactly 40 hours and
    // coverage doesn't change.
    const relief = [];
    if (opts.relief !== false && c.offerOtRelief !== false) {
      const threshold = +c.otThresholdHours || 40;
      const wi = P.workIntervals(temp, fromDay - 1, to + 1);
      const byEmp = P.groupBy(wi.intervals, 'employeeId');
      const wk = P.workWeek(temp, fromDay);
      const firstOk = opts.allowShortNotice ? today + 1 : today + notice;
      for (const e of temp.employees) {
        if (!P.countable(e) || P.isPartTime(e)) continue;
        const x = info[classOfEmp[e.id]];
        if (!x) continue;
        const ivs = (byEmp[e.id] || []).filter((iv) => iv.day >= wk.start && iv.day <= wk.end && iv.end > iv.start);
        const total = ivs.reduce((t, iv) => t + (iv.end - iv.start) / 60, 0);
        const excess = Math.round((total - threshold) * 4) / 4;
        if (excess < 1) continue;
        // A whole regular shift longer than the excess, far enough out; keep at least 4 hours.
        const shifts = ivs.filter((iv) => iv.kind === 'regular' && !iv.moveId && iv.day >= Math.max(fromDay, firstOk) && iv.day <= to
          && (iv.end - iv.start) / 60 - excess >= 4 - 1e-9 && iv.start === (P.regularShifts(temp, iv.day, iv.day).find((r) => r.employeeId === e.id && r.day === iv.day) || {}).start);
        let done = false;
        for (const r of shifts.sort((a, b) => a.start - b.start)) {
          if (done) break;
          const reg = P.regularShifts(temp, r.day, r.day).find((q) => q.employeeId === e.id && q.day === r.day);
          if (!reg || reg.end !== r.end) continue; // only untouched shifts
          const ps = reg.end - excess * 60, pe = reg.end;
          const key = `r|${e.id}|${P.fmtDate(r.day)}`;
          if (skip.has(key)) continue;
          const pid = P.certifications(e).find((q) => x.consoles.includes(q)) || reg.positionId;
          const cands = P.fillCandidates(temp, { positionId: pid, start: ps, end: pe }, { order: 'voluntary', jobClassId: x.jobClass.id })
            .filter((cd) => cd.partTime && cd.eligible && !cd.otHours && cd.emp.id !== e.id && !cd.warnings.some((w) => /in a row/.test(w)));
          for (const pick of cands) {
            const pPid = P.qualifiedFor(pick.emp, pid) ? pid : P.certifications(pick.emp).find((q) => x.consoles.includes(q));
            if (!pPid) continue;
            const exc = { id: P.uid('ex'), employeeId: e.id, date: P.fmtDate(r.day), endDate: null, start: P.timeStr(ps), hours: excess, type: 'otrelief', status: 'approved', note: `${P.empName(pick.emp)} (part-time) covers; back to ${threshold} hours` };
            const fill = { id: P.uid('ot'), date: P.fmtDate(r.day), start: P.timeStr(ps), hours: excess, positionId: pPid, employeeId: pick.emp.id, type: 'voluntary', reason: 'otrelief', exceptionId: exc.id, status: 'scheduled' };
            const before = P.openings(temp, r.day - 1, r.day + 1).slots.length;
            temp.exceptions.push(exc); temp.fills.push(fill);
            if (P.openings(temp, r.day - 1, r.day + 1).slots.length > before) { temp.exceptions.pop(); temp.fills.pop(); continue; }
            const mult = +c.otMultiplier || 1.5;
            const saved = excess * (+e.hourlyRate || 0) * mult - pick.cost;
            if (saved <= 0) { temp.exceptions.pop(); temp.fills.pop(); continue; }
            relief.push({ key, employeeId: e.id, ptId: pick.emp.id, date: exc.date, keepStart: P.timeStr(reg.start), keepHours: (reg.end - reg.start) / 60 - excess, start: exc.start, hours: excess, weekHours: total, saved, ptCost: pick.cost, exception: exc, fill, templateId: reg.templateId });
            done = true;
            break;
          }
        }
      }
    }

    // 4-hour shifts that could go to training: coverage stays at minimum without anyone
    // on overtime (spare staff, or a part-timer covers the seat).
    const training = [];
    if (opts.training !== false && c.offerTraining !== false) {
      const limit = opts.trainingLimit != null ? +opts.trainingLimit : 3;
      const regs = P.regularShifts(temp, fromDay, to).filter((r) => (r.end - r.start) / 60 < 8 && r.day > today && r.end > now);
      const excBusy = new Set(temp.exceptions.filter((e) => e.status === 'approved' || e.status === 'pending').flatMap((e) => { const [a, b] = P.exceptionRange(e); const o = []; for (let d = a; d <= b; d++) o.push(e.employeeId + '|' + d); return o; }));
      regs.sort((a, b) => a.start - b.start);
      for (const r of regs) {
        if (training.length >= limit) break;
        const e = temp.employees.find((x) => x.id === r.employeeId);
        if (!e || P.isPartTime(e) || !P.countable(e) || excBusy.has(e.id + '|' + r.day)) continue;
        const exc = { id: P.uid('ex'), employeeId: e.id, date: P.fmtDate(r.day), endDate: null, start: P.timeStr(r.start), hours: (r.end - r.start) / 60, type: 'training', status: 'approved', note: 'Training on the 4-hour shift' };
        const t = { employeeId: e.id, date: exc.date, start: exc.start, hours: exc.hours, templateId: r.templateId, exception: exc, cover: null };
        if (skip.has(trainKey(t))) continue;
        const before = P.openings(temp, r.day - 1, r.day + 1).slots.length;
        temp.exceptions.push(exc);
        const after = P.openings(temp, r.day - 1, r.day + 1).slots.filter((s) => s.causes && s.causes.some((x) => x.exceptionId === exc.id));
        let ok = after.length === 0;
        if (!ok && after.length === 1) {
          const slot = after[0];
          const pick = P.fillCandidates(temp, slot, { order: 'voluntary' }).find((x) => x.partTime && x.eligible && !x.otHours && !x.warnings.some((w) => /in a row/.test(w)));
          if (pick) {
            const fill = { id: P.uid('ot'), date: P.fmtDate(Math.floor(slot.start / 1440)), start: P.timeStr(slot.start), hours: slot.hours, positionId: slot.positionId, employeeId: pick.emp.id, type: 'voluntary', reason: 'training', exceptionId: exc.id, status: 'scheduled' };
            temp.fills.push(fill);
            t.cover = { employeeId: pick.emp.id, fill, cost: pick.cost };
            ok = P.openings(temp, r.day - 1, r.day + 1).slots.length <= before;
            if (!ok) temp.fills.pop();
          }
        }
        if (!ok) { temp.exceptions.pop(); continue; }
        excBusy.add(e.id + '|' + r.day);
        training.push(t);
      }
    }

    slots = P.openings(temp, fromDay, to).slots.filter((s) => s.end > now);
    const hours = slots.reduce((t, s) => t + s.hours, 0);
    const cost = slots.reduce((t, s) => t + P.slotCost(temp, s), 0);
    const after = classScore(temp, fromDay, to).out;
    return { from: fromDay, to, classes, moves, ptOffers, relief, training, remaining: { slots, hours, cost }, after, skippedForNotice, blockedByRun, noticeDays: notice, state: temp };
  }

  // ------------------------------------------------------- plan coverage
  /** 'days' / 'evenings' / 'nights' for a shift block by its start hour. */
  function blockName(startAbs) {
    const h = Math.floor(P.mod(startAbs, 1440) / 60);
    return h >= 4 && h < 11 ? 'days' : h >= 11 && h < 18 ? 'evenings' : 'nights';
  }

  /**
   * Group open slots into shift-sized gaps: per scheduling day and shift block, how many
   * people short (most at once) and when. Then group the same gap across weeks.
   */
  function groupGaps(state, slots) {
    // Cut every opening at the shift changes, so each shortage belongs to exactly one
    // shift (e.g. 0700-1900 or 1900-0700) of one scheduling day.
    const perBlock = {};
    for (const s of slots) {
      const sd = P.schedulingDayOf(state, s.start);
      for (let day = sd; day <= sd + 2; day++) {
        const blocks = P.shiftBlocks(state, day);
        if (blocks[0].start >= s.end) break;
        for (const b of blocks) {
          const a = Math.max(s.start, b.start), z = Math.min(s.end, b.end);
          if (z <= a) continue;
          const k = day + '|' + b.start;
          const g = perBlock[k] || (perBlock[k] = { day, block: b, parts: [] });
          g.parts.push({ start: a, end: z, positionId: s.positionId, hours: (z - a) / 60, cost: P.slotCost(state, s) * (z - a) / (s.end - s.start) });
        }
      }
    }
    const shifts = Object.values(perBlock).map((g) => {
      const b = g.block;
      // People short each hour of the shift, then runs of hours with the same count.
      const n = [];
      for (let t = b.start; t < b.end; t += 60) n.push(g.parts.filter((x) => x.start < t + 60 && x.end > t).length);
      const segs = [];
      n.forEach((c, i) => {
        const last = segs[segs.length - 1];
        if (c && last && last.n === c && last.to === i) last.to = i + 1;
        else if (c) segs.push({ n: c, from: i, to: i + 1 });
      });
      const full = segs.length === 1 && segs[0].from === 0 && segs[0].to === n.length;
      const at = (i) => P.mil(b.start + i * 60);
      return {
        day: g.day, dow: P.dow(g.day), name: blockName(b.start), block: b, blockText: `${P.mil(b.start)}-${P.mil(b.end)}`, full,
        short: Math.max(0, ...n), segments: segs.map((x) => ({ short: x.n, from: at(x.from), to: at(x.to) })),
        sig: full ? `all${segs[0].n}` : segs.map((x) => `${x.n}@${x.from}-${x.to}`).join(','),
        hours: g.parts.reduce((t, x) => t + x.hours, 0), consoles: [...new Set(g.parts.map((x) => x.positionId))], cost: g.parts.reduce((t, x) => t + x.cost, 0),
      };
    });
    const groups = {};
    for (const s of shifts) {
      const k = [s.dow, s.name, s.blockText, s.sig].join('|');
      const g = groups[k] || (groups[k] = { key: k, dow: s.dow, name: s.name, blockText: s.blockText, full: s.full, short: s.short, segments: s.segments, days: [], hours: 0, cost: 0, consoles: new Set(), shifts: [] });
      g.days.push(s.day); g.hours += s.hours; g.cost += s.cost; g.shifts.push(s);
      s.consoles.forEach((p) => g.consoles.add(p));
    }
    return Object.values(groups).map((g) => Object.assign(g, { days: g.days.sort((x, y) => x - y), consoles: [...g.consoles] })).sort((a, b) => a.days[0] - b.days[0] || b.short - a.short);
  }

  /**
   * Fix coverage: balanceWeek for each of the next `weeks` work weeks, carried forward,
   * then grouped for review. opts as balanceWeek, plus { weeks }.
   * Returns { from, to, weeks, gaps (before), moves (grouped), ptOffers (grouped), training,
   *   remaining (grouped gaps), cost, hours, classes, skippedForNotice, blockedByRun }.
   */
  function planCoverage(state, fromDay, opts = {}) {
    const weeks = Math.max(1, Math.min(12, +(opts.weeks || state.center.fixHorizonWeeks || 4)));
    const start = P.workWeek(state, fromDay).start;
    const end = start + 7 * weeks - 1;
    const now = opts.now != null ? opts.now : P.nowAbs();
    const gapsBefore = P.openings(state, start, end).slots.filter((s) => s.end > now);
    let temp = cloneForPlan(state);
    const all = { moves: [], ptOffers: [], relief: [], training: [], skippedForNotice: 0, blockedByRun: 0, classes: null };
    for (let w = 0; w < weeks; w++) {
      const r = balanceWeek(temp, start + 7 * w, Object.assign({}, opts, { temp: true, now }));
      temp = r.state;
      all.moves.push(...r.moves); all.ptOffers.push(...r.ptOffers); all.relief.push(...r.relief); all.training.push(...r.training);
      all.skippedForNotice += r.skippedForNotice; all.blockedByRun += r.blockedByRun;
      if (!all.classes) all.classes = r.classes;
    }
    const remainingSlots = P.openings(temp, start, end).slots.filter((s) => s.end > now);
    // Group the same change across weeks: "Move Smith's day off from Tue to Fri (3 weeks)".
    const mg = {};
    for (const m of all.moves) {
      const k = [m.employeeId, P.dow(P.parseDate(m.offDate)), P.dow(P.parseDate(m.workDate)), m.templateId].join('|');
      const g = mg[k] || (mg[k] = { key: k, kind: 'move', employeeId: m.employeeId, offDow: P.dow(P.parseDate(m.offDate)), workDow: P.dow(P.parseDate(m.workDate)), templateId: m.templateId, jobClassId: m.jobClassId, items: [], hours: 0, emergency: false });
      g.items.push(m); g.hours += m.gapHoursClosed; g.emergency = g.emergency || !!m.emergency;
      (g.skipKeys ||= []).push(moveKey(m));
    }
    const pg = {};
    for (const o of all.ptOffers) {
      const k = [o.employeeId, P.dow(P.parseDate(o.fill.date)), o.fill.start, o.fill.hours, o.fill.positionId].join('|');
      const g = pg[k] || (pg[k] = { key: k, kind: 'pt', employeeId: o.employeeId, dow: P.dow(P.parseDate(o.fill.date)), start: o.fill.start, hours: o.fill.hours, positionId: o.fill.positionId, items: [], cost: 0, skipKeys: [] });
      g.items.push(o); g.cost += o.cost; g.skipKeys.push(ptKey(o));
    }
    const training = all.training.map((t) => Object.assign({ key: trainKey(t), kind: 'training', skipKeys: [trainKey(t)] }, t));
    // The same relief every other week reads as one suggestion.
    const rg = {};
    for (const r of all.relief) {
      const k = [r.employeeId, r.ptId, P.dow(P.parseDate(r.date)), r.start, r.hours].join('|');
      const g = rg[k] || (rg[k] = { key: k, kind: 'relief', employeeId: r.employeeId, ptId: r.ptId, dow: P.dow(P.parseDate(r.date)), start: r.start, hours: r.hours, keepStart: r.keepStart, keepHours: r.keepHours, items: [], saved: 0, skipKeys: [] });
      g.items.push(r); g.saved += r.saved; g.skipKeys.push(r.key);
    }
    const relief = Object.values(rg).sort((a, b) => P.parseDate(a.items[0].date) - P.parseDate(b.items[0].date));
    const remaining = groupGaps(state, remainingSlots);
    for (const g of remaining) g.everyWeek = weeks >= 2 && g.days.length >= weeks;
    return {
      from: start, to: end, weeks, classes: all.classes || [],
      gaps: groupGaps(state, gapsBefore), gapHours: gapsBefore.reduce((t, s) => t + s.hours, 0),
      moves: Object.values(mg).sort((a, b) => P.parseDate(a.items[0].workDate) - P.parseDate(b.items[0].workDate)),
      ptOffers: Object.values(pg).sort((a, b) => P.parseDate(a.items[0].fill.date) - P.parseDate(b.items[0].fill.date)),
      training, relief, reliefSaved: relief.reduce((t, g) => t + g.saved, 0), reliefHours: relief.reduce((t, g) => t + g.hours * g.items.length, 0), remaining,
      hours: remainingSlots.reduce((t, s) => t + s.hours, 0), cost: remainingSlots.reduce((t, s) => t + P.slotCost(state, s), 0),
      skippedForNotice: all.skippedForNotice, blockedByRun: all.blockedByRun, noticeDays: +state.center.dayOffNoticeDays || 0,
    };
  }

  /**
   * A suggested peak-hours 4-hour shift for a 12-hour shift: the 4 hours inside it with
   * the highest total minimum on the job class's consoles across the week.
   */
  function suggestPeakStart(state, jc, templateId) {
    const t = state.shiftTemplates.find((x) => x.id === templateId);
    if (!t) return null;
    const pids = P.classConsoles(state, jc);
    const { min } = weeklyMinimum(state, pids);
    const s0 = P.parseTime(t.start);
    let best = s0, bv = -1;
    for (let off = 0; off + 240 <= t.hours * 60; off += 60) {
      let v = 0;
      for (let d = 0; d < 7; d++) for (let k = 0; k < 4; k++) v += min[mod(d * 24 + Math.floor((s0 + off) / 60) + k, WEEK)];
      if (v > bv + 1e-9) { bv = v; best = s0 + off; }
    }
    return P.timeStr(best);
  }

  const api = {
    suggestLines, toLineRecords, applyToCurrentLines, balanceWeek, planCoverage, groupGaps, suggestPeakStart,
    weeklyMinimum, lineCandidates, linesProfile, rotationPattern, blockName, moveKey, ptKey, trainKey, WEEK,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.PSAPBalance = api;
})(typeof window !== 'undefined' ? window : globalThis);
