const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../js/core.js');
const A = require('../js/actions.js');

const D = P.parseDate;
const ctx = { today: D('2026-01-01'), now: '2026-01-01T00:00:00Z' };
const sup = { userId: 'u_sup', role: 'supervisor', employeeId: null };
const as = (empId) => ({ userId: 'u_' + empId, role: 'employee', employeeId: empId });

/** Three people on 5x8 days: a works Sun-Thu, b Tue-Sat, c Thu-Mon. */
function center() {
  const s = P.emptyState();
  s.positions = [{ id: 'tc', name: 'TC', authorized: 3 }];
  P.migrate(s);
  s.employees = ['a', 'b', 'c'].map((id, i) => ({ id, firstName: id, lastName: id.toUpperCase(), positionId: 'tc', status: 'active', hourlyRate: 20, seniorityDate: `200${i}-01-01`, qualifications: [] }));
  s.lines = ['a', 'b', 'c'].map((id, i) => ({ id: 'L' + id, name: id, positionId: 'tc', shiftTemplateId: 't_d8', patternId: 'p_52', anchorDate: P.fmtDate(D('2026-01-04') + i * 2), effectiveFrom: '2026-01-04', employeeId: id }));
  for (const row of s.minimums.tc) for (let h = 7; h < 15; h++) row[h] = 1;
  return s;
}

test('employees can only request leave for themselves; supervisors decide', () => {
  const s = center();
  const r = A.run(s, as('a'), 'requestLeave', { employeeId: 'b', date: '2026-01-05', type: 'vacation' }, ctx);
  const e = s.exceptions.find((x) => x.id === r.id);
  assert.equal(e.employeeId, 'a');
  assert.equal(e.status, 'pending');
  assert.throws(() => A.run(s, as('a'), 'decideLeave', { id: e.id, status: 'approved' }, ctx), /Supervisor/);
  A.run(s, sup, 'decideLeave', { id: e.id, status: 'approved' }, ctx);
  assert.equal(e.status, 'approved');
  assert.ok(s.notifications.some((n) => n.employeeId === 'a' && /approved/.test(n.title)));
  assert.throws(() => A.run(s, as('a'), 'cancelRequest', { id: e.id }, ctx), /pending/);
});

test('shift trade: propose → accept → approve puts the partner on at straight time', () => {
  const s = center();
  // a works Sun 1/4; c is off Sun? c's line starts 1/8, so c works Thu-Mon: Sun 1/4 is index -4 → day 3 of cycle → works. Use b (Tue-Sat; Sun off).
  const t = A.run(s, as('a'), 'proposeTrade', { partnerId: 'b', date: '2026-01-04' }, ctx);
  assert.throws(() => A.run(s, as('c'), 'respondTrade', { id: t.id, accept: true }, ctx), /not sent to you/);
  A.run(s, as('b'), 'respondTrade', { id: t.id, accept: true }, ctx);
  assert.equal(s.trades[0].status, 'accepted');
  A.run(s, sup, 'decideTrade', { id: t.id, approve: true }, ctx);
  const day = D('2026-01-04');
  const cov = P.coverage(s, day, day, { keepAssign: true });
  assert.equal(cov.assign[8].b, 'tc');
  assert.equal(cov.assign[8].a, undefined);
  assert.equal(P.otReport(s, day, day + 6).totals.hours, 0);
  // Cancelling removes the generated records.
  A.run(s, sup, 'cancelTrade', { id: t.id }, ctx);
  assert.equal(s.fills.length, 0);
});

test('trade is refused if the partner is already working', () => {
  const s = center();
  // a and c both work Mon 1/5.
  assert.throws(() => A.run(s, as('a'), 'proposeTrade', { partnerId: 'c', date: '2026-01-05' }, ctx), /Already working/);
});

test('first-come posting is awarded to the first eligible volunteer', () => {
  const s = center();
  const po = A.run(s, sup, 'postOpening', { positionId: 'tc', date: '2026-01-04', start: '15:00', hours: 4, mode: 'first' }, ctx);
  // a works 0700-1500 Sun: a 4h holdover is legal.
  A.run(s, as('a'), 'volunteer', { id: po.id }, ctx);
  const p = s.postings[0];
  assert.equal(p.status, 'awarded');
  assert.equal(p.awardedTo, 'a');
  assert.equal(s.fills[0].type, 'holdover');
  assert.throws(() => A.run(s, as('b'), 'volunteer', { id: po.id }, ctx), /no longer available/);
});

test('list-mode posting collects volunteers until a supervisor awards', () => {
  const s = center();
  const po = A.run(s, sup, 'postOpening', { positionId: 'tc', date: '2026-01-04', start: '15:00', hours: 4 }, ctx);
  A.run(s, as('a'), 'volunteer', { id: po.id }, ctx);
  A.run(s, as('b'), 'volunteer', { id: po.id }, ctx);
  assert.equal(s.postings[0].status, 'open');
  A.run(s, sup, 'awardPosting', { id: po.id, employeeId: 'b' }, ctx);
  assert.equal(s.fills[0].employeeId, 'b');
  assert.ok(s.notifications.some((n) => n.employeeId === 'a' && /filled/.test(n.title)));
});

