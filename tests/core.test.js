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
  // A 42-hour pattern, kept here only to test built-in OT detection.
  s.patterns.push({ id: 'p_pitman', name: 'Pitman', cycle: [1, 1, 0, 0, 1, 1, 1, 0, 0, 1, 1, 0, 0, 0] });
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

test('mixed 12/8 pattern switches shifts within the cycle and stays at 40 h every week', () => {
  const s = tiny();
  s.lines = [{ id: 'R', name: 'R', positionId: 'tc', shiftTemplateId: 't_d12', patternId: 'p_12d8', anchorDate: '2026-01-04', effectiveFrom: '2026-01-04', employeeId: 'a' }];
  const regs = P.regularShifts(s, D('2026-01-04'), D('2026-01-10'));
  assert.deepEqual(regs.map((r) => r.templateId), ['t_d12', 't_d12', 't_d8', 't_d8']);
});

test('every default pattern is OT-free under a 7-day/40-hour rule, at any alignment', () => {
  const s = tiny();
  const tplFor = { p_52: 't_d8', p_410: 't_p10', p_12d8: 't_d12', p_12n8: 't_n12', p_3x12: 't_d12' };
  for (const [pat, tpl] of Object.entries(tplFor)) {
    const r = P.patternBuiltInOT(s, tpl, pat, D('2026-01-04'));
    assert.equal(r.max, 0, pat);
  }
  // ...and a 12-hour line on 5-on/2-off is flagged.
  assert.ok(P.patternBuiltInOT(s, 't_d12', 'p_52', D('2026-01-04')).min > 0);
});

test('console assignment: cross-trained staff are placed where they are needed', () => {
  const s = P.emptyState();
  s.positions = [{ id: 'law', name: 'Law', priority: 1 }, { id: 'ct', name: 'CT', priority: 2 }];
  P.migrate(s);
  for (const pid of ['law', 'ct']) for (const row of s.minimums[pid]) row.fill(1);
  // Both people are home 'ct'; one is also certified on law.
  s.employees = [
    { id: 'x', firstName: 'x', lastName: 'X', positionId: 'ct', status: 'active', qualifications: ['law'] },
    { id: 'y', firstName: 'y', lastName: 'Y', positionId: 'ct', status: 'active', qualifications: [] },
  ];
  const ln = (id, emp) => ({ id, name: id, positionId: 'ct', shiftTemplateId: 't_d8', patternId: 'p_52', anchorDate: '2026-01-04', effectiveFrom: '2026-01-04', employeeId: emp });
  s.lines = [ln('a', 'x'), ln('b', 'y')];
  const day = D('2026-01-04');
  const cov = P.coverage(s, day, day, { keepAssign: true });
  assert.equal(cov.staffed.law[8], 1);
  assert.equal(cov.staffed.ct[8], 1);
  assert.equal(cov.assign[8].x, 'law');
  // Home-only counting would leave law empty.
  s.center.coverageMode = 'home';
  assert.equal(P.coverage(s, day, day).staffed.law[8], 0);
  s.center.coverageMode = 'assigned';
  // Priority: with only 'x' on duty, the higher-priority law seat is the one filled.
  s.exceptions.push({ id: 'e', employeeId: 'y', date: '2026-01-04', type: 'sick', status: 'approved' });
  const { slots } = P.openings(s, day, day);
  assert.ok(slots.every((sl) => sl.positionId === 'ct' || sl.start % 1440 < 7 * 60 || sl.start % 1440 >= 15 * 60));
  // A supervisor pin keeps 'x' on call-taking; law becomes the opening.
  s.pins.push({ id: 'p', date: '2026-01-04', employeeId: 'x', positionId: 'ct' });
  const c2 = P.coverage(s, day, day);
  assert.equal(c2.staffed.law[8], 0);
  assert.equal(c2.staffed.ct[8], 1);
});

