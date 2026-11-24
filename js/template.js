/*
 * PSAP Scheduler — schedule templates.
 *
 * Reads a schedule template laid out like a typical 12-hour dispatch schedule:
 *
 *   Days  (0700 - 1900)                       ← block title: the block's regular shift
 *   Employee | Week   | Mon  | Tue       | … | Sun
 *   Day 1    | Week 1 | Work | 1100-1500 | … | Work      ← one slot, one row per week
 *            | Week 2 | Work | Work      | … | Work
 *   Mid-Shift (1100-2300) | Week 1 | 1100-2300 | …       ← a slot with its own shift
 *
 * "Work" = the block's (or slot's) regular shift, "RDO"/"Off" = day off, and a time
 * range = that shift. Dated copies of the same blocks give the start date. Each slot
 * becomes a schedule slot with its own repeating pattern.
 *
 * Also: fixRuns() trades a work day and a day off between two slots on the same shift
 * in the same week (coverage and hours stay exactly the same) until nobody works more
 * than the limit in a row.
 */
(function (global) {
  'use strict';
  const P = global.PSAP || (typeof require !== 'undefined' ? require('./core.js') : null);

  const DAYS = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
  const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
  const clean = (v) => String(v == null ? '' : v).replace(/\r/g, '').trim();

  /** "1100-1500", "11:00 - 15:00", "0700-1900" → { start: 'HH:MM', hours } */
  function readRange(text) {
    const m = /(\d{1,2}):?(\d{2})\s*[-–]\s*(\d{1,2}):?(\d{2})/.exec(text);
    if (!m) return null;
    const a = +m[1] * 60 + +m[2], b = +m[3] * 60 + +m[4];
    if (a >= 1440 || b > 1440) return null;
    const hours = P.mod(b - a, 1440) / 60 || 24;
    return { start: P.pad(+m[1]) + ':' + m[2], hours };
  }
  /** "Oct 5, 2026" anywhere in the text → day number */
  function readDate(text) {
    const m = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})/i.exec(text);
    if (!m) return null;
    return P.parseDate(`${m[3]}-${P.pad(MONTHS[m[1].toLowerCase()])}-${P.pad(+m[2])}`);
  }
  function dayOfHeader(text) {
    const m = /^(sun|mon|tue|wed|thu|fri|sat)/i.exec(clean(text));
    return m ? DAYS[m[1].toLowerCase()] : null;
  }
  /** One cell → 'off' | 'work' | { start, hours } | { unknown } */
  function readCode(text) {
    const t = clean(text).toLowerCase();
    if (!t || /^(rdo|off|o|-|x?off|r)$/.test(t)) return 'off';
    if (/^(work|w|on|x|reg|regular)$/.test(t)) return 'work';
    const r = readRange(t);
    return r || { unknown: clean(text) };
  }

  /**
   * sheets: [{ name, rows }] (from PSAPXlsx.read, or one sheet from pasted text).
   * Returns { start (day number or null), firstDow, slots: [{ name, base, weeks: [[cell × 7]] }], warnings }.
   */
  function parse(sheets) {
    const slots = [], warnings = [], seen = {};
    let start = null, firstDow = null;
    for (const sh of sheets) {
      let base = null, blockDate = null, cols = null, cur = null;
      for (const row of sh.rows) {
        const cells = (row || []).map(clean);
        const first = cells[0] || '';
        const dayCols = cells.map(dayOfHeader);
        const nDays = dayCols.filter((x) => x != null).length;
        if (nDays >= 5) {
          // Header row: which column is which day (and the block's first date).
          cols = []; dayCols.forEach((d, i) => { if (d != null) cols.push({ i, dow: d }); });
          cur = null;
          if (firstDow == null) firstDow = cols[0].dow;
          const hd = readDate(cells[cols[0].i]) || (blockDate != null && P.dow(blockDate) === cols[0].dow ? blockDate : null);
          if (hd == null && cells[cols[0].i]) {
            // "Mon\nOct 5 / Oct 12" — the year comes from the block title.
            const m = /(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})/i.exec(cells[cols[0].i]);
            if (m && blockDate != null) {
              const y = P.fmtDate(blockDate).slice(0, 4);
              const d = P.parseDate(`${y}-${P.pad(MONTHS[m[1].toLowerCase()])}-${P.pad(+m[2])}`);
              if (start == null || d < start) start = d;
            }
          } else if (hd != null && (start == null || hd < start)) start = hd;
          continue;
        }
        const rest = cells.slice(1).filter(Boolean);
        // Block title: text with a time range and nothing else on the row, e.g. "Days (0700 - 1900)".
        if (first && !rest.length && readRange(first) && !/week/i.test(first)) {
          base = readRange(first); cur = null; cols = null;
          blockDate = readDate(first);
          continue;
        }
        if (!cols) continue;
        if (/scheduled|headcount|total|coverage/i.test(first)) { cur = null; cols = null; continue; }
        const weekCell = cells.find((c) => /^week\s*\d+/i.test(c));
        const codes = cols.map((c) => cells[c.i] || '');
        if (!codes.some(Boolean)) continue;
        if (first && !/^week\s*\d+/i.test(first)) {
          // A new slot. "Mid-Shift (1100-2300)" carries its own regular shift.
          const own = readRange(first);
          const name = first.replace(/\s*\(.*?\)\s*/g, ' ').replace(/\s+/g, ' ').trim() || first;
          cur = { name, base: own || base, weeks: [] };
          if (!cur.base) warnings.push(`${name}: no regular shift time found (add it to the block title, e.g. "Days (0700 - 1900)")`);
          const key = name.toLowerCase();
          if (seen[key]) {
            cur.duplicateOf = seen[key];
          } else { seen[key] = cur; slots.push(cur); }
        }
        if (!cur || (weekCell == null && cur.weeks.length && !first)) continue;
        cur.weeks.push(codes.map(readCode));
      }
    }
    // Repeats of a slot in dated copies must match the template.
    for (const s of slots) {
      for (const w of s.weeks) for (const c of w) if (c && c.unknown) warnings.push(`${s.name}: "${c.unknown}" isn't a shift time, Work or RDO — treated as a day off`);
    }
    if (start != null && firstDow != null && P.dow(start) !== firstDow) start = start + P.mod(firstDow - P.dow(start), 7);
    return { start, firstDow: firstDow == null ? 1 : firstDow, slots, warnings };
  }

  /** Text pasted from a spreadsheet (tabs) or CSV → one sheet. */
  function sheetFromText(text) {
    const lines = String(text).replace(/\r/g, '').split('\n');
    const tab = lines.some((l) => l.includes('\t'));
    const rows = lines.map((l) => (tab ? l.split('\t') : splitCsv(l)));
    return [{ name: 'Pasted', rows }];
  }
  function splitCsv(line) {
    const out = []; let cur = '', q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (q) { if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; }
      else if (ch === '"') q = true; else if (ch === ',') { out.push(cur); cur = ''; } else cur += ch;
    }
    out.push(cur);
    return out;
  }

  // -------------------------------------------------------------- analysis
  const tokKey = (t) => (!t || t === 0 || t === '0' ? 'O' : String(t));
  function maxRun(cycle) {
    const L = cycle.length; let best = 0, run = 0;
    for (let i = 0; i < 2 * L; i++) { run = tokKey(cycle[i % L]) === 'O' ? 0 : run + 1; best = Math.max(best, run); }
    return Math.min(best, L);
  }

  /**
   * Fix stretches longer than `limit` days in a row by trading between two slots on the
   * same regular shift: in one week, A works day x and is off day y while B is the
   * opposite (same shift on those days); they swap. Each day keeps the same people on
   * duty and each slot keeps the same hours every week.
   * slots: [{ name, group, cycle }]. Returns { trades: [{ a, b, week, x, y }], cycles: { name: cycle } }.
   */
  function fixRuns(slots, limit = 4) {
    const cyc = {}; for (const s of slots) cyc[s.name] = s.cycle.slice();
    const over = (c) => Math.max(0, maxRun(c) - limit);
    const badness = () => slots.reduce((t, s) => t + over(cyc[s.name]), 0);
    const trades = [];
    for (let guard = 0; guard < 50 && badness() > 0; guard++) {
      let best = null;
      const before = badness();
      for (const A of slots) for (const B of slots) {
        if (A === B || A.group !== B.group || cyc[A.name].length !== cyc[B.name].length) continue;
        if (!over(cyc[A.name]) && !over(cyc[B.name])) continue;
        const a = cyc[A.name], b = cyc[B.name], L = a.length;
        for (let w = 0; w * 7 < L; w++) for (let x = 0; x < 7; x++) for (let y = 0; y < 7; y++) {
          const i = w * 7 + x, j = w * 7 + y;
          if (tokKey(a[i]) === 'O' || tokKey(a[j]) !== 'O' || tokKey(b[j]) === 'O' || tokKey(b[i]) !== 'O' || tokKey(a[i]) !== tokKey(b[j])) continue;
          const a2 = a.slice(), b2 = b.slice();
          [a2[i], a2[j]] = [a2[j], a2[i]]; [b2[i], b2[j]] = [b2[j], b2[i]];
          const s0 = over(a) + over(b), s1 = over(a2) + over(b2);
          const score = before - s0 + s1;
          // Prefer trades that leave the shortest runs, then the earliest.
          const tie = maxRun(a2) + maxRun(b2);
          if (s1 < s0 && (!best || score < best.score || (score === best.score && tie < best.tie))) best = { score, tie, A, B, a2, b2, w, x, y };
        }
      }
      if (!best) break;
      cyc[best.A.name] = best.a2; cyc[best.B.name] = best.b2;
      trades.push({ a: best.A.name, b: best.B.name, week: best.w, x: best.x, y: best.y });
    }
    return { trades, cycles: cyc, remaining: slots.filter((s) => over(cyc[s.name])).map((s) => s.name) };
  }

  // ---------------------------------------------------------------- build
  /** Find or create a shift template for a start time and length. */
  function templateFor(state, r, created) {
    const t = state.shiftTemplates.find((x) => x.start === r.start && Math.abs(+x.hours - r.hours) < 1e-9);
    if (t) return t;
    const end = P.mil(P.parseTime(r.start) + r.hours * 60);
    const startH = +r.start.slice(0, 2);
    const t2 = {
      id: P.uid('tpl'), code: `${r.start.replace(':', '').replace(/00$/, '')}-${end.replace(/00$/, '')}`, name: `${r.start.replace(':', '')}-${end}`,
      start: r.start, hours: r.hours, color: r.hours >= 12 ? (startH >= 5 && startH < 11 ? '#3b82f6' : startH >= 11 && startH < 17 ? '#14b8a6' : '#8b5cf6') : '#64748b',
    };
    state.shiftTemplates.push(t2);
    if (created) created.push(t2);
    return t2;
  }

  /** The slot's 14-day (or longer) cycle as pattern tokens; templates are created as needed. */
  function slotCycle(state, slot, created) {
    const baseT = slot.base ? templateFor(state, slot.base, created) : null;
    const cycle = [];
    for (const w of slot.weeks) for (const c of w) {
      if (c === 'off' || (c && c.unknown)) cycle.push(0);
      else if (c === 'work') cycle.push(baseT ? 1 : 0);
      else if (baseT && c.start === baseT.start && Math.abs(c.hours - baseT.hours) < 1e-9) cycle.push(1);
      else cycle.push(templateFor(state, c, created).id);
    }
    return { cycle, baseId: baseT ? baseT.id : null };
  }

  /**
   * Preview a parsed template against the center without changing it: per slot the
   * weekly hours, most days in a row, and the trades that keep everyone at or under the
   * limit. Returns { slots: [{ name, cycle, baseId, weekHours, maxRun, fixedCycle, fixedRun }], trades, start }.
   */
  function preview(state, parsed, limit) {
    const tmp = Object.assign({}, state, { shiftTemplates: state.shiftTemplates.map((t) => Object.assign({}, t)) });
    const rows = parsed.slots.map((s) => {
      const { cycle, baseId } = slotCycle(tmp, s, []);
      const ix = P.index(tmp);
      const hoursOf = (tok) => (tok === 1 ? +(ix.tpl[baseId] || {}).hours || 0 : tok ? +(ix.tpl[tok] || {}).hours || 0 : 0);
      const weekHours = s.weeks.map((_, w) => cycle.slice(w * 7, w * 7 + 7).reduce((t, x) => t + hoursOf(x), 0));
      return { name: s.name, slot: s, cycle, baseId, group: baseId, weekHours, maxRun: maxRun(cycle) };
    });
    const fix = fixRuns(rows, limit || 4);
    for (const r of rows) { r.fixedCycle = fix.cycles[r.name]; r.fixedRun = maxRun(r.fixedCycle); }
    return { rows, trades: fix.trades, remaining: fix.remaining, templates: tmp.shiftTemplates.filter((t) => !state.shiftTemplates.some((x) => x.id === t.id)) };
  }

  /**
   * Create the schedule slots. opts: { jobClassId, effectiveFrom (date string), anchor (date
   * string, the template's first day), assign: { slotName: employeeId }, applyFixes, endCurrent }.
   * Returns { lines, patterns, templates, ended }.
   */
  function apply(state, parsed, opts) {
    const created = [];
    const pv = opts.applyFixes ? preview(state, parsed, opts.limit) : null;
    const lines = [], patterns = [];
    const eff = opts.effectiveFrom;
    let ended = 0;
    if (opts.endCurrent) {
      const effD = P.parseDate(eff);
      for (const l of state.lines.slice()) {
        if ((P.lineClass(state, l) || {}).id !== opts.jobClassId) continue;
        if (l.effectiveTo && P.parseDate(l.effectiveTo) < effD) continue;
        const e = l.employeeId ? state.employees.find((x) => x.id === l.employeeId) : null;
        if (e && P.isPartTime(e)) continue; // part-timers keep their own slots
        if (P.parseDate(l.effectiveFrom) >= effD) state.lines = state.lines.filter((x) => x.id !== l.id);
        else l.effectiveTo = P.fmtDate(effD - 1);
        ended++;
      }
    }
    for (const s of parsed.slots) {
      const { cycle, baseId } = slotCycle(state, s, created);
      const fixed = pv ? (pv.rows.find((r) => r.name === s.name) || {}).fixedCycle : null;
      const pat = { id: P.uid('pat'), name: `Template: ${s.name}`, cycle: fixed || cycle, template: true };
      state.patterns.push(pat); patterns.push(pat);
      const line = {
        id: P.uid('ln'), name: s.name, jobClassId: opts.jobClassId, positionId: null, shiftTemplateId: baseId, patternId: pat.id,
        anchorDate: opts.anchor, effectiveFrom: eff, effectiveTo: null, employeeId: (opts.assign || {})[s.name] || null,
      };
      state.lines.push(line); lines.push(line);
    }
    state.center.lineMode = 'fixed';
    return { lines, patterns, templates: created, ended };
  }

  const api = { parse, sheetFromText, preview, apply, fixRuns, maxRun, readRange, readCode };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.PSAPTemplate = api;
})(typeof window !== 'undefined' ? window : globalThis);
