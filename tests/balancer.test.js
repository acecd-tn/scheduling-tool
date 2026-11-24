const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../js/core.js');
const B = require('../js/balancer.js');

const D = P.parseDate;

function center(min = 1) {
  const s = P.migrate({
    center: { schemaVersion: 4, otPeriodDays: 7, otPeriodStart: '2026-01-04', dayOffNoticeDays: 14 },
    positions: [{ id: 'law', name: 'Law', priority: 1 }],
    jobClasses: [{ id: 'tc', name: 'Telecommunicator', positionIds: ['law'], authorized: 2 }],
  });
  for (const row of s.minimums.law) for (let h = 7; h < 15; h++) row[h] = min;
  s.employees = ['a', 'b'].map((id, i) => ({ id, firstName: id, lastName: id.toUpperCase(), jobClassId: 'tc', qualifications: ['law'], status: 'active', hourlyRate: 25, seniorityDate: `200${i}-01-01` }));
  // Both work Sun-Thu 0700-1500: Fri and Sat uncovered, Sun-Thu one extra.
  s.lines = s.employees.map((e) => ({ id: 'L' + e.id, jobClassId: 'tc', employeeId: e.id, shiftTemplateId: 't_d8', patternId: 'p_52', anchorDate: '2026-01-04', effectiveFrom: '2026-01-04' }));
  return s;
}

test('balance week: moves days off from surplus days to gap days, same work week, and closes the gaps', () => {
  const s = center();
  s.center.maxConsecutiveDays = 0; // 5 x 8 lines: no days-in-a-row limit here
  const week = D('2026-03-01'); // a Sunday, well past the notice period
  const r = B.balanceWeek(s, week, { today: D('2026-01-05'), now: D('2026-01-05') * 1440 });
  assert.equal(r.moves.length, 2);
  const workDays = r.moves.map((m) => m.workDate).sort();
  assert.deepEqual(workDays, ['2026-03-06', '2026-03-07']); // Fri and Sat
  for (const m of r.moves) assert.equal(P.workWeek(s, D(m.offDate)).start, P.workWeek(s, D(m.workDate)).start);
  assert.deepEqual(r.moves.map((m) => m.employeeId).sort(), ['a', 'b']); // spread across people
  assert.equal(r.remaining.hours, 0);
  // Approving them (as the UI does) changes the schedule; still 40 h each.
  for (const m of r.moves) s.shiftMoves.push(Object.assign({ id: P.uid('mv'), status: 'approved' }, m));
  assert.equal(P.openings(s, week, week + 6).slots.length, 0);
  const hrs = (id) => P.regularShifts(s, week, week + 6).filter((x) => x.employeeId === id).reduce((t, x) => t + (x.end - x.start) / 60, 0);
  assert.equal(hrs('a'), 40);
  assert.equal(hrs('b'), 40);
});

test('balance week: day-off moves never make more than 4 days in a row unless marked emergency', () => {
  const s = center();
  // a works Mon-Thu and Sat. Fri needs someone; Mon and Sat don't.
  s.patterns.push({ id: 'p_a', name: 'a', cycle: [0, 1, 1, 1, 1, 0, 1] });
  s.lines[0].patternId = 'p_a';
  s.lines[1].employeeId = null;
  for (const [d, row] of s.minimums.law.entries()) for (let h = 0; h < 24; h++) row[h] = d >= 2 && d <= 5 && h >= 7 && h < 15 ? 1 : 0;
  const week = D('2026-03-01');
  const opts = { today: D('2026-01-05'), now: D('2026-01-05') * 1440 };
  // Off Mon -> Fri makes Tue-Sat 5 in a row; off Sat -> Fri makes Mon-Fri 5 in a row.
  const r = B.balanceWeek(s, week, opts);
  assert.equal(r.moves.length, 0);
  assert.ok(r.blockedByRun > 0);
  const e = B.balanceWeek(s, week, Object.assign({ allowEmergency: true }, opts));
  assert.equal(e.moves.length, 1);
  assert.ok(e.moves[0].emergency);
  assert.equal(e.moves[0].workDate, '2026-03-06');
});