test('vacation bid: seniority turns, per-discipline daily cap, rounds', () => {
  const s = center();
  s.vacationBids.push({ id: 'vb', name: 'VB', from: '2026-02-01', to: '2026-12-31', jobClassIds: ['jc_tc'], rounds: 2, maxDaysPerPick: 5, pickUnit: 'shifts', caps: { jc_tc: 1 }, status: 'draft', picks: [] });
  A.run(s, sup, 'vacOpen', { bidId: 'vb' }, ctx);
  assert.equal(A.vacTurn(s, s.vacationBids[0]).employee.id, 'a');
  assert.throws(() => A.run(s, as('b'), 'vacPick', { bidId: 'vb', from: '2026-03-01', to: '2026-03-07' }, ctx), /not your turn/);
  A.run(s, as('a'), 'vacPick', { bidId: 'vb', from: '2026-03-01', to: '2026-03-07' }, ctx);
  // b overlaps a's week: cap of 1 per day for the discipline.
  assert.throws(() => A.run(s, as('b'), 'vacPick', { bidId: 'vb', from: '2026-03-05', to: '2026-03-10' }, ctx), /limit/);
  A.run(s, as('b'), 'vacPick', { bidId: 'vb', from: '2026-03-08', to: '2026-03-14' }, ctx);
  A.run(s, as('c'), 'vacPass', { bidId: 'vb' }, ctx);
  assert.equal(A.vacTurn(s, s.vacationBids[0]).round, 2);
  assert.equal(s.exceptions.filter((x) => x.vacationBidId === 'vb' && x.status === 'approved').length, 2);
});

test('shift bid: employees pick only on their own turn', () => {
  const s = center();
  s.bids.push({ id: 'b1', name: 'Bid', positionId: 'tc', effectiveDate: '2026-03-01', status: 'open', lines: [{ id: 'x1' }, { id: 'x2' }, { id: 'x3' }], picks: {}, skipped: [] });
  assert.throws(() => A.run(s, as('b'), 'shiftBidPick', { bidId: 'b1', lineId: 'x1' }, ctx), /not your turn/);
  A.run(s, as('a'), 'shiftBidPick', { bidId: 'b1', lineId: 'x2' }, ctx);
  assert.throws(() => A.run(s, as('b'), 'shiftBidPick', { bidId: 'b1', lineId: 'x2' }, ctx), /taken/);
  assert.ok(s.notifications.some((n) => n.employeeId === 'b' && /turn/.test(n.title)));
});

test('vacation pick limit counts scheduled workdays (5 = a full week off on 5x8)', () => {
  const s = center();
  s.vacationBids.push({ id: 'vb', name: 'VB', from: '2026-02-01', to: '2026-12-31', jobClassIds: ['jc_tc'], rounds: 1, maxDaysPerPick: 5, pickUnit: 'shifts', caps: {}, status: 'draft', picks: [] });
  A.run(s, sup, 'vacOpen', { bidId: 'vb' }, ctx);
  // a works Sun-Thu: 2026-03-01 (Sun) .. 03-07 (Sat) = 5 workdays → allowed.
  assert.throws(() => A.run(s, as('a'), 'vacPick', { bidId: 'vb', from: '2026-03-01', to: '2026-03-09' }, ctx), /5 scheduled workdays/);
  A.run(s, as('a'), 'vacPick', { bidId: 'vb', from: '2026-03-01', to: '2026-03-07' }, ctx);
});

test('mandatory list: longest since any OT first, then least senior', () => {
  const s = center();
  // a (most senior) and b both off Sun? a works Sun; use a Saturday 15:00-19:00 slot: a off, b works Sat 0700-1500 (holdover), c works Sat.
  s.employees.push({ id: 'd', firstName: 'd', lastName: 'D', positionId: 'tc', status: 'active', hourlyRate: 20, seniorityDate: '2010-01-01', qualifications: [] });
  s.employees.push({ id: 'e', firstName: 'e', lastName: 'E', positionId: 'tc', status: 'active', hourlyRate: 20, seniorityDate: '2015-01-01', qualifications: [] });
  s.fills.push({ id: 'f1', date: '2026-01-02', start: '07:00', hours: 8, positionId: 'tc', employeeId: 'e', type: 'voluntary' });
  s.fills.push({ id: 'f2', date: '2025-12-01', start: '07:00', hours: 8, positionId: 'tc', employeeId: 'a', type: 'voluntary' });
  const day = D('2026-01-10');
  const order = P.fillCandidates(s, { positionId: 'tc', start: day * 1440 + 15 * 60, end: day * 1440 + 19 * 60 }, { order: 'mandatory' })
    .filter((c) => c.eligible).map((c) => c.emp.id);
  // d never worked OT (first among never-OT by least senior: d 2010 vs others), then a (Dec), then e (Jan).
  assert.deepEqual(order.filter((x) => ['a', 'd', 'e'].includes(x)), ['d', 'a', 'e']);
});
