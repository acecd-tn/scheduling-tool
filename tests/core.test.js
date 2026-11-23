// Run with: node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../js/core.js');

const D = (s) => P.parseDate(s);

/** One position, one 12h day shift template, minimum `min` 0600-1800. */
function tiny({ min = 1, otPeriodDays = 7, otThresholdHours = 40, extraShiftsAlwaysOT = false } = {}) {
  const s = P.emptyState();
  Object.assign(s.center, { otPeriodDays, otThresholdHours, otPeriodStart: '2026-01-04', extraShiftsAlwaysOT, minRestHours: 8, maxShiftHours: 16 });
  s.positions = [{ id: 'tc', name: 'TC', authorized: 3 }];
  const grid = Array.from({ length: 7 }, () => new Array(24).fill(0));
  for (const row of grid) for (let h = 6; h < 18; h++) row[h] = min;
  s.minimums = { tc: grid };
  s.employees = ['a', 'b', 'c'].map((id, i) => ({ id, firstName: id, lastName: id.toUpperCase(), positionId: 'tc', status: 'active', hourlyRate: 20, seniorityDate: `200${i}-01-01`, qualifications: [] }));
  const line = (id, emp, anchor, pat = 'p_pitman') => ({ id, name: id, positionId: 'tc', shiftTemplateId: 't_d12', patternId: pat, anchorDate: anchor, effectiveFrom: '2026-01-04', effectiveTo: null, employeeId: emp });
  s.lines = [line('L1', 'a', '2026-01-04'), line('L2', 'b', '2026-01-11')];
  return P.migrate(s);
}

test('date helpers', () => {
  assert.equal(P.fmtDate(D('2026-11-23')), '2026-11-23');
  assert.equal(P.DOW[P.dow(D('2026-11-23'))], 'Mon');
  assert.equal(P.mil(D('2026-01-01') * 1440 + 18 * 60), '1800');
});

test('Pitman A/B lines cover every day exactly once', () => {
  const s = tiny();
  const regs = P.regularShifts(s, D('2026-01-04'), D('2026-01-31'));
  const perDay = {};
  for (const r of regs) perDay[r.day] = (perDay[r.day] || 0) + 1;
  for (let d = D('2026-01-04'); d <= D('2026-01-31'); d++) assert.equal(perDay[d], 1, P.fmtDate(d));
});

test('night shifts that cross midnight count toward the next day', () => {
  const s = tiny();
  s.lines = [{ id: 'N', name: 'N', positionId: 'tc', shiftTemplateId: 't_n12', patternId: 'p_52', anchorDate: '2026-01-04', effectiveFrom: '2026-01-04', employeeId: 'a' }];
  const cov = P.coverage(s, D('2026-01-05'), D('2026-01-05'));
  assert.equal(cov.staffed.tc[2], 1);   // 0200 on Monday, from Sunday's 1800 shift
  assert.equal(cov.staffed.tc[19], 1);  // 1900 Monday, from Monday's shift
  assert.equal(cov.staffed.tc[10], 0);
});

test('a sick call-out creates an opening attributed to that call-out', () => {
  const s = tiny();
  const day = D('2026-01-04'); // line A works
  assert.equal(P.openings(s, day, day).slots.length, 0);
  s.exceptions.push({ id: 'x1', employeeId: 'a', date: '2026-01-04', type: 'sick', status: 'approved' });
  const { slots } = P.openings(s, day, day);
  assert.equal(slots.length, 1);
  assert.equal(slots[0].hours, 12);
  assert.equal(slots[0].causes[0].exceptionId, 'x1');
});

test('pending requests do not affect coverage, but impact preview does', () => {
  const s = tiny();
  s.exceptions.push({ id: 'p1', employeeId: 'a', date: '2026-01-04', type: 'vacation', status: 'pending' });
  assert.equal(P.openings(s, D('2026-01-04'), D('2026-01-04')).slots.length, 0);
  const imp = P.requestImpact(s, 'p1');
  assert.equal(imp.addedGapHours, 12);
  assert.equal(imp.leaveHours, 12);
});