test('balance week: respects the notice period for day-off changes', () => {
  const s = center();
  s.center.maxConsecutiveDays = 0;
  const week = D('2026-01-11');
  const r = B.balanceWeek(s, week, { today: D('2026-01-05'), now: D('2026-01-05') * 1440 });
  assert.equal(r.moves.length, 0);
  assert.ok(r.skippedForNotice > 0);
  const r2 = B.balanceWeek(s, week, { today: D('2026-01-05'), now: D('2026-01-05') * 1440, allowShortNotice: true });
  assert.equal(r2.moves.length, 2);
});

test('balance week: offers remaining gaps to part-timers under their cap, then lists OT', () => {
  const s = center();
  s.lines[1].employeeId = null; // 'b' has no line now: only 'a' works Sun-Thu
  s.employees[1].employmentType = 'part';
  s.employees[1].maxWeeklyHours = 16;
  const week = D('2026-03-01');
  const r = B.balanceWeek(s, week, { today: D('2026-01-05'), now: D('2026-01-05') * 1440 });
  assert.equal(r.moves.length, 0);                 // nobody has spare days to move
  assert.equal(r.ptOffers.length, 2);              // Fri and Sat to the part-timer (16 h cap)
  assert.ok(r.ptOffers.every((o) => o.employeeId === 'b'));
  assert.equal(r.remaining.hours, 0);
  s.employees[1].maxWeeklyHours = 8;               // only one day fits under the cap
  const r2 = B.balanceWeek(s, week, { today: D('2026-01-05'), now: D('2026-01-05') * 1440 });
  assert.equal(r2.ptOffers.length, 1);
  assert.equal(r2.remaining.hours, 8);
  assert.ok(r2.remaining.cost > 0);
});

test('suggest lines: covers every hour with 40-hour lines and keeps surplus to the margin', () => {
  const s = P.migrate({ center: { schemaVersion: 4 }, positions: [{ id: 'law', name: 'Law' }, { id: 'fire', name: 'Fire' }], jobClasses: [{ id: 'tc', name: 'TC', positionIds: ['law', 'fire'], authorized: 9 }] });
  for (const pid of ['law', 'fire']) for (const row of s.minimums[pid]) row.fill(1); // 2 people 24/7 = 336 h/wk
  s.employees = Array.from({ length: 9 }, (_, i) => ({ id: 'e' + i, firstName: 'e', lastName: 'E' + i, jobClassId: 'tc', qualifications: ['law', 'fire'], status: 'active' }));
  const r = B.suggestLines(s, 'tc', { mode: 'weekly', keepShifts: false, templateIds: ['t_d8', 't_e8', 't_m8'], reliefMargin: 0 });
  assert.equal(r.headcount, 9);
  assert.equal(r.after.uncov, 0);
  assert.ok(r.after.surplus <= 360 - 336 + 1e-9);   // only the unavoidable extra hours
  assert.ok(r.lines.every((l) => l.patternId === 'p_52'));
  // Applying to a bid-free re-line keeps holders and ends old lines.
  s.lines = s.employees.map((e) => ({ id: 'L' + e.id, jobClassId: 'tc', employeeId: e.id, shiftTemplateId: 't_d8', patternId: 'p_52', anchorDate: '2026-01-04', effectiveFrom: '2026-01-04' }));
  const r2 = B.suggestLines(s, 'tc', { mode: 'weekly', keepShifts: false, templateIds: ['t_d8', 't_e8', 't_m8'], reliefMargin: 0, effectiveDate: '2026-03-01' });
  const res = B.applyToCurrentLines(s, r2, '2026-03-01');
  // Unchanged lines are left alone; changed ones end the day before.
  assert.equal(s.lines.filter((l) => l.effectiveTo === '2026-02-28').length + res.kept, 9);
  assert.equal(s.lines.filter((l) => l.effectiveFrom === '2026-03-01' && l.employeeId).length, res.changed.length);
  assert.equal(new Set(P.regularShifts(s, D('2026-03-02'), D('2026-03-02')).map((x) => x.employeeId)).size <= 9, true);
  assert.ok(res.changed.length > 0);
  // From Monday on (the first night after a changeover depends on the old lines' last day).
  assert.equal(P.openings(s, D('2026-03-02'), D('2026-03-07')).slots.length, 0);
});

