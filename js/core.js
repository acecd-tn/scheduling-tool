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
    // Shift trade: the partner works this shift at straight time. Under FLSA 7(p)(3) the
    // original employee is credited as if they worked it, and the partner's hours are excluded.
    { id: 'trade', label: 'Shift trade (partner working)', abbr: 'TR', worked: true, system: true },
    // A part-timer works part of a full-timer's shift so the full-timer stays at 40 hours
    // (cuts scheduled overtime). Not paid leave: the hours simply aren't worked.
    { id: 'otrelief', label: 'Part-timer covering (cuts OT)', abbr: 'PT', system: true, unpaid: true },
    // What other employees see in place of someone's leave reason (sick/FMLA are confidential).
    { id: 'leave', label: 'Off (leave)', abbr: 'L', system: true },
  ];
  const PLANNED_LEAVE = ['vacation', 'comp', 'holiday'];

  const FILL_TYPES = [
    { id: 'voluntary', label: 'Voluntary OT' },
    { id: 'mandatory', label: 'Mandatory (forced)' },
    { id: 'holdover', label: 'Holdover' },
    { id: 'earlyin', label: 'Early call-in' },
    { id: 'callback', label: 'Call-back' },
    { id: 'trade', label: 'Shift trade (straight time)' },
  ];
  const COLLECTIONS = ['positions', 'jobClasses', 'shiftTemplates', 'patterns', 'employees', 'lines', 'exceptions', 'fills', 'bids',
    'minimumOverrides', 'trades', 'postings', 'vacationBids', 'notifications', 'pins', 'assignments', 'scheduleImports', 'shiftMoves'];

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
      partTimeFirst: true,        // voluntary list: eligible part-timers (straight time) before full-time OT
      partTimeDefaultCap: 32,     // weekly hour cap for part-timers without their own (part-timers are never forced)
      partTimeOnLines: 'count',   // 'count' = part-timers' scheduled lines count toward minimums; 'extra' = they're on top
      levelIncludesPartTime: true,// staffing level adds part-time FTE
      levelNormalPct: 90,         // staffing level thresholds (% of authorized)
      levelShortPct: 75,
      // Per staffing level: relief margin (people above minimum per console-hour that's
      // acceptable) and daily vacation limit ('' = the job class's own limit).
      levelRules: { normal: { reliefMargin: 1, maxOffPerDay: '' }, short: { reliefMargin: 0, maxOffPerDay: '' }, critical: { reliefMargin: 0, maxOffPerDay: '' } },
      dayOffNoticeDays: 14,       // notice needed before changing someone's days off
      maxConsecutiveDays: 4,      // most days in a row anyone is scheduled (a 4-hour shift counts); +1 only as a flagged emergency
      lineMode: 'fixed',          // 'fixed' = each schedule slot keeps its own repeating pattern (e.g. a 2-week template); 'rotation' = 3 x 12 + one 4-hr, days off move one day later each week; 'weekly' = fixed 7-day patterns
      rotationPatternId: 'p_rot', // the rotation the line tools build
      fixHorizonWeeks: 4,         // how far ahead "Fix coverage" looks
      offerTraining: true,        // Fix coverage offers 4-hour shifts for training when coverage allows
      offerOtRelief: true,        // Fix coverage suggests part-timers to bring weeks over 40 hours back to 40
      levelSeen: {},              // last staffing level acknowledged per job class
      dayStartHour: '',           // scheduling day start hour (0-23); '' = earliest regular shift start
      shiftBoundaries: '',        // e.g. '0700,1900'; '' = worked out from the shifts people work
      coverageMode: 'assigned',   // 'assigned' = cross-trained staff are placed on consoles each hour; 'home' = count home discipline only
      minPresenceMinutes: 30,     // a person counts for an hour if on duty at least this long in it
      tradeRequiresApproval: true,
      forceOrderBasis: 'lastOT',  // mandatory list: 'lastOT' = longest since any OT worked; 'lastForced' = longest since last forced
      maxOffPerDay: {},           // planned leave (vacation/comp/holiday) limit per discipline per day; blank = none
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
      jobClasses: [],
      trades: [],
      postings: [],
      vacationBids: [],
      notifications: [],
      pins: [],
      assignments: [],      // day-by-day shifts from an imported schedule
      shiftMoves: [],       // approved day-off moves (work one day instead of another)
      scheduleImports: [],  // each import: who and which dates it covers
    };
  }

  function defaultTemplates() {
    return [
      { id: 't_d12', code: 'D12', name: 'Day 12', start: '07:00', hours: 12, color: '#3b82f6', shortTemplateId: 't_d4' },
      { id: 't_n12', code: 'N12', name: 'Night 12', start: '19:00', hours: 12, color: '#8b5cf6', shortTemplateId: 't_n4' },
      { id: 't_d4', code: 'D4', name: 'Day 4 (short)', start: '07:00', hours: 4, color: '#60a5fa' },
      { id: 't_n4', code: 'N4', name: 'Night 4 (short)', start: '19:00', hours: 4, color: '#a78bfa' },
      { id: 't_d8', code: 'D8', name: 'Days 8', start: '07:00', hours: 8, color: '#0ea5e9' },
      { id: 't_e8', code: 'E8', name: 'Evenings 8', start: '15:00', hours: 8, color: '#f59e0b' },
      { id: 't_m8', code: 'M8', name: 'Mids 8', start: '23:00', hours: 8, color: '#6366f1' },
      { id: 't_p8', code: 'P8', name: 'Power 8 (peak)', start: '14:00', hours: 8, color: '#10b981' },
      { id: 't_p10', code: 'P10', name: 'Power 10 (peak)', start: '12:00', hours: 10, color: '#14b8a6' },
      { id: 't_s4', code: 'S4', name: 'Short 4 (peak)', start: '10:00', hours: 4, color: '#64748b' },
    ];
  }

  /**
   * The default rotation's base week (W = 12-hour shift, S = 4-hour shift, O = off).
   * Each week the whole week moves one day later, so over 7 weeks everyone has every
   * combination of days off, weekends included. This one never puts anyone on more
   * than 3 days in a row, even across week boundaries.
   */
  const ROTATION_BASE = 'OWWOOWS';

  /** 49-day cycle from a 7-day base week: week k, day d = base[(d - k) mod 7]. */
  function rotationCycle(base = ROTATION_BASE) {
    const b = String(base).toUpperCase().replace(/[^WSO]/g, '');
    if (b.length !== 7) throw new Error('A rotation base week needs 7 days of W, S or O');
    const tok = { W: 1, S: 's', O: 0 };
    const out = [];
    for (let k = 0; k < 7; k++) for (let d = 0; d < 7; d++) out.push(tok[b[mod(d - k, 7)]]);
    return out;
  }

  /** Longest run of worked days in a cyclic token list. */
  function cycleMaxRun(cycle) {
    let best = 0, run = 0;
    const L = cycle.length;
    for (let i = 0; i < 2 * L; i++) { const t = cycle[i % L]; run = (!t || t === '0') ? 0 : run + 1; best = Math.max(best, run); }
    return Math.min(best, L);
  }

  /**
   * Default library: every pattern is exactly 40 hours in every work week, so none of
   * them builds in overtime for a non-exempt 7-day/40-hour work week.
   * Tokens: 1 = the line's own shift, 's' = the line's 4-hour shift, 0 = off,
   * template id = that shift.
   */
  function defaultPatterns() {
    const D12 = 't_d12', N12 = 't_n12', D8 = 't_d8', M8 = 't_m8';
    return [
      { id: 'p_rot', name: 'Rotation: 3 x 12 + one 4-hr, days off move 1 day later each week', cycle: rotationCycle(), rotation: true, base: ROTATION_BASE },
      { id: 'p_52', name: '5 x 8 (5 on / 2 off)', cycle: [1, 1, 1, 1, 1, 0, 0] },
      { id: 'p_410', name: '4 x 10 (4 on / 3 off)', cycle: [1, 1, 1, 1, 0, 0, 0] },
      { id: 'p_12d8', name: '2 x 12 + 2 x 8 — days (D12 D12 D8 D8)', cycle: [D12, D12, 0, D8, D8, 0, 0] },
      { id: 'p_12n8', name: '2 x 12 + 2 x 8 — nights (N12 N12 M8 M8)', cycle: [N12, N12, 0, 0, M8, M8, 0] },
      { id: 'p_3x12', name: '3 x 12 + 1 x 4, fixed days off', cycle: [1, 1, 1, 0, 's', 0, 0] },
      { id: 'p_pt2', name: 'Part-time: 2 days a week', cycle: [1, 1, 0, 0, 0, 0, 0] },
      { id: 'p_pt3', name: 'Part-time: 3 days a week', cycle: [1, 1, 1, 0, 0, 0, 0] },
    ];
  }

  /** Fill in anything missing so older saved data keeps working. */
  function migrate(s) {
    const base = emptyState();
    s = s || {};
    s.center = Object.assign(defaultCenter(), s.center || {});
    for (const k of ['positions', 'shiftTemplates', 'patterns']) if (!Array.isArray(s[k])) s[k] = base[k];
    for (const k of COLLECTIONS) if (!Array.isArray(s[k])) s[k] = base[k] || [];
    s.minimums = s.minimums || {};
    for (const p of s.positions) {
      if (!Array.isArray(s.minimums[p.id])) s.minimums[p.id] = Array.from({ length: 7 }, () => new Array(24).fill(0));
    }
    // One-time upgrades, recorded in the center settings (which the server saves).
    if ((+s.center.schemaVersion || 1) < 2) {
      if (+s.center.partTimeDefaultCap === 29) s.center.partTimeDefaultCap = 32; // 29 was only the shipped default
      delete s.center.partTimeMandatory;                                          // part-timers are never forced
      s.center.schemaVersion = 2;
    }
    // v3: authorized staffing moves from consoles (positions) to job classes. One class
    // per console to start, carrying over its authorized counts and daily leave limit.
    if ((+s.center.schemaVersion || 1) < 3) {
      if (!s.jobClasses.length) {
        for (const p of s.positions) {
          const lim = s.center.maxOffPerDay ? s.center.maxOffPerDay[p.id] : null;
          s.jobClasses.push({
            id: 'jc_' + p.id, name: p.name, positionIds: [p.id],
            authorized: +p.authorized || 0, authorizedPartTime: +p.authorizedPartTime || 0,
            maxOffPerDay: lim == null || lim === '' ? null : +lim,
          });
        }
      }
      const posIds = new Set(s.positions.map((p) => p.id));
      const toClass = (pid) => (posIds.has(pid) ? 'jc_' + pid : pid);
      for (const vb of s.vacationBids) {
        if (vb.positionIds && !vb.jobClassIds) vb.jobClassIds = [...new Set(vb.positionIds.map(toClass))];
        if (vb.caps) { const c = {}; for (const [k, v] of Object.entries(vb.caps)) c[toClass(k)] = v; vb.caps = c; }
        delete vb.positionIds;
      }
      s.center.schemaVersion = 3;
    }
    // v4: the job class is the position. Employees and lines get an explicit job class
    // (from their console's class); the console becomes an optional preference, and a
    // person's preferred console is always among their certifications. Lines lose their
    // console so nobody is tied to one by their line.
    if ((+s.center.schemaVersion || 1) < 4) {
      const covered = new Set(s.jobClasses.flatMap((c) => c.positionIds || []));
      for (const p of s.positions) {
        if (covered.has(p.id)) continue;
        let id = 'jc_' + p.id;
        while (s.jobClasses.some((c) => c.id === id)) id += '_';
        s.jobClasses.push({ id, name: p.name, positionIds: [p.id], authorized: +p.authorized || 0, authorizedPartTime: +p.authorizedPartTime || 0, maxOffPerDay: null });
      }
      const classOfPos = (pid) => (s.jobClasses.find((c) => (c.positionIds || []).includes(pid)) || {}).id || null;
      for (const e of s.employees) {
        if (!e.jobClassId) e.jobClassId = classOfPos(e.positionId);
        e.qualifications = [...new Set([e.positionId, ...(e.qualifications || [])].filter(Boolean))];
      }
      const empById = {}; for (const e of s.employees) empById[e.id] = e;
      for (const l of s.lines) {
        if (!l.jobClassId) l.jobClassId = classOfPos(l.positionId) || (empById[l.employeeId] || {}).jobClassId || null;
        l.positionId = null;
      }
      for (const b of s.bids) {
        if (!b.jobClassId) b.jobClassId = classOfPos(b.positionId);
        for (const bl of b.lines || []) { if (!bl.jobClassId) bl.jobClassId = b.jobClassId; bl.positionId = null; }
      }
      s.center.schemaVersion = 4;
    }
    // v5: rotation rules. Every 12-hour shift gets a 4-hour shift starting when it does
    // (D12 0700 -> D4 0700-1100), and the 7-week rotation joins the pattern library.
    if ((+s.center.schemaVersion || 1) < 5) {
      for (const t of s.shiftTemplates.slice()) {
        if (+t.hours !== 12 || (t.shortTemplateId && s.shiftTemplates.some((x) => x.id === t.shortTemplateId))) continue;
        let short = s.shiftTemplates.find((x) => +x.hours === 4 && x.start === t.start);
        if (!short) {
          const code = /12/.test(t.code || '') ? t.code.replace('12', '4') : (t.code || 'S') + '-4';
          let id = t.id + '_4';
          while (s.shiftTemplates.some((x) => x.id === id)) id += '_';
          short = { id, code, name: `${t.name || t.code} (4-hour)`, start: t.start, hours: 4, color: t.color || '#64748b' };
          s.shiftTemplates.push(short);
        }
        t.shortTemplateId = short.id;
      }
      if (!s.patterns.some((p) => p.id === 'p_rot')) s.patterns.unshift(defaultPatterns()[0]);
      s.center.schemaVersion = 5;
    }
    // v6: a fixed schedule template is the default. Centers already running the 7-week
    // rotation keep it.
    if ((+s.center.schemaVersion || 1) < 6) {
      const rot = new Set(s.patterns.filter((p) => p.rotation).map((p) => p.id));
      const onRotation = s.lines.some((l) => l.employeeId && rot.has(l.patternId) && !l.effectiveTo);
      if (!s.center.lineMode || s.center.lineMode === 'rotation') s.center.lineMode = onRotation ? 'rotation' : 'fixed';
      s.center.schemaVersion = 6;
    }
    s.version = 2;
    return s;
  }

  function index(state) {
    const by = (arr) => { const o = {}; for (const x of arr || []) o[x.id] = x; return o; };
    return {
      emp: by(state.employees), tpl: by(state.shiftTemplates), pat: by(state.patterns),
      pos: by(state.positions), line: by(state.lines), excType: by(EXCEPTION_TYPES), jc: by(state.jobClasses),
    };
  }

  /**
   * Job classes are the job (e.g. Telecommunicator): authorized positions, vacancies,
   * leave limits, lines and bid lists. Each employee and each line has a job class.
   * Consoles (state.positions: Law, Fire/EMS...) are only where people sit each hour,
   * assigned by certification and fill priority. A class's positionIds are the consoles
   * it staffs (used for planning and bid previews). A console in no class acts as its
   * own class.
   *
   * Field names kept for compatibility: employee.positionId / line.positionId mean the
   * optional *preferred console* (only breaks ties in placement); employee.qualifications
   * are the consoles they are certified on.
   */
  function jobClasses(state) {
    const posIds = new Set(state.positions.map((p) => p.id));
    const seen = new Set();
    const out = [];
    for (const c of state.jobClasses || []) {
      const pids = (c.positionIds || []).filter((id) => posIds.has(id) && !seen.has(id));
      pids.forEach((id) => seen.add(id));
      out.push(Object.assign({}, c, { positionIds: pids }));
    }
    for (const p of state.positions) {
      if (seen.has(p.id)) continue;
      const lim = state.center.maxOffPerDay ? state.center.maxOffPerDay[p.id] : null;
      out.push({ id: 'pos:' + p.id, name: p.name, positionIds: [p.id], authorized: +p.authorized || 0, authorizedPartTime: +p.authorizedPartTime || 0, maxOffPerDay: lim == null || lim === '' ? null : +lim, implicit: true });
    }
    return out;
  }
  function jobClassOf(state, positionId) {
    return jobClasses(state).find((c) => c.positionIds.includes(positionId)) || null;
  }
  function jobClassById(state, id) { return jobClasses(state).find((c) => c.id === id) || null; }
  /** An employee's job class (explicit; falls back to their preferred console's class for old data). */
  function empClass(state, emp) {
    if (!emp) return null;
    return (emp.jobClassId && jobClassById(state, emp.jobClassId)) || (emp.positionId ? jobClassOf(state, emp.positionId) : null);
  }
  function lineClass(state, line) {
    if (!line) return null;
    if (line.jobClassId) { const c = jobClassById(state, line.jobClassId); if (c) return c; }
    if (line.positionId) { const c = jobClassOf(state, line.positionId); if (c) return c; }
    return line.employeeId ? empClass(state, state.employees.find((e) => e.id === line.employeeId)) : null;
  }
  function bidClass(state, bid) {
    if (!bid) return null;
    return (bid.jobClassId && jobClassById(state, bid.jobClassId)) || (bid.positionId ? jobClassOf(state, bid.positionId) : null);
  }
  function classMembers(state, jc, includeInactive) {
    if (!jc) return [];
    const all = jobClasses(state);
    const byId = {}; for (const c of all) byId[c.id] = c;
    return state.employees.filter((e) => {
      if (!includeInactive && e.status === 'inactive') return false;
      const c = (e.jobClassId && byId[e.jobClassId]) || (e.positionId ? all.find((x) => x.positionIds.includes(e.positionId)) : null);
      return !!c && c.id === jc.id;
    });
  }
  /** Consoles a class staffs; if none are linked, the consoles its members are certified on. */
  function classConsoles(state, jc) {
    if (!jc) return [];
    if (jc.positionIds && jc.positionIds.length) return jc.positionIds.slice();
    const set = new Set();
    for (const e of classMembers(state, jc)) for (const q of certifications(e)) set.add(q);
    return state.positions.map((p) => p.id).filter((id) => set.has(id));
  }

  const isPartTime = (e) => !!e && e.employmentType === 'part';
  function partTimeCap(state, e) {
    const v = e && e.maxWeeklyHours !== '' && e.maxWeeklyHours != null ? +e.maxWeeklyHours : +state.center.partTimeDefaultCap;
    return v > 0 ? v : 32;
  }
  /** The 7-day work week containing a day: the OT period when it is 7 days, else Sunday-Saturday. */
  function workWeek(state, day) {
    if ((+state.center.otPeriodDays || 7) === 7) return periodOf(state, day);
    const start = day - dow(day);
    return { start, end: start + 6 };
  }

  function empName(e) { return e ? `${e.lastName}, ${e.firstName}` : '—'; }
  function countable(emp) { return !!emp && (emp.status === 'active' || (emp.status === 'trainee' && !!emp.soloCleared)); }
  /** Consoles a person is certified on (their preferred console is always one of them). */
  function certifications(emp) { return emp ? [...new Set([emp.positionId, ...(emp.qualifications || [])].filter(Boolean))] : []; }
  function qualifiedFor(emp, positionId) { return !!emp && certifications(emp).includes(positionId); }

  // -------------------------------------------------------------- schedule
  function lineActiveOn(line, day) {
    if (day < parseDate(line.effectiveFrom)) return false;
    if (line.effectiveTo && day > parseDate(line.effectiveTo)) return false;
    return true;
  }

  const isShortTok = (t) => t === 's' || t === 'S';

  /**
   * A line's 4-hour shift: the line's own choice, else its job class's choice for that
   * shift (e.g. peak hours), else the 4-hour shift paired with the 12 (same start).
   */
  function shortTemplateOf(line, ix, mainId) {
    const tpl = ix.tpl;
    if (line && line.shortTemplateId && tpl[line.shortTemplateId]) return tpl[line.shortTemplateId];
    const main = tpl[mainId || (line && line.shiftTemplateId)];
    const jc = line && ix.jc ? ix.jc[line.jobClassId] : null;
    const pick = jc && jc.shortShift && main ? jc.shortShift[main.id] : null;
    if (pick && tpl[pick]) return tpl[pick];
    if (main && main.shortTemplateId && tpl[main.shortTemplateId]) return tpl[main.shortTemplateId];
    if (main) { const same = Object.values(tpl).find((t) => +t.hours === 4 && t.start === main.start); if (same) return same; }
    return Object.values(tpl).find((t) => +t.hours === 4) || null;
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
    if (isShortTok(tok)) return shortTemplateOf(line, ix);
    return ix.tpl[tok] || null;
  }

  /** Length of the run of consecutive worked days through `day` (0 if not worked). */
  function runThrough(days, day) {
    if (!days.has(day)) return 0;
    let a = day, b = day;
    while (days.has(a - 1)) a--;
    while (days.has(b + 1)) b++;
    return b - a + 1;
  }

  /** Days someone is scheduled (lines, moves, imports, extra shifts), net of full-day leave. */
  function workedDays(state, employeeId, fromDay, toDay, ix = index(state)) {
    const wi = workIntervals(state, fromDay, toDay, { ix });
    const set = new Set();
    for (const iv of wi.intervals) if (iv.employeeId === employeeId && iv.end > iv.start && iv.day >= fromDay && iv.day <= toDay) set.add(iv.day);
    return set;
  }

  /** Per employee, the date ranges an imported schedule covers (where it replaces their lines). */
  function importWindows(state) {
    const win = {};
    for (const im of state.scheduleImports || []) {
      const a = parseDate(im.from), b = parseDate(im.to);
      for (const id of im.employeeIds || []) (win[id] ||= []).push([a, b]);
    }
    return win;
  }

  /**
   * Scheduled (pre-exception) shifts: from lines, except where an imported schedule
   * covers the person and date, in which case the imported day's shift is used.
   */
  function regularShifts(state, fromDay, toDay, ix = index(state)) {
    const out = [];
    const win = importWindows(state);
    const imported = (empId, d) => { const w = win[empId]; return !!w && w.some(([a, b]) => d >= a && d <= b); };
    // Approved day-off moves: the person is off on offDate and works workDate instead.
    const movedOff = new Set();
    const moves = (state.shiftMoves || []).filter((m) => m.status === 'approved');
    for (const m of moves) movedOff.add(m.employeeId + '|' + parseDate(m.offDate));
    for (const line of state.lines) {
      if (!line.employeeId) continue;
      const emp = ix.emp[line.employeeId];
      if (!emp || emp.status === 'inactive') continue;
      const a = Math.max(fromDay, parseDate(line.effectiveFrom));
      const b = Math.min(toDay, line.effectiveTo ? parseDate(line.effectiveTo) : Infinity);
      for (let d = a; d <= b; d++) {
        if (win[emp.id] && imported(emp.id, d)) continue;
        if (movedOff.has(emp.id + '|' + d)) continue;
        const tpl = lineShiftOn(line, d, ix);
        if (!tpl) continue;
        const start = d * DAY + parseTime(tpl.start);
        out.push({
          // positionId here is only a preference for placement: line's, else the person's.
          employeeId: emp.id, positionId: line.positionId || emp.positionId || certifications(emp)[0] || null, day: d, start,
          end: start + Math.round(tpl.hours * 60), templateId: tpl.id, lineId: line.id, kind: 'regular',
        });
      }
    }
    for (const as of state.assignments || []) {
      const d = parseDate(as.date);
      if (d < fromDay || d > toDay) continue;
      const emp = ix.emp[as.employeeId], tpl = ix.tpl[as.templateId];
      if (!emp || emp.status === 'inactive' || !tpl) continue;
      if (movedOff.has(emp.id + '|' + d)) continue;
      const start = d * DAY + parseTime(tpl.start);
      out.push({
        employeeId: emp.id, positionId: emp.positionId || certifications(emp)[0] || null, day: d, start,
        end: start + Math.round(tpl.hours * 60), templateId: tpl.id, lineId: null, assignmentId: as.id, importId: as.importId || null, kind: 'regular',
      });
    }
    for (const m of moves) {
      const d = parseDate(m.workDate);
      if (d < fromDay || d > toDay) continue;
      const emp = ix.emp[m.employeeId], tpl = ix.tpl[m.templateId];
      if (!emp || emp.status === 'inactive' || !tpl) continue;
      const start = d * DAY + parseTime(tpl.start);
      out.push({
        employeeId: emp.id, positionId: emp.positionId || certifications(emp)[0] || null, day: d, start,
        end: start + Math.round(tpl.hours * 60), templateId: tpl.id, lineId: null, moveId: m.id, emergency: !!m.emergency, kind: 'regular',
      });
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

  /** Positions in fill-priority order (lower `priority` first, then list order). */
  function positionOrder(state) {
    return state.positions.map((p, i) => ({ p, k: p.priority == null || p.priority === '' ? 100 + i : +p.priority, i }))
      .sort((a, b) => a.k - b.k || a.i - b.i).map((x) => x.p);
  }

  /**
   * Place the people on duty in one hour onto console seats.
   * Seats are filled in priority order with augmenting paths (Kuhn's algorithm),
   * so a higher-priority seat is never given up to fill a lower one. People left
   * over sit on their home discipline.
   * people: [{ id, home, quals: Set }]; req: { positionId: count }
   */
  function assignHour(people, req, order) {
    const seats = [];
    for (const p of order) for (let k = 0; k < (req[p.id] || 0); k++) seats.push(p.id);
    const owner = new Array(people.length).fill(-1);
    const cands = seats.map((pid) => people.map((x, i) => i).filter((i) => people[i].quals.has(pid))
      .sort((a, b) => (people[b].home === pid) - (people[a].home === pid) || people[a].quals.size - people[b].quals.size));
    const dfs = (si, seen) => {
      for (const pi of cands[si]) {
        if (seen[pi]) continue;
        seen[pi] = 1;
        if (owner[pi] === -1 || dfs(owner[pi], seen)) { owner[pi] = si; return true; }
      }
      return false;
    };
    for (let si = 0; si < seats.length; si++) dfs(si, new Array(people.length).fill(0));
    const where = {}, counts = {};
    people.forEach((x, i) => {
      const pid = owner[i] >= 0 ? seats[owner[i]] : (x.quals.has(x.home) ? x.home : [...x.quals][0]);
      if (!pid) return;
      where[x.id] = pid;
      counts[pid] = (counts[pid] || 0) + 1;
    });
    return { where, counts };
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
    const mode = state.center.coverageMode || 'assigned';
    // Part-timers' scheduled lines can be set as extra (on top of minimums); shifts they
    // pick up (OT/fills) always count.
    const extraPT = (iv) => state.center.partTimeOnLines === 'extra' && iv.kind === 'regular' && isPartTime(ix.emp[iv.employeeId]);
    if (mode === 'home') {
      for (const iv of wi.intervals) {
        if (!countable(ix.emp[iv.employeeId]) || extraPT(iv)) continue;
        const arr = staffed[iv.positionId];
        if (!arr) continue;
        const h0 = Math.max(0, Math.floor((iv.start - base) / 60));
        const h1 = Math.min(n, Math.ceil((iv.end - base) / 60));
        for (let h = h0; h < h1; h++) {
          const ov = Math.min(iv.end, base + (h + 1) * 60) - Math.max(iv.start, base + h * 60);
          if (ov > 0) arr[h] += ov / 60;
        }
      }
      return { fromDay, toDay, base, n, staffed, required, wi, assign: null };
    }
    // Console-assignment mode.
    const minPres = Math.max(1, +state.center.minPresenceMinutes || 30);
    const posIds = new Set(state.positions.map((p) => p.id));
    // Pins apply to a person's shift(s) that start within a scheduling day (e.g. 0700-0700).
    const pins = {};
    for (const pn of state.pins || []) pins[pn.employeeId + '|' + parseDate(pn.date)] = pn.positionId;
    const dayStartMin = (state.pins || []).length ? schedulingDayStart(state, fromDay) : 0;
    const schedDay = (abs) => Math.floor((abs - dayStartMin) / DAY);
    const present = Array.from({ length: n }, () => new Map());
    for (const iv of wi.intervals) {
      const emp = ix.emp[iv.employeeId];
      if (!countable(emp) || extraPT(iv)) continue;
      const h0 = Math.max(0, Math.floor((iv.start - base) / 60));
      const h1 = Math.min(n, Math.ceil((iv.end - base) / 60));
      for (let h = h0; h < h1; h++) {
        const ov = Math.min(iv.end, base + (h + 1) * 60) - Math.max(iv.start, base + h * 60);
        if (ov <= 0) continue;
        let x = present[h].get(emp.id);
        if (!x) {
          x = { id: emp.id, home: iv.positionId, quals: new Set(certifications(emp).filter((q) => posIds.has(q))), mins: 0, day: iv.day };
          present[h].set(emp.id, x);
        }
        x.mins += ov;
        // An OT assignment to a console lets them sit it; a trade doesn't grant a console.
        if (iv.kind === 'ot' && iv.fillType !== 'trade' && posIds.has(iv.positionId)) { x.quals.add(iv.positionId); x.otPos = iv.positionId; }
        const pin = pins[emp.id + '|' + schedDay(iv.start)];
        if (pin && posIds.has(pin)) x.pin = pin;
      }
    }
    const order = positionOrder(state);
    const assign = opts.keepAssign ? new Array(n) : null;
    for (let h = 0; h < n; h++) {
      const people = [...present[h].values()].filter((x) => x.mins >= Math.min(minPres, 60));
      for (const x of people) { if (x.pin) x.quals = new Set([x.pin]); else if (x.otPos && !x.quals.has(x.home)) x.quals = new Set([x.otPos]); }
      if (!people.length) continue;
      const req = {};
      for (const p of state.positions) req[p.id] = required[p.id][h];
      const r = assignHour(people, req, order);
      for (const [pid, c] of Object.entries(r.counts)) if (staffed[pid]) staffed[pid][h] = c;
      if (assign) assign[h] = r.where;
    }
    return { fromDay, toDay, base, n, staffed, required, wi, assign };
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
            if (l.start >= end || l.end <= start || seen.has(l.exceptionId) || l.type === 'trade') continue;
            const le = ix.emp[l.employeeId];
            if (l.positionId !== p.id && !(le && qualifiedFor(le, p.id))) continue;
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
      if (iv.kind === 'ot' && iv.fillType === 'trade') continue; // FLSA 7(p)(3): substitute's trade hours excluded
      if (iv.kind === 'ot') { h.fill += hrs; h.fillByReason[iv.reason || 'other'] = (h.fillByReason[iv.reason || 'other'] || 0) + hrs; }
      else h.regular += hrs;
    }
    for (const l of leaves) {
      if (l.day < pStart || l.day > pEnd || l.day > cutoff) continue;
      if (l.type === 'otrelief') continue; // not worked and not paid leave
      if (l.worked) h.workedLeave += l.minutes / 60; else h.leave += l.minutes / 60;
    }
    return h;
  }

  /**
   * Apply the center's OT rules to an employee's period hours. Part-timers work
   * extra shifts at straight time; only hours over the legal threshold (FLSA) are OT.
   */
  function otCalc(center, h, emp) {
    let worked = h.regular + h.fill + h.workedLeave;
    if (center.leaveCountsTowardOT) worked += h.leave;
    const excess = Math.max(0, worked - (+center.otThresholdHours || 40));
    const otHours = center.extraShiftsAlwaysOT && !isPartTime(emp) ? Math.max(excess, h.fill) : excess;
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
    const emptyPT = () => ({ hours: 0, cost: 0, avoided: 0 });
    if (!periods.length) return { periods, totals: { cost: 0, hours: 0, byReason: {}, byEmp: {}, partTime: emptyPT() } };
    const wi = opts.wi || workIntervals(state, periods[0].start, periods[periods.length - 1].end);
    const ivBy = groupBy(wi.intervals, 'employeeId'), lvBy = groupBy(wi.leave, 'employeeId');
    const totals = { cost: 0, hours: 0, byReason: {}, byEmp: {}, partTime: emptyPT() };
    const mult = +c.otMultiplier || 1.5;
    // What the same hours would have cost as full-time overtime.
    const ftRates = state.employees.filter((e) => e.status !== 'inactive' && !isPartTime(e) && +e.hourlyRate > 0).map((e) => +e.hourlyRate);
    const ftRate = ftRates.length ? ftRates.reduce((a, b) => a + b, 0) / ftRates.length : 0;
    for (const p of periods) p.partTime = emptyPT();
    for (const emp of state.employees) {
      const ivs = ivBy[emp.id] || [], lvs = lvBy[emp.id] || [];
      if (!ivs.length) continue;
      const rate = +emp.hourlyRate || 0;
      const pt = isPartTime(emp);
      for (const p of periods) {
        const h = empHours(ivs, lvs, p.start, p.end, opts.cutoff);
        const r = otCalc(c, h, emp);
        if (pt && h.fill > 0) {
          const straight = h.fill - r.fillOT;
          const x = { hours: straight, cost: straight * rate, avoided: Math.max(0, straight * (ftRate * mult - rate)) };
          for (const o of [p.partTime, totals.partTime]) { o.hours += x.hours; o.cost += x.cost; o.avoided += x.avoided; }
        }
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
    const list = state.employees.filter((e) => e.status !== 'inactive' && (!positionId || qualifiedFor(e, positionId)) && +e.hourlyRate > 0);
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
  /** Authorized vs. actual staffing, by job class. */
  function staffingSummary(state) {
    return jobClasses(state).filter((jc) => !jc.implicit || classMembers(state, jc).length || +jc.authorized).map((jc) => {
      const emps = classMembers(state, jc);
      const active = emps.filter((e) => e.status === 'active').length;
      const traineeSolo = emps.filter((e) => e.status === 'trainee' && e.soloCleared).length;
      const traineeNot = emps.filter((e) => e.status === 'trainee' && !e.soloCleared).length;
      const onLeave = emps.filter((e) => e.status === 'leave').length;
      const authorized = +jc.authorized || 0;
      // Authorized strength is full-time positions; part-time positions are their own count.
      const full = emps.filter((e) => !isPartTime(e));
      const part = emps.filter((e) => isPartTime(e));
      const partFTE = part.reduce((s2, e) => s2 + partTimeCap(state, e) / 40, 0);
      const countableFull = full.filter(countable).length;
      const countablePartFTE = part.filter(countable).reduce((s2, e) => s2 + partTimeCap(state, e) / 40, 0);
      const authorizedPart = +jc.authorizedPartTime || 0;
      const rates = emps.filter((e) => +e.hourlyRate > 0).map((e) => +e.hourlyRate);
      return {
        jobClass: jc, position: { id: jc.id, name: jc.name }, positionIds: classConsoles(state, jc),
        authorized, current: emps.length, fullTime: full.length, partTime: part.length, partFTE,
        authorizedPart, partVacancies: Math.max(0, authorizedPart - part.length),
        active, traineeSolo, traineeNot, onLeave,
        countable: active + traineeSolo, countableFTE: countableFull + countablePartFTE,
        vacancies: Math.max(0, authorized - full.length),
        pct: authorized ? full.length / authorized : 0,
        avgRate: rates.length ? rates.reduce((x, y) => x + y, 0) / rates.length : 0,
        minRate: rates.length ? Math.min(...rates) : 0,
        consoles: classConsoles(state, jc),
        requiredWeeklyHours: classConsoles(state, jc).reduce((t, pid) => t + requiredWeeklyHours(state, pid), 0),
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
      const tpl = (tok === 1 || tok === '1') ? ix.tpl[templateId] : isShortTok(tok) ? shortTemplateOf(null, ix, templateId) : ix.tpl[tok];
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
      if (l.day < today - 364 || l.day > today || l.type === 'trade') continue;
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
    const wk = workWeek(state, d0);
    const wi = workIntervals(state, Math.min(d0 - 8, per.start, wk.start), Math.max(d0 + 2, per.end, wk.end), { ix });
    const ivBy = groupBy(wi.intervals, 'employeeId'), lvBy = groupBy(wi.leave, 'employeeId');
    const fy = fiscalYear(state, d0);
    const fyFills = state.fills.filter((f) => f.status !== 'cancelled' && f.type !== 'trade' && parseDate(f.date) >= fy.start && parseDate(f.date) <= fy.end);
    const fillsBy = groupBy(fyFills, 'employeeId');
    // Most recent OT each person worked before this slot (any year; trades don't count).
    const lastOT = {};
    for (const f of state.fills) {
      if (f.status === 'cancelled' || f.type === 'trade') continue;
      const at = parseDate(f.date) * DAY + parseTime(f.start);
      if (at < slot.start && (lastOT[f.employeeId] == null || at > lastOT[f.employeeId])) lastOT[f.employeeId] = at;
    }
    const mult = +c.otMultiplier || 1.5;
    const slotHours = (slot.end - slot.start) / 60;
    const res = [];
    for (const emp of state.employees) {
      if (!countable(emp)) continue;
      if (opts.jobClassId ? (empClass(state, emp) || {}).id !== opts.jobClassId : !qualifiedFor(emp, slot.positionId)) continue;
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
      const maxRun = +c.maxConsecutiveDays || 0;
      if (maxRun) {
        const days = new Set(ivs.filter((iv) => iv.end > iv.start).map((iv) => iv.day));
        days.add(d0);
        const run = runThrough(days, d0);
        if (run > maxRun) warnings.push(`${run} days in a row (limit ${maxRun})`);
      }
      if (emp.status === 'trainee') warnings.push('Trainee (solo cleared)');
      const partTime = isPartTime(emp);
      let weekHours = null, cap = null;
      if (partTime) {
        cap = partTimeCap(state, emp);
        weekHours = d0 >= wk.start && d0 <= wk.end ? slotHours : 0;
        for (const iv of ivs) if (iv.day >= wk.start && iv.day <= wk.end) weekHours += (iv.end - iv.start) / 60;
        if (weekHours > cap + 1e-6) issues.push(`Part-time cap: ${round2(weekHours)} of ${cap} h this week`);
        if (opts.order === 'mandatory') issues.push('Part-time: never forced');
      }
      // incremental OT cost
      const h = empHours(ivs, lvBy[emp.id] || [], per.start, per.end);
      const before = otCalc(c, h, emp).otHours;
      const h2 = Object.assign({}, h, { fill: h.fill + (d0 <= per.end ? slotHours : 0) });
      const after = otCalc(c, h2, emp).otHours;
      const otHours = after - before;
      const myFills = fillsBy[emp.id] || [];
      const otFyHours = myFills.reduce((s, f) => s + +f.hours, 0);
      const forced = myFills.filter((f) => f.type === 'mandatory').map((f) => f.date).sort();
      res.push({
        emp, eligible: !issues.length, issues, warnings, holdover, earlyIn, blockHours, hours7, partTime, weekHours, cap,
        otFyHours, lastForced: forced.length ? forced[forced.length - 1] : null, forcedCount: forced.length,
        lastOTAt: lastOT[emp.id] ?? null, lastOT: lastOT[emp.id] != null ? fmtDate(Math.floor(lastOT[emp.id] / DAY)) : null,
        otHours, cost: otHours * (+emp.hourlyRate || 0) * mult + (slotHours - otHours) * (+emp.hourlyRate || 0),
      });
    }
    const sen = (e) => parseDate(e.seniorityDate || e.hireDate || '2000-01-01');
    if (opts.order === 'mandatory') {
      // Force list: whoever has gone longest without OT (or without being forced) first, then least senior.
      const key = c.forceOrderBasis === 'lastForced' ? (x) => (x.lastForced ? parseDate(x.lastForced) * DAY : -Infinity) : (x) => (x.lastOTAt ?? -Infinity);
      res.sort((a, b) => (b.eligible - a.eligible) || key(a) - key(b) || sen(b.emp) - sen(a.emp));
    } else {
      // Voluntary list: part-timers at straight time first (if set), then holdovers,
      // then fewest OT hours this FY, then most senior.
      const ptFirst = c.partTimeFirst !== false;
      res.sort((a, b) => (b.eligible - a.eligible) || (ptFirst ? (b.partTime - a.partTime) : 0) || ((b.holdover || b.earlyIn) - (a.holdover || a.earlyIn)) || a.otFyHours - b.otFyHours || sen(a.emp) - sen(b.emp));
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
    // A rotation starts on a work-week boundary and staggers people a whole week apart
    // (7 groups over a 7-week cycle), so every work week stays at 40 hours.
    const rot = !!(pat && pat.rotation && L % 7 === 0);
    const anchor = rot ? workWeek(state, parseDate(o.anchorDate)).start : parseDate(o.anchorDate);
    const lines = [];
    const counters = {};
    for (let i = 0; i < count; i++) {
      const t = i % teams;
      const offset = rot ? 7 * Math.floor(t * (L / 7) / teams) : Math.floor(t * L / teams);
      const letter = String.fromCharCode(65 + t);
      counters[t] = (counters[t] || 0) + 1;
      lines.push({
        id: uid('ln'), name: `${o.prefix || (tpl ? tpl.code : 'L')} ${letter}-${counters[t]}`,
        jobClassId: o.jobClassId || null, positionId: o.positionId || null, shiftTemplateId: o.shiftTemplateId, patternId: o.patternId,
        anchorDate: fmtDate(anchor + offset), effectiveFrom: o.effectiveFrom || (rot ? fmtDate(anchor) : o.anchorDate), effectiveTo: null, employeeId: null,
      });
    }
    return lines;
  }

  function bidOrder(state, bid) {
    const sen = (e) => parseDate(e.seniorityDate || e.hireDate || '2000-01-01');
    // Everyone in the job class bids together (e.g. law and fire/EMS dispatchers).
    let list = classMembers(state, bidClass(state, bid));
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
    const jc = bidClass(state, bid);
    const inClass = (l) => !!jc && (lineClass(state, l) || {}).id === jc.id;
    state.lines = state.lines.filter((l) => !(inClass(l) && parseDate(l.effectiveFrom) >= eff));
    for (const l of state.lines) {
      if (!inClass(l)) continue;
      if (!l.effectiveTo || parseDate(l.effectiveTo) >= eff) l.effectiveTo = fmtDate(eff - 1);
    }
    const byLine = {};
    for (const [empId, lineId] of Object.entries(bid.picks || {})) byLine[lineId] = empId;
    for (const bl of bid.lines) {
      state.lines.push(Object.assign({}, bl, { id: uid('ln'), jobClassId: jc ? jc.id : bl.jobClassId, effectiveFrom: bid.effectiveDate, effectiveTo: null, employeeId: byLine[bl.id] || null }));
    }
    bid.status = 'applied';
    bid.appliedAt = new Date().toISOString();
  }

  /**
   * Coverage a set of lines would produce if every line were filled, with everyone
   * else's lines unchanged and no leave. The job class is replaced by one person per
   * line, certified on all of the class's consoles (a cross-trained pool).
   */
  function previewLines(state, jobClassId, lines, fromDay, days) {
    const jc = jobClassById(state, jobClassId) || jobClassOf(state, jobClassId);
    const pids = classConsoles(state, jc);
    const members = new Set(classMembers(state, jc, true).map((e) => e.id));
    const synthEmps = lines.map((l, i) => ({ id: `__ln${i}`, firstName: '', lastName: l.name, jobClassId: jc ? jc.id : null, positionId: l.positionId || null, qualifications: pids.slice(), status: 'active' }));
    const temp = Object.assign({}, state, {
      employees: state.employees.filter((e) => !members.has(e.id)).concat(synthEmps),
      lines: state.lines.filter((l) => l.employeeId && !members.has(l.employeeId) && !(jc && (lineClass(state, l) || {}).id === jc.id))
        .concat(lines.map((l, i) => Object.assign({}, l, { employeeId: `__ln${i}`, effectiveFrom: fmtDate(Math.min(fromDay, parseDate(l.effectiveFrom || fmtDate(fromDay)))), effectiveTo: null }))),
      exceptions: [], fills: [],
    });
    const op = openings(temp, fromDay, fromDay + days - 1);
    op.consoles = pids;
    return op;
  }

  // ----------------------------------------------------------- sync & privacy
  /** Record-level changes between two states (used to sync and to audit). */
  function diffState(before, after) {
    const out = { upserts: {}, deletes: {}, config: {} };
    for (const k of COLLECTIONS) {
      const a = {}, b = {};
      for (const x of before[k] || []) a[x.id] = x;
      for (const x of after[k] || []) b[x.id] = x;
      for (const [id, x] of Object.entries(b)) if (!a[id] || JSON.stringify(a[id]) !== JSON.stringify(x)) (out.upserts[k] ||= []).push(x);
      for (const id of Object.keys(a)) if (!b[id]) (out.deletes[k] ||= []).push(id);
    }
    for (const k of ['center', 'minimums']) if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) out.config[k] = after[k];
    return out;
  }
  function diffEmpty(d) { return !Object.keys(d.upserts).length && !Object.keys(d.deletes).length && !Object.keys(d.config).length; }
  function applyDiff(state, d) {
    for (const [k, list] of Object.entries(d.upserts || {})) {
      if (!COLLECTIONS.includes(k)) continue;
      for (const x of list) {
        if (!x || !x.id) continue;
        const i = state[k].findIndex((y) => y.id === x.id);
        if (i >= 0) state[k][i] = x; else state[k].push(x);
      }
    }
    for (const [k, ids] of Object.entries(d.deletes || {})) {
      if (!COLLECTIONS.includes(k)) continue;
      const set = new Set(ids);
      state[k] = state[k].filter((x) => !set.has(x.id));
    }
    for (const [k, v] of Object.entries(d.config || {})) if (k === 'center' || k === 'minimums') state[k] = v;
    return state;
  }

  /**
   * What an employee-role user may see: their own data in full; for everyone
   * else no pay rates or notes, and leave shows only as "Off (leave)".
   */
  function filterStateFor(state, user) {
    if (!user || user.role === 'admin' || user.role === 'supervisor') return state;
    const me = user.employeeId;
    const out = Object.assign({}, state);
    out.center = Object.assign({}, state.center, { annualOtBudget: 0 });
    out.employees = state.employees.filter((e) => e.status !== 'inactive' || e.id === me)
      .map((e) => e.id === me ? e : Object.assign({}, e, { hourlyRate: 0, notes: '', phone: '' }));
    // Planned leave (vacation/comp/holiday) stays visible so staff can see which days are full;
    // sick, FMLA, injury and other reasons are confidential.
    const open = (t) => t === 'trade' || PLANNED_LEAVE.includes(t);
    out.exceptions = state.exceptions.filter((x) => x.employeeId === me || x.status === 'approved' || (x.status === 'pending' && open(x.type)))
      .map((x) => x.employeeId === me ? x : Object.assign({}, x, { type: open(x.type) ? x.type : 'leave', note: '', decisionNote: '' }));
    out.trades = state.trades.filter((t) => t.requesterId === me || t.partnerId === me);
    out.notifications = state.notifications.filter((n) => n.employeeId === me);
    out.postings = state.postings.map((p) => Object.assign({}, p, { volunteers: (p.volunteers || []).filter((v) => v.employeeId === me), volunteerCount: (p.volunteers || []).length }));
    out.bids = state.bids.filter((b) => b.status !== 'draft');
    return out;
  }

  /** Employees of a job class with planned leave (vacation/comp/holiday) on a day. */
  function plannedLeaveOn(state, day, jobClassId, extra = []) {
    const ix = index(state);
    const jc = jobClassById(state, jobClassId);
    const inClass = new Set(classMembers(state, jc, true).map((e) => e.id));
    const who = new Set();
    for (const e of state.exceptions.concat(extra)) {
      if (!PLANNED_LEAVE.includes(e.type) || !(e.status === 'approved' || e.status === 'pending')) continue;
      const [a, b] = exceptionRange(e);
      if (day < a || day > b) continue;
      const emp = ix.emp[e.employeeId];
      if (emp && inClass.has(emp.id)) who.add(emp.id);
    }
    return who;
  }

  /** Days in [from,to] where adding `exc` would put the job class over its daily leave limit. */
  function overLeaveLimit(state, exc) {
    if (!PLANNED_LEAVE.includes(exc.type)) return [];
    const emp = state.employees.find((e) => e.id === exc.employeeId);
    const jc = empClass(state, emp);
    const lim = jc ? maxOffFor(state, jc) : null;
    if (lim == null || lim === '') return [];
    const [a, b] = exceptionRange(exc);
    const out = [];
    for (let d = a; d <= b; d++) {
      const who = plannedLeaveOn(state, d, jc.id);
      who.delete(emp.id);
      if (who.size >= +lim) out.push({ day: d, others: [...who] });
    }
    return out;
  }

  // -------------------------------------------------------- staffing level
  const EXTENDED_LEAVE = ['family', 'military', 'injury'];
  const LEVELS = ['normal', 'short', 'critical'];

  /** On extended leave on `day`: status LOA (until returnDate), or approved FMLA/military/injury leave of 7+ days. */
  function onExtendedLeave(state, emp, day) {
    if (emp.status === 'leave' && !(emp.returnDate && parseDate(emp.returnDate) <= day)) return true;
    return state.exceptions.some((e) => {
      if (e.employeeId !== emp.id || e.status !== 'approved' || !EXTENDED_LEAVE.includes(e.type)) return false;
      const [a, b] = exceptionRange(e);
      return b - a + 1 >= 7 && a <= day && day <= b;
    });
  }
  /** Able to work solo on `day` (active, or a trainee who is solo-cleared or past their expected solo date). */
  function soloOn(emp, day) {
    if (emp.hireDate && parseDate(emp.hireDate) > day) return false;
    if (emp.status === 'active' || emp.status === 'leave') return true;
    if (emp.status === 'trainee') return !!emp.soloCleared || (!!emp.soloDate && parseDate(emp.soloDate) <= day);
    return false;
  }

  /**
   * Effective staffing for a job class on a day: full-time filled, minus people on
   * extended leave and trainees not yet solo, plus part-time FTE (setting), as a % of
   * authorized full-time positions.
   */
  function staffingLevel(state, jc, day = todayNum()) {
    const c = state.center;
    const authorized = +jc.authorized || 0;
    const members = classMembers(state, jc);
    let full = 0, partFTE = 0, out = { leave: 0, trainees: 0 };
    let filled = 0;
    for (const e of members) {
      if (!isPartTime(e)) filled++;
      const away = onExtendedLeave(state, e, day);
      const solo = soloOn(e, day);
      if (!solo) { if (!isPartTime(e)) out.trainees++; continue; }
      if (away) { if (!isPartTime(e)) out.leave++; continue; }
      if (isPartTime(e)) partFTE += partTimeCap(state, e) / 40; else full++;
    }
    const effective = full + (c.levelIncludesPartTime !== false ? partFTE : 0);
    const pct = authorized ? effective / authorized : null;
    const normal = (+c.levelNormalPct || 90) / 100, short = (+c.levelShortPct || 75) / 100;
    const level = pct == null || pct >= normal ? 'normal' : pct >= short ? 'short' : 'critical';
    return { jobClass: jc, day, authorized, filled, effective, partFTE, out, pct, level };
  }
  function levelRule(state, level) {
    const r = (state.center.levelRules || {})[level] || {};
    const d = defaultCenter().levelRules[level];
    return {
      reliefMargin: r.reliefMargin === '' || r.reliefMargin == null ? d.reliefMargin : +r.reliefMargin,
      maxOffPerDay: r.maxOffPerDay === '' || r.maxOffPerDay == null ? null : +r.maxOffPerDay,
    };
  }
  /** Daily vacation limit for a job class at its current staffing level. */
  function maxOffFor(state, jc, day = todayNum()) {
    const rule = levelRule(state, staffingLevel(state, jc, day).level);
    if (rule.maxOffPerDay != null) return rule.maxOffPerDay;
    return jc.maxOffPerDay;
  }
  /** Staffing level today and on the 1st of each of the next `months` months. */
  function projectLevels(state, jc, months = 6, today = todayNum()) {
    const pts = [today];
    const dt = new Date(today * 86400000);
    for (let i = 1; i <= months; i++) pts.push(Math.floor(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth() + i, 1) / 86400000));
    return pts.map((d) => staffingLevel(state, jc, d));
  }

  // ------------------------------------------------------- scheduling day
  /** Start minutes and weight of each regular shift worked on lines active around `day`. */
  function shiftStartsInUse(state, day) {
    const ix = index(state);
    const counts = {}; // startMin -> { n, hours: {h: n} }
    const add = (tpl) => {
      if (!tpl) return;
      const m = parseTime(tpl.start);
      const c = counts[m] || (counts[m] = { n: 0, hours: {} });
      c.n++; c.hours[tpl.hours] = (c.hours[tpl.hours] || 0) + 1;
    };
    for (const line of state.lines) {
      if (!line.employeeId) continue;
      if (!lineActiveOn(line, day) && !lineActiveOn(line, day + 7)) continue;
      const pat = ix.pat[line.patternId];
      const toks = new Set(pat && pat.cycle ? pat.cycle : [1]);
      for (const t of toks) {
        if (!t || t === '0' || isShortTok(t)) continue;
        add(t === 1 || t === '1' ? ix.tpl[line.shiftTemplateId] : ix.tpl[t]);
      }
    }
    return counts;
  }

  /**
   * When the scheduling day starts, in minutes after midnight: the center setting, or
   * the earliest start among regular shifts worked by at least two lines (e.g. 0700).
   */
  function schedulingDayStart(state, refDay = todayNum()) {
    const v = state.center.dayStartHour;
    if (v !== '' && v != null && !isNaN(+v)) return mod(+v, 24) * 60;
    const counts = shiftStartsInUse(state, refDay);
    const starts = Object.keys(counts).map(Number).sort((a, b) => a - b);
    const common = starts.filter((m) => counts[m].n >= 2);
    const m = (common.length ? common : starts)[0];
    return m == null ? 7 * 60 : Math.floor(m / 60) * 60;
  }

  /**
   * The shifts a scheduling day is made of, e.g. 0700-1900 and 1900-0700. Uses the
   * center's shift boundaries if set; otherwise tiles the day with the most common
   * shift starting at each boundary (D 0700-1500, E 1500-2300, M 2300-0700, ...).
   * Returns [{ start, end }] in absolute minutes.
   */
  function shiftBlocks(state, day) {
    const startMin = schedulingDayStart(state, day);
    const t0 = day * DAY + startMin, t1 = t0 + DAY;
    let marks = [];
    const custom = String(state.center.shiftBoundaries || '').split(/[\s,;]+/).filter(Boolean)
      .map((x) => { const d = x.replace(':', ''); return d.length <= 2 ? +d * 60 : parseTime(d.slice(0, -2) + ':' + d.slice(-2)); })
      .filter((m) => !isNaN(m) && m >= 0 && m < DAY);
    if (custom.length) {
      marks = custom.map((m) => t0 + mod(m - startMin, DAY));
    } else {
      const counts = shiftStartsInUse(state, day);
      const starts = Object.keys(counts).map(Number).sort((a, b) => a - b);
      let cur = startMin;
      marks.push(t0);
      for (let guard = 0; guard < 12; guard++) {
        const c = counts[mod(cur, DAY)];
        let next;
        if (c) {
          const hours = +Object.entries(c.hours).sort((a, b) => b[1] - a[1] || b[0] - a[0])[0][0];
          next = cur + Math.round(hours * 60);
        } else {
          // No shift starts here: jump to the next start time in use.
          const later = starts.map((m) => cur + mod(m - cur, DAY)).filter((m) => m > cur).sort((a, b) => a - b);
          next = later.length ? later[0] : cur + DAY;
        }
        if (next - startMin >= DAY) break;
        marks.push(t0 + (next - startMin));
        cur = next;
      }
    }
    marks = [...new Set(marks.concat([t0]))].sort((a, b) => a - b);
    const blocks = [];
    for (let i = 0; i < marks.length; i++) blocks.push({ start: marks[i], end: i + 1 < marks.length ? marks[i + 1] : t1 });
    return blocks;
  }

  /** The scheduling day an absolute minute falls in. */
  function schedulingDayOf(state, abs) {
    const startMin = schedulingDayStart(state, Math.floor(abs / DAY));
    return Math.floor((abs - startMin) / DAY);
  }

  // ------------------------------------------------------------------ demo
  function demoState(today = todayNum()) {
    const rnd = mulberry32(9110);
    const s = emptyState();
    s.center.name = 'Demo County Emergency Communications';
    // Work weeks run Monday-Sunday, like the 2-week schedule template.
    Object.assign(s.center, { annualOtBudget: 90000, schemaVersion: 6, otPeriodStart: '2026-10-05', lineMode: 'fixed' });
    // Minimums are set per discipline. Telecommunicators sit Law or Fire/EMS (most are
    // certified on both); supervisors have their own console.
    s.positions = [
      { id: 'pos_law', name: 'Law', isConsole: true, priority: 2 },
      { id: 'pos_fire', name: 'Fire/EMS', isConsole: true, priority: 3 },
      { id: 'pos_sup', name: 'Supervisor', isConsole: false, priority: 1 },
    ];
    // Job classes hold authorized strength; one class can staff several consoles.
    s.jobClasses = [
      { id: 'jc_tc', name: 'Telecommunicator', positionIds: ['pos_law', 'pos_fire'], authorized: 16, authorizedPartTime: 3, maxOffPerDay: 1 },
      { id: 'jc_sup', name: 'Supervisor', positionIds: ['pos_sup'], authorized: 5, authorizedPartTime: 0, maxOffPerDay: 1 },
    ];
    const grid = (fn) => Array.from({ length: 7 }, (_, d) => Array.from({ length: 24 }, (_, h) => fn(d, h)));
    // Minimum 3 telecommunicators around the clock (2 law, 1 fire/EMS) and a supervisor.
    s.minimums = {
      pos_law: grid(() => 2),
      pos_fire: grid(() => 1),
      pos_sup: grid(() => 1),
    };

    const first = ['Ava', 'Ben', 'Carla', 'Derek', 'Elena', 'Frank', 'Gina', 'Hector', 'Ivy', 'Jamal', 'Kara', 'Liam', 'Maya', 'Nate', 'Olivia', 'Pete', 'Quinn', 'Rosa', 'Sam', 'Tara', 'Uri', 'Vera', 'Wes', 'Xena', 'Yusuf', 'Zoe', 'Grant', 'Holly', 'Iris', 'Jack', 'Leah', 'Miles'];
    const last = ['Adams', 'Brooks', 'Carter', 'Dalton', 'Ellis', 'Foster', 'Garcia', 'Hayes', 'Irwin', 'Jensen', 'Keller', 'Lopez', 'Monroe', 'Nash', 'Owens', 'Price', 'Quincy', 'Reed', 'Shaw', 'Turner', 'Underwood', 'Vance', 'Walsh', 'Xiong', 'Young', 'Zimmer', 'Pruitt', 'Lambert', 'Bishop', 'Cole', 'Dunn', 'Fields'];
    let n = 0;
    const mk = (positionId, extra = {}) => {
      const year = Math.min(2025, 1998 + Math.floor((n * 37) % 28));
      const sen = `${year}-${pad(1 + (n * 5) % 12)}-${pad(1 + (n * 7) % 27)}`;
      const base = positionId === 'pos_sup' ? 30 : 20;
      const e = Object.assign({
        id: uid('emp'), firstName: first[n % first.length], lastName: last[n % last.length], badge: String(1001 + n), positionId, status: 'active',
        hireDate: sen, seniorityDate: sen, hourlyRate: round2(base + Math.min(2026 - year, 20) * 0.55), soloCleared: true, qualifications: [],
        phone: `555-01${pad(n % 100)}`, notes: '',
      }, extra);
      n++;
      s.employees.push(e);
      return e;
    };

    // The 2-week schedule template (weeks run Monday-Sunday): 6 day slots, 6 night slots
    // and a mid-shift. W = the slot's 12-hour shift, O = off, otherwise a shift id.
    s.shiftTemplates.push(
      { id: 't_mid', code: '11-23', name: 'Mid 1100-2300', start: '11:00', hours: 12, color: '#14b8a6' },
      { id: 't_d4p', code: '11-15', name: 'Day 4 (1100-1500)', start: '11:00', hours: 4, color: '#60a5fa' },
    );
    const anchor = parseDate('2026-10-05');
    const tok = (str) => str.split(' ').map((c) => (c === 'O' ? 0 : c === 'W' ? 1 : c));
    const TEMPLATE = [
      ['Day 1', 't_d12', 'W t_d4p O O O W W W W W O O O W'],
      ['Day 2', 't_d12', 'W W W W O O O O W t_d4p W W O O'],
      ['Day 3', 't_d12', 'O O O W W W W W O O O t_d4p W W'],
      ['Day 4', 't_d12', 'W W O O O W W t_d4p W W O O O W'],
      ['Day 5', 't_d12', 'O O W W W t_d4p O W O O W W W O'],
      ['Day 6', 't_d12', 'O W W t_d4p W O O O O W W W W O'],
      ['Mid-Shift', 't_mid', 'W t_e8 W O W O O O W t_e8 W O W O'],
      ['Night 1', 't_n12', 'W t_n4 O O O W W W W W O O O W'],
      ['Night 2', 't_n12', 'W t_m8 W W O O O O W t_n4 W W O O'],
      ['Night 3', 't_n12', 'O O O W W W W W O O O t_n4 W W'],
      ['Night 4', 't_n12', 'W W O O O W W t_n4 W W O O O W'],
      ['Night 5', 't_n12', 'O O W W W t_n4 O W O O W W W O'],
      ['Night 6', 't_n12', 'O W W t_n4 W O O O O t_m8 W W W O'],
      // Supervisors: two per shift, one on each week.
      ['Sup Day A', 't_d12', 'W W W O O O W O O O W W W O'],
      ['Sup Day B', 't_d12', 'O O O W W W O W W W O O O W'],
      ['Sup Night A', 't_n12', 'W W W O O O W O O O W W W O'],
      ['Sup Night B', 't_n12', 'O O O W W W O W W W O O O W'],
    ];
    const slot = (name, tpl, cycle, emp, jobClassId) => {
      const pat = { id: 'pat_' + name.toLowerCase().replace(/[^a-z0-9]+/g, '_'), name: `Template: ${name}`, cycle: tok(cycle), template: true };
      s.patterns.push(pat);
      s.lines.push({ id: uid('ln'), name, jobClassId, positionId: null, shiftTemplateId: tpl, patternId: pat.id, anchorDate: fmtDate(anchor), effectiveFrom: '2026-10-05', effectiveTo: null, employeeId: emp ? emp.id : null });
    };
    const day = [], night = [], sups = [];
    let mid = null;
    TEMPLATE.forEach(([name, tpl, cycle], i) => {
      const sup = name.startsWith('Sup');
      const e = mk(sup ? 'pos_sup' : (i % 2 ? 'pos_fire' : 'pos_law'), { jobClassId: sup ? 'jc_sup' : 'jc_tc', qualifications: sup ? ['pos_sup', 'pos_law', 'pos_fire'] : ['pos_law', 'pos_fire'] });
      if (sup) sups.push(e); else if (name.startsWith('Day')) day.push(e); else if (name.startsWith('Night')) night.push(e); else mid = e;
      slot(name, tpl, cycle, e, sup ? 'jc_sup' : 'jc_tc');
    });
    const tcs = day.concat(night, [mid]);
    const law = tcs.filter((e) => e.positionId === 'pos_law'), fire = tcs.filter((e) => e.positionId === 'pos_fire');
    // Two are certified on one console only.
    day[3].qualifications = ['pos_fire']; night[2].qualifications = ['pos_law'];
    // A solo-cleared trainee on nights.
    Object.assign(night[5], { status: 'trainee', soloCleared: true, hireDate: '2026-03-16', seniorityDate: '2026-03-16', hourlyRate: 20 });
    // Part-time telecommunicators: not on the template; straight time, capped at 32
    // hours, never forced. They pick up open shifts and can cut scheduled OT.
    mk('pos_law', { jobClassId: 'jc_tc', qualifications: ['pos_law', 'pos_fire'], employmentType: 'part', maxWeeklyHours: null, hourlyRate: 21, hireDate: '2024-05-06', seniorityDate: '2024-05-06' });
    mk('pos_fire', { jobClassId: 'jc_tc', qualifications: ['pos_law', 'pos_fire'], employmentType: 'part', maxWeeklyHours: 24, hourlyRate: 21.5, hireDate: '2023-02-13', seniorityDate: '2023-02-13' });
    mk('pos_law', { jobClassId: 'jc_tc', employmentType: 'part', maxWeeklyHours: null, hourlyRate: 24, hireDate: '2019-08-01', seniorityDate: '2019-08-01', qualifications: ['pos_law', 'pos_fire'], notes: 'Retired full-timer; picks up open shifts' });

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
    const v1 = nextWork(night[4], today + 2);
    if (v1 != null) ex(night[4], v1, 'vacation', 'approved', { endDate: fmtDate(v1 + 4), note: 'Annual leave' });
    const t1 = nextWork(day[5], today + 5);
    if (t1 != null) ex(day[5], t1, 'training', 'approved', { start: '13:00', hours: 4, note: 'CTO refresher class' });
    const p1 = nextWork(law[3], today + 6);
    if (p1 != null) ex(law[3], p1, 'vacation', 'pending', { endDate: fmtDate(p1 + 1), note: 'Family trip' });
    const p2 = nextWork(mid, today + 9);
    if (p2 != null) ex(mid, p2, 'comp', 'pending');
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
    DAY, DOW, EXCEPTION_TYPES, FILL_TYPES, STATUSES, COLLECTIONS, PLANNED_LEAVE,
    jobClasses, jobClassOf, jobClassById, classMembers, classConsoles, empClass, lineClass, bidClass, certifications,
    schedulingDayStart, shiftBlocks, schedulingDayOf, importWindows,
    staffingLevel, levelRule, maxOffFor, projectLevels, onExtendedLeave, soloOn, LEVELS, EXTENDED_LEAVE,
    positionOrder, assignHour, diffState, diffEmpty, applyDiff, filterStateFor, plannedLeaveOn, overLeaveLimit,
    mod, pad, parseDate, fmtDate, dow, todayNum, nowAbs, parseTime, timeStr, mil, shortDate, uid, round2, groupBy,
    defaultCenter, emptyState, migrate, index, empName, countable, qualifiedFor, isPartTime, partTimeCap, workWeek,
    lineActiveOn, lineShiftOn, shortTemplateOf, isShortTok, runThrough, workedDays, rotationCycle, cycleMaxRun, ROTATION_BASE, regularShifts, workIntervals, exceptionRange,
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