test('partial leave only removes the requested hours', () => {
  const s = tiny();
  s.exceptions.push({ id: 't', employeeId: 'a', date: '2026-01-04', start: '06:00', hours: 4, type: 'training', status: 'approved' });
  const { slots } = P.openings(s, D('2026-01-04'), D('2026-01-04'));
  assert.equal(slots.length, 1);
  assert.equal(slots[0].hours, 4);
});

test('an OT fill closes the opening', () => {
  const s = tiny();
  s.exceptions.push({ id: 'x1', employeeId: 'a', date: '2026-01-04', type: 'sick', status: 'approved' });
  s.fills.push({ id: 'f1', date: '2026-01-04', start: '06:00', hours: 12, positionId: 'tc', employeeId: 'c', type: 'voluntary', reason: 'sick' });
  assert.equal(P.openings(s, D('2026-01-04'), D('2026-01-04')).slots.length, 0);
});

test('non-solo trainees do not count toward minimums', () => {
  const s = tiny();
  s.employees[0].status = 'trainee';
  s.employees[0].soloCleared = false;
  assert.equal(P.openings(s, D('2026-01-04'), D('2026-01-04')).slots.length, 1);
  s.employees[0].soloCleared = true;
  assert.equal(P.openings(s, D('2026-01-04'), D('2026-01-04')).slots.length, 0);
});

test('fill candidates exclude people already working or without rest', () => {
  const s = tiny();
  const day = D('2026-01-04');
  const slot = { positionId: 'tc', start: day * 1440 + 6 * 60, end: day * 1440 + 18 * 60 };
  const c = P.fillCandidates(s, slot);
  const by = Object.fromEntries(c.map((x) => [x.emp.id, x]));
  assert.equal(by.a.eligible, false);           // already on that shift
  assert.equal(by.c.eligible, true);            // unassigned
  // A 1800-2200 slot: 'a' would hold over 4h (16h total) — allowed and flagged.
  const hold = P.fillCandidates(s, { positionId: 'tc', start: day * 1440 + 18 * 60, end: day * 1440 + 22 * 60 });
  const ha = hold.find((x) => x.emp.id === 'a');
  assert.equal(ha.holdover, true);
  assert.equal(ha.eligible, true);
  // ...but 6h would make it 18h straight.
  const long = P.fillCandidates(s, { positionId: 'tc', start: day * 1440 + 18 * 60, end: day * 1440 + 24 * 60 });
  assert.equal(long.find((x) => x.emp.id === 'a').eligible, false);
});

test('Pitman built-in OT depends on period length and on how the rotation aligns with the work week', () => {
  // Rotation anchored on the same Sunday the work week starts: weeks of 60h / 24h.
  const sun = tiny({ otPeriodDays: 7, otThresholdHours: 40 });
  assert.equal(P.otReport(sun, D('2026-01-04'), D('2026-01-17')).totals.byEmp.a.hours, 20);
  // Anchored one day later: weeks of 48h / 36h.
  const mon = tiny({ otPeriodDays: 7, otThresholdHours: 40 });
  mon.lines[0].anchorDate = '2026-01-05';
  assert.equal(P.otReport(mon, D('2026-01-04'), D('2026-01-17')).totals.byEmp.a.hours, 8);
  // 14-day / 80h: always 84h → 4 OT hrs regardless of alignment.
  const s14 = tiny({ otPeriodDays: 14, otThresholdHours: 80 });
  const r14 = P.otReport(s14, D('2026-01-04'), D('2026-01-17'));
  assert.equal(r14.totals.byEmp.a.hours, 4);
  assert.equal(r14.totals.byEmp.a.cost, 4 * 20 * 1.5);
});