test('staffing level: extended leave and non-solo trainees count against it; outlook uses solo and return dates', () => {
  const s = P.migrate({ center: { schemaVersion: 4 }, positions: [{ id: 'law', name: 'Law' }], jobClasses: [{ id: 'tc', name: 'TC', positionIds: ['law'], authorized: 10 }] });
  s.employees = Array.from({ length: 10 }, (_, i) => ({ id: 'e' + i, firstName: 'e', lastName: 'E' + i, jobClassId: 'tc', qualifications: ['law'], status: 'active' }));
  const today = D('2026-01-05');
  const jc = s.jobClasses[0];
  assert.equal(P.staffingLevel(s, jc, today).level, 'normal');
  Object.assign(s.employees[0], { status: 'trainee', soloCleared: false, soloDate: '2026-03-01' });
  Object.assign(s.employees[1], { status: 'leave', returnDate: '2026-04-15' });
  s.exceptions.push({ id: 'f', employeeId: 'e2', date: '2026-01-01', endDate: '2026-02-15', type: 'family', status: 'approved' });
  const L = P.staffingLevel(s, jc, today);
  assert.equal(L.effective, 7);
  assert.equal(L.level, 'critical');                // 70% < 75%
  const out = P.projectLevels(s, jc, 6, today).map((x) => x.effective);
  assert.deepEqual(out, [7, 7, 9, 9, 10, 10, 10]);  // by Mar 1: FMLA over (Feb 15) and trainee solo; LOA back Apr 15
  // Part-time FTE counts (setting).
  s.employees.push({ id: 'p', firstName: 'p', lastName: 'P', jobClassId: 'tc', qualifications: ['law'], status: 'active', employmentType: 'part', maxWeeklyHours: 32 });
  assert.equal(P.staffingLevel(s, jc, today).effective, 7.8);
  s.center.levelIncludesPartTime = false;
  assert.equal(P.staffingLevel(s, jc, today).effective, 7);
});

test('staffing level sets the daily vacation limit; part-timers on lines can be extra', () => {
  const s = center();
  s.jobClasses[0].maxOffPerDay = 2;
  assert.equal(P.maxOffFor(s, s.jobClasses[0], D('2026-01-05')), 2);
  s.center.levelRules.normal.maxOffPerDay = 1;
  assert.equal(P.maxOffFor(s, s.jobClasses[0], D('2026-01-05')), 1);
  // Part-timer on a line: counts by default, not when "extra".
  s.employees[1].employmentType = 'part';
  const day = D('2026-03-02');
  assert.equal(P.coverage(s, day, day).staffed.law[8], 2);
  s.center.partTimeOnLines = 'extra';
  assert.equal(P.coverage(s, day, day).staffed.law[8], 1);
});