test('shift trades: partner works at straight time and nobody earns OT from it', () => {
  const s = tiny();
  // Both on 5x8, 40 h; 'c' takes 'a's Sunday shift as a trade.
  s.lines = [
    { id: 'E', name: 'E', positionId: 'tc', shiftTemplateId: 't_d8', patternId: 'p_52', anchorDate: '2026-01-04', effectiveFrom: '2026-01-04', employeeId: 'a' },
    { id: 'F', name: 'F', positionId: 'tc', shiftTemplateId: 't_d8', patternId: 'p_52', anchorDate: '2026-01-05', effectiveFrom: '2026-01-04', employeeId: 'c' },
  ];
  s.exceptions.push({ id: 'tx', employeeId: 'a', date: '2026-01-04', type: 'trade', status: 'approved' });
  s.fills.push({ id: 'tf', date: '2026-01-04', start: '07:00', hours: 8, positionId: 'tc', employeeId: 'c', type: 'trade', reason: 'trade' });
  const r = P.otReport(s, D('2026-01-04'), D('2026-01-10'));
  assert.equal(r.totals.hours, 0);
});

test('privacy filter hides other employees\' leave reasons and pay', () => {
  const s = tiny();
  s.exceptions.push({ id: 'x1', employeeId: 'a', date: '2026-01-04', type: 'family', status: 'approved', note: 'medical' });
  s.exceptions.push({ id: 'x2', employeeId: 'b', date: '2026-01-05', type: 'vacation', status: 'pending' });
  const f = P.filterStateFor(s, { role: 'employee', employeeId: 'b' });
  assert.equal(f.exceptions.find((x) => x.id === 'x1').type, 'leave');
  assert.equal(f.exceptions.find((x) => x.id === 'x1').note, '');
  assert.equal(f.exceptions.find((x) => x.id === 'x2').type, 'vacation');
  // Another person's vacation stays visible (for vacation-bid limits); their sick time does not.
  const g = P.filterStateFor(s, { role: 'employee', employeeId: 'c' });
  assert.equal(g.exceptions.find((x) => x.id === 'x2').type, 'vacation');
  assert.equal(g.exceptions.find((x) => x.id === 'x1').type, 'leave');
  assert.equal(f.employees.find((e) => e.id === 'a').hourlyRate, 0);
  assert.equal(f.employees.find((e) => e.id === 'b').hourlyRate, 20);
});

test('diffState / applyDiff round-trip', () => {
  const a = tiny();
  const b = JSON.parse(JSON.stringify(a));
  b.employees[0].lastName = 'Changed';
  b.fills.push({ id: 'n', date: '2026-01-04', start: '06:00', hours: 4, positionId: 'tc', employeeId: 'c' });
  b.lines = b.lines.filter((l) => l.id !== 'L2');
  b.center.minRestHours = 10;
  const d = P.diffState(a, b);
  assert.deepEqual(Object.keys(d.upserts).sort(), ['employees', 'fills']);
  assert.deepEqual(d.deletes.lines, ['L2']);
  const c = P.applyDiff(JSON.parse(JSON.stringify(a)), d);
  assert.equal(JSON.stringify(P.diffState(b, c)), JSON.stringify({ upserts: {}, deletes: {}, config: {} }));
});

test('part-time: extra shifts at straight time, ranked first, capped, not forced', () => {
  const s = tiny();
  s.center.extraShiftsAlwaysOT = true; // full-timers would be paid OT for any extra shift
  s.lines = [{ id: 'E', name: 'E', positionId: 'tc', shiftTemplateId: 't_d8', patternId: 'p_52', anchorDate: '2026-01-04', effectiveFrom: '2026-01-04', employeeId: 'a' }];
  Object.assign(s.employees[2], { employmentType: 'part', maxWeeklyHours: 20, hourlyRate: 18 }); // 'c' is part-time
  const day = D('2026-01-10'); // Saturday: 'a' is off
  const slot = { positionId: 'tc', start: day * 1440 + 7 * 60, end: day * 1440 + 15 * 60 };
  const vol = P.fillCandidates(s, slot).filter((x) => x.eligible);
  assert.equal(vol[0].emp.id, 'c');                 // part-timer first
  assert.equal(vol[0].cost, 8 * 18);                // straight time
  assert.ok(vol.find((x) => x.emp.id === 'a').cost > 8 * 20); // full-timer is OT
  const forced = P.fillCandidates(s, slot, { order: 'mandatory' });
  assert.equal(forced.find((x) => x.emp.id === 'c').eligible, false); // part-timers are never forced
  // Cap: 16 h already this week, another 8 would make 24 > 20.
  s.fills.push({ id: 'p1', date: '2026-01-05', start: '07:00', hours: 8, positionId: 'tc', employeeId: 'c', type: 'voluntary', reason: 'sick' });
  s.fills.push({ id: 'p2', date: '2026-01-06', start: '07:00', hours: 8, positionId: 'tc', employeeId: 'c', type: 'voluntary', reason: 'sick' });
  const capped = P.fillCandidates(s, slot).find((x) => x.emp.id === 'c');
  assert.equal(capped.eligible, false);
  assert.match(capped.issues.join(), /Part-time cap: 24 of 20/);
  // OT report: the part-timer's 16 extra hours are straight time and counted as OT avoided.
  const r = P.otReport(s, D('2026-01-04'), D('2026-01-10'));
  assert.equal((r.totals.byEmp.c || { hours: 0 }).hours, 0);
  assert.equal(r.totals.partTime.hours, 16);
  assert.equal(r.totals.partTime.cost, 16 * 18);
  assert.ok(r.totals.partTime.avoided > 0);
});

