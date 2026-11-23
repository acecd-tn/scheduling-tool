const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../js/core.js');
const I = require('../js/importer.js');

const D = P.parseDate;

function center() {
  const s = P.migrate({ center: { schemaVersion: 4 }, positions: [{ id: 'law', name: 'Law' }, { id: 'fire', name: 'Fire' }], jobClasses: [{ id: 'tc', name: 'Telecommunicator', positionIds: ['law', 'fire'], authorized: 4 }] });
  s.shiftTemplates.find((t) => t.id === 't_d12').start = '07:00';
  s.shiftTemplates.find((t) => t.id === 't_n12').start = '19:00';
  s.employees = [
    { id: 'a', firstName: 'Ava', lastName: 'Adams', badge: '1001', jobClassId: 'tc', qualifications: ['law', 'fire'], status: 'active' },
    { id: 'b', firstName: 'Ben', lastName: 'Brooks', badge: '1002', jobClassId: 'tc', qualifications: ['law', 'fire'], status: 'active' },
    { id: 'c', firstName: 'Carla', lastName: 'Carter', badge: '1003', jobClassId: 'tc', qualifications: ['law'], status: 'active' },
  ];
  // Everyone also has a line (5x8 days) that the import should override for its dates.
  s.lines = s.employees.map((e) => ({ id: 'L' + e.id, jobClassId: 'tc', employeeId: e.id, shiftTemplateId: 't_d8', patternId: 'p_52', anchorDate: '2026-11-29', effectiveFrom: '2026-01-04' }));
  return s;
}

// What you get copying a schedule out of Excel: tabs, a title row, a weekday row, dates without a year.
const PASTE = [
  'Dispatch schedule\t\t\t\t\t',
  'Name\tBadge\tSun 12/27\tMon 12/28\tTue 12/29\tWed 12/30\tThu 12/31\tFri 1/1',
  '\t\tSun\tMon\tTue\tWed\tThu\tFri',
  'Adams, Ava\t1001\tD\tD\tOFF\tN\tN\tV',
  'Brooks Ben\t\t0700-1900\t\tVAC\t1900-0700\t\tD',
  'C. Carter\t\tN\tN\t\t\tSL\tTRN',
  'Total on duty\t\t3\t2\t0\t2\t1\t2',
].join('\n');

test('reads a pasted grid: title and weekday rows skipped, years rolled over Dec -> Jan', () => {
  const rows = I.parseTable(PASTE);
  const g = I.detectGrid(rows, { today: D('2026-11-23') });
  assert.equal(g.error, undefined);
  assert.deepEqual(g.dates.map((x) => P.fmtDate(x.day)), ['2026-12-27', '2026-12-28', '2026-12-29', '2026-12-30', '2026-12-31', '2027-01-01']);
  assert.deepEqual(g.people.map((p) => p.name), ['Adams, Ava', 'Brooks Ben', 'C. Carter', 'Total on duty']);
  assert.equal(g.people[0].badge, '1001');
});

test('date formats: ISO, US, month names, weekday prefixes, Excel serials', () => {
  const r = I.readDateRow(['2027-02-01', '2/2/2027', '3-Feb-27', 'Feb 4', 'Thu 2/5', '46793'], { today: D('2026-11-23') });
  assert.deepEqual(r.map((d) => d && P.fmtDate(d)), ['2027-02-01', '2027-02-02', '2027-02-03', '2027-02-04', '2027-02-05', '2028-02-10']);
  assert.deepEqual(I.readTimeRange('0700-1900'), { start: 420, hours: 12 });
  assert.deepEqual(I.readTimeRange('7p-7a'), { start: 1140, hours: 12 });
  assert.deepEqual(I.readTimeRange('15:00 - 23:00'), { start: 900, hours: 8 });
});

test('matches people by badge, "Last, First", "First Last", initial + last; skips totals rows', () => {
  const s = center();
  const g = I.detectGrid(I.parseTable(PASTE), { today: D('2026-11-23') });
  const m = I.matchPeople(s, g.people);
  assert.deepEqual([0, 1, 2, 3].map((i) => m[i].employeeId), ['a', 'b', 'c', null]);
});

