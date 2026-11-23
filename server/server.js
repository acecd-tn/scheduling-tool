#!/usr/bin/env node
/*
 * PSAP Scheduler server — multi-user version.
 *
 * Zero third-party dependencies: Node.js 22+ built-ins only (http, crypto,
 * node:sqlite). Serves the web app, keeps data in one SQLite file, handles
 * logins and roles, records an audit trail, and pushes live updates.
 *
 *   node server/server.js                 # empty center, prints the admin password
 *   node server/server.js --demo --data data-demo   # demo center with demo accounts
 *
 * Settings: psap.config.json (see psap.config.example.json), environment
 * variables, or command-line flags — see readConfig() below.
 */
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const P = require('../js/core.js');
const A = require('../js/actions.js');

const ROOT = path.resolve(__dirname, '..');

/*
 * Configuration, highest priority first:
 *   1. command line:  --port 8080 --host 127.0.0.1 --data D:\PSAP\data --demo --config <file>
 *   2. environment variables (PORT, HOST, DATA_DIR, COOKIE_SECURE, ADMIN_PASSWORD, NOTIFY_WEBHOOK_URL, SESSION_HOURS, SEED)
 *   3. psap.config.json in the app folder (see psap.config.example.json)
 */
function readConfig() {
  const args = process.argv.slice(2);
  const arg = (name) => { const i = args.indexOf('--' + name); return i >= 0 ? (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true) : undefined; };
  const cfgPath = path.resolve(arg('config') || process.env.PSAP_CONFIG || path.join(ROOT, 'psap.config.json'));
  let file = {};
  if (fs.existsSync(cfgPath)) {
    try { file = JSON.parse(fs.readFileSync(cfgPath, 'utf8').replace(/^\uFEFF/, '')); }
    catch (e) { console.error(`Cannot read ${cfgPath}: ${e.message}`); process.exit(1); }
  }
  const pick = (cli, env, key, def) => (cli !== undefined ? cli : process.env[env] !== undefined && process.env[env] !== '' ? process.env[env] : file[key] !== undefined ? file[key] : def);
  const truthy = (v) => v === true || /^(1|true|yes)$/i.test(String(v));
  return {
    port: +pick(arg('port'), 'PORT', 'port', 8080),
    host: String(pick(arg('host'), 'HOST', 'host', '0.0.0.0')),
    dataDir: arg('data') !== undefined || process.env.DATA_DIR ? path.resolve(ROOT, String(arg('data') !== undefined ? arg('data') : process.env.DATA_DIR))
      : path.resolve(file.dataDir ? path.dirname(cfgPath) : ROOT, String(file.dataDir || 'data')),
    cookieSecure: truthy(pick(undefined, 'COOKIE_SECURE', 'cookieSecure', false)),
    adminPassword: pick(undefined, 'ADMIN_PASSWORD', 'adminPassword', ''),
    webhook: String(pick(undefined, 'NOTIFY_WEBHOOK_URL', 'notifyWebhookUrl', '') || ''),
    sessionHours: +pick(undefined, 'SESSION_HOURS', 'sessionHours', 168),
    seedDemo: arg('demo') === true || /^demo$/i.test(String(pick(undefined, 'SEED', 'seed', ''))),
    configFile: fs.existsSync(cfgPath) ? cfgPath : null,
  };
}
const CFG = readConfig();
const PORT = CFG.port;
const HOST = CFG.host;
const DATA_DIR = CFG.dataDir;
const COOKIE_SECURE = CFG.cookieSecure;
const SESSION_MS = CFG.sessionHours * 3600e3;
const WEBHOOK = CFG.webhook;

// ------------------------------------------------------------------- db
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'psap.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS records (kind TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (kind, id));
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE, pass TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin','supervisor','employee')), employee_id TEXT,
    must_change INTEGER NOT NULL DEFAULT 1, disabled INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, last_login TEXT);
  CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, created_at TEXT NOT NULL, expires_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, user_id TEXT, username TEXT, action TEXT NOT NULL, detail TEXT);
  CREATE INDEX IF NOT EXISTS audit_at ON audit(at);