test('staffing: authorized counts full-time; part-timers shown as FTE', () => {
  const s = tiny();
  Object.assign(s.employees[2], { employmentType: 'part', maxWeeklyHours: 20 });
  s.jobClasses[0].authorizedPartTime = 2;
  const r = P.staffingSummary(s)[0];
  assert.equal(r.authorizedPart, 2);
  assert.equal(r.partVacancies, 1);
  assert.equal(r.fullTime, 2);
  assert.equal(r.partTime, 1);
  assert.equal(r.vacancies, 1); // authorized 3, two full-time
  assert.equal(r.partFTE, 0.5);
  assert.equal(r.countableFTE, 2.5);
});

test('part-time cap defaults to 32; older saved data moves from the old 29 default', () => {
  const s = tiny();
  Object.assign(s.employees[2], { employmentType: 'part' });
  assert.equal(P.partTimeCap(s, s.employees[2]), 32);
  const old = P.migrate({ version: 1, center: { partTimeDefaultCap: 29, partTimeMandatory: true } });
  assert.equal(old.center.partTimeDefaultCap, 32);
  assert.equal(old.center.partTimeMandatory, undefined);
  const custom = P.migrate({ version: 1, center: { partTimeDefaultCap: 24 } });
  assert.equal(custom.center.partTimeDefaultCap, 24);
  // Runs once: a deliberate 29 after the upgrade is kept (the server reloads without the top-level version).
  const later = P.migrate({ center: Object.assign({}, old.center, { partTimeDefaultCap: 29 }) });
  assert.equal(later.center.partTimeDefaultCap, 29);
});

test('job classes: one class staffs several consoles; authorized, bids and leave limits are by class', () => {
  const s = P.emptyState();
  s.positions = [{ id: 'law', name: 'Law', authorized: 18 }, { id: 'fire', name: 'Fire/EMS', authorized: 18 }, { id: 'sup', name: 'Supervisor', authorized: 4 }];
  P.migrate(s);
  // Converted: one class per console, carrying the console's authorized count.
  assert.deepEqual(s.jobClasses.map((c) => [c.id, c.authorized]), [['jc_law', 18], ['jc_fire', 18], ['jc_sup', 4]]);
  // Center merges Fire/EMS into Telecommunicator.
  const tc = s.jobClasses[0];
  Object.assign(tc, { name: 'Telecommunicator', positionIds: ['law', 'fire'], authorized: 18, maxOffPerDay: 1 });
  s.jobClasses = s.jobClasses.filter((c) => c.id !== 'jc_fire');
  s.employees = [
    { id: 'a', firstName: 'a', lastName: 'A', positionId: 'law', status: 'active', qualifications: ['fire'], seniorityDate: '2001-01-01' },
    { id: 'b', firstName: 'b', lastName: 'B', positionId: 'law', status: 'active', qualifications: ['fire'], seniorityDate: '2002-01-01' },
    { id: 'c', firstName: 'c', lastName: 'C', positionId: 'fire', status: 'active', qualifications: [], seniorityDate: '2000-01-01' },
    { id: 's', firstName: 's', lastName: 'S', positionId: 'sup', status: 'active', qualifications: [] },
  ];
  const sum = P.staffingSummary(s);
  assert.deepEqual(sum.map((r) => [r.jobClass.name, r.authorized, r.fullTime, r.vacancies]), [['Telecommunicator', 18, 3, 15], ['Supervisor', 4, 1, 3]]);
  // A bid for either console includes the whole class, by seniority.
  assert.deepEqual(P.bidOrder(s, { positionId: 'law' }).map((e) => e.id), ['c', 'a', 'b']);
  assert.deepEqual(P.bidOrder(s, { positionId: 'fire' }).map((e) => e.id), ['c', 'a', 'b']);
  // Leave limit counts the class: law + fire together, 1 per day.
  s.exceptions.push({ id: 'v1', employeeId: 'c', date: '2026-03-02', type: 'vacation', status: 'approved' });
  const req = { id: 'v2', employeeId: 'a', date: '2026-03-02', type: 'vacation', status: 'pending' };
  s.exceptions.push(req);
  assert.equal(P.overLeaveLimit(s, req).length, 1);
  assert.deepEqual([...P.plannedLeaveOn(s, D('2026-03-02'), 'jc_law')].sort(), ['a', 'c']);
});

