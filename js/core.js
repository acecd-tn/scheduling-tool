/*
 * PSAP Scheduler — core engine.
 *
 * Pure data + scheduling logic with no DOM access, so it can be unit tested in
 * Node and reused by a future server backend.
 *
 * Time model: dates are "day numbers" (days since 1970-01-01, UTC-based so DST
 * never shifts them). Times are absolute minutes = day * 1440 + minute-of-day.
 * A shift belongs to the day it STARTS on (e.g. a 1800-0600 night shift).
 */
(function (global) {
  'use strict';

  const DAY = 1440;
  const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  // worked: true => the hours count as "hours worked" toward the OT threshold (FLSA treats training this way).
  const EXCEPTION_TYPES = [
    { id: 'sick', label: 'Sick call-out', abbr: 'S' },
    { id: 'family', label: 'FMLA / family sick', abbr: 'FM' },
    { id: 'vacation', label: 'Vacation / PTO', abbr: 'V' },
    { id: 'comp', label: 'Comp time', abbr: 'CT' },
    { id: 'holiday', label: 'Holiday leave', abbr: 'H' },
    { id: 'training', label: 'Training (off console)', abbr: 'T', worked: true },
    { id: 'military', label: 'Military leave', abbr: 'M' },
    { id: 'bereavement', label: 'Bereavement', abbr: 'B' },
    { id: 'admin', label: 'Admin leave / detail', abbr: 'A', worked: true },
    { id: 'injury', label: 'Injury / workers comp', abbr: 'WC' },
    { id: 'other', label: 'Other', abbr: 'O' },
  ];

  const FILL_TYPES = [
    { id: 'voluntary', label: 'Voluntary OT' },
    { id: 'mandatory', label: 'Mandatory (forced)' },
    { id: 'holdover', label: 'Holdover' },
    { id: 'earlyin', label: 'Early call-in' },
    { id: 'callback', label: 'Call-back' },
  ];

  const STATUSES = [
    { id: 'active', label: 'Active' },
    { id: 'trainee', label: 'Trainee (CTO)' },
    { id: 'leave', label: 'Extended leave' },
    { id: 'inactive', label: 'Separated / inactive' },
  ];

  // ---------------------------------------------------------------- utilities
  const mod = (a, b) => ((a % b) + b) % b;
  const pad = (n) => String(n).padStart(2, '0');

  function parseDate(s) {
    if (typeof s === 'number') return s;
    const [y, m, d] = String(s).split('-').map(Number);
    return Math.floor(Date.UTC(y, m - 1, d) / 86400000);
  }
  function fmtDate(n) { return new Date(n * 86400000).toISOString().slice(0, 10); }
  function dow(n) { return mod(n + 4, 7); } // 1970-01-01 was a Thursday
  function todayNum(now = new Date()) {
    return Math.floor(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) / 86400000);
  }
  function nowAbs(now = new Date()) { return todayNum(now) * DAY + now.getHours() * 60 + now.getMinutes(); }
  function parseTime(t) {
    if (t == null || t === '') return 0;
    const [h, m] = String(t).split(':').map(Number);
    return h * 60 + (m || 0);
  }
  /** "HH:MM" for a minute-of-day (or absolute minute). */
  function timeStr(min) { min = mod(Math.round(min), DAY); return pad(Math.floor(min / 60)) + ':' + pad(min % 60); }
  /** Military style "0600". */
  function mil(min) { return timeStr(min).replace(':', ''); }
  function shortDate(n) {
    const d = new Date(n * 86400000);
    return `${DOW[dow(n)]} ${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
  }
  function uid(p) {
    return (p || 'id') + '_' + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
  }
  function round2(n) { return Math.round(n * 100) / 100; }
  function groupBy(arr, key) {
    const out = {};
    for (const x of arr) (out[x[key]] ||= []).push(x);
    return out;
  }
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function subtract(pieces, w0, w1) {
    const out = [];
    for (const [a, b] of pieces) {
      if (w1 <= a || w0 >= b) { out.push([a, b]); continue; }
      if (w0 > a) out.push([a, w0]);
      if (w1 < b) out.push([w1, b]);
    }
    return out;
  }
  const total = (pieces) => pieces.reduce((s, [a, b]) => s + (b - a), 0);

  // ------------------------------------------------------------------- state
  function defaultCenter() {
    return {
      name: 'Emergency Communications Center',
      otPeriodDays: 7,            // FLSA work week = 7. Some agencies use 14 or 28 (7k).
      otThresholdHours: 40,       // hours in the period before OT applies
      otPeriodStart: '2026-01-04',// any date that begins an OT/work period (a Sunday here)
      otMultiplier: 1.5,
      extraShiftsAlwaysOT: false, // true = any extra (non-scheduled) shift is paid as OT regardless of hours
      leaveCountsTowardOT: false, // true = paid leave counts as hours worked toward the threshold
      fiscalYearStart: '07-01',   // MM-DD
      annualOtBudget: 180000,
      minRestHours: 8,
      maxShiftHours: 16,
      maxHours7Days: 60,
      theme: 'dark',
    };
  }

  function emptyState() {
    return {
      version: 1,
      center: defaultCenter(),
      positions: [
        { id: 'pos_tc', name: 'Telecommunicator', authorized: 0, isConsole: true },
        { id: 'pos_sup', name: 'Supervisor', authorized: 0, isConsole: false },
      ],
      minimums: {},
      minimumOverrides: [],
      shiftTemplates: defaultTemplates(),
      patterns: defaultPatterns(),
      employees: [],
      lines: [],
      exceptions: [],
      fills: [],
      bids: [],
    };
  }

  function defaultTemplates() {
    return [
      { id: 't_d12', code: 'D12', name: 'Day 12', start: '06:00', hours: 12, color: '#3b82f6' },
      { id: 't_n12', code: 'N12', name: 'Night 12', start: '18:00', hours: 12, color: '#8b5cf6' },
      { id: 't_d8', code: 'D8', name: 'Days 8', start: '07:00', hours: 8, color: '#0ea5e9' },
      { id: 't_e8', code: 'E8', name: 'Evenings 8', start: '15:00', hours: 8, color: '#f59e0b' },
      { id: 't_m8', code: 'M8', name: 'Mids 8', start: '23:00', hours: 8, color: '#6366f1' },
      { id: 't_p8', code: 'P8', name: 'Power 8 (peak)', start: '14:00', hours: 8, color: '#10b981' },
      { id: 't_p10', code: 'P10', name: 'Power 10 (peak)', start: '12:00', hours: 10, color: '#14b8a6' },
      { id: 't_s4', code: 'S4', name: 'Short 4 (peak)', start: '10:00', hours: 4, color: '#64748b' },
    ];
  }

  /**
   * Default library: every pattern is exactly 40 hours in ANY 7-day window, so
   * none of them builds in overtime for a non-exempt 7-day/40-hour work week.
   * Tokens: 1 = the line's own shift, 0 = off, template id = that shift.
   */
  function defaultPatterns() {
    const D12 = 't_d12', N12 = 't_n12', D8 = 't_d8', M8 = 't_m8', S4 = 't_s4';
    return [
      { id: 'p_52', name: '5 x 8 (5 on / 2 off)', cycle: [1, 1, 1, 1, 1, 0, 0] },
      { id: 'p_410', name: '4 x 10 (4 on / 3 off)', cycle: [1, 1, 1, 1, 0, 0, 0] },
      { id: 'p_12d8', name: '2 x 12 + 2 x 8 — days (D12 D12 D8 D8)', cycle: [D12, D12, 0, D8, D8, 0, 0] },
      { id: 'p_12n8', name: '2 x 12 + 2 x 8 — nights (N12 N12 M8 M8)', cycle: [N12, N12, 0, 0, M8, M8, 0] },
      { id: 'p_3x12', name: '3 x 12 + 1 x 4 (three 12s plus a 4-hr peak)', cycle: [1, 1, 1, 0, S4, 0, 0] },
    ];
  }

  /** Fill in anything missing so older saved data keeps working. */
  function migrate(s) {
    const base = emptyState();
    s = s || {};
    s.center = Object.assign(defaultCenter(), s.center || {});
    for (const k of ['positions', 'shiftTemplates', 'patterns']) if (!Array.isArray(s[k])) s[k] = base[k];
    for (const k of ['employees', 'lines', 'exceptions', 'fills', 'bids', 'minimumOverrides']) if (!Array.isArray(s[k])) s[k] = [];
    s.minimums = s.minimums || {};
    for (const p of s.positions) {
      if (!Array.isArray(s.minimums[p.id])) s.minimums[p.id] = Array.from({ length: 7 }, () => new Array(24).fill(0));
    }
    s.version = 1;
    return s;
  }

  function index(state) {
    const by = (arr) => { const o = {}; for (const x of arr || []) o[x.id] = x; return o; };
    return {
      emp: by(state.employees), tpl: by(state.shiftTemplates), pat: by(state.patterns),
      pos: by(state.positions), line: by(state.lines), excType: by(EXCEPTION_TYPES),
    };
  }

  function empName(e) { return e ? `${e.lastName}, ${e.firstName}` : '—'; }
  function countable(emp) { return !!emp && (emp.status === 'active' || (emp.status === 'trainee' && !!emp.soloCleared)); }
  function qualifiedFor(emp, positionId) { return emp.positionId === positionId || (emp.qualifications || []).includes(positionId); }

  // -------------------------------------------------------------- schedule
  function lineActiveOn(line, day) {
    if (day < parseDate(line.effectiveFrom)) return false;
    if (line.effectiveTo && day > parseDate(line.effectiveTo)) return false;
    return true;
  }

  /** The shift template a line works on a given day, or null if off. */
  function lineShiftOn(line, day, ix) {
    if (!lineActiveOn(line, day)) return null;
    const pat = ix.pat[line.patternId];
    if (!pat || !pat.cycle || !pat.cycle.length) return null;
    const anchor = parseDate(line.anchorDate || line.effectiveFrom);
    const tok = pat.cycle[mod(day - anchor, pat.cycle.length)];
    if (!tok || tok === '0') return null;
    if (tok === 1 || tok === '1') return ix.tpl[line.shiftTemplateId] || null;
    return ix.tpl[tok] || null;
  }

  /** Scheduled (pre-exception) shifts from the line assignments. */
  function regularShifts(state, fromDay, toDay, ix = index(state)) {
    const out = [];
    for (const line of state.lines) {
      if (!line.employeeId) continue;
      const emp = ix.emp[line.employeeId];
      if (!emp || emp.status === 'inactive') continue;
      const a = Math.max(fromDay, parseDate(line.effectiveFrom));
      const b = Math.min(toDay, line.effectiveTo ? parseDate(line.effectiveTo) : Infinity);
      for (let d = a; d <= b; d++) {
        const tpl = lineShiftOn(line, d, ix);
        if (!tpl) continue;
        const start = d * DAY + parseTime(tpl.start);
        out.push({
          employeeId: emp.id, positionId: emp.positionId, day: d, start,
          end: start + Math.round(tpl.hours * 60), templateId: tpl.id, lineId: line.id, kind: 'regular',
        });
      }
    }
    return out;
  }

  function exceptionRange(e) { const d0 = parseDate(e.date); return [d0, e.endDate ? parseDate(e.endDate) : d0]; }

  /**
   * Actual working intervals after leave/call-outs are removed and OT fills added.
   * opts.includePending: treat pending requests as approved.
   * opts.overrideStatus: { [exceptionId]: status } — used for "what if" previews.
   */
  function workIntervals(state, fromDay, toDay, opts = {}) {
    const ix = opts.ix || index(state);
    const regs = regularShifts(state, fromDay - 1, toDay, ix);
    const excByEmp = {};
    for (const e of state.exceptions) {
      const st = (opts.overrideStatus && opts.overrideStatus[e.id]) || e.status;
      if (!(st === 'approved' || (opts.includePending && st === 'pending'))) continue;
      const [d0, d1] = exceptionRange(e);
      if (d1 < fromDay - 1 || d0 > toDay + 1) continue;
      (excByEmp[e.employeeId] ||= []).push({ e, d0, d1 });
    }
    const intervals = [], leave = [];
    for (const r of regs) {
      let pieces = [[r.start, r.end]];
      for (const { e, d0, d1 } of excByEmp[r.employeeId] || []) {
        let w0, w1;
        if (e.start) { w0 = d0 * DAY + parseTime(e.start); w1 = w0 + Math.round((+e.hours || 0) * 60); }
        else { if (r.day < d0 || r.day > d1) continue; w0 = r.start; w1 = r.end; }
        const before = total(pieces);
        pieces = subtract(pieces, w0, w1);
        const removed = before - total(pieces);
        if (removed > 0) {
          leave.push({
            employeeId: r.employeeId, positionId: r.positionId, day: r.day,
            start: Math.max(w0, r.start), end: Math.min(w1, r.end), minutes: removed,
            type: e.type, exceptionId: e.id, worked: !!(ix.excType[e.type] || {}).worked,
          });
        }
      }
      for (const [a, b] of pieces) intervals.push(Object.assign({}, r, { start: a, end: b }));
    }
    for (const f of state.fills) {
      if (f.status === 'cancelled') continue;
      const d = parseDate(f.date);
      if (d < fromDay - 1 || d > toDay) continue;
      const start = d * DAY + parseTime(f.start);
      intervals.push({
        employeeId: f.employeeId, positionId: f.positionId, day: d, start,
        end: start + Math.round(f.hours * 60), kind: 'ot', fillId: f.id, reason: f.reason, fillType: f.type,
      });
    }
    return { intervals, leave, ix };
  }

  // -------------------------------------------------------------- coverage
  function requiredFor(state, positionId, day, hour) {
    let v = (((state.minimums[positionId] || [])[dow(day)]) || [])[hour] || 0;
    for (const o of state.minimumOverrides) {
      if (o.positionId === positionId && parseDate(o.date) === day && hour >= +o.startHour && hour < +o.endHour) v = +o.minimum;
    }
    return v;
  }

  /** Hour-by-hour staffed vs required per position over [fromDay, toDay]. */
  function coverage(state, fromDay, toDay, opts = {}) {
    const wi = opts.wi || workIntervals(state, fromDay, toDay, opts);
    const ix = wi.ix;
    const n = (toDay - fromDay + 1) * 24;
    const base = fromDay * DAY;
    const staffed = {}, required = {};
    for (const p of state.positions) {
      staffed[p.id] = new Array(n).fill(0);
      const req = required[p.id] = new Array(n);
      for (let i = 0; i < n; i++) req[i] = requiredFor(state, p.id, fromDay + Math.floor(i / 24), i % 24);
    }
    for (const iv of wi.intervals) {
      if (!countable(ix.emp[iv.employeeId])) continue;
      const arr = staffed[iv.positionId];
      if (!arr) continue;
      const h0 = Math.max(0, Math.floor((iv.start - base) / 60));
      const h1 = Math.min(n, Math.ceil((iv.end - base) / 60));
      for (let h = h0; h < h1; h++) {
        const ov = Math.min(iv.end, base + (h + 1) * 60) - Math.max(iv.start, base + h * 60);
        if (ov > 0) arr[h] += ov / 60;
      }
    }
    return { fromDay, toDay, base, n, staffed, required, wi };
  }

  /**
   * Openings: every hour where staffed < minimum becomes part of a "slot" that
   * one person could fill. A 2-person shortage yields two stacked slots.
   */
  function openings(state, fromDay, toDay, opts = {}) {
    const cov = coverage(state, fromDay, toDay, opts);
    const ix = cov.wi.ix;
    const slots = [];
    for (const p of state.positions) {
      const s = cov.staffed[p.id], r = cov.required[p.id];
      const short = s.map((v, i) => Math.max(0, Math.ceil(r[i] - v - 1e-6)));
      let maxS = 0;
      for (const v of short) if (v > maxS) maxS = v;
      for (let k = 1; k <= maxS; k++) {
        let h = 0;
        while (h < cov.n) {
          if (short[h] < k) { h++; continue; }
          let e = h;
          while (e < cov.n && short[e] >= k) e++;
          const start = cov.base + h * 60, end = cov.base + e * 60;
          const seen = new Set(), causes = [];
          for (const l of cov.wi.leave) {
            if (l.positionId !== p.id || l.start >= end || l.end <= start || seen.has(l.exceptionId)) continue;
            seen.add(l.exceptionId);
            causes.push({ exceptionId: l.exceptionId, employeeId: l.employeeId, type: l.type, label: (ix.excType[l.type] || {}).label || l.type });
          }
          slots.push({ id: `${p.id}|${start}|${k}`, positionId: p.id, start, end, hours: (end - start) / 60, level: k, causes });
          h = e;
        }
      }
    }
    slots.sort((a, b) => a.start - b.start || a.level - b.level);
    return { slots, cov };
  }

  function slotReason(slot) {
    if (slot.causes && slot.causes.length) return slot.causes[0].type;
    return 'vacancy';
  }

  // -------------------------------------------------------------- overtime
  function periodOf(state, day) {
    const len = Math.max(1, +state.center.otPeriodDays || 7);
    const anchor = parseDate(state.center.otPeriodStart || '2026-01-04');
    const start = anchor + Math.floor((day - anchor) / len) * len;
    return { start, end: start + len - 1 };
  }

  function fiscalYear(state, day) {
    const [mm, dd] = (state.center.fiscalYearStart || '07-01').split('-').map(Number);
    const y = new Date(day * 86400000).getUTCFullYear();
    let start = parseDate(`${y}-${pad(mm)}-${pad(dd)}`);
    if (day < start) start = parseDate(`${y - 1}-${pad(mm)}-${pad(dd)}`);
    const sy = new Date(start * 86400000).getUTCFullYear();
    const end = parseDate(`${sy + 1}-${pad(mm)}-${pad(dd)}`) - 1;
    return { start, end, label: `FY ${sy}-${String(sy + 1).slice(2)}` };
  }

  /** Bucket one employee's hours inside a period. */
  function empHours(ivs, leaves, pStart, pEnd, cutoff = Infinity) {
    const h = { regular: 0, fill: 0, leave: 0, workedLeave: 0, fillByReason: {} };
    for (const iv of ivs) {
      if (iv.day < pStart || iv.day > pEnd || iv.day > cutoff) continue;
      const hrs = (iv.end - iv.start) / 60;
      if (iv.kind === 'ot') { h.fill += hrs; h.fillByReason[iv.reason || 'other'] = (h.fillByReason[iv.reason || 'other'] || 0) + hrs; }
      else h.regular += hrs;
    }
    for (const l of leaves) {
      if (l.day < pStart || l.day > pEnd || l.day > cutoff) continue;
      if (l.worked) h.workedLeave += l.minutes / 60; else h.leave += l.minutes / 60;
    }
    return h;
  }

  /** Apply the center's OT rules to an employee's period hours. */
  function otCalc(center, h) {
    let worked = h.regular + h.fill + h.workedLeave;
    if (center.leaveCountsTowardOT) worked += h.leave;
    const excess = Math.max(0, worked - (+center.otThresholdHours || 40));
    const otHours = center.extraShiftsAlwaysOT ? Math.max(excess, h.fill) : excess;
    const fillOT = Math.min(otHours, h.fill);
    return { worked, otHours, fillOT, builtIn: otHours - fillOT };
  }

  /**
   * OT cost by period. opts.cutoff = last day counted (for "actual to date").
   * Each period's cost is reported against the period it falls in.
   */
  function otReport(state, fromDay, toDay, opts = {}) {
    const c = state.center;
    const len = Math.max(1, +c.otPeriodDays || 7);
    const periods = [];
    for (let p = periodOf(state, fromDay); p.start <= toDay; p = { start: p.end + 1, end: p.end + len }) {
      periods.push({ start: p.start, end: p.end, cost: 0, hours: 0, byReason: {}, byEmp: {} });
    }
    if (!periods.length) return { periods, totals: { cost: 0, hours: 0, byReason: {}, byEmp: {} } };
    const wi = opts.wi || workIntervals(state, periods[0].start, periods[periods.length - 1].end);
    const ivBy = groupBy(wi.intervals, 'employeeId'), lvBy = groupBy(wi.leave, 'employeeId');
    const totals = { cost: 0, hours: 0, byReason: {}, byEmp: {} };
    const mult = +c.otMultiplier || 1.5;
    for (const emp of state.employees) {
      const ivs = ivBy[emp.id] || [], lvs = lvBy[emp.id] || [];
      if (!ivs.length) continue;
      const rate = +emp.hourlyRate || 0;
      for (const p of periods) {
        const h = empHours(ivs, lvs, p.start, p.end, opts.cutoff);
        const r = otCalc(c, h);
        if (r.otHours <= 0) continue;
        const cost = r.otHours * rate * mult;
        p.cost += cost; p.hours += r.otHours;
        const add = (o, k, hrs) => { o[k] = o[k] || { hours: 0, cost: 0 }; o[k].hours += hrs; o[k].cost += hrs * rate * mult; };
        if (r.builtIn > 0) { add(p.byReason, 'built-in', r.builtIn); add(totals.byReason, 'built-in', r.builtIn); }
        if (r.fillOT > 0) {
          for (const [reason, hrs] of Object.entries(h.fillByReason)) {
            const share = r.fillOT * hrs / h.fill;
            add(p.byReason, reason, share); add(totals.byReason, reason, share);
          }
        }
        add(p.byEmp, emp.id, r.otHours); add(totals.byEmp, emp.id, r.otHours);
        totals.cost += cost; totals.hours += r.otHours;
      }
    }
    return { periods, totals, wi };
  }

  function avgRate(state, positionId) {
    const list = state.employees.filter((e) => e.status !== 'inactive' && (!positionId || e.positionId === positionId) && +e.hourlyRate > 0);
    if (!list.length) return 0;
    return list.reduce((s, e) => s + +e.hourlyRate, 0) / list.length;
  }

  function slotCost(state, slot) { return slot.hours * avgRate(state, slot.positionId) * (+state.center.otMultiplier || 1.5); }

  /**
   * Overtime dashboard numbers: actual vs predicted.
   */
  function otForecast(state, today = todayNum(), horizonDays = 28) {
    const fy = fiscalYear(state, today);
    const full = otReport(state, fy.start, fy.end);
    const actual = otReport(state, fy.start, fy.end, { cutoff: today, wi: full.wi });
    const cur = periodOf(state, today);
    const pick = (rep, p) => rep.periods.find((x) => x.start === p.start) || { cost: 0, hours: 0 };
    // Run rate: last 28 days of actual cost.
    const lookback = 28;
    const rr = otReport(state, today - lookback + 1, today, { cutoff: today });
    let rrCost = 0;
    for (const p of rr.periods) {
      // pro-rate periods that straddle the lookback window start
      const days = p.end - p.start + 1;
      const inside = Math.min(p.end, today) - Math.max(p.start, today - lookback + 1) + 1;
      rrCost += p.cost * Math.max(0, inside) / days;
    }
    const daily = rrCost / lookback;
    const remaining = Math.max(0, fy.end - today);
    const ytd = actual.totals.cost;
    const known = full.totals.cost - ytd; // built-in pattern OT + already scheduled fills, rest of FY
    const gaps = openings(state, today, today + horizonDays - 1).slots.filter((s) => s.end > nowAbs());
    const gapCost = gaps.reduce((s, g) => s + slotCost(state, g), 0);
    const gapHours = gaps.reduce((s, g) => s + g.hours, 0);
    return {
      fy, today, cur,
      curActual: pick(actual, cur).cost,
      curTotal: pick(full, cur).cost,
      ytd, ytdHours: actual.totals.hours,
      known, daily,
      projection: ytd + daily * remaining,
      projectionKnown: ytd + Math.max(known, daily * remaining),
      budget: +state.center.annualOtBudget || 0,
      gapCost, gapHours, gapCount: gaps.length, horizonDays,
      full, actual,
    };
  }

  // ---------------------------------------------------------- staffing level
  function staffingSummary(state) {
    return state.positions.map((p) => {
      const emps = state.employees.filter((e) => e.positionId === p.id && e.status !== 'inactive');
      const active = emps.filter((e) => e.status === 'active').length;
      const traineeSolo = emps.filter((e) => e.status === 'trainee' && e.soloCleared).length;
      const traineeNot = emps.filter((e) => e.status === 'trainee' && !e.soloCleared).length;
      const onLeave = emps.filter((e) => e.status === 'leave').length;
      const authorized = +p.authorized || 0;
      return {
        position: p, authorized, current: emps.length, active, traineeSolo, traineeNot, onLeave,
        countable: active + traineeSolo, vacancies: Math.max(0, authorized - emps.length),
        pct: authorized ? emps.length / authorized : 0,
      };
    });
  }

  /** Average weekly minimum person-hours a position requires. */
  function requiredWeeklyHours(state, positionId) {
    const g = state.minimums[positionId] || [];
    let s = 0;
    for (const row of g) for (const v of row || []) s += +v || 0;
    return s;
  }

  /** Average weekly paid hours an employee on this line/pattern works. */
  function patternWeeklyHours(state, pattern, templateId) {
    const ix = index(state);
    let mins = 0;
    for (const tok of pattern.cycle) {
      if (!tok || tok === '0') continue;
      const tpl = (tok === 1 || tok === '1') ? ix.tpl[templateId] : ix.tpl[tok];
      if (tpl) mins += tpl.hours * 60;
    }
    return pattern.cycle.length ? (mins / 60) * 7 / pattern.cycle.length : 0;
  }

  /**
   * Built-in OT hours/yr one employee earns on a line of this pattern under the
   * center's OT rule, best and worst case over every alignment of the rotation
   * with the OT period. min === 0 means the pattern can run OT-free.
   */
  function patternBuiltInOT(state, templateId, patternId, today = todayNum()) {
    const pat = state.patterns.find((p) => p.id === patternId);
    if (!pat || !pat.cycle.length) return { min: 0, max: 0, bestOffset: 0 };
    const t0 = periodOf(state, today).start;
    const L = pat.cycle.length;
    let min = Infinity, max = 0, bestOffset = 0;
    const posId = (state.positions[0] || {}).id;
    for (let off = 0; off < L; off++) {
      const temp = Object.assign({}, state, {
        employees: [{ id: 'x', firstName: '', lastName: 'x', positionId: posId, status: 'active', hourlyRate: 1 }],
        lines: [{ id: 'l', employeeId: 'x', shiftTemplateId: templateId, patternId, anchorDate: fmtDate(t0 + off), effectiveFrom: fmtDate(t0 - L), positionId: posId }],
        exceptions: [], fills: [],
      });
      const h = otReport(temp, t0, t0 + 363).totals.hours * 365 / 364;
      if (h < min - 1e-9) { min = h; bestOffset = off; }
      if (h > max) max = h;
    }
    return { min, max, bestOffset, bestDow: DOW[dow(t0 + bestOffset)] };
  }

  /** Average leave hours per countable employee over the last 365 days. */
  function actualLeavePerEmployee(state, today = todayNum()) {
    const wi = workIntervals(state, today - 364, today);
    const byType = {};
    let totalH = 0;
    for (const l of wi.leave) {
      if (l.day < today - 364 || l.day > today) continue;
      byType[l.type] = (byType[l.type] || 0) + l.minutes / 60;
      totalH += l.minutes / 60;
    }
    const n = Math.max(1, state.employees.filter((e) => e.status !== 'inactive').length);
    return { perEmployee: totalH / n, byType, headcount: n };
  }

  // -------------------------------------------------------- fill candidates
  /**
   * Rank who could fill a slot. Hard issues make a candidate ineligible;
   * warnings are shown but don't block.
   */
  function fillCandidates(state, slot, opts = {}) {
    const c = state.center;
    const ix = index(state);
    const d0 = Math.floor(slot.start / DAY);
    const per = periodOf(state, d0);
    const wi = workIntervals(state, Math.min(d0 - 8, per.start), Math.max(d0 + 2, per.end), { ix });
    const ivBy = groupBy(wi.intervals, 'employeeId'), lvBy = groupBy(wi.leave, 'employeeId');
    const fy = fiscalYear(state, d0);
    const fyFills = state.fills.filter((f) => f.status !== 'cancelled' && parseDate(f.date) >= fy.start && parseDate(f.date) <= fy.end);
    const fillsBy = groupBy(fyFills, 'employeeId');
    const mult = +c.otMultiplier || 1.5;
    const slotHours = (slot.end - slot.start) / 60;
    const res = [];
    for (const emp of state.employees) {
      if (!countable(emp) || !qualifiedFor(emp, slot.positionId)) continue;
      const ivs = (ivBy[emp.id] || []).filter((iv) => !opts.ignoreFillId || iv.fillId !== opts.ignoreFillId);
      const issues = [], warnings = [];
      if (ivs.some((iv) => iv.start < slot.end && iv.end > slot.start)) issues.push('Already working');
      const onLeave = state.exceptions.some((e) => {
        if (e.employeeId !== emp.id || e.status !== 'approved') return false;
        const [a, b] = exceptionRange(e);
        return a <= d0 && d0 <= b;
      });
      if (onLeave) issues.push('On leave that day');
      // contiguous block including this slot
      const all = ivs.map((iv) => [iv.start, iv.end]).concat([[slot.start, slot.end]]).sort((a, b) => a[0] - b[0]);
      let blk = null;
      for (const [a, b] of all) {
        if (blk && a <= blk[1]) blk[1] = Math.max(blk[1], b);
        else { if (blk && blk[0] <= slot.start && blk[1] >= slot.end) break; blk = [a, b]; }
      }
      const blockHours = blk ? (blk[1] - blk[0]) / 60 : slotHours;
      let prevEnd = -Infinity, nextStart = Infinity;
      for (const iv of ivs) {
        if (iv.end <= slot.start && iv.end > prevEnd) prevEnd = iv.end;
        if (iv.start >= slot.end && iv.start < nextStart) nextStart = iv.start;
      }
      const holdover = prevEnd === slot.start, earlyIn = nextStart === slot.end;
      if (blockHours > (+c.maxShiftHours || 16)) issues.push(`${round2(blockHours)}h straight (max ${c.maxShiftHours})`);
      const restB = (slot.start - prevEnd) / 60, restA = (nextStart - slot.end) / 60;
      if (!holdover && restB < (+c.minRestHours || 8)) issues.push(`${round2(restB)}h rest before`);
      if (!earlyIn && restA < (+c.minRestHours || 8)) issues.push(`${round2(restA)}h rest after`);
      let hours7 = slotHours;
      for (const iv of ivs) {
        const ov = Math.min(iv.end, slot.start) - Math.max(iv.start, slot.start - 7 * DAY);
        if (ov > 0) hours7 += ov / 60;
      }
      if (hours7 > (+c.maxHours7Days || 60)) warnings.push(`${round2(hours7)}h in 7 days`);
      if (emp.status === 'trainee') warnings.push('Trainee (solo cleared)');
      if (emp.positionId !== slot.positionId) warnings.push('Cross-trained');
      // incremental OT cost
      const h = empHours(ivs, lvBy[emp.id] || [], per.start, per.end);
      const before = otCalc(c, h).otHours;
      const h2 = Object.assign({}, h, { fill: h.fill + (d0 <= per.end ? slotHours : 0) });
      const after = otCalc(c, h2).otHours;
      const otHours = after - before;
      const myFills = fillsBy[emp.id] || [];
      const otFyHours = myFills.reduce((s, f) => s + +f.hours, 0);
      const forced = myFills.filter((f) => f.type === 'mandatory').map((f) => f.date).sort();
      res.push({
        emp, eligible: !issues.length, issues, warnings, holdover, earlyIn, blockHours, hours7,
        otFyHours, lastForced: forced.length ? forced[forced.length - 1] : null, forcedCount: forced.length,
        otHours, cost: otHours * (+emp.hourlyRate || 0) * mult + (slotHours - otHours) * (+emp.hourlyRate || 0),
      });
    }
    const sen = (e) => parseDate(e.seniorityDate || e.hireDate || '2000-01-01');
    if (opts.order === 'mandatory') {
      // Force list: never/least-recently forced first, then least senior first.
      res.sort((a, b) => (b.eligible - a.eligible) || String(a.lastForced || '').localeCompare(String(b.lastForced || '')) || sen(b.emp) - sen(a.emp));
    } else {
      // Voluntary list: holdovers first, then fewest OT hours this FY, then most senior.
      res.sort((a, b) => (b.eligible - a.eligible) || ((b.holdover || b.earlyIn) - (a.holdover || a.earlyIn)) || a.otFyHours - b.otFyHours || sen(a.emp) - sen(b.emp));
    }
    return res;
  }

  /** How many additional open hours approving a request would create. */
  function requestImpact(state, exceptionId) {
    const e = state.exceptions.find((x) => x.id === exceptionId);
    if (!e) return null;
    const [d0, d1] = exceptionRange(e);
    const from = d0 - 1, to = d1 + 1;
    const withIt = openings(state, from, to, { overrideStatus: { [e.id]: 'approved' } }).slots;
    const without = openings(state, from, to, { overrideStatus: { [e.id]: 'denied' } }).slots;
    const sum = (arr) => arr.reduce((s, x) => s + x.hours, 0);
    const added = sum(withIt) - sum(without);
    const newSlots = withIt.filter((s) => s.causes.some((c) => c.exceptionId === e.id));
    const cost = newSlots.length ? added * avgRate(state, newSlots[0].positionId) * (+state.center.otMultiplier || 1.5) : 0;
    const wi = workIntervals(state, d0, d1, { overrideStatus: { [e.id]: 'approved' } });
    const leaveHours = wi.leave.filter((l) => l.exceptionId === e.id).reduce((s, l) => s + l.minutes / 60, 0);
    return { addedGapHours: Math.max(0, added), cost: Math.max(0, cost), leaveHours };
  }

  // ------------------------------------------------------------------ bids
  /** Create rotation lines; `teams` distinct start offsets spread across the cycle. */
  function generateLines(state, o) {
    const ix = index(state);
    const pat = ix.pat[o.patternId], tpl = ix.tpl[o.shiftTemplateId];
    const L = pat ? pat.cycle.length : 7;
    const count = Math.max(1, +o.count || 1);
    const teams = Math.max(1, Math.min(+o.teams || 1, count));
    const anchor = parseDate(o.anchorDate);
    const lines = [];
    const counters = {};
    for (let i = 0; i < count; i++) {
      const t = i % teams;
      const offset = Math.floor(t * L / teams);
      const letter = String.fromCharCode(65 + t);
      counters[t] = (counters[t] || 0) + 1;
      lines.push({
        id: uid('ln'), name: `${o.prefix || (tpl ? tpl.code : 'L')} ${letter}-${counters[t]}`,
        positionId: o.positionId, shiftTemplateId: o.shiftTemplateId, patternId: o.patternId,
        anchorDate: fmtDate(anchor + offset), effectiveFrom: o.effectiveFrom || o.anchorDate, effectiveTo: null, employeeId: null,
      });
    }
    return lines;
  }

  function bidOrder(state, bid) {
    const sen = (e) => parseDate(e.seniorityDate || e.hireDate || '2000-01-01');
    let list = state.employees.filter((e) => e.positionId === bid.positionId && e.status !== 'inactive');
    list.sort((a, b) => sen(a) - sen(b) || String(a.lastName).localeCompare(b.lastName));
    if (Array.isArray(bid.order) && bid.order.length) {
      const pos = {}; bid.order.forEach((id, i) => { pos[id] = i; });
      list.sort((a, b) => (pos[a.id] ?? 1e9) - (pos[b.id] ?? 1e9));
    }
    return list;
  }

  function currentBidder(state, bid) {
    const picks = bid.picks || {}, skipped = bid.skipped || [];
    return bidOrder(state, bid).find((e) => !picks[e.id] && !skipped.includes(e.id)) || null;
  }

  function applyBid(state, bid) {
    const eff = parseDate(bid.effectiveDate);
    state.lines = state.lines.filter((l) => !(l.positionId === bid.positionId && parseDate(l.effectiveFrom) >= eff));
    for (const l of state.lines) {
      if (l.positionId !== bid.positionId) continue;
      if (!l.effectiveTo || parseDate(l.effectiveTo) >= eff) l.effectiveTo = fmtDate(eff - 1);
    }
    const byLine = {};
    for (const [empId, lineId] of Object.entries(bid.picks || {})) byLine[lineId] = empId;
    for (const bl of bid.lines) {
      state.lines.push(Object.assign({}, bl, { id: uid('ln'), effectiveFrom: bid.effectiveDate, effectiveTo: null, employeeId: byLine[bl.id] || null }));
    }
    bid.status = 'applied';
    bid.appliedAt = new Date().toISOString();
  }

  /**
   * Coverage a set of lines would produce if every line were filled, with all
   * other positions' current lines unchanged and no leave.
   */
  function previewLines(state, positionId, lines, fromDay, days) {
    const synthEmps = lines.map((l, i) => ({ id: `__ln${i}`, firstName: '', lastName: l.name, positionId, status: 'active' }));
    const temp = Object.assign({}, state, {
      employees: state.employees.filter((e) => e.positionId !== positionId).concat(synthEmps),
      lines: state.lines.filter((l) => l.positionId !== positionId && l.employeeId)
        .concat(lines.map((l, i) => Object.assign({}, l, { employeeId: `__ln${i}`, effectiveFrom: fmtDate(Math.min(fromDay, parseDate(l.effectiveFrom || fmtDate(fromDay)))), effectiveTo: null }))),
      exceptions: [], fills: [],
    });
    return openings(temp, fromDay, fromDay + days - 1);
  }

  // ------------------------------------------------------------------ demo
  function demoState(today = todayNum()) {
    const rnd = mulberry32(9110);
    const s = emptyState();
    s.center.name = 'Demo County Emergency Communications';
    Object.assign(s.center, { annualOtBudget: 90000 });
    // Minimums are set per discipline.
    s.positions = [
      { id: 'pos_ct', name: 'Call-taker', authorized: 18, isConsole: true },
      { id: 'pos_law', name: 'Law dispatch', authorized: 13, isConsole: true },
      { id: 'pos_fire', name: 'Fire/EMS dispatch', authorized: 9, isConsole: true },
      { id: 'pos_sup', name: 'Shift Supervisor', authorized: 6, isConsole: false },
    ];
    const grid = (fn) => Array.from({ length: 7 }, (_, d) => Array.from({ length: 24 }, (_, h) => fn(d, h)));
    const weekendNight = (d, h) => (d === 5 || d === 6) && h >= 22;
    s.minimums = {
      pos_ct: grid((d, h) => (h >= 14 && h < 22) || weekendNight(d, h) ? 4 : (h >= 10 && h < 14) || h >= 22 ? 3 : 2),
      pos_law: grid(() => 2),
      pos_fire: grid((d, h) => (h >= 7 && h < 23 ? 2 : 1)),
      pos_sup: grid(() => 1),
    };

    const first = ['Ava', 'Ben', 'Carla', 'Derek', 'Elena', 'Frank', 'Gina', 'Hector', 'Ivy', 'Jamal', 'Kara', 'Liam', 'Maya', 'Nate', 'Olivia', 'Pete', 'Quinn', 'Rosa', 'Sam', 'Tara', 'Uri', 'Vera', 'Wes', 'Xena', 'Yusuf', 'Zoe', 'Grant', 'Holly', 'Iris', 'Jack', 'Leah', 'Miles', 'Nora', 'Omar', 'Paige', 'Reid', 'Sofia', 'Troy', 'Wade', 'Abby'];
    const last = ['Adams', 'Brooks', 'Carter', 'Dalton', 'Ellis', 'Foster', 'Garcia', 'Hayes', 'Irwin', 'Jensen', 'Keller', 'Lopez', 'Monroe', 'Nash', 'Owens', 'Price', 'Quincy', 'Reed', 'Shaw', 'Turner', 'Underwood', 'Vance', 'Walsh', 'Xiong', 'Young', 'Zimmer', 'Pruitt', 'Lambert', 'Bishop', 'Cole', 'Dunn', 'Fields', 'Greer', 'Hale', 'Ingram', 'Jordan', 'Kemp', 'Lyons', 'Mercer', 'Noble'];
    let n = 0;
    const mk = (positionId, extra = {}) => {
      const year = Math.min(2025, 1998 + Math.floor((n * 37) % 28));
      const sen = `${year}-${pad(1 + (n * 5) % 12)}-${pad(1 + (n * 7) % 27)}`;
      const base = positionId === 'pos_sup' ? 30 : positionId === 'pos_ct' ? 18.5 : 20;
      const e = Object.assign({
        id: uid('emp'), firstName: first[n % first.length], lastName: last[n % last.length], badge: String(1001 + n), positionId, status: 'active',
        hireDate: sen, seniorityDate: sen, hourlyRate: round2(base + Math.min(2026 - year, 20) * 0.55), soloCleared: true, qualifications: [],
        phone: `555-01${pad(n % 100)}`, notes: '',
      }, extra);
      n++;
      s.employees.push(e);
      return e;
    };

    const anchor = parseDate('2026-01-04');
    const line = (positionId, tplId, patId, offset, name, emp) => s.lines.push({
      id: uid('ln'), name, positionId, shiftTemplateId: tplId, patternId: patId,
      anchorDate: fmtDate(anchor + offset), effectiveFrom: '2026-01-04', effectiveTo: null, employeeId: emp ? emp.id : null,
    });
    const shiftCode = { t_d8: 'D', t_e8: 'E', t_m8: 'M', t_p10: 'P10' };
    // [position, prefix, template, pattern, offsets (staggered days off), qualifications]
    const plan = [
      ['pos_ct', 'CT', 't_d8', 'p_52', [0, 2, 4, 5], []],
      ['pos_ct', 'CT', 't_e8', 'p_52', [0, 1, 2, 4, 5], []],
      ['pos_ct', 'CT', 't_m8', 'p_52', [0, 2, 4], []],
      ['pos_ct', 'CT', 't_p10', 'p_410', [0, 2, 4], []],
      ['pos_law', 'LAW', 't_d8', 'p_52', [0, 2, 4, 5], ['pos_ct']],
      ['pos_law', 'LAW', 't_e8', 'p_52', [0, 2, 4, 5], ['pos_ct']],
      ['pos_law', 'LAW', 't_m8', 'p_52', [0, 2, 4], ['pos_ct']],
      ['pos_fire', 'FIRE', 't_d8', 'p_52', [0, 2, 4], ['pos_ct']],
      ['pos_fire', 'FIRE', 't_e8', 'p_52', [0, 2, 4], ['pos_ct']],
      ['pos_fire', 'FIRE', 't_m8', 'p_52', [0, 2], ['pos_ct']],
      ['pos_sup', 'SUP', 't_d8', 'p_52', [0, 2], ['pos_ct', 'pos_law', 'pos_fire']],
      ['pos_sup', 'SUP', 't_e8', 'p_52', [0, 2], ['pos_ct', 'pos_law', 'pos_fire']],
      ['pos_sup', 'SUP', 't_m8', 'p_52', [0], ['pos_ct', 'pos_law', 'pos_fire']],
    ];
    const byPos = { pos_ct: [], pos_law: [], pos_fire: [], pos_sup: [] };
    for (const [pos, pre, tpl, pat, offs, quals] of plan) {
      offs.forEach((off, k) => {
        const e = mk(pos, { qualifications: quals.slice() });
        byPos[pos].push(e);
        line(pos, tpl, pat, off, `${pre} ${shiftCode[tpl]}-${k + 1}`, e);
      });
    }
    const ct = byPos.pos_ct, law = byPos.pos_law, fire = byPos.pos_fire, sups = byPos.pos_sup;
    // Senior call-takers cross-trained on law; a couple of law dispatchers on fire.
    ct[4].qualifications.push('pos_law'); ct[9].qualifications.push('pos_law');
    law[2].qualifications.push('pos_fire'); law[7].qualifications.push('pos_fire');
    // Trainees: one call-taker still with a CTO (doesn't count), one law dispatcher solo-cleared.
    Object.assign(ct[1], { status: 'trainee', soloCleared: false, hireDate: '2026-09-08', seniorityDate: '2026-09-08', hourlyRate: 18.5 });
    Object.assign(law[5], { status: 'trainee', soloCleared: true, hireDate: '2026-03-16', seniorityDate: '2026-03-16', hourlyRate: 20 });
    // Vacant lines on the books (authorized but unfilled).
    line('pos_ct', 't_d8', 'p_52', 3, 'CT D-5', null);
    line('pos_sup', 't_m8', 'p_52', 2, 'SUP M-2', null);
    const tcs = ct.concat(law, fire);

    const ix = index(s);
    const workDays = (emp, from, to) => regularShifts(s, from, to, ix).filter((r) => r.employeeId === emp.id).map((r) => r.day);
    const nextWork = (emp, from) => workDays(emp, from, from + 30)[0];
    const ex = (emp, date, type, status, extra = {}) => {
      const e = Object.assign({ id: uid('ex'), employeeId: emp.id, date: fmtDate(date), endDate: null, start: null, hours: null, type, status, note: '', createdAt: new Date().toISOString() }, extra);
      s.exceptions.push(e);
      return e;
    };
    const fillFor = (exc, typeBias) => {
      const emp = ix.emp[exc.employeeId];
      const shifts = regularShifts(s, parseDate(exc.date), parseDate(exc.endDate || exc.date), ix).filter((r) => r.employeeId === emp.id);
      for (const r of shifts) {
        const slot = { positionId: emp.positionId, start: r.start, end: r.end };
        const order = rnd() < typeBias ? 'mandatory' : 'voluntary';
        const cands = fillCandidates(s, slot, { order }).filter((cd) => cd.eligible);
        if (!cands.length) continue;
        const pickC = cands[Math.floor(rnd() * Math.min(3, cands.length))];
        s.fills.push({
          id: uid('ot'), date: fmtDate(r.day), start: timeStr(r.start), hours: (r.end - r.start) / 60,
          positionId: emp.positionId, employeeId: pickC.emp.id, type: order === 'mandatory' ? 'mandatory' : (pickC.holdover ? 'holdover' : 'voluntary'),
          reason: exc.type, exceptionId: exc.id, status: 'scheduled', note: '', createdAt: new Date().toISOString(),
        });
      }
    };
    // History: ~140 days of call-outs and leave, mostly backfilled with OT.
    const fyStart = fiscalYear(s, today).start;
    const everyone = tcs.concat(sups).filter((e) => countable(e));
    for (let d = Math.min(fyStart, today - 140); d < today; d++) {
      if (rnd() < 0.7) {
        const working = everyone.filter((e) => workDays(e, d, d).length);
        const e = working[Math.floor(rnd() * working.length)];
        if (e) fillFor(ex(e, d, rnd() < 0.8 ? 'sick' : 'family', 'approved'), 0.2);
      }
      if (rnd() < 0.25) {
        const working = everyone.filter((e) => workDays(e, d, d).length);
        const e = working[Math.floor(rnd() * working.length)];
        if (e && !s.exceptions.some((x) => x.employeeId === e.id && x.date === fmtDate(d))) {
          const x = ex(e, d, rnd() < 0.85 ? 'vacation' : 'training', 'approved');
          if (rnd() < 0.7) fillFor(x, 0.05);
        }
      }
    }
    // Current and upcoming items.
    const dayWorkers = law.filter((e) => countable(e) && workDays(e, today, today).length);
    if (dayWorkers[0]) ex(dayWorkers[0], today, 'sick', 'approved', { note: 'Called out 0430' });
    const fm = ex(fire[1], today - 3, 'family', 'approved', { endDate: fmtDate(today + 10), note: 'FMLA — intermittent block' });
    for (const d of workDays(fire[1], today - 3, today - 1)) fillFor({ ...fm, date: fmtDate(d), endDate: null }, 0.3);
    const v1 = nextWork(ct[6], today + 2);
    if (v1 != null) ex(ct[6], v1, 'vacation', 'approved', { endDate: fmtDate(v1 + 4), note: 'Annual leave' });
    const t1 = nextWork(ct[12], today + 5);
    if (t1 != null) ex(ct[12], t1, 'training', 'approved', { start: '14:00', hours: 4, note: 'CTO refresher class' });
    const p1 = nextWork(law[3], today + 6);
    if (p1 != null) ex(law[3], p1, 'vacation', 'pending', { endDate: fmtDate(p1 + 1), note: 'Family trip' });
    const p2 = nextWork(ct[10], today + 9);
    if (p2 != null) ex(ct[10], p2, 'comp', 'pending');
    const p3 = nextWork(sups[1], today + 12);
    if (p3 != null) ex(sups[1], p3, 'vacation', 'pending');
    const v2 = nextWork(sups[2], today + 4);
    if (v2 != null) {
      const x = ex(sups[2], v2, 'vacation', 'approved');
      fillFor(x, 0);
    }
    s.bids = [];
    return s;
  }

  const api = {
    DAY, DOW, EXCEPTION_TYPES, FILL_TYPES, STATUSES,
    mod, pad, parseDate, fmtDate, dow, todayNum, nowAbs, parseTime, timeStr, mil, shortDate, uid, round2, groupBy,
    defaultCenter, emptyState, migrate, index, empName, countable, qualifiedFor,
    lineActiveOn, lineShiftOn, regularShifts, workIntervals, exceptionRange,
    requiredFor, coverage, openings, slotReason,
    periodOf, fiscalYear, empHours, otCalc, otReport, otForecast, avgRate, slotCost,
    staffingSummary, requiredWeeklyHours, patternWeeklyHours, patternBuiltInOT, actualLeavePerEmployee,
    fillCandidates, requestImpact,
    generateLines, bidOrder, currentBidder, applyBid, previewLines,
    demoState,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.PSAP = api;
})(typeof window !== 'undefined' ? window : globalThis);