test('FLSA mode: leave offsets an extra shift; "extra shifts always OT" mode pays it', () => {
  const s = tiny();
  // 8h 5-on/2-off: works Sun-Thu (40h). Sick Sunday, picks up an extra 8 on Friday.
  s.lines = [{ id: 'E', name: 'E', positionId: 'tc', shiftTemplateId: 't_d8', patternId: 'p_52', anchorDate: '2026-01-04', effectiveFrom: '2026-01-04', employeeId: 'a' }];
  s.exceptions.push({ id: 'x', employeeId: 'a', date: '2026-01-04', type: 'sick', status: 'approved' });
  s.fills.push({ id: 'f', date: '2026-01-09', start: '07:00', hours: 8, positionId: 'tc', employeeId: 'a', type: 'voluntary', reason: 'sick' });
  const flsa = P.otReport(s, D('2026-01-04'), D('2026-01-10'));
  assert.equal((flsa.totals.byEmp.a || { hours: 0 }).hours, 0);
  s.center.extraShiftsAlwaysOT = true;
  assert.equal(P.otReport(s, D('2026-01-04'), D('2026-01-10')).totals.byEmp.a.hours, 8);
  s.center.extraShiftsAlwaysOT = false;
  s.center.leaveCountsTowardOT = true;
  assert.equal(P.otReport(s, D('2026-01-04'), D('2026-01-10')).totals.byEmp.a.hours, 8);
});

test('generateLines spreads teams evenly across the cycle', () => {
  const s = tiny();
  const lines = P.generateLines(s, { positionId: 'tc', shiftTemplateId: 't_d12', patternId: 'p_pitman', count: 4, teams: 2, anchorDate: '2026-02-01' });
  assert.deepEqual(lines.map((l) => l.anchorDate), ['2026-02-01', '2026-02-08', '2026-02-01', '2026-02-08']);
});

test('applying a bid ends old lines and starts new ones on the effective date', () => {
  const s = tiny();
  const newLines = P.generateLines(s, { positionId: 'tc', shiftTemplateId: 't_d8', patternId: 'p_52', count: 3, teams: 3, anchorDate: '2026-03-01' })
    .map((l, i) => Object.assign(l, { id: 'bl' + i }));
  const bid = { id: 'b', positionId: 'tc', effectiveDate: '2026-03-01', status: 'open', lines: newLines, picks: {}, skipped: [] };
  assert.equal(P.currentBidder(s, bid).id, 'a'); // most senior first
  bid.picks.a = 'bl0'; bid.picks.b = 'bl1'; bid.picks.c = 'bl2';
  assert.equal(P.currentBidder(s, bid), null);
  P.applyBid(s, bid);
  assert.equal(s.lines.find((l) => l.id === 'L1').effectiveTo, '2026-02-28');
  const regs = P.regularShifts(s, D('2026-03-01'), D('2026-03-01'));
  assert.ok(regs.every((r) => r.templateId === 't_d8'));
  const before = P.regularShifts(s, D('2026-02-28'), D('2026-02-28'));
  assert.ok(before.every((r) => r.templateId === 't_d12'));
});

test('rotating patterns can switch shifts within the cycle (DuPont)', () => {
  const s = tiny();
  s.lines = [{ id: 'R', name: 'R', positionId: 'tc', shiftTemplateId: 't_d12', patternId: 'p_dupont', anchorDate: '2026-01-04', effectiveFrom: '2026-01-04', employeeId: 'a' }];
  const regs = P.regularShifts(s, D('2026-01-04'), D('2026-01-31'));
  assert.equal(regs.length, 14);
  assert.equal(regs[0].templateId, 't_n12');
  assert.ok(regs.some((r) => r.templateId === 't_d12'));
});

test('demo data builds and produces sane numbers', () => {
  const today = D('2026-11-23');
  const s = P.demoState(today);
  const sum = P.staffingSummary(s);
  assert.equal(sum[0].authorized, 28);
  assert.equal(sum[0].vacancies, 4);
  const fc = P.otForecast(s, today);
  assert.ok(fc.ytd > 0 && fc.projection >= fc.ytd);
});