test('rotation: 3 x 12 + one 4-hour, 40 hours every work week, days off move one day later each week, max 3 in a row', () => {
  const s = P.migrate({ center: { otPeriodStart: '2026-01-04' } });
  const pat = s.patterns.find((p) => p.id === 'p_rot');
  assert.equal(pat.cycle.length, 49);
  assert.equal(P.cycleMaxRun(pat.cycle), 3);
  assert.equal(P.patternWeeklyHours(s, pat, 't_d12'), 40);
  // Each week's days off are the previous week's, one day later.
  const off = (w) => [0, 1, 2, 3, 4, 5, 6].filter((d) => !pat.cycle[w * 7 + d]);
  for (let w = 1; w < 7; w++) assert.deepEqual(off(w), off(w - 1).map((d) => (d + 1) % 7).sort());
  // The 4-hour shift starts with the regular shift: D4 0700, N4 1900.
  const ix = P.index(s);
  const line = { shiftTemplateId: 't_n12', patternId: 'p_rot', anchorDate: '2026-01-04', effectiveFrom: '2026-01-04' };
  const shorts = [];
  for (let d = D('2026-01-04'); d < D('2026-01-04') + 49; d++) { const t = P.lineShiftOn(line, d, ix); if (t && t.hours === 4) shorts.push(t.start); }
  assert.deepEqual([...new Set(shorts)], ['19:00']);
  // Job class choice (peak hours) and a line's own choice win.
  s.shiftTemplates.push({ id: 'pk', code: 'N4P', start: '20:00', hours: 4 });
  s.jobClasses = [{ id: 'tc', name: 'TC', positionIds: [], shortShift: { t_n12: 'pk' } }];
  assert.equal(P.shortTemplateOf(Object.assign({ jobClassId: 'tc' }, line), P.index(s)).id, 'pk');
  // The generator staggers lines a week apart, starting on a work week.
  const ls = P.generateLines(s, { shiftTemplateId: 't_d12', patternId: 'p_rot', count: 7, teams: 7, anchorDate: '2026-01-07' });
  assert.deepEqual(ls.map((l) => (D(l.anchorDate) - D('2026-01-04')) / 7), [0, 1, 2, 3, 4, 5, 6]);
});

test('suggest lines (rotation): people keep their shift, only the week they start on changes; no gaps, 40 h weeks', () => {
  const s = P.migrate({ center: { schemaVersion: 4, otPeriodStart: '2026-01-04' }, positions: [{ id: 'law', name: 'Law' }, { id: 'fire', name: 'Fire' }], jobClasses: [{ id: 'tc', name: 'TC', positionIds: ['law', 'fire'], authorized: 10 }] });
  for (const pid of ['law', 'fire']) for (const row of s.minimums[pid]) row.fill(1);
  s.employees = Array.from({ length: 10 }, (_, i) => ({ id: 'e' + i, firstName: 'e', lastName: 'E' + i, jobClassId: 'tc', qualifications: ['law', 'fire'], status: 'active', seniorityDate: `20${10 + i}-01-01` }));
  // Everyone starts the rotation the same week: days off all land together.
  s.lines = s.employees.map((e, i) => ({ id: 'L' + i, jobClassId: 'tc', employeeId: e.id, shiftTemplateId: i < 5 ? 't_d12' : 't_n12', patternId: 'p_rot', anchorDate: '2026-01-04', effectiveFrom: '2026-01-04' }));
  const r = B.suggestLines(s, 'tc', { effectiveDate: '2026-03-01', reliefMargin: 0 });
  assert.equal(r.mode, 'rotation');
  assert.ok(r.before.uncov > 0);
  assert.equal(r.after.uncov, 0);
  for (const l of r.lines) assert.equal(l.shiftTemplateId, s.lines.find((x) => x.employeeId === l.employeeId).shiftTemplateId);
  const res = B.applyToCurrentLines(s, r, P.fmtDate(r.start));
  assert.ok(res.kept >= 1);
  const d0 = r.start;
  assert.equal(P.openings(s, d0 + 1, d0 + 48).slots.length, 0);
  const regs = P.regularShifts(s, d0, d0 + 48);
  for (const e of s.employees) {
    const mine = regs.filter((x) => x.employeeId === e.id);
    const days = new Set(mine.map((x) => x.day));
    for (const d of days) assert.ok(P.runThrough(days, d) <= 3);
    for (let w = 0; w < 7; w++) assert.equal(mine.filter((x) => x.day >= d0 + 7 * w && x.day < d0 + 7 * w + 7).reduce((a, x) => a + (x.end - x.start) / 60, 0), 40);
  }
});