test('conversion moves vacation-bid caps and lists from consoles to job classes', () => {
  const s = P.migrate({
    positions: [{ id: 'law', name: 'Law', authorized: 10 }],
    center: { maxOffPerDay: { law: 2 } },
    vacationBids: [{ id: 'vb', positionIds: ['law'], caps: { law: 1 } }],
  });
  assert.equal(s.jobClasses[0].maxOffPerDay, 2);
  assert.deepEqual(s.vacationBids[0].jobClassIds, ['jc_law']);
  assert.deepEqual(s.vacationBids[0].caps, { jc_law: 1 });
  // Runs once: migrating again doesn't double-prefix.
  const again = P.migrate(JSON.parse(JSON.stringify(s)));
  assert.deepEqual(again.vacationBids[0].caps, { jc_law: 1 });
  assert.equal(again.jobClasses.length, 1);
});

test('a console in no job class acts as its own class', () => {
  const s = P.migrate({ positions: [{ id: 'x', name: 'X' }], center: { schemaVersion: 3 } });
  s.positions.push({ id: 'y', name: 'Y', authorized: 5 });
  const cls = P.jobClasses(s);
  assert.deepEqual(cls.map((c) => c.positionIds), [['x'], ['y']]);
  assert.equal(P.jobClassOf(s, 'y').authorized, 5);
});

test('v4 conversion: job class on every employee, line and bid; console becomes a preference', () => {
  const s = P.migrate({
    center: { schemaVersion: 3 },
    positions: [{ id: 'law', name: 'Law' }, { id: 'fire', name: 'Fire/EMS' }, { id: 'sup', name: 'Supervisor' }],
    jobClasses: [
      { id: 'tc', name: 'Telecommunicator', positionIds: ['law', 'fire'], authorized: 18 },
      { id: 'sv', name: 'Supervisor', positionIds: ['sup'], authorized: 4 },
    ],
    employees: [
      { id: 'a', firstName: 'a', lastName: 'A', positionId: 'law', qualifications: ['fire'], status: 'active' },
      { id: 'b', firstName: 'b', lastName: 'B', positionId: 'fire', qualifications: [], status: 'active' },
      { id: 's', firstName: 's', lastName: 'S', positionId: 'sup', status: 'active' },
    ],
    lines: [{ id: 'L1', positionId: 'law', employeeId: 'a', shiftTemplateId: 't_d8', patternId: 'p_52', effectiveFrom: '2026-01-04' }],
    bids: [{ id: 'B1', positionId: 'fire', lines: [{ id: 'bl', positionId: 'fire' }] }],
  });
  assert.deepEqual(s.employees.map((e) => [e.id, e.jobClassId, e.positionId, e.qualifications.join('+')]),
    [['a', 'tc', 'law', 'law+fire'], ['b', 'tc', 'fire', 'fire'], ['s', 'sv', 'sup', 'sup']]);
  assert.equal(s.lines[0].jobClassId, 'tc');
  assert.equal(s.lines[0].positionId, null);        // nobody tied to a console by their line
  assert.equal(s.bids[0].jobClassId, 'tc');
  assert.equal(s.bids[0].lines[0].jobClassId, 'tc');
  assert.equal(s.center.schemaVersion, 4);
  // Runs once.
  s.employees[0].jobClassId = 'sv';
  assert.equal(P.migrate(s).employees[0].jobClassId, 'sv');
});