`);
const q = {
  allRecords: db.prepare('SELECT kind, id, data FROM records'),
  upsert: db.prepare('INSERT INTO records (kind, id, data, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(kind, id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at'),
  del: db.prepare('DELETE FROM records WHERE kind = ? AND id = ?'),
  delAll: db.prepare('DELETE FROM records'),
  userByName: db.prepare('SELECT * FROM users WHERE username = ?'),
  userById: db.prepare('SELECT * FROM users WHERE id = ?'),
  users: db.prepare('SELECT id, username, role, employee_id, must_change, disabled, created_at, last_login FROM users ORDER BY username'),
  userCount: db.prepare('SELECT COUNT(*) AS n FROM users'),
  addUser: db.prepare('INSERT INTO users (id, username, pass, role, employee_id, must_change, disabled, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?)'),
  setPass: db.prepare('UPDATE users SET pass = ?, must_change = ? WHERE id = ?'),
  setUser: db.prepare('UPDATE users SET role = ?, employee_id = ?, disabled = ? WHERE id = ?'),
  touchLogin: db.prepare('UPDATE users SET last_login = ? WHERE id = ?'),
  addSession: db.prepare('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)'),
  session: db.prepare('SELECT s.token, s.expires_at, u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?'),
  delSession: db.prepare('DELETE FROM sessions WHERE token = ?'),
  delUserSessions: db.prepare('DELETE FROM sessions WHERE user_id = ?'),
  purgeSessions: db.prepare('DELETE FROM sessions WHERE expires_at < ?'),
  audit: db.prepare('INSERT INTO audit (at, user_id, username, action, detail) VALUES (?, ?, ?, ?, ?)'),
  auditList: db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT ?'),
};
const tx = (fn) => { db.exec('BEGIN'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } };

// ---------------------------------------------------------------- state
let state;
let version = 1;

function loadState() {
  const s = P.emptyState();
  for (const k of P.COLLECTIONS) s[k] = [];
  let any = false;
  for (const r of q.allRecords.all()) {
    any = true;
    const data = JSON.parse(r.data);
    if (r.kind === 'config') s[r.id] = data;
    else if (P.COLLECTIONS.includes(r.kind)) s[r.kind].push(data);
  }
  return any ? P.migrate(s) : null;
}

function writeAll(s) {
  const now = new Date().toISOString();
  tx(() => {
    q.delAll.run();
    q.upsert.run('config', 'center', JSON.stringify(s.center), now);
    q.upsert.run('config', 'minimums', JSON.stringify(s.minimums), now);
    for (const k of P.COLLECTIONS) for (const x of s[k] || []) q.upsert.run(k, x.id, JSON.stringify(x), now);
  });
}

function persist(diff) {
  const now = new Date().toISOString();
  tx(() => {
    for (const [k, list] of Object.entries(diff.upserts)) for (const x of list) q.upsert.run(k, x.id, JSON.stringify(x), now);
    for (const [k, ids] of Object.entries(diff.deletes)) for (const id of ids) q.del.run(k, id);
    for (const [k, v] of Object.entries(diff.config)) q.upsert.run('config', k, JSON.stringify(v), now);
  });
}

/** Summarise a diff for the audit log (keeps before/after of changed records). */
function auditDetail(before, diff, extra) {
  const idx = {};
  for (const k of P.COLLECTIONS) { idx[k] = {}; for (const x of before[k] || []) idx[k][x.id] = x; }
  const changes = [];
  for (const [k, list] of Object.entries(diff.upserts)) {
    if (k === 'notifications') continue;
    for (const x of list) changes.push({ kind: k, id: x.id, op: idx[k][x.id] ? 'update' : 'create', before: idx[k][x.id] || null, after: x });
  }
  for (const [k, ids] of Object.entries(diff.deletes)) for (const id of ids) changes.push({ kind: k, id, op: 'delete', before: idx[k][id] || null });
  for (const k of Object.keys(diff.config)) changes.push({ kind: 'config', id: k, op: 'update', before: before[k], after: diff.config[k] });
  return JSON.stringify(Object.assign({ changes }, extra || {}));
}

/** Apply a mutation to a copy, persist the record-level diff, audit it, notify listeners. */
function commit(user, action, mutate, extra) {
  const before = state;
  const next = structuredClone(state);
  const result = mutate(next);
  const diff = P.diffState(before, next);
  if (P.diffEmpty(diff)) return { result, diff };
  persist(diff);
  state = next;
  version++;
  q.audit.run(new Date().toISOString(), user ? user.id : null, user ? user.username : 'system', action, auditDetail(before, diff, extra));
  broadcast();
  deliver(diff);
  return { result, diff };
}

// -------------------------------------------------------- notifications
async function deliver(diff) {
  const fresh = (diff.upserts.notifications || []).filter((n) => !n.delivered);
  if (!fresh.length) return;
  for (const n of fresh) {
    const recipients = n.employeeId ? [state.employees.find((e) => e.id === n.employeeId)].filter(Boolean)
      : state.employees.filter((e) => usersForRole('supervisor').includes(e.id));
    const payload = {
      title: n.title, body: n.body, at: n.at, center: state.center.name,
      to: recipients.map((e) => ({ employeeId: e.id, name: `${e.firstName} ${e.lastName}`, email: e.email || '', phone: e.phone || '', textOptIn: !!e.textOptIn })),
    };
    if (WEBHOOK) {
      try {
        const r = await fetch(WEBHOOK, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
        if (!r.ok) throw new Error('HTTP ' + r.status);
      } catch (e) { console.warn(`[notify] webhook failed for "${n.title}": ${e.message}`); continue; }
    } else {
      console.log(`[notify] ${payload.to.map((t) => t.name).join(', ') || '(supervisors)'} - ${n.title}: ${n.body}`);
    }
    const cur = state.notifications.find((x) => x.id === n.id);
    if (cur) { cur.delivered = true; q.upsert.run('notifications', cur.id, JSON.stringify(cur), new Date().toISOString()); }
  }
}
function usersForRole(role) {
  return db.prepare('SELECT employee_id FROM users WHERE role IN (?, ?) AND disabled = 0 AND employee_id IS NOT NULL').all(role, 'admin').map((r) => r.employee_id);
}

// ------------------------------------------------------------------ SSE
const listeners = new Set();
function broadcast() {
  for (const res of listeners) res.write(`event: change\ndata: {"version":${version}}\n\n`);
}
setInterval(() => { for (const res of listeners) res.write(': ping\n\n'); }, 25000).unref();

// ----------------------------------------------------------------- auth
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 64);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}
function checkPassword(pw, stored) {
  const [alg, salt, hash] = String(stored).split('$');
  if (alg !== 'scrypt') return false;
  const h = crypto.scryptSync(pw, Buffer.from(salt, 'base64'), 64);
  const want = Buffer.from(hash, 'base64');
  return want.length === h.length && crypto.timingSafeEqual(h, want);
}
function validPassword(pw) {
  if (typeof pw !== 'string' || pw.length < 10) return 'Password must be at least 10 characters';
  return null;
}
const randomPassword = () => crypto.randomBytes(9).toString('base64url');
const publicUser = (u) => u && ({ id: u.id, username: u.username, role: u.role, employeeId: u.employee_id || null, mustChange: !!u.must_change, disabled: !!u.disabled, createdAt: u.created_at, lastLogin: u.last_login });

const failures = new Map(); // key -> { n, until }
function throttled(key) { const f = failures.get(key); return f && f.until > Date.now(); }
function noteFailure(key) {
  const f = failures.get(key) || { n: 0, until: 0 };
  f.n++;
  if (f.n >= 5) { f.until = Date.now() + 5 * 60e3; f.n = 0; }
  failures.set(key, f);
}

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function sessionUser(req) {
  const tok = parseCookies(req).psap_sid;
  if (!tok) return null;
  const row = q.session.get(tok);
  if (!row || row.expires_at < Date.now() || row.disabled) return null;
  return row;
}
function setCookie(res, tok, maxAgeSec) {
  res.setHeader('Set-Cookie', `psap_sid=${tok}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${COOKIE_SECURE ? '; Secure' : ''}`);
}
const isSup = (u) => u && (u.role === 'admin' || u.role === 'supervisor');
const actorOf = (u) => ({ userId: u.id, role: u.role, employeeId: u.employee_id || null });

// ------------------------------------------------------------------ http
function send(res, code, obj, headers = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(code, Object.assign({ 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }, headers));
  res.end(body);
}
class HttpError extends Error { constructor(code, msg) { super(msg); this.code = code; } }
const bad = (msg) => { throw new HttpError(400, msg); };

function readJson(req, limit = 10 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    if (!/^application\/json/i.test(req.headers['content-type'] || '')) return reject(new HttpError(415, 'JSON required'));
    let size = 0;
    const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new HttpError(413, 'Too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { reject(new HttpError(400, 'Bad JSON')); } });
    req.on('error', reject);
  });
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };
function serveStatic(req, res, pathname) {
  if (pathname === '/') pathname = '/index.html';
  const rel = path.normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, '');
  if (!(rel === 'index.html' || /^(css|js)[/\\]/.test(rel)) || rel.includes('..')) return send(res, 404, { error: 'Not found' });
  const file = path.join(ROOT, rel);
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, { error: 'Not found' });
    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] || 'application/octet-stream',
      'cache-control': 'no-cache',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'same-origin',
      'content-security-policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
    });
    res.end(buf);
  });
}

const routes = {
  'POST /api/login': async (req, res) => {
    const { username, password } = await readJson(req);
    const key = `${String(username).toLowerCase()}|${req.socket.remoteAddress}`;
    if (throttled(key)) return send(res, 429, { error: 'Too many attempts — wait 5 minutes' });
    const u = q.userByName.get(String(username || ''));
    if (!u || u.disabled || !checkPassword(String(password || ''), u.pass)) { noteFailure(key); return send(res, 401, { error: 'Wrong username or password' }); }
    failures.delete(key);
    const tok = crypto.randomBytes(32).toString('base64url');
    q.addSession.run(tok, u.id, new Date().toISOString(), Date.now() + SESSION_MS);
    q.touchLogin.run(new Date().toISOString(), u.id);
    q.audit.run(new Date().toISOString(), u.id, u.username, 'login', null);
    setCookie(res, tok, Math.floor(SESSION_MS / 1000));
    send(res, 200, { user: publicUser(u) });
  },
  'POST /api/logout': async (req, res, u) => {
    const tok = parseCookies(req).psap_sid;
    if (tok) q.delSession.run(tok);
    setCookie(res, '', 0);
    send(res, 200, { ok: true });
  },
  'GET /api/me': async (req, res, u) => send(res, 200, { user: publicUser(u), mode: 'server', version }),
  'POST /api/password': async (req, res, u) => {
    const { current, next } = await readJson(req);
    if (!checkPassword(String(current || ''), u.pass)) bad('Current password is wrong');
    const err = validPassword(next); if (err) bad(err);
    q.setPass.run(hashPassword(next), 0, u.id);
    q.audit.run(new Date().toISOString(), u.id, u.username, 'password-change', null);
    send(res, 200, { ok: true });
  },
  'GET /api/state': async (req, res, u) => {
    const s = P.filterStateFor(state, { role: u.role, employeeId: u.employee_id });
    send(res, 200, { state: s, version, user: publicUser(u) });
  },
  'POST /api/patch': async (req, res, u) => {
    if (!isSup(u)) throw new HttpError(403, 'Supervisor access required');
    const { diff, label } = await readJson(req);
    if (!diff || typeof diff !== 'object') bad('Missing diff');
    for (const k of Object.keys(diff.upserts || {}).concat(Object.keys(diff.deletes || {}))) if (!P.COLLECTIONS.includes(k)) bad('Unknown collection ' + k);
    if (diff.config && Object.keys(diff.config).some((k) => !['center', 'minimums'].includes(k))) bad('Unknown config');
    commit(u, 'edit' + (label ? ': ' + String(label).slice(0, 80) : ''), (s) => { P.applyDiff(s, diff); P.migrate(s); });
    send(res, 200, { ok: true, version });
  },
  'GET /api/events': async (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    res.write(`event: change\ndata: {"version":${version}}\n\n`);
    listeners.add(res);
    req.on('close', () => listeners.delete(res));
  },
  'GET /api/users': async (req, res, u) => {
    if (!isSup(u)) throw new HttpError(403, 'Supervisor access required');
    send(res, 200, { users: q.users.all().map(publicUser) });
  },
  'POST /api/users': async (req, res, u) => {
    if (!isSup(u)) throw new HttpError(403, 'Supervisor access required');
    const b = await readJson(req);
    const role = b.role || 'employee';
    if (!['admin', 'supervisor', 'employee'].includes(role)) bad('Bad role');
    if (u.role !== 'admin' && role !== 'employee') throw new HttpError(403, 'Only an admin can create supervisor or admin accounts');
    if (!/^[A-Za-z0-9._-]{3,40}$/.test(b.username || '')) bad('Username: 3-40 letters, numbers, . _ -');
    if (q.userByName.get(b.username)) bad('That username is taken');
    const pw = b.password || randomPassword();
    const err = validPassword(pw); if (err) bad(err);
    const id = P.uid('usr');
    q.addUser.run(id, b.username, hashPassword(pw), role, b.employeeId || null, 1, new Date().toISOString());
    q.audit.run(new Date().toISOString(), u.id, u.username, 'user-create', JSON.stringify({ id, username: b.username, role, employeeId: b.employeeId || null }));
    send(res, 200, { user: publicUser(q.userById.get(id)), tempPassword: pw });
  },
  'POST /api/users/:id': async (req, res, u, id) => {
    if (!isSup(u)) throw new HttpError(403, 'Supervisor access required');
    const t = q.userById.get(id);
    if (!t) throw new HttpError(404, 'No such user');
    if (u.role !== 'admin' && t.role !== 'employee') throw new HttpError(403, 'Only an admin can change supervisor or admin accounts');
    const b = await readJson(req);
    let tempPassword = null;
    if (b.resetPassword) {
      tempPassword = randomPassword();
      q.setPass.run(hashPassword(tempPassword), 1, id);
      q.delUserSessions.run(id);
    }
    const role = b.role || t.role;
    if (role !== t.role && u.role !== 'admin') throw new HttpError(403, 'Only an admin can change roles');
    if (t.id === u.id && (b.disabled || role !== t.role)) bad('You cannot disable or demote yourself');
    q.setUser.run(role, b.employeeId !== undefined ? (b.employeeId || null) : t.employee_id, b.disabled !== undefined ? (b.disabled ? 1 : 0) : t.disabled, id);
    if (b.disabled) q.delUserSessions.run(id);
    q.audit.run(new Date().toISOString(), u.id, u.username, 'user-update', JSON.stringify({ id, username: t.username, role, disabled: !!b.disabled, resetPassword: !!b.resetPassword }));
    send(res, 200, { user: publicUser(q.userById.get(id)), tempPassword });
  },
  'GET /api/audit': async (req, res, u, _, url) => {
    if (!isSup(u)) throw new HttpError(403, 'Supervisor access required');
    const limit = Math.min(1000, +url.searchParams.get('limit') || 200);
    send(res, 200, { entries: q.auditList.all(limit).map((r) => Object.assign({}, r, { detail: r.detail ? JSON.parse(r.detail) : null })) });
  },
  'GET /api/export': async (req, res, u) => {
    if (!u || u.role !== 'admin') throw new HttpError(403, 'Admin only');
    res.writeHead(200, { 'content-type': 'application/json', 'content-disposition': `attachment; filename="psap-backup-${new Date().toISOString().slice(0, 10)}.json"` });
    res.end(JSON.stringify(state, null, 1));
  },
  'POST /api/import': async (req, res, u) => {
    if (!u || u.role !== 'admin') throw new HttpError(403, 'Admin only');
    const data = await readJson(req, 50 * 1024 * 1024);
    if (!data || !Array.isArray(data.employees)) bad('Not a PSAP Scheduler backup');
    const next = P.migrate(data);
    writeAll(next);
    state = next;
    version++;
    q.audit.run(new Date().toISOString(), u.id, u.username, 'import', JSON.stringify({ employees: next.employees.length }));
    broadcast();
    send(res, 200, { ok: true });
  },
};

async function handle(req, res) {
  const url = new URL(req.url, 'http://local');
  const p = url.pathname;
  if (!p.startsWith('/api/')) return serveStatic(req, res, p);
  let key = `${req.method} ${p}`, param = null;
  if (!routes[key]) {
    const m = p.match(/^\/api\/users\/([\w-]+)$/);
    if (m) { key = `${req.method} /api/users/:id`; param = m[1]; }
    const a = p.match(/^\/api\/action\/(\w+)$/);
    if (a && req.method === 'POST') { key = 'ACTION'; param = a[1]; }
  }
  try {
    if (key === 'POST /api/login') return await routes[key](req, res);
    const u = sessionUser(req);
    if (!u) return send(res, 401, { error: 'Please sign in' });
    const mcOk = ['POST /api/password', 'GET /api/me', 'POST /api/logout'];
    if (u.must_change && !mcOk.includes(key)) return send(res, 403, { error: 'Password change required', mustChange: true });
    if (key === 'ACTION') {
      const body = await readJson(req);
      if (!A.ACTIONS[param]) throw new HttpError(404, 'Unknown action');
      let out;
      try {
        out = commit(u, 'action: ' + param, (s) => A.run(s, actorOf(u), param, body.payload || {}, { now: new Date().toISOString(), today: P.todayNum() }), { payload: body.payload || {} });
      } catch (e) {
        if (e instanceof A.ActionError) return send(res, 409, { error: e.message });
        throw e;
      }
      return send(res, 200, Object.assign({ ok: true, version }, out.result));
    }
    const fn = routes[key];
    if (!fn) return send(res, 404, { error: 'Not found' });
    await fn(req, res, u, param, url);
  } catch (e) {
    if (e instanceof HttpError) return send(res, e.code, { error: e.message });
    console.error(e);
    send(res, 500, { error: 'Server error' });
  }
}

// ------------------------------------------------------------- startup
function bootstrap() {
  state = loadState();
  // Save any one-time data upgrades made while loading, so they don't depend on
  // someone later editing the affected records.
  if (state) writeAll(state);
  const seedDemo = CFG.seedDemo;
  if (!state) {
    state = seedDemo ? P.migrate(P.demoState()) : P.migrate(P.emptyState());
    writeAll(state);
    console.log(`Created new ${seedDemo ? 'DEMO' : 'empty'} center in ${DATA_DIR}`);
  }
  if (q.userCount.get().n === 0) {
    const pw = CFG.adminPassword || randomPassword();
    q.addUser.run(P.uid('usr'), 'admin', hashPassword(pw), 'admin', null, CFG.adminPassword ? 0 : 1, new Date().toISOString());
    console.log('\n  Admin account created.  username: admin   password: ' + pw + (CFG.adminPassword ? '' : '   (must be changed at first sign-in)') + '\n');
    if (seedDemo) {
      const demoPw = 'demo-password';
      const used = new Set(['admin']);
      for (const e of state.employees) {
        let un = (e.firstName[0] + e.lastName).toLowerCase().replace(/[^a-z0-9]/g, '');
        while (used.has(un)) un += '1';
        used.add(un);
        q.addUser.run(P.uid('usr'), un, hashPassword(demoPw), (e.jobClassId === 'jc_sup' || e.positionId === 'pos_sup') ? 'supervisor' : 'employee', e.id, 0, new Date().toISOString());
      }
      const sup = state.employees.find((e) => e.positionId === 'pos_sup');
      const emp = state.employees.find((e) => e.positionId === 'pos_law' && e.status === 'active');
      console.log(`  Demo accounts (password "${demoPw}" for all), e.g.:`);
      if (sup) console.log(`    supervisor: ${(sup.firstName[0] + sup.lastName).toLowerCase()}`);
      if (emp) console.log(`    employee:   ${(emp.firstName[0] + emp.lastName).toLowerCase()}`);
      console.log('  Every employee has an account: first initial + last name.\n');
    }
  }
  q.purgeSessions.run(Date.now());
}

if (require.main === module) {
  bootstrap();
  const server = http.createServer(handle);
  server.on('error', (e) => {
    const where = `${HOST}:${PORT}`;
    if (e.code === 'EADDRINUSE') {
      console.error(`Cannot start: port ${PORT} is already in use (${where}). Another copy of the app or another program (IIS, for example) is using it. Pick a different port in the config file, and use the same port in the IIS web.config rewrite URL.`);
    } else if (e.code === 'EACCES') {
      console.error(`Cannot start: permission denied for port ${PORT} (${where}). On Windows this usually means another program (often IIS, if a site is bound to this port) holds it, or Windows has reserved it (see: netsh interface ipv4 show excludedportrange protocol=tcp). Pick a different port in the config file, and use the same port in the IIS web.config rewrite URL.`);
    } else {
      console.error(`Cannot start on ${where}: ${e.message}`);
    }
    process.exit(1);
  });
  server.listen(PORT, HOST, () => {
    console.log(`PSAP Scheduler running at http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
    console.log(`  data: ${DATA_DIR}${CFG.configFile ? '   config: ' + CFG.configFile : ''}${COOKIE_SECURE ? '   (secure cookies: HTTPS only)' : ''}`);
  });
  const stop = () => { console.log('Shutting down'); server.close(); try { db.close(); } catch { /* ignore */ } process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
module.exports = { handle, bootstrap, db, getState: () => state };
