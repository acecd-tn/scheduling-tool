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

test('balance week: respects the notice period for day-off changes', () => {
  const s = center();
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
  const r = B.suggestLines(s, 'tc', { templateIds: ['t_d8', 't_e8', 't_m8'], reliefMargin: 0 });
  assert.equal(r.headcount, 9);
  assert.equal(r.after.uncov, 0);
  assert.ok(r.after.surplus <= 360 - 336 + 1e-9);   // only the unavoidable extra hours
  assert.ok(r.lines.every((l) => l.patternId === 'p_52'));
  // Applying to a bid-free re-line keeps holders and ends old lines.
  s.lines = s.employees.map((e) => ({ id: 'L' + e.id, jobClassId: 'tc', employeeId: e.id, shiftTemplateId: 't_d8', patternId: 'p_52', anchorDate: '2026-01-04', effectiveFrom: '2026-01-04' }));
  const res = B.applyToCurrentLines(s, r, '2026-03-01');
  assert.equal(s.lines.filter((l) => l.effectiveTo === '2026-02-28').length, 9);
  assert.equal(s.lines.filter((l) => l.effectiveFrom === '2026-03-01' && l.employeeId).length, 9);
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
