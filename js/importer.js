/*
 * PSAP Scheduler — import an existing schedule.
 *
 * Takes a grid copied from a spreadsheet (or a CSV file): people down the side,
 * dates across the top, a shift or leave code in each cell. Matches names to
 * employees, works out what each code means, and turns it into day-by-day
 * assignments (plus approved leave) that replace the people's lines for the
 * imported dates.
 */
(function (global) {
  'use strict';
  const P = global.PSAP || (typeof require !== 'undefined' ? require('./core.js') : null);

  // ------------------------------------------------------------ table text
  /** Rows of cells from pasted spreadsheet text (tabs) or CSV (commas/semicolons, quotes). */
  function parseTable(text) {
    text = String(text || '').replace(/^﻿/, '').replace(/\r\n?/g, '\n');
    const first = text.split('\n').slice(0, 5).join('\n');
    const delim = first.includes('\t') ? '\t' : (first.split(';').length > first.split(',').length ? ';' : ',');
    const rows = [];
    let row = [], cell = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) {
        if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
        else cell += c;
      } else if (c === '"' && cell === '') q = true;
      else if (c === delim) { row.push(cell); cell = ''; }
      else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
      else cell += c;
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    return rows.map((r) => r.map((x) => x.trim())).filter((r) => r.some((x) => x !== ''));
  }

  // ------------------------------------------------------------------ dates
  const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const WEEKDAY = /\b(mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)(day|nesday|rsday|urday)?\b\.?/gi;
  const monthOf = (w) => { const i = MONTHS.indexOf(String(w).slice(0, 3).toLowerCase()); return i < 0 ? null : i + 1; };
  const validDay = (y, m, d) => m >= 1 && m <= 12 && d >= 1 && d <= 31 && new Date(Date.UTC(y, m - 1, d)).getUTCDate() === d;

  /** { y?, m, d } from a date cell, or null. Year may be missing. */
  function readDate(str) {
    let s = String(str || '').trim();
    if (!s) return null;
    if (/^\d{5}(\.0+)?$/.test(s)) { // Excel serial date
      const n = Math.floor(+s);
      if (n > 40000 && n < 80000) { const dt = new Date((n - 25569) * 86400000); return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() }; }
      return null;
    }
    s = s.replace(WEEKDAY, ' ').replace(/,/g, ' ').replace(/\s+/g, ' ').trim();
    let m;
    if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))) return { y: +m[1], m: +m[2], d: +m[3] };
    if ((m = s.match(/^(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{2,4}))?$/))) {
      let y = m[3] ? +m[3] : null;
      if (y != null && y < 100) y += 2000;
      return { y, m: +m[1], d: +m[2] };
    }
    if ((m = s.match(/^(\d{1,2})[\s-]([A-Za-z]{3,9})\.?(?:[\s-](\d{2,4}))?$/)) && monthOf(m[2])) {
      let y = m[3] ? +m[3] : null; if (y != null && y < 100) y += 2000;
      return { y, m: monthOf(m[2]), d: +m[1] };
    }
    if ((m = s.match(/^([A-Za-z]{3,9})\.?[\s-](\d{1,2})(?:[\s-](\d{2,4}))?$/)) && monthOf(m[1])) {
      let y = m[3] ? +m[3] : null; if (y != null && y < 100) y += 2000;
      return { y, m: monthOf(m[1]), d: +m[2] };
    }
    return null;
  }

  /**
   * Turn a row of header cells into day numbers. Dates without a year get one:
   * `year` if given, else the year that puts the first date nearest today; the
   * year rolls over when the months wrap (Dec -> Jan).
   */
  function readDateRow(cells, opts = {}) {
    const raw = cells.map(readDate);
    const today = opts.today != null ? opts.today : P.todayNum();
    const ty = new Date(today * 86400000).getUTCFullYear();
    let year = opts.year ? +opts.year : null;
    const firstNoYear = raw.find((r) => r && r.y == null);
    if (!year && firstNoYear) {
      let best = ty, bestDist = Infinity;
      for (const y of [ty - 1, ty, ty + 1]) {
        const dist = Math.abs(P.parseDate(`${y}-${P.pad(firstNoYear.m)}-${P.pad(firstNoYear.d)}`) - today);
        if (dist < bestDist) { bestDist = dist; best = y; }
      }
      year = best;
    }
    let prevM = null;
    return raw.map((r) => {
      if (!r) return null;
      let y = r.y;
      if (y == null) {
        if (prevM != null && r.m < prevM - 6) year++;
        y = year;
      }
      prevM = r.m;
      if (!validDay(y, r.m, r.d)) return null;
      return P.parseDate(`${y}-${P.pad(r.m)}-${P.pad(r.d)}`);
    });
  }

  // ------------------------------------------------------------------- grid
  const looksLikeWeekdayRow = (cells) => cells.filter((c) => /^(mon|tue|wed|thu|fri|sat|sun)[a-z]*\.?$/i.test(c)).length >= 3;

  /**
   * Find the date header and the people in a table.
   * Returns { dates: [{ col, day }], people: [{ row, name, badge, cells: { day: code } }], from, to }.
   */
  function detectGrid(rows, opts = {}) {
    let hdr = -1, days = null;
    for (let r = 0; r < Math.min(rows.length, 25) && hdr < 0; r++) {
      const ds = readDateRow(rows[r], opts);
      if (ds.filter((d) => d != null).length >= 3) { hdr = r; days = ds; }
    }
    if (hdr < 0) return { error: 'No row of dates found. The first rows should hold the dates across the top (e.g. 12/1, 12/2, ... or Mon 12/1).' };
    const dates = [];
    days.forEach((d, col) => { if (d != null) dates.push({ col, day: d }); });
    const firstDateCol = dates[0].col;
    const people = [];
    for (let r = hdr + 1; r < rows.length; r++) {
      const cells = rows[r];
      if (looksLikeWeekdayRow(cells)) continue;
      if (readDateRow(cells, opts).filter((d) => d != null).length >= 3) continue; // another date header
      const lead = cells.slice(0, firstDateCol).filter((c) => c !== '');
      const badge = lead.find((c) => /^\d{1,8}$/.test(c)) || '';
      const name = lead.filter((c) => !/^\d{1,8}$/.test(c)).join(' ').trim();
      if (!name && !badge) continue;
      const map = {};
      let any = false;
      for (const { col, day } of dates) { const v = (cells[col] || '').trim(); if (v) { map[day] = v; any = true; } }
      if (!any) continue;
      people.push({ row: r, name, badge, cells: map });
    }
    const allDays = dates.map((x) => x.day);
    return { dates, people, from: Math.min(...allDays), to: Math.max(...allDays) };
  }

  // ----------------------------------------------------------------- people
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

  /** Match imported names (and badges) to employees. Returns { [personIndex]: { employeeId, how } }. */
  function matchPeople(state, people) {
    const emps = state.employees.filter((e) => e.status !== 'inactive');
    const byLast = {};
    for (const e of emps) (byLast[norm(e.lastName)] ||= []).push(e);
    const out = {};
    people.forEach((p, i) => {
      let hit = null, how = '';
      if (p.badge) { hit = emps.find((e) => String(e.badge || '') === p.badge); how = 'badge'; }
      const n = norm(p.name);
      const toks = n.split(' ').filter(Boolean);
      if (!hit && toks.length) {
        hit = emps.find((e) => {
          const f = norm(e.firstName), l = norm(e.lastName);
          if (n === `${f} ${l}` || n === `${l} ${f}`) return true;
          if (toks.length >= 2) {
            const set = new Set(toks);
            if (set.has(l) && (set.has(f) || toks.some((t) => t.length === 1 && t === f[0]))) return true;
          }
          return false;
        });
        how = hit ? 'name' : '';
      }
      if (!hit && toks.length) {
        // Last name alone, if only one employee has it.
        for (const t of toks) { if (byLast[t] && byLast[t].length === 1) { hit = byLast[t][0]; how = 'last name'; break; } }
      }
      out[i] = { employeeId: hit ? hit.id : null, how };
    });
    return out;
  }

  // ------------------------------------------------------------------ codes
  const OFF = new Set(['off', 'o', 'x', '-', '--', 'r', 'rdo', 'do', 'ro', 'n/a', '/']);
  const LEAVE_ALIASES = {
    vacation: ['v', 'vac', 'vacation', 'pto', 'al', 'annual', 'a/l', 'l', 'leave'],
    sick: ['s', 'sl', 'sick', 'sk', 'co', 'callout', 'call out'],
    family: ['fm', 'fmla', 'fam', 'family'],
    comp: ['ct', 'comp', 'c', 'comp time'],
    holiday: ['h', 'hol', 'holiday', 'fh'],
    training: ['t', 'trn', 'train', 'training', 'class', 'sch', 'school'],
    military: ['m', 'mil', 'military'],
    bereavement: ['b', 'bl', 'ber', 'bereavement', 'funeral'],
    admin: ['a', 'adm', 'admin', 'ad'],
    injury: ['wc', 'ioj', 'injury', 'oji'],
  };
  const codeKey = (v) => String(v || '').trim().toLowerCase();

  /** Parse "0700-1900", "7-19", "7a-7p", "07:00 - 19:00" to { start (min), hours }. */
  function readTimeRange(v) {
    const m = String(v || '').trim().match(/^(\d{1,2})(?::?(\d{2}))?\s*(a|p|am|pm)?\s*(?:-|–|to)\s*(\d{1,2})(?::?(\d{2}))?\s*(a|p|am|pm)?$/i);
    if (!m) return null;
    const conv = (h, mm, ap, compact) => {
      h = +h; mm = +(mm || 0);
      if (compact && h > 24) return null;
      if (ap) { ap = ap[0].toLowerCase(); if (h === 12) h = 0; if (ap === 'p') h += 12; }
      return h < 24 && mm < 60 ? h * 60 + mm : null;
    };
    // "0700" is captured as h=07, mm=00 by the optional minutes group.
    const a = conv(m[1], m[2], m[3], true), b = conv(m[4], m[5], m[6], true);
    if (a == null || b == null) return null;
    let mins = P.mod(b - a, 1440);
    if (mins === 0) mins = 1440;
    return { start: a, hours: Math.round(mins / 15) * 15 / 60 };
  }

  /**
   * Best guess for each distinct code. mapping: { kind: 'off'|'shift'|'newShift'|'leave'|'ignore', templateId?, start?, hours?, leaveType? }
   */
  function guessCodes(state, grid) {
    const counts = {}, samples = {};
    for (const p of grid.people) for (const v of Object.values(p.cells)) {
      const k = codeKey(v);
      counts[k] = (counts[k] || 0) + 1;
      if (!samples[k]) samples[k] = v.trim();
    }
    return Object.keys(counts).sort((a, b) => counts[b] - counts[a]).map((k) => ({ key: k, code: samples[k], count: counts[k], mapping: guessOne(state, k) }));
  }
  function guessOne(state, k) {
    if (OFF.has(k)) return { kind: 'off' };
    const tpl = state.shiftTemplates.find((t) => codeKey(t.code) === k || codeKey(t.name) === k);
    if (tpl) return { kind: 'shift', templateId: tpl.id };
    const tr = readTimeRange(k);
    if (tr) {
      const same = state.shiftTemplates.find((t) => P.parseTime(t.start) === tr.start && +t.hours === tr.hours);
      return same ? { kind: 'shift', templateId: same.id } : { kind: 'newShift', start: tr.start, hours: tr.hours };
    }
    for (const t of P.EXCEPTION_TYPES) if (!t.system && (codeKey(t.abbr) === k || codeKey(t.id) === k || codeKey(t.label) === k)) return { kind: 'leave', leaveType: t.id };
    for (const [type, list] of Object.entries(LEAVE_ALIASES)) if (list.includes(k)) return { kind: 'leave', leaveType: type };
    return { kind: 'ignore' };
  }

  // ------------------------------------------------------------------ build
  /**
   * Turn the grid into records. people: grid.people; match: { i: employeeId|null };
   * codes: { key: mapping }. Returns { record, assignments, exceptions, templates, stats }.
   */
  function buildImport(state, grid, match, codes, opts = {}) {
    const importId = P.uid('imp');
    const templates = [];
    const tplFor = {}; // code key -> template id
    for (const [k, m] of Object.entries(codes)) {
      if (m.kind === 'shift') tplFor[k] = m.templateId;
      if (m.kind === 'newShift') {
        const ex = state.shiftTemplates.concat(templates).find((t) => P.parseTime(t.start) === m.start && +t.hours === +m.hours);
        if (ex) { tplFor[k] = ex.id; continue; }
        const code = `${P.mil(m.start)}`;
        const t = { id: P.uid('t'), code: `${code}/${m.hours}`, name: `Imported ${P.mil(m.start)}-${P.mil(m.start + m.hours * 60)}`, start: P.timeStr(m.start), hours: +m.hours, color: '#64748b', importId };
        templates.push(t);
        tplFor[k] = t.id;
      }
    }
    const allTpl = {}; for (const t of state.shiftTemplates.concat(templates)) allTpl[t.id] = t;
    const ix = P.index(state);
    const assignments = [], exceptions = [];
    const stats = { people: 0, shifts: 0, leave: 0, off: 0, unknown: 0, skippedPeople: 0, leaveWithoutShift: 0 };
    const empIds = new Set();
    grid.people.forEach((p, i) => {
      const empId = match[i];
      if (!empId) { stats.skippedPeople++; return; }
      if (empIds.has(empId)) { stats.skippedPeople++; return; } // same person twice: keep the first row
      empIds.add(empId);
      stats.people++;
      // Their usual shift, for leave days: most common imported shift, else their line.
      const tc = {};
      for (const v of Object.values(p.cells)) { const t = tplFor[codeKey(v)]; if (t) tc[t] = (tc[t] || 0) + 1; }
      const usual = Object.keys(tc).sort((a, b) => tc[b] - tc[a])[0] || null;
      for (const [dayStr, v] of Object.entries(p.cells)) {
        const day = +dayStr, k = codeKey(v), m = codes[k] || { kind: 'ignore' };
        const date = P.fmtDate(day);
        if (m.kind === 'shift' || m.kind === 'newShift') {
          assignments.push({ id: P.uid('as'), importId, employeeId: empId, date, templateId: tplFor[k], code: v });
          stats.shifts++;
        } else if (m.kind === 'leave') {
          let tpl = usual;
          if (!tpl) {
            const line = state.lines.find((l) => l.employeeId === empId && P.lineActiveOn(l, day));
            const t = line ? P.lineShiftOn(line, day, ix) : null;
            tpl = t ? t.id : null;
          }
          if (tpl && allTpl[tpl]) assignments.push({ id: P.uid('as'), importId, employeeId: empId, date, templateId: tpl, code: v, leave: true });
          else stats.leaveWithoutShift++;
          const dup = state.exceptions.some((e) => e.employeeId === empId && e.status === 'approved' && !e.importId && P.exceptionRange(e)[0] <= day && day <= P.exceptionRange(e)[1]);
          if (!dup) exceptions.push({ id: P.uid('ex'), importId, employeeId: empId, date, endDate: null, start: null, hours: null, type: m.leaveType, status: 'approved', note: `Imported (${v})`, createdAt: new Date().toISOString() });
          stats.leave++;
        } else if (m.kind === 'off') stats.off++;
        else stats.unknown++;
      }
    });
    const record = {
      id: importId, name: opts.name || `Imported schedule ${P.fmtDate(grid.from)} to ${P.fmtDate(grid.to)}`,
      from: P.fmtDate(grid.from), to: P.fmtDate(grid.to), employeeIds: [...empIds],
      createdAt: new Date().toISOString(), stats: Object.assign({}, stats), templateIds: templates.map((t) => t.id),
    };
    return { record, assignments, exceptions, templates, stats };
  }

  /** Add an import to the state. Earlier imported days for the same people and dates are replaced. */
  function applyImport(state, built) {
    const r = built.record;
    const a = P.parseDate(r.from), b = P.parseDate(r.to);
    const who = new Set(r.employeeIds);
    const inRange = (x) => who.has(x.employeeId) && P.parseDate(x.date) >= a && P.parseDate(x.date) <= b;
    state.assignments = (state.assignments || []).filter((x) => !inRange(x));
    state.exceptions = state.exceptions.filter((x) => !(x.importId && inRange(x)));
    // Shrink older imports' coverage so they no longer claim these people and dates.
    for (const im of state.scheduleImports || []) {
      const ia = P.parseDate(im.from), ib = P.parseDate(im.to);
      if (ib < a || ia > b) continue;
      if (ia >= a && ib <= b) im.employeeIds = im.employeeIds.filter((id) => !who.has(id));
    }
    state.shiftTemplates.push(...built.templates);
    state.assignments.push(...built.assignments);
    state.exceptions.push(...built.exceptions);
    (state.scheduleImports ||= []).push(r);
    return state;
  }

  /** Remove an import: its days, its leave, and any shift templates it created that nothing else uses. */
  function undoImport(state, importId) {
    state.assignments = (state.assignments || []).filter((x) => x.importId !== importId);
    state.exceptions = state.exceptions.filter((x) => x.importId !== importId);
    const im = (state.scheduleImports || []).find((x) => x.id === importId);
    state.scheduleImports = (state.scheduleImports || []).filter((x) => x.id !== importId);
    if (im) {
      const used = new Set(state.lines.map((l) => l.shiftTemplateId).concat(state.assignments.map((x) => x.templateId)));
      state.shiftTemplates = state.shiftTemplates.filter((t) => !(im.templateIds || []).includes(t.id) || used.has(t.id));
    }
    return state;
  }

  const api = { parseTable, readDate, readDateRow, detectGrid, matchPeople, guessCodes, guessOne, readTimeRange, buildImport, applyImport, undoImport, codeKey, LEAVE_ALIASES };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.PSAPImport = api;
})(typeof window !== 'undefined' ? window : globalThis);