test('job class is the position: staffing, lines and bids follow the explicit job class, not a console', () => {
  const s = P.migrate({
    center: { schemaVersion: 4 },
    positions: [{ id: 'law', name: 'Law', priority: 1 }, { id: 'fire', name: 'Fire', priority: 2 }],
    jobClasses: [{ id: 'tc', name: 'Telecommunicator', positionIds: ['law', 'fire'], authorized: 3 }, { id: 'ct', name: 'Call-taker', positionIds: [], authorized: 1 }],
  });
  for (const pid of ['law', 'fire']) for (const row of s.minimums[pid]) for (let h = 7; h < 15; h++) row[h] = 1;
  s.employees = [
    // No preferred console at all: placed purely by certification.
    { id: 'a', firstName: 'a', lastName: 'A', jobClassId: 'tc', positionId: null, qualifications: ['law', 'fire'], status: 'active', seniorityDate: '2001-01-01' },
    { id: 'b', firstName: 'b', lastName: 'B', jobClassId: 'tc', positionId: null, qualifications: ['law', 'fire'], status: 'active', seniorityDate: '2002-01-01' },
    // Different job class, but certified on Fire: a candidate for Fire openings.
    { id: 'c', firstName: 'c', lastName: 'C', jobClassId: 'ct', positionId: null, qualifications: ['fire'], status: 'active', seniorityDate: '2000-01-01' },
  ];
  s.lines = P.generateLines(s, { jobClassId: 'tc', shiftTemplateId: 't_d8', patternId: 'p_52', count: 2, teams: 1, anchorDate: '2026-01-04', effectiveFrom: '2026-01-04' });
  assert.ok(s.lines.every((l) => l.jobClassId === 'tc' && l.positionId === null));
  s.lines[0].employeeId = 'a'; s.lines[1].employeeId = 'b';
  const day = D('2026-01-04');
  const cov = P.coverage(s, day, day, { keepAssign: true });
  assert.equal(cov.staffed.law[8], 1);
  assert.equal(cov.staffed.fire[8], 1);
  // Staffing is by job class.
  const sum = P.staffingSummary(s);
  assert.deepEqual(sum.map((r) => [r.jobClass.name, r.fullTime, r.vacancies]), [['Telecommunicator', 2, 1], ['Call-taker', 1, 0]]);
  // Fire opening: candidates come from any job class certified on Fire.
  s.exceptions.push({ id: 'x', employeeId: 'b', date: '2026-01-04', type: 'sick', status: 'approved' });
  const slot = P.openings(s, day, day).slots[0];
  assert.ok(slot);
  const cands = P.fillCandidates(s, slot).map((c) => c.emp.id);
  assert.ok(cands.includes('c'));
  // A bid for the job class: bidders are the class; preview totals both consoles.
  const bid = { id: 'bd', jobClassId: 'tc', effectiveDate: '2026-02-01', lines: P.generateLines(s, { jobClassId: 'tc', shiftTemplateId: 't_d8', patternId: 'p_52', count: 3, teams: 1, anchorDate: '2026-02-01' }), picks: { a: null }, skipped: [] };
  assert.deepEqual(P.bidOrder(s, bid).map((e) => e.id), ['a', 'b']);
  const prev = P.previewLines(s, 'tc', bid.lines, D('2026-02-01'), 7);
  assert.deepEqual(prev.consoles, ['law', 'fire']);
  assert.equal(prev.cov.staffed.law[8] + prev.cov.staffed.fire[8], 3);
  bid.picks = { a: bid.lines[0].id, b: bid.lines[1].id };
  P.applyBid(s, bid);
  assert.equal(s.lines.filter((l) => l.jobClassId === 'tc' && !l.effectiveTo).length, 3);
  assert.equal(s.lines.filter((l) => l.effectiveTo === '2026-01-31').length, 2);
});

test('demo data builds and produces sane numbers', () => {
  const today = D('2026-11-23');
  const s = P.demoState(today);
  const sum = P.staffingSummary(s);
  assert.deepEqual(sum.map((r) => r.jobClass.name), ['Call-taker', 'Telecommunicator', 'Supervisor']);
  assert.equal(sum[0].vacancies, 3);
  const fc = P.otForecast(s, today);
  assert.ok(fc.ytd > 0 && fc.projection >= fc.ytd);
  assert.ok(!fc.full.totals.byReason['built-in'], 'demo rotation should build in no OT');
});
