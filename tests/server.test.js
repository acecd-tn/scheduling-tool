// Server API: login, roles, privacy, actions, audit. Uses a throwaway data folder.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'psap-test-'));
process.env.DATA_DIR = dir;
process.env.SEED = 'demo';
process.env.ADMIN_PASSWORD = 'admin-password-123';
const origLog = console.log;
console.log = () => {};
const srv = require('../server/server.js');
srv.bootstrap();
console.log = origLog;

let base;
const server = http.createServer(srv.handle);
test.before(() => new Promise((r) => server.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; r(); })));
test.after(() => { server.close(); srv.db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

async function login(username, password) {
  const r = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) });
  const cookie = (r.headers.get('set-cookie') || '').split(';')[0];
  return { status: r.status, cookie, body: await r.json() };
}
const call = (cookie, method, url, body) => fetch(base + url, { method, headers: Object.assign({ cookie }, body ? { 'content-type': 'application/json' } : {}), body: body ? JSON.stringify(body) : undefined })
  .then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));

function demoUser(pred) {
  const s = srv.getState();
  const e = s.employees.find(pred);
  const row = srv.db.prepare('SELECT username FROM users WHERE employee_id = ?').get(e.id);
  return { emp: e, username: row.username };
}

test('rejects bad passwords and requires sign-in', async () => {
  assert.equal((await login('admin', 'nope')).status, 401);
  assert.equal((await fetch(base + '/api/state')).status, 401);
});

test('employee: filtered state, cannot patch, can request leave', async () => {
  const { emp, username } = demoUser((e) => e.positionId === 'pos_law' && e.status === 'active');
  const { cookie } = await login(username, 'demo-password');
  const st = await call(cookie, 'GET', '/api/state');
  assert.equal(st.status, 200);
  assert.ok(st.body.state.employees.filter((e) => e.id !== emp.id).every((e) => !e.hourlyRate));
  assert.equal((await call(cookie, 'POST', '/api/patch', { diff: { upserts: {}, deletes: {}, config: {} } })).status, 403);
  assert.equal((await call(cookie, 'GET', '/api/users')).status, 403);
  const d = new Date(Date.now() + 20 * 86400e3).toISOString().slice(0, 10);
  const r = await call(cookie, 'POST', '/api/action/requestLeave', { payload: { type: 'vacation', date: d } });
  assert.equal(r.status, 200);
  const r2 = await call(cookie, 'POST', '/api/action/decideLeave', { payload: { id: r.body.id, status: 'approved' } });
  assert.equal(r2.status, 409);
  assert.match(r2.body.error, /Supervisor/);
});

test('supervisor: patch is applied, persisted and audited', async () => {
  const { username } = demoUser((e) => e.positionId === 'pos_sup');
  const { cookie } = await login(username, 'demo-password');
  const before = srv.getState().center.minRestHours;
  const center = Object.assign({}, srv.getState().center, { minRestHours: before + 1 });
  const r = await call(cookie, 'POST', '/api/patch', { diff: { upserts: {}, deletes: {}, config: { center } }, label: 'rest rule' });
  assert.equal(r.status, 200);
  assert.equal(srv.getState().center.minRestHours, before + 1);
  const row = srv.db.prepare("SELECT data FROM records WHERE kind='config' AND id='center'").get();
  assert.equal(JSON.parse(row.data).minRestHours, before + 1);
  const audit = await call(cookie, 'GET', '/api/audit?limit=5');
  assert.ok(audit.body.entries.some((e) => /rest rule/.test(e.action)));
  // supervisors can't create admin accounts
  assert.equal((await call(cookie, 'POST', '/api/users', { username: 'newadmin', role: 'admin' })).status, 403);
});

test('admin must change a temporary password before using the app', async () => {
  const { cookie } = await login('admin', 'admin-password-123');
  assert.equal((await call(cookie, 'GET', '/api/state')).status, 200); // ADMIN_PASSWORD set => no forced change
  const created = await call(cookie, 'POST', '/api/users', { username: 'tempuser', role: 'employee' });
  assert.equal(created.status, 200);
  const t = await login('tempuser', created.body.tempPassword);
  assert.equal((await call(t.cookie, 'GET', '/api/state')).status, 403);
  assert.equal((await call(t.cookie, 'POST', '/api/password', { current: created.body.tempPassword, next: 'short' })).status, 400);
  assert.equal((await call(t.cookie, 'POST', '/api/password', { current: created.body.tempPassword, next: 'a-much-better-password' })).status, 200);
  assert.equal((await call(t.cookie, 'GET', '/api/state')).status, 200);
});

test('static files: app is served, server code and data are not', async () => {
  assert.equal((await fetch(base + '/')).status, 200);
  assert.equal((await fetch(base + '/js/core.js')).status, 200);
  assert.equal((await fetch(base + '/server/server.js')).status, 404);
  assert.equal((await fetch(base + '/data/psap.db')).status, 404);
  assert.equal((await fetch(base + '/js/../server/server.js')).status, 404);
});

test('strict Content-Security-Policy: no inline scripts or inline event handlers anywhere', async () => {
  const r = await fetch(base + '/');
  const csp = r.headers.get('content-security-policy');
  assert.match(csp, /script-src 'self';/);
  assert.doesNotMatch(csp, /script-src[^;]*unsafe-inline/);
  const files = ['index.html'].concat(fs.readdirSync(path.join(__dirname, '..', 'js')).filter((f) => f.endsWith('.js')).map((f) => 'js/' + f),
    fs.readdirSync(path.join(__dirname, '..', 'js', 'views')).map((f) => 'js/views/' + f));
  for (const f of files) {
    const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    assert.doesNotMatch(src, /\son(click|submit|change|input|load|keydown|keyup)\s*=\s*["']/i, f + ' has an inline event handler');
    if (f.endsWith('.html')) assert.doesNotMatch(src, /<script>(?!\s*<\/script>)/, f + ' has an inline script');
  }
});
