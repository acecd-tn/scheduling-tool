/*
 * PSAP Scheduler — schedule balancer.
 *
 * Goal: every console covered to minimum every hour without overtime, and hours above
 * minimum kept to a deliberate relief margin. The margin and the approach depend on the
 * job class's staffing level:
 *   Normal   keep the relief margin
 *   Short    margin 0; part-timers before overtime
 *   Critical minimums only; spread unavoidable gaps evenly across days; list what
 *            can't be covered without overtime
 *
 * suggestLines(): proposes a set of 40-hour lines (shift + staggered days off) for a
 *   job class: fewest uncovered hours first, then fewest hours above the margin.
 * balanceWeek(): for one week, proposes moving people's days off from surplus days to
 *   gap days (same work week, so still 40 hours; rest rules and notice respected), then
 *   offers remaining gaps to part-timers under their cap, then lists what's left for OT.
 */
(function (global) {
  'use strict';
  const P = global.PSAP || (typeof require !== 'undefined' ? require('./core.js') : null);
  const WEEK = 168;
  const mod = P.mod;

  // ------------------------------------------------------------ profiles
  /** Add a shift starting `startMin` minutes into the week (Sunday 0000) to a 168-hour profile. */
  function addShift(v, startMin, hours, w = 1) {
    const end = startMin + hours * 60;
    for (let m = Math.floor(startMin / 60) * 60; m < end; m += 60) {
      const ov = Math.min(end, m + 60) - Math.max(startMin, m);
      if (ov > 0) v[mod(m / 60, WEEK)] += w * ov / 60;
    }
  }

  /** Weekly minimum (sum over consoles) and how many consoles need someone, per hour of the week. */
  function weeklyMinimum(state, pids) {
    const min = new Float64Array(WEEK), cnt = new Float64Array(WEEK);
    for (let dw = 0; dw < 7; dw++) for (let h = 0; h < 24; h++) for (const pid of pids) {
      const v = +(((state.minimums[pid] || [])[dw] || [])[h]) || 0;
      min[dw * 24 + h] += v;
      if (v > 0) cnt[dw * 24 + h]++;
    }
    return { min, cnt };
  }

  /** Average weekly profile of a set of lines over `weeks` weeks from a Sunday. */
  function linesProfile(state, lines, sunday, weeks = 4) {
    const ix = P.index(state);
    const v = new Float64Array(WEEK);
    for (const l of lines) for (let d = sunday; d < sunday + 7 * weeks; d++) {
      const tpl = P.lineShiftOn(Object.assign({}, l, { effectiveFrom: l.effectiveFrom || P.fmtDate(sunday), effectiveTo: null }), d, ix);
      if (tpl) addShift(v, (d - sunday) * 1440 % (7 * 1440) + P.parseTime(tpl.start), tpl.hours, 1 / weeks);
    }
    return v;
  }

  function score(stf, min, target, spread) {
    let uncov = 0, surplus = 0, sq = 0;
    for (let d = 0; d < 7; d++) {
      let ud = 0;
      for (let h = d * 24; h < d * 24 + 24; h++) {
        const u = min[h] - stf[h];
        if (u > 1e-9) ud += u;
        const sp = stf[h] - target[h];
        if (sp > 1e-9) surplus += sp;
      }
      uncov += ud;
      sq += ud * ud;
    }
    return { uncov, surplus, value: uncov * 1000 + (spread ? sq * 20 : 0) + surplus };
  }

  // ---------------------------------------------------------- candidates
  /** Every 7-day, 40-hour line type × start offset, as a weekly profile. */
  function lineCandidates(state, templateIds) {
    const ix = P.index(state);
    const allowed = new Set(templateIds && templateIds.length ? templateIds : state.shiftTemplates.map((t) => t.id));
    const threshold = +state.center.otThresholdHours || 40;
    const out = [];
    for (const pat of state.patterns) {
      if (!pat.cycle || pat.cycle.length !== 7) continue;
      const explicit = pat.cycle.filter((t) => t && t !== 1 && t !== '1' && t !== '0');
      if (explicit.some((t) => !allowed.has(t))) continue;
      const hasW = pat.cycle.some((t) => t === 1 || t === '1');
      const tplOptions = hasW ? [...allowed] : [explicit[0] || null];
      for (const tplId of tplOptions) {
        const weekly = P.patternWeeklyHours(state, pat, tplId);
        if (Math.abs(weekly - threshold) > 0.01) continue; // only lines that never build in OT
        for (let o = 0; o < 7; o++) {
          const v = new Float64Array(WEEK);
          for (let dw = 0; dw < 7; dw++) {
            const tok = pat.cycle[mod(dw - o, 7)];
            if (!tok || tok === '0') continue;
            const tpl = tok === 1 || tok === '1' ? ix.tpl[tplId] : ix.tpl[tok];
            if (tpl) addShift(v, dw * 1440 + P.parseTime(tpl.start), tpl.hours);
          }
          out.push({ tplId, patId: pat.id, offset: o, v });
        }
      }
    }
    return out;
  }

  function nextSunday(day) { return day + mod(7 - P.dow(day), 7); }

  // -------------------------------------------------------- suggest lines
  /**
   * opts: { headcount, templateIds, reliefMargin, effectiveDate }
   * Returns { lines, before, after, min, target, level, margin, headcount, sunday } or { error }.
   */
  function suggestLines(state, jobClassId, opts = {}) {
    const jc = P.jobClassById(state, jobClassId);
    if (!jc) return { error: 'Unknown job class' };
    const pids = P.classConsoles(state, jc);
    if (!pids.length) return { error: 'This job class staffs no consoles (Staff → Consoles → Staffed by).' };
    const ref = opts.effectiveDate != null ? P.parseDate(opts.effectiveDate) : P.todayNum();
    const sunday = nextSunday(ref);
    const lvl = P.staffingLevel(state, jc, ref);
    const rule = P.levelRule(state, lvl.level);
    const margin = opts.reliefMargin != null && opts.reliefMargin !== '' ? +opts.reliefMargin : (lvl.level === 'normal' ? rule.reliefMargin : 0);
    const spread = lvl.level === 'critical';
    const { min, cnt } = weeklyMinimum(state, pids);
    const target = new Float64Array(WEEK);
    for (let h = 0; h < WEEK; h++) target[h] = min[h] + margin * cnt[h];

    const members = P.classMembers(state, jc);
    const ftMembers = members.filter((e) => !P.isPartTime(e));
    const ptIds = new Set(members.filter((e) => P.isPartTime(e)).map((e) => e.id));
    const classLines = state.lines.filter((l) => (P.lineClass(state, l) || {}).id === jc.id && P.lineActiveOn(l, ref));
    // Part-timers' lines stay as they are; they count if the center counts them.
    const base = state.center.partTimeOnLines === 'extra' ? new Float64Array(WEEK)
      : linesProfile(state, classLines.filter((l) => l.employeeId && ptIds.has(l.employeeId)), sunday);
    const ftLines = classLines.filter((l) => !l.employeeId || !ptIds.has(l.employeeId));
    const beforeV = linesProfile(state, ftLines.filter((l) => l.employeeId), sunday);
    for (let h = 0; h < WEEK; h++) beforeV[h] += base[h];

    // Default headcount: everyone in a full-time position (people on leave still hold a line).
    const N = Math.max(0, Math.round(opts.headcount != null && opts.headcount !== '' ? +opts.headcount : ftMembers.length));
    const cands = lineCandidates(state, opts.templateIds);
    if (!cands.length) return { error: 'No 40-hour, 7-day patterns fit the chosen shifts.' };

    // Greedy start, then local search (swap one line at a time), then iterated local
    // search: shake up a few lines and search again, keeping the best set found.
    const stf = Float64Array.from(base);
    const add = (v, sign) => { for (let h = 0; h < WEEK; h++) stf[h] += sign * v[h]; };
    const valueNow = () => score(stf, min, target, spread).value;
    let chosen = [];
    for (let k = 0; k < N; k++) {
      let best = null, bestVal = Infinity;
      for (const c of cands) { add(c.v, 1); const val = valueNow(); add(c.v, -1); if (val < bestVal - 1e-9) { bestVal = val; best = c; } }
      chosen.push(best); add(best.v, 1);
    }
    const localSearch = () => {
      let cur = valueNow();
      for (let pass = 0; pass < 8; pass++) {
        let improved = false;
        for (let i = 0; i < chosen.length; i++) {
          add(chosen[i].v, -1);
          let best = chosen[i], bestVal = Infinity;
          for (const c of cands) { add(c.v, 1); const val = valueNow(); add(c.v, -1); if (val < bestVal - 1e-9) { bestVal = val; best = c; } }
          add(best.v, 1);
          if (best !== chosen[i] && bestVal < cur - 1e-9) { chosen[i] = best; cur = bestVal; improved = true; } else if (best !== chosen[i]) { add(best.v, -1); add(chosen[i].v, 1); }
        }
        if (!improved) break;
      }
      return cur;
    };
    // Pair move: change two lines' days off (start offsets) together. Fixes the common
    // case where no single change helps but two do.
    const keyOf = (c) => `${c.tplId}|${c.patId}|${c.offset}`;
    const byKey = {}; for (const c of cands) byKey[keyOf(c)] = c;
    const sibling = (c, o) => byKey[`${c.tplId}|${c.patId}|${o}`];
    const pairSearch = () => {
      let cur = valueNow(), improved = false;
      for (let i = 0; i < chosen.length; i++) for (let j = i + 1; j < chosen.length; j++) {
        const ci = chosen[i], cj = chosen[j];
        add(ci.v, -1); add(cj.v, -1);
        let best = null, bestV = cur;
        for (let oi = 0; oi < 7; oi++) {
          const ni = sibling(ci, oi); if (!ni) continue;
          add(ni.v, 1);
          for (let oj = 0; oj < 7; oj++) {
            const nj = sibling(cj, oj); if (!nj) continue;
            add(nj.v, 1); const v = valueNow(); add(nj.v, -1);
            if (v < bestV - 1e-9) { bestV = v; best = [ni, nj]; }
          }
          add(ni.v, -1);
        }
        if (best) { chosen[i] = best[0]; chosen[j] = best[1]; add(best[0].v, 1); add(best[1].v, 1); cur = bestV; improved = true; }
        else { add(ci.v, 1); add(cj.v, 1); }
      }
      return improved;
    };
    const search = () => { let v = localSearch(); for (let k = 0; k < 4 && pairSearch(); k++) v = localSearch(); return v; };
    let bestVal = search();
    let bestSet = chosen.slice();
    let seed = 12345;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    const rounds = opts.effort != null ? +opts.effort : 25;
    for (let it = 0; it < rounds && N > 0; it++) {
      const kick = Math.max(1, Math.round(N * 0.15));
      for (let j = 0; j < kick; j++) {
        const i = Math.floor(rnd() * chosen.length);
        add(chosen[i].v, -1);
        chosen[i] = cands[Math.floor(rnd() * cands.length)];
        add(chosen[i].v, 1);
      }
      const val = search();
      if (val < bestVal - 1e-9) { bestVal = val; bestSet = chosen.slice(); }
      else { for (const c of chosen) add(c.v, -1); chosen = bestSet.slice(); for (const c of chosen) add(c.v, 1); }
    }
    chosen = bestSet;
    stf.set(base); for (const c of chosen) add(c.v, 1);
    const before = Object.assign({ v: beforeV, lines: ftLines.filter((l) => l.employeeId).length }, score(beforeV, min, target, false));
    const after = Object.assign({ v: stf }, score(stf, min, target, false));
    const lines = chosen.map((c) => ({ shiftTemplateId: c.tplId, patternId: c.patId, offset: c.offset, anchorDate: P.fmtDate(sunday + c.offset) }))
      .sort((a, b) => String(a.shiftTemplateId).localeCompare(String(b.shiftTemplateId)) || a.patternId.localeCompare(b.patternId) || a.offset - b.offset);
    let minTotal = 0; for (let h = 0; h < WEEK; h++) minTotal += min[h];
    return { jobClass: jc, consoles: pids, lines, before, after, min, target, level: lvl, margin, headcount: N, sunday, minHours: minTotal, lineHours: N * (+state.center.otThresholdHours || 40) };
  }

  /** Name and shape suggested lines as line records for a job class. */
  function toLineRecords(state, result, effectiveDate) {
    const ix = P.index(state);
    const count = {};
    return result.lines.map((l) => {
      const pat = ix.pat[l.patternId];
      const t = ix.tpl[l.shiftTemplateId] || (pat ? ix.tpl[pat.cycle.find((x) => x && x !== 1 && x !== '1' && x !== '0')] : null);
      const code = t ? t.code : 'L';
      count[code] = (count[code] || 0) + 1;
      return { id: P.uid('ln'), name: `${code} ${count[code]}`, jobClassId: result.jobClass.id, positionId: null, shiftTemplateId: l.shiftTemplateId || (t && t.id), patternId: l.patternId, anchorDate: l.anchorDate, effectiveFrom: effectiveDate || l.anchorDate, effectiveTo: null, employeeId: null };
    });
  }

  /**
   * Re-line a job class without a bid: from `effectiveDate`, each current line holder
   * gets the suggested line closest to their current one (same shift and days off where
   * possible); current lines end the day before. Returns the holders whose schedule changes.
   */
  function applyToCurrentLines(state, result, effectiveDate) {
    const eff = P.parseDate(effectiveDate);
    const jc = result.jobClass;
    const ix = P.index(state);
    const isPT = (id) => { const e = ix.emp[id]; return !!e && P.isPartTime(e); };
    const current = state.lines.filter((l) => (P.lineClass(state, l) || {}).id === jc.id && (P.lineActiveOn(l, eff) || (!l.effectiveTo && P.parseDate(l.effectiveFrom) <= eff)) && !(l.employeeId && isPT(l.employeeId)));
    const fresh = toLineRecords(state, result, P.fmtDate(eff));
    const sen = (e) => P.parseDate(e.seniorityDate || e.hireDate || '2000-01-01');
    const holders = current.filter((l) => l.employeeId).sort((a, b) => sen(ix.emp[a.employeeId] || {}) - sen(ix.emp[b.employeeId] || {}));
    const daysOn = (l, from) => { const out = []; for (let d = from; d < from + 7; d++) out.push(P.lineShiftOn(Object.assign({}, l, { effectiveFrom: P.fmtDate(from), effectiveTo: null }), d, ix) ? 1 : 0); return out.join(''); };
    const free = fresh.slice();
    const changed = [];
    for (const old of holders) {
      if (!free.length) break;
      const sig = daysOn(old, eff);
      let bestI = 0, bestS = -1;
      free.forEach((nl, i) => {
        const s2 = daysOn(nl, eff);
        let sc = (nl.shiftTemplateId === old.shiftTemplateId ? 10 : 0);
        for (let k = 0; k < 7; k++) if (sig[k] === s2[k]) sc++;
        if (sc > bestS) { bestS = sc; bestI = i; }
      });
      const nl = free.splice(bestI, 1)[0];
      nl.employeeId = old.employeeId;
      nl.name = old.name;
      if (!(nl.shiftTemplateId === old.shiftTemplateId && daysOn(nl, eff) === daysOn(old, eff))) changed.push(old.employeeId);
    }
    for (const l of current) {
      if (P.parseDate(l.effectiveFrom) >= eff) state.lines = state.lines.filter((x) => x.id !== l.id);
      else l.effectiveTo = P.fmtDate(eff - 1);
    }
    state.lines.push(...fresh);
    return { changed, created: fresh.length, vacant: fresh.filter((l) => !l.employeeId).length };
  }

  // --------------------------------------------------------- balance week
  function restOk(state, ivs, start, end) {
    const c = state.center;
    const minRest = (+c.minRestHours || 8) * 60;
    for (const iv of ivs) {
      if (iv.start < end && iv.end > start) return false;
      if (iv.end <= start && start - iv.end < minRest) return false;
      if (iv.start >= end && iv.start - end < minRest) return false;
    }
    return true;
  }

  /**
   * opts: { today, allowShortNotice }
   * Returns { from, to, classes: [{ jobClass, level, margin }], moves, ptOffers, remaining: { slots, hours, cost }, skippedForNotice }.
   */
  function balanceWeek(state, fromDay, opts = {}) {
    const today = opts.today != null ? opts.today : P.todayNum();
    const to = fromDay + 6;
    const c = state.center;
    const notice = Math.max(0, +c.dayOffNoticeDays || 0);
    const temp = Object.assign({}, state, { shiftMoves: (state.shiftMoves || []).slice(), fills: state.fills.slice() });
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
    let skippedForNotice = 0;
    const firstAllowed = opts.allowShortNotice ? today : today + notice;
    for (let iter = 0; iter < 40; iter++) {
      const base = classScore(temp, fromDay, to);
      const cov = base.cov;
      const regs = P.regularShifts(temp, fromDay - 1, to + 1);
      const wi = P.workIntervals(temp, fromDay - 1, to + 1);
      const ivBy = P.groupBy(wi.intervals, 'employeeId');
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
            if (Math.min(r.day, g) < firstAllowed) { skippedForNotice++; continue; }
            // Exact effect.
            const mv = { id: '__try', employeeId: e.id, offDate: P.fmtDate(r.day), workDate: P.fmtDate(g), templateId: r.templateId, status: 'approved' };
            const trial = Object.assign({}, temp, { shiftMoves: temp.shiftMoves.concat([mv]) });
            const d0 = Math.min(r.day, g), d1 = Math.max(r.day, g);
            const pre = classScore(temp, d0, d1).out[x.jobClass.id];
            const post = classScore(trial, d0, d1).out[x.jobClass.id];
            const raw = (x.level.level === 'critical' ? pre.sq - post.sq : pre.total - post.total);
            if (raw <= 0) continue;
            // Prefer days that keep the relief margin, and spread changes across people.
            const gain = raw + (keepsMargin ? 0.5 : 0) - 0.1 * moves.filter((m) => m.employeeId === e.id).length;
            if (x.level.level !== 'critical' && post.perDay[r.day - d0] > pre.perDay[r.day - d0]) continue; // no new gap on the day off
            if (!best || gain > best.gain) best = { gain, closed: pre.total - post.total, move: mv, jobClassId: x.jobClass.id };
          }
        }
      }
      if (!best) break;
      best.move.id = P.uid('mv');
      temp.shiftMoves.push(best.move);
      moves.push({ employeeId: best.move.employeeId, offDate: best.move.offDate, workDate: best.move.workDate, templateId: best.move.templateId, jobClassId: best.jobClassId, gapHoursClosed: best.closed });
    }

    // Part-timers under their cap, before any overtime.
    const ptOffers = [];
    const now = opts.now != null ? opts.now : P.nowAbs();
    let slots = P.openings(temp, fromDay, to).slots.filter((s) => s.end > now);
    for (const slot of slots) {
      const cands = P.fillCandidates(temp, slot, { order: 'voluntary' }).filter((x) => x.partTime && x.eligible);
      if (!cands.length) continue;
      const pick = cands[0];
      const fill = { id: P.uid('ot'), date: P.fmtDate(Math.floor(slot.start / 1440)), start: P.timeStr(slot.start), hours: slot.hours, positionId: slot.positionId, employeeId: pick.emp.id, type: 'voluntary', reason: P.slotReason(slot), status: 'scheduled' };
      temp.fills.push(fill);
      ptOffers.push({ employeeId: pick.emp.id, slot, fill, cost: pick.cost, weekHours: pick.weekHours, cap: pick.cap });
    }
    slots = P.openings(temp, fromDay, to).slots.filter((s) => s.end > now);
    const hours = slots.reduce((t, s) => t + s.hours, 0);
    const cost = slots.reduce((t, s) => t + P.slotCost(temp, s), 0);
    const after = classScore(temp, fromDay, to).out;
    return { from: fromDay, to, classes, moves, ptOffers, remaining: { slots, hours, cost }, after, skippedForNotice, noticeDays: notice };
  }

  const api = { suggestLines, toLineRecords, applyToCurrentLines, balanceWeek, weeklyMinimum, lineCandidates, linesProfile, WEEK };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.PSAPBalance = api;
})(typeof window !== 'undefined' ? window : globalThis);