test('fix coverage plan: the same gap and the same move are grouped across weeks', () => {
  const s = center();
  s.center.maxConsecutiveDays = 0;
  const opts = { today: D('2026-01-05'), now: D('2026-01-05') * 1440, weeks: 3 };
  const plan = B.planCoverage(s, D('2026-03-01'), opts);
  assert.equal(plan.weeks, 3);
  // Before: Fri and Sat days are 1 short, 3 weeks each.
  assert.deepEqual(plan.gaps.map((g) => [P.DOW[g.dow], g.name, g.short, g.days.length]).sort(), [['Fri', 'days', 1, 3], ['Sat', 'days', 1, 3]]);
  // Two grouped moves (one per person), 3 weeks each; nothing left for OT.
  assert.equal(plan.moves.length, 2);
  assert.ok(plan.moves.every((m) => m.items.length === 3));
  assert.equal(plan.hours, 0);
  // Skipping a group's moves brings up the next best instead.
  const skip = new Set(plan.moves[0].skipKeys);
  const p2 = B.planCoverage(s, D('2026-03-01'), Object.assign({ skip }, opts));
  assert.ok(!p2.moves.some((m) => m.items.some((x) => skip.has(B.moveKey(x)))));
});

test('training offers: a 4-hour shift can go to training when coverage stays at minimum without OT', () => {
  const s = center();
  s.center.maxConsecutiveDays = 0;
  for (const row of s.minimums.law) row.fill(0);
  for (let h = 7; h < 15; h++) s.minimums.law[1][h] = 1;               // Monday 0700-1500: 1
  s.patterns.push({ id: 'p_mon', name: 'Mon', cycle: [0, 1, 0, 0, 0, 0, 0] });
  s.lines[0].shiftTemplateId = 't_d4'; s.lines[0].patternId = 'p_mon'; // a: Mon 0700-1100
  s.lines[1].patternId = 'p_mon';                                      // b: Mon 0700-1500
  const opts = { today: D('2026-01-05'), now: D('2026-01-05') * 1440 };
  const r = B.balanceWeek(s, D('2026-03-01'), opts);
  assert.equal(r.training.length, 1);
  assert.equal(r.training[0].employeeId, 'a');
  assert.equal(r.training[0].cover, null);                              // b is still on: at minimum
  // At 2 needed 0700-1100, a part-timer covers the seat at straight time.
  for (let h = 7; h < 11; h++) s.minimums.law[1][h] = 2;
  s.employees.push({ id: 'c', firstName: 'c', lastName: 'C', jobClassId: 'tc', qualifications: ['law'], status: 'active', hourlyRate: 20, employmentType: 'part', maxWeeklyHours: 32 });
  const r2 = B.balanceWeek(s, D('2026-03-01'), opts);
  assert.equal(r2.training.length, 1);
  assert.equal(r2.training[0].cover.employeeId, 'c');
  assert.equal(r2.remaining.hours, 0);
  s.center.offerTraining = false;
  assert.equal(B.balanceWeek(s, D('2026-03-01'), opts).training.length, 0);
});

test('peak 4-hour suggestion: the busiest 4 hours inside the shift by minimums', () => {
  const s = center();
  for (const row of s.minimums.law) { row.fill(1); for (let h = 15; h < 19; h++) row[h] = 3; }
  assert.equal(B.suggestPeakStart(s, s.jobClasses[0], 't_d12'), '15:00');
});

test('v5 conversion: every 12-hour shift gets a 4-hour shift at its start; rotation pattern added', () => {
  const s = P.migrate({ center: { schemaVersion: 4 }, shiftTemplates: [{ id: 'x12', code: 'X12', name: 'X', start: '06:30', hours: 12 }], patterns: [] });
  const x = s.shiftTemplates.find((t) => t.id === 'x12');
  const short = s.shiftTemplates.find((t) => t.id === x.shortTemplateId);
  assert.deepEqual([short.code, short.start, short.hours], ['X4', '06:30', 4]);
  assert.ok(s.patterns.some((p) => p.id === 'p_rot' && p.cycle.length === 49));
  assert.equal(s.center.maxConsecutiveDays, 4);
});
