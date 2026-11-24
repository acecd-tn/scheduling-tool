const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const P = require('../js/core.js');
const T = require('../js/template.js');
const X = require('../js/xlsx.js');
const B = require('../js/balancer.js');

const D = P.parseDate;
const hdr = ['Employee', 'Week', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun', 'Hours Worked'];
// A 2-week template like a typical 12-hour dispatch schedule (Monday-Sunday weeks).
const DAYS = [
  ['Days  (0700 - 1900)\nOct 5, 2026 – Oct 18, 2026'], [],
  ['Employee', 'Week', 'Mon\nOct 5 / Oct 12', 'Tue\nOct 6 / Oct 13', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun', 'Hours Worked'],
  ['Day 1', 'Week 1', 'Work', '1100-1500', 'RDO', 'RDO', 'RDO', 'Work', 'Work', '40'],
  ['', 'Week 2', 'Work', 'Work', 'Work', 'RDO', 'RDO', 'RDO', 'Work', '48'],
  [],
  ['Day 2', 'Week 1', 'Work', 'Work', 'Work', 'Work', 'RDO', 'RDO', 'RDO', '48'],
  ['', 'Week 2', 'RDO', 'Work', '1100-1500', 'Work', 'Work', 'RDO', 'RDO', '40'],
  ['Day 3', 'Week 1', 'RDO', 'RDO', 'RDO', 'Work', 'Work', 'Work', 'Work', '48'],
  ['', 'Week 2', 'Work', 'RDO', 'RDO', 'RDO', '1100-1500', 'Work', 'Work', '40'],
  ['Day 4', 'Week 1', 'Work', 'Work', 'RDO', 'RDO', 'RDO', 'Work', 'Work', '48'],
  ['', 'Week 2', '1100-1500', 'Work', 'Work', 'RDO', 'RDO', 'RDO', 'Work', '40'],
  ['Day 5', 'Week 1', 'RDO', 'RDO', 'Work', 'Work', 'Work', '1100-1500', 'RDO', '40'],
  ['', 'Week 2', 'Work', 'RDO', 'RDO', 'Work', 'Work', 'Work', 'RDO', '48'],
  ['Day 6', 'Week 1', 'RDO', 'Work', 'Work', '1100-1500', 'Work', 'RDO', 'RDO', '40'],
  ['', 'Week 2', 'RDO', 'RDO', 'Work', 'Work', 'Work', 'Work', 'RDO', '48'],
  ['Mid-Shift\n(1100-2300)', 'Week 1', '1100-2300', '1500-2300', '1100-2300', 'RDO', '1100-2300', 'RDO', 'RDO', '44'],
  ['', 'Week 2', 'RDO', '1100-2300', '1500-2300', '1100-2300', 'RDO', '1100-2300', 'RDO', '44'],
  [], ['Scheduled headcount by time'], ['', '', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'], ['# Scheduled', 'Week 1', 'Peak: 4', 'Peak: 4', '', '', '', '', ''],
];

test('template: reads blocks, slots, shift times, start date and weekly hours', () => {
  const p = T.parse([{ name: 'Days Oct-Jan', rows: DAYS }]);
  assert.deepEqual(p.slots.map((s) => s.name), ['Day 1', 'Day 2', 'Day 3', 'Day 4', 'Day 5', 'Day 6', 'Mid-Shift']);
  assert.equal(P.fmtDate(p.start), '2026-10-05');
  assert.equal(p.firstDow, 1); // Monday
  assert.deepEqual(p.slots[6].base, { start: '11:00', hours: 12 });
  const s = P.migrate(P.emptyState());
  const pv = T.preview(s, p, 4);
  assert.deepEqual(pv.rows.map((r) => r.weekHours.join('/')), ['40/48', '48/40', '48/40', '48/40', '40/48', '40/48', '44/44']);
  assert.deepEqual(pv.rows.map((r) => r.maxRun), [5, 4, 5, 5, 4, 4, 3]);
  // Trades between day slots fix every 5-in-a-row without changing any day's coverage or hours.
  assert.ok(pv.trades.length > 0);
  assert.ok(pv.rows.every((r) => r.fixedRun <= 4));
  const perDay = (key) => Array.from({ length: 14 }, (_, i) => pv.rows.filter((r) => r.baseId === pv.rows[0].baseId).map((r) => String(r[key][i] || 0)).sort().join());
  assert.deepEqual(perDay('fixedCycle'), perDay('cycle'));
  assert.deepEqual(pv.rows.map((r) => r.fixedCycle.slice(0, 7).filter(Boolean).length + r.fixedCycle.slice(7).filter(Boolean).length), pv.rows.map((r) => r.cycle.filter(Boolean).length));
});

test('template: creating the slots schedules each person on the template, Monday-Sunday weeks', () => {
  const s = P.migrate(P.emptyState());
  s.positions = [{ id: 'tc', name: 'TC', isConsole: true }];
  s.jobClasses = [{ id: 'jc', name: 'Telecommunicator', positionIds: ['tc'], authorized: 7 }];
  s.employees = ['a', 'b'].map((id) => ({ id, firstName: id, lastName: id.toUpperCase(), jobClassId: 'jc', qualifications: ['tc'], status: 'active', hourlyRate: 25 }));
  s.lines = [{ id: 'old', name: 'Old', jobClassId: 'jc', employeeId: 'a', shiftTemplateId: 't_d8', patternId: 'p_52', anchorDate: '2026-01-04', effectiveFrom: '2026-01-04' }];
  const p = T.parse([{ name: 'Days', rows: DAYS }]);
  const res = T.apply(s, p, { jobClassId: 'jc', effectiveFrom: '2026-10-05', anchor: '2026-10-05', assign: { 'Day 1': 'a', 'Mid-Shift': 'b' }, applyFixes: false, endCurrent: true });
  assert.equal(res.lines.length, 7);
  assert.equal(res.ended, 1);
  assert.equal(s.lines.find((l) => l.id === 'old').effectiveTo, '2026-10-04');
  assert.equal(s.center.lineMode, 'fixed');
  const regs = P.regularShifts(s, D('2026-10-05'), D('2026-10-11')).filter((r) => r.employeeId === 'a');
  assert.deepEqual(regs.map((r) => `${P.DOW[P.dow(r.day)]} ${P.mil(r.start)} ${(r.end - r.start) / 60}`), ['Mon 0700 12', 'Tue 1100 4', 'Sat 0700 12', 'Sun 0700 12']);
  const mid = P.regularShifts(s, D('2026-10-12'), D('2026-10-18')).filter((r) => r.employeeId === 'b');
  assert.deepEqual(mid.map((r) => `${P.DOW[P.dow(r.day)]} ${P.mil(r.start)}`), ['Tue 1100', 'Wed 1500', 'Thu 1100', 'Sat 1100']);
});

test('template: pasted rows (tabs) read the same way', () => {
  const text = DAYS.map((r) => r.map((c) => String(c).replace(/\n/g, ' ')).join('\t')).join('\n');
  const p = T.parse(T.sheetFromText(text));
  assert.equal(p.slots.length, 7);
  assert.equal(P.fmtDate(p.start), '2026-10-05');
});

// A minimal .xlsx (zip of XML) built in memory to test the reader.
function makeXlsx(rows) {
  const esc = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const shared = [];
  const si = (v) => { let i = shared.indexOf(v); if (i < 0) { i = shared.length; shared.push(v); } return i; };
  const col = (i) => String.fromCharCode(65 + i);
  const sheet = `<worksheet><sheetData>${rows.map((r, ri) => `<row r="${ri + 1}">${r.map((v, ci) => (v === '' ? '' : /^\d+$/.test(String(v)) ? `<c r="${col(ci)}${ri + 1}"><v>${v}</v></c>` : `<c r="${col(ci)}${ri + 1}" t="s"><v>${si(String(v))}</v></c>`)).join('')}</row>`).join('')}</sheetData></worksheet>`;
  const files = {
    'xl/workbook.xml': '<workbook xmlns:r="r"><sheets><sheet name="Days" sheetId="1" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/worksheets/sheet1.xml': sheet,
    'xl/sharedStrings.xml': `<sst>${shared.map((v) => `<si><t xml:space="preserve">${esc(v)}</t></si>`).join('')}</sst>`,
  };
  const parts = [], central = [];
  let off = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = zlib.deflateRawSync(Buffer.from(text));
    const nb = Buffer.from(name);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(8, 8); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(text.length, 22); lh.writeUInt16LE(nb.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(8, 10); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(text.length, 24); ch.writeUInt16LE(nb.length, 28); ch.writeUInt32LE(off, 42);
    parts.push(lh, nb, data); central.push(ch, nb);
    off += 30 + nb.length + data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...parts, cd, end]);
}

test('xlsx reader: reads shared strings and numbers into a grid', async () => {
  const sheets = await X.read(makeXlsx(DAYS.slice(0, 6)));
  assert.equal(sheets[0].name, 'Days');
  assert.deepEqual(sheets[0].rows[3], ['Day 1', 'Week 1', 'Work', '1100-1500', 'RDO', 'RDO', 'RDO', 'Work', 'Work', '40']);
  const p = T.parse(sheets);
  assert.equal(p.slots[0].name, 'Day 1');
});

test('cut scheduled overtime: a part-timer takes part of a 48-hour week so the full-timer stays at 40', () => {
  const s = P.migrate(P.emptyState());
  Object.assign(s.center, { otPeriodStart: '2026-10-05', dayOffNoticeDays: 0 });
  s.positions = [{ id: 'tc', name: 'TC', isConsole: true }];
  s.jobClasses = [{ id: 'jc', name: 'Telecommunicator', positionIds: ['tc'] }];
  s.minimums.tc = Array.from({ length: 7 }, () => new Array(24).fill(0));
  for (let dw = 1; dw <= 4; dw++) for (let h = 7; h < 19; h++) s.minimums.tc[dw][h] = 1; // Mon-Thu days
  s.employees = [
    { id: 'a', firstName: 'a', lastName: 'A', jobClassId: 'jc', qualifications: ['tc'], status: 'active', hourlyRate: 30 },
    { id: 'p', firstName: 'p', lastName: 'P', jobClassId: 'jc', qualifications: ['tc'], status: 'active', hourlyRate: 20, employmentType: 'part', maxWeeklyHours: 32 },
  ];
  s.patterns.push({ id: 'p48', name: '4 x 12', cycle: [1, 1, 1, 1, 0, 0, 0] });
  s.lines = [{ id: 'l', name: 'Day 1', jobClassId: 'jc', employeeId: 'a', shiftTemplateId: 't_d12', patternId: 'p48', anchorDate: '2026-10-05', effectiveFrom: '2026-10-05' }];
  const wk = D('2026-11-02'); // a Monday
  const opts = { today: D('2026-10-20'), now: D('2026-10-20') * 1440 };
  const r = B.balanceWeek(s, wk, opts);
  assert.equal(r.relief.length, 1);
  const x = r.relief[0];
  assert.equal(x.hours, 8);
  assert.equal(x.ptId, 'p');
  assert.ok(x.saved > 0);
  const before = P.otReport(s, wk, wk + 6).totals.hours;
  s.exceptions.push(x.exception); s.fills.push(x.fill);
  assert.equal(before, 8);
  assert.equal(P.otReport(s, wk, wk + 6).totals.hours, 0);   // full-timer at 40, part-timer straight time
  assert.equal(P.openings(s, wk, wk + 6).slots.length, 0);   // coverage unchanged
  s.center.offerOtRelief = false;
  s.exceptions.pop(); s.fills.pop();
  assert.equal(B.balanceWeek(s, wk, opts).relief.length, 0);
});