test('guesses codes: off, time ranges to existing shifts, leave aliases; unknown left for the user', () => {
  const s = center();
  const g = I.detectGrid(I.parseTable(PASTE), { today: D('2026-11-23') });
  const codes = Object.fromEntries(I.guessCodes(s, g).map((c) => [c.key, c.mapping]));
  assert.equal(codes.off.kind, 'off');
  assert.deepEqual(codes['0700-1900'], { kind: 'shift', templateId: 't_d12' });
  assert.deepEqual(codes['1900-0700'], { kind: 'shift', templateId: 't_n12' });
  assert.deepEqual(codes.vac, { kind: 'leave', leaveType: 'vacation' });
  assert.deepEqual(codes.sl, { kind: 'leave', leaveType: 'sick' });
  assert.deepEqual(codes.trn, { kind: 'leave', leaveType: 'training' });
  assert.equal(codes.d.kind, 'ignore');       // "D" — the user says what it means
});

test('import replaces lines for the imported dates; lines resume after; undo restores', () => {
  const s = center();
  const g = I.detectGrid(I.parseTable(PASTE), { today: D('2026-11-23') });
  const m = I.matchPeople(s, g.people);
  const match = Object.fromEntries(Object.entries(m).map(([i, x]) => [i, x.employeeId]));
  const codes = Object.fromEntries(I.guessCodes(s, g).map((c) => [c.key, c.mapping]));
  codes.d = { kind: 'shift', templateId: 't_d12' };
  codes.n = { kind: 'shift', templateId: 't_n12' };
  const built = I.buildImport(s, g, match, codes, { name: 'Holiday schedule' });
  assert.equal(built.stats.people, 3);
  assert.equal(built.stats.skippedPeople, 1);
  I.applyImport(s, built);
  const shifts = (day) => P.regularShifts(s, day, day).map((r) => `${r.employeeId}:${r.templateId}`).sort();
  // 12/27: Adams D, Brooks 0700-1900 (= D12), Carter N. No 8-hour line shifts.
  assert.deepEqual(shifts(D('2026-12-27')), ['a:t_d12', 'b:t_d12', 'c:t_n12']);
  // 12/29: Adams off, Brooks on vacation (usual shift D12 + approved leave), Carter blank.
  assert.deepEqual(shifts(D('2026-12-29')), ['b:t_d12']);
  const wi = P.workIntervals(s, D('2026-12-29'), D('2026-12-29'));
  assert.equal(wi.intervals.filter((iv) => iv.day === D('2026-12-29')).length, 0);
  assert.equal(wi.leave.filter((l) => l.day === D('2026-12-29'))[0].type, 'vacation');
  // After the import ends, lines take over again.
  assert.ok(P.regularShifts(s, D('2027-01-04'), D('2027-01-04')).every((r) => r.templateId === 't_d8'));
  // Undo puts the lines back for those dates.
  I.undoImport(s, built.record.id);
  assert.ok(shifts(D('2026-12-27')).every((x) => x.endsWith('t_d8')));
  assert.equal(s.exceptions.filter((e) => e.importId).length, 0);
});

test('re-importing the same dates replaces the earlier import\'s days', () => {
  const s = center();
  const g = I.detectGrid(I.parseTable(PASTE), { today: D('2026-11-23') });
  const match = { 0: 'a', 1: 'b', 2: 'c' };
  const codes = Object.fromEntries(I.guessCodes(s, g).map((c) => [c.key, c.mapping]));
  codes.d = { kind: 'shift', templateId: 't_d12' };
  codes.n = { kind: 'shift', templateId: 't_n12' };
  I.applyImport(s, I.buildImport(s, g, match, codes));
  const n1 = s.assignments.length;
  I.applyImport(s, I.buildImport(s, g, match, codes));
  assert.equal(s.assignments.length, n1);
  assert.equal(P.regularShifts(s, D('2026-12-27'), D('2026-12-27')).length, 3);
});
