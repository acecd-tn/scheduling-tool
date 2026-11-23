/* PSAP Scheduler — app shell: data layer (local or server), auth, routing, modals, helpers. */
(function () {
  'use strict';
  const P = window.PSAP;
  const A = window.PSAPActions;
  const KEY = 'psap-scheduler.v1';
  const VIEW_AS = 'psap-scheduler.viewAs';
  let S = null;          // full state (local) or what the server sent for this user
  let version = 0;

  const App = window.App = {
    P, A,
    views: {},
    actions: {},
    changes: {},
    ui: {},
    mode: 'local',       // 'local' (browser storage) | 'server'
    me: null,            // { id, username, role, employeeId, mustChange }
    get S() { return S; },
  };
  App.isSup = () => !!App.me && (App.me.role === 'admin' || App.me.role === 'supervisor');
  App.isAdmin = () => !!App.me && App.me.role === 'admin';
  App.actor = () => ({ userId: App.me ? App.me.id : 'local', role: App.me ? App.me.role : 'admin', employeeId: App.me ? App.me.employeeId : null });

  // ------------------------------------------------------------- server io
  async function api(method, url, body) {
    const r = await fetch(url, {
      method, credentials: 'same-origin',
      headers: body !== undefined ? { 'content-type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let data = {};
    try { data = await r.json(); } catch { /* empty */ }
    if (!r.ok) {
      if (r.status === 401 && url !== '/api/login') { App.me = null; render(); }
      if (data.mustChange && App.me) { App.me.mustChange = true; render(); }
      const e = new Error(data.error || `HTTP ${r.status}`);
      e.status = r.status;
      throw e;
    }
    return data;
  }
  App.api = api;

  async function refresh() {
    const d = await api('GET', '/api/state');
    S = P.migrate(d.state);
    version = d.version;
    App.me = d.user;
    render();
  }
  let refreshTimer = null;
  function scheduleRefresh() { clearTimeout(refreshTimer); refreshTimer = setTimeout(() => refresh().catch(() => {}), 150); }

  let events = null;
  function listen() {
    if (events) events.close();
    events = new EventSource('/api/events');
    events.addEventListener('change', (ev) => {
      try { const v = JSON.parse(ev.data).version; if (v > version) scheduleRefresh(); } catch { /* ignore */ }
    });
  }

  // ---------------------------------------------------------- local store
  function loadLocal() {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) return P.migrate(JSON.parse(raw));
    } catch (e) { console.warn('load failed', e); }
    return P.migrate(P.demoState());
  }
  function saveLocal() {
    if (App.mode !== 'local') return;
    try { localStorage.setItem(KEY, JSON.stringify(S)); }
    catch (e) { toast('Could not save: ' + e.message, true); }
  }
  function localViewAs() {
    let v = null;
    try { v = JSON.parse(localStorage.getItem(VIEW_AS) || 'null'); } catch { /* ignore */ }
    if (v && v.employeeId && !S.employees.some((e) => e.id === v.employeeId)) v = null;
    return v && v.employeeId ? { id: 'local-' + v.employeeId, username: 'preview', role: 'employee', employeeId: v.employeeId } : { id: 'local', username: 'local', role: 'admin', employeeId: null };
  }

  // ------------------------------------------------------------ mutations
  /** Supervisor edit: mutate, show it, and sync the record-level changes. */
  App.commit = function (fn, msg) {
    if (App.mode === 'server' && !App.isSup()) return toast('Supervisor access required', true);
    const before = App.mode === 'server' ? JSON.parse(JSON.stringify(S)) : null;
    fn(S);
    render();
    if (App.mode === 'local') { saveLocal(); if (msg) toast(msg); return; }
    const diff = P.diffState(before, S);
    if (P.diffEmpty(diff)) return;
    api('POST', '/api/patch', { diff, label: msg || '' })
      .then((r) => { version = Math.max(version, r.version || 0); if (msg) toast(msg); })
      .catch((e) => { toast('Not saved: ' + e.message, true); refresh(); });
  };
  /** Same, without re-rendering (inline edits keep focus). */
  App.silent = function (fn) {
    if (App.mode === 'local') { fn(S); saveLocal(); return; }
    const before = JSON.parse(JSON.stringify(S));
    fn(S);
    const diff = P.diffState(before, S);
    if (P.diffEmpty(diff)) return;
    api('POST', '/api/patch', { diff }).then((r) => { version = Math.max(version, r.version || 0); }).catch((e) => { toast('Not saved: ' + e.message, true); refresh(); });
  };
  /** Workflow action (requests, trades, postings, bids) — rules enforced by the actions module. Resolves to the result, or null if refused. */
  App.act = function (name, payload, opts = {}) {
    if (App.mode === 'local') {
      try {
        const r = A.run(S, App.actor(), name, payload, { now: new Date().toISOString(), today: P.todayNum() });
        saveLocal();
        render();
        if (r.message && !opts.quiet) toast(r.message);
        return Promise.resolve(r);
      } catch (e) {
        toast(e.message, true);
        return Promise.resolve(null);
      }
    }
    return api('POST', '/api/action/' + name, { payload })
      .then((r) => { if (r.message && !opts.quiet) toast(r.message); return refresh().then(() => r); })
      .catch((e) => { toast(e.message, true); return null; });
  };
  App.replaceState = function (next, msg) {
    if (App.mode === 'server') {
      api('POST', '/api/import', P.migrate(next)).then(() => { toast(msg || 'Imported'); refresh(); }).catch((e) => toast(e.message, true));
      return;
    }
    S = P.migrate(next); saveLocal(); render(); if (msg) toast(msg);
  };

  // ------------------------------------------------------------- helpers
  const esc = App.esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  App.money = (n, dec = 0) => (n < 0 ? '-' : '') + '$' + Math.abs(n || 0).toLocaleString(undefined, { minimumFractionDigits: dec, maximumFractionDigits: dec });
  App.hrs = (n) => (Math.round((n || 0) * 10) / 10).toLocaleString();
  App.pct = (n) => Math.round((n || 0) * 100) + '%';
  App.opts = (list, sel, labelFn = (x) => x.name, valFn = (x) => x.id) =>
    list.map((x) => `<option value="${esc(valFn(x))}"${String(valFn(x)) === String(sel) ? ' selected' : ''}>${esc(labelFn(x))}</option>`).join('');
  App.posName = (id) => (S.positions.find((p) => p.id === id) || {}).name || '—';
  App.tpl = (id) => S.shiftTemplates.find((t) => t.id === id);
  App.emp = (id) => S.employees.find((e) => e.id === id);
  App.excType = (id) => P.EXCEPTION_TYPES.find((t) => t.id === id) || { label: id, abbr: '?' };
  App.fillType = (id) => (P.FILL_TYPES.find((t) => t.id === id) || { label: id }).label;
  App.reasonLabel = (r) => r === 'vacancy' ? 'Vacancy / structural' : r === 'built-in' ? 'Built-in (schedule)' : r === 'event' ? 'Special event / weather' : App.excType(r).label;
  App.slotTime = (slot) => {
    const d0 = Math.floor(slot.start / P.DAY), d1 = Math.floor((slot.end - 1) / P.DAY);
    return `${P.shortDate(d0)} ${P.mil(slot.start)}–${P.mil(slot.end)}${d1 > d0 ? ' (+1)' : ''}`;
  };
  App.formData = (form) => {
    const o = {};
    for (const el of form.elements) {
      if (!el.name) continue;
      if (el.type === 'checkbox') { if (el.dataset.multi) { (o[el.name] ||= []); if (el.checked) o[el.name].push(el.value); } else o[el.name] = el.checked; }
      else if (el.type === 'radio') { if (el.checked) o[el.name] = el.value; }
      else o[el.name] = el.value;
    }
    return o;
  };
  App.download = (name, text, type = 'application/json') => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type }));
    a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
  };
  App.kpi = (label, value, sub = '', cls = '') => `<div class="kpi ${cls}"><div class="label">${esc(label)}</div><div class="value">${value}</div><div class="sub">${sub}</div></div>`;
  App.covClass = (staffed, req) => {
    if (!req && !staffed) return '';
    if (staffed + 1e-6 < req) return 'short';
    if (Math.abs(staffed - req) < 1e-6) return 'exact';
    return 'over';
  };
  App.fmtStaff = (v) => (Math.round(v * 10) / 10).toString();
  App.levelBadge = (lvl) => {
    if (!lvl) return '';
    const cls = { normal: 'ok', short: 'warn', critical: 'bad' }[lvl.level];
    return `<span class="badge ${cls}" title="Effective ${(Math.round(lvl.effective * 10) / 10)} of ${lvl.authorized} authorized">${lvl.level === 'normal' ? 'Normal' : lvl.level === 'short' ? 'Short' : 'Critical'}${lvl.pct != null ? ' ' + Math.round(lvl.pct * 100) + '%' : ''}</span>`;
  };
  /** Job classes whose staffing level differs from the last one a supervisor acknowledged. */
  App.levelChanges = (st) => P.jobClasses(st).filter((jc) => P.classMembers(st, jc).length && +jc.authorized).map((jc) => ({ jc, lvl: P.staffingLevel(st, jc) }))
    .filter((x) => x.lvl.level !== ((st.center.levelSeen || {})[x.jc.id] || 'normal'));
  App.levelNotice = (st) => {
    if (!App.isSup()) return '';
    const ch = App.levelChanges(st);
    if (!ch.length) return '';
    return `<div class="callout ${ch.some((x) => x.lvl.level === 'critical') ? 'bad' : 'warn'}" style="margin-bottom:14px">${ch.map((x) => `<div><b>${esc(x.jc.name)}</b> staffing is now ${App.levelBadge(x.lvl)} (was ${esc((st.center.levelSeen || {})[x.jc.id] || 'normal')}). ${x.lvl.level === 'normal' ? 'Consider restoring the relief margin and vacation limit.' : 'Consider a line review or re-bid (Lines & Bid → Suggest lines).'}</div>`).join('')}
      <div style="margin-top:6px"><button class="btn sm" data-action="go" data-to="bid">Review lines</button> <button class="btn sm" data-action="level-ack">Got it</button></div></div>`;
  };
  App.actions['level-ack'] = () => App.commit((s) => {
    s.center.levelSeen = Object.assign({}, s.center.levelSeen);
    for (const x of App.levelChanges(s)) s.center.levelSeen[x.jc.id] = x.lvl.level;
  });
  App.statusBadge = (s) => `<span class="badge ${s === 'approved' || s === 'awarded' ? 'ok' : s === 'pending' || s === 'proposed' || s === 'accepted' || s === 'open' ? 'warn' : s === 'denied' || s === 'declined' ? 'bad' : ''}">${esc(s)}</span>`;

  // --------------------------------------------------------- notifications
  App.myNotifications = () => {
    if (!S || !App.me) return [];
    const uid = App.me.id;
    return S.notifications.filter((n) => (n.employeeId && n.employeeId === App.me.employeeId) || (n.role === 'supervisor' && App.isSup()))
      .map((n) => Object.assign({}, n, { unread: n.employeeId ? !n.read : !(n.readBy || []).includes(uid) }))
      .sort((a, b) => String(b.at).localeCompare(String(a.at)));
  };
  App.actions['bell'] = () => {
    App.modal({
      title: 'Notifications',
      body: () => {
        const list = App.myNotifications().slice(0, 60);
        return list.length ? `<table><tbody>${list.map((n) => `<tr class="${n.unread ? '' : 'dim'}"><td>${n.unread ? '<span class="badge info">new</span> ' : ''}<b>${esc(n.title)}</b><div class="small">${esc(n.body)}</div></td>
          <td class="small muted nowrap">${esc(new Date(n.at).toLocaleString())}</td><td>${n.link ? `<button class="btn sm" data-action="go-close" data-to="${esc(n.link)}">Open</button>` : ''}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">No notifications.</div>';
      },
      footer: '<button class="btn" data-action="bell-read">Mark all read</button><button class="btn" data-action="modal-close">Close</button>',
    });
  };
  App.actions['bell-read'] = () => App.act('markRead', {}, { quiet: true });
  App.actions['go-close'] = (el) => { App.closeModal(); App.go(el.dataset.to); };

  // --------------------------------------------------------------- toast
  function toast(msg, err) {
    const el = document.createElement('div');
    el.className = 'toast' + (err ? ' err' : '');
    el.textContent = msg;
    document.getElementById('toasts').appendChild(el);
    setTimeout(() => el.remove(), err ? 6000 : 3200);
  }
  App.toast = toast;

  // --------------------------------------------------------------- modal
  let modalState = null;
  App.modal = function (o) { modalState = o; drawModal(); };
  function drawModal() {
    const root = document.getElementById('modal-root');
    if (!modalState) { root.innerHTML = ''; return; }
    const o = modalState;
    const body = typeof o.body === 'function' ? o.body() : o.body;
    root.innerHTML = `<div class="modal-back" data-action="modal-bg"><div class="modal ${o.wide ? 'wide' : ''}" role="dialog" aria-modal="true">
      <div class="modal-head"><h2>${esc(o.title)}</h2><button class="btn ghost sm" data-action="modal-close" aria-label="Close">✕</button></div>
      <form class="modal-body" id="modal-form">${body}</form>
      ${o.footer ? `<div class="modal-foot">${o.footer}</div>` : ''}
    </div></div>`;
    if (o.mount) o.mount(document.getElementById('modal-form'));
  }
  App.redrawModal = function () {
    if (!modalState) return;
    const form = document.getElementById('modal-form');
    const keep = form ? App.formData(form) : {};
    drawModal();
    const f2 = document.getElementById('modal-form');
    for (const [k, v] of Object.entries(keep)) {
      const el = f2.elements[k];
      if (el && !Array.isArray(v) && el.type !== 'checkbox' && el.type !== 'radio' && el.tagName !== 'BUTTON' && !el.dataset.keep) el.value = v;
    }
  };
  App.closeModal = function () { modalState = null; drawModal(); };
  App.modalForm = () => App.formData(document.getElementById('modal-form'));
  App.actions['modal-close'] = () => App.closeModal();
  App.actions['modal-bg'] = (el, ev) => { if (ev.target === el) App.closeModal(); };
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && modalState) App.closeModal(); });

  App.confirm = function (msg, onYes, yesLabel = 'Confirm') {
    App.modal({
      title: 'Please confirm',
      body: `<p>${msg}</p>`,
      footer: `<button class="btn" data-action="modal-close">Cancel</button><button class="btn primary" data-action="confirm-yes">${esc(yesLabel)}</button>`,
    });
    App.actions['confirm-yes'] = () => { App.closeModal(); onYes(); };
  };

  // -------------------------------------------------------------- router
  const NAV_SUP = [
    ['dashboard', 'Dashboard'], ['schedule', 'Schedule'], ['coverage', 'Coverage'], ['consoles', 'Consoles'], ['openings', 'Openings'],
    ['overtime', 'Overtime'], ['bid', 'Lines & Bid'], ['vacation', 'Vacation Bid'], ['staff', 'Staff'], ['planner', 'Planner'], ['settings', 'Settings'],
  ];
  const NAV_EMP = [['me', 'My Schedule'], ['schedule', 'Schedule'], ['open', 'Open Shifts'], ['trades', 'Trades'], ['vacation', 'Vacation Bid'], ['bid', 'Shift Bid']];
  const nav = () => App.isSup() ? NAV_SUP : NAV_EMP;
  function route() {
    const h = (location.hash || '').slice(2).split('?')[0];
    const allowed = nav().map((x) => x[0]);
    return allowed.includes(h) && App.views[h] ? h : allowed[0];
  }
  App.go = (name) => { location.hash = '#/' + name; };

  function topbar(cur) {
    const pending = App.isSup() ? S.exceptions.filter((e) => e.status === 'pending').length + S.trades.filter((t) => t.status === 'accepted').length : 0;
    document.getElementById('nav').innerHTML = nav().map(([id, label]) =>
      `<a href="#/${id}" class="${id === cur ? 'active' : ''}">${label}${id === 'openings' && pending ? ` <span class="badge warn" title="Requests and trades awaiting a decision">${pending}</span>` : ''}</a>`).join('');
    document.getElementById('center-name').textContent = S.center.name;
    const unread = App.myNotifications().filter((n) => n.unread).length;
    const who = App.me.employeeId ? P.empName(App.emp(App.me.employeeId)) : App.me.username;
    let userBox;
    if (App.mode === 'server') {
      userBox = `<span class="small muted" title="${esc(App.me.role)}">${esc(who)} · ${esc(App.me.role)}</span><button class="btn ghost sm" data-action="pw-open">Password</button><button class="btn ghost sm" data-action="logout">Sign out</button>`;
    } else {
      userBox = `<label class="small muted" style="margin:0">View as <select data-change="view-as" style="max-width:190px"><option value="">Supervisor / admin</option>${App.opts(S.employees.filter((e) => e.status !== 'inactive').sort((a, b) => P.empName(a).localeCompare(P.empName(b))), App.me.employeeId || '', (e) => 'Employee: ' + P.empName(e))}</select></label>`;
    }
    document.getElementById('user-box').innerHTML = `<button class="btn ghost sm" data-action="bell" title="Notifications">🔔${unread ? ` <span class="badge bad">${unread}</span>` : ''}</button>${userBox}`;
  }

  function render() {
    document.documentElement.dataset.theme = localStorage.getItem('psap.theme') || 'dark';
    const root = document.getElementById('view');
    if (App.mode === 'server' && !App.me) return renderLogin(root);
    if (App.mode === 'server' && App.me.mustChange) return renderPwChange(root);
    if (!S) { root.innerHTML = '<div class="empty">Loading…</div>'; return; }
    document.body.classList.remove('auth');
    const cur = route();
    topbar(cur);
    const v = App.views[cur];
    const viewState = App.mode === 'local' && !App.isSup() ? P.filterStateFor(S, { role: 'employee', employeeId: App.me.employeeId }) : S;
    try {
      root.innerHTML = v.render(viewState, App.ui);
      if (v.after) v.after(root);
    } catch (e) {
      console.error(e);
      root.innerHTML = `<div class="panel callout bad"><b>Something went wrong rendering this page.</b><pre>${esc(e.stack || e)}</pre></div>`;
    }
    if (modalState) App.redrawModal();
  }
  App.render = render;

  // ---------------------------------------------------------------- auth
  function renderLogin(root) {
    document.body.classList.add('auth');
    document.getElementById('nav').innerHTML = '';
    document.getElementById('user-box').innerHTML = '';
    root.innerHTML = `<div class="login panel"><h1>Sign in</h1><p class="muted">PSAP Scheduler</p>
      <form id="login-form">
        <div class="field"><label>Username</label><input name="username" autocomplete="username" autofocus required style="width:100%"></div>
        <div class="field"><label>Password</label><input name="password" type="password" autocomplete="current-password" required style="width:100%"></div>
        <button class="btn primary" data-action="login" style="width:100%;justify-content:center">Sign in</button>
        <p class="small muted" id="login-msg"></p>
      </form></div>`;
  }
  App.actions['login'] = async () => {
    const f = App.formData(document.getElementById('login-form'));
    try {
      const r = await api('POST', '/api/login', { username: f.username, password: f.password });
      App.me = r.user;
      if (App.me.mustChange) return render();
      await refresh();
      listen();
    } catch (e) { const m = document.getElementById('login-msg'); if (m) m.textContent = e.message; }
  };
  document.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.closest('#login-form')) { e.preventDefault(); App.actions.login(); } });
  App.actions['logout'] = async () => { try { await api('POST', '/api/logout', {}); } catch { /* ignore */ } App.me = null; S = null; if (events) events.close(); render(); };
  function pwForm(first) {
    return `<form id="pw-form">
      ${first ? '<p>Choose a new password before continuing.</p>' : ''}
      <div class="field"><label>Current password</label><input name="current" type="password" autocomplete="current-password" style="width:100%"></div>
      <div class="field"><label>New password (10+ characters)</label><input name="next" type="password" autocomplete="new-password" style="width:100%"></div>
      <div class="field"><label>Repeat new password</label><input name="again" type="password" autocomplete="new-password" style="width:100%"></div>
      <button class="btn primary" data-action="pw-save">Change password</button> <span class="small muted" id="pw-msg"></span></form>`;
  }
  function renderPwChange(root) {
    document.body.classList.add('auth');
    document.getElementById('nav').innerHTML = '';
    document.getElementById('user-box').innerHTML = '<button class="btn ghost sm" data-action="logout">Sign out</button>';
    root.innerHTML = `<div class="login panel"><h1>New password</h1>${pwForm(true)}</div>`;
  }
  App.actions['pw-open'] = () => App.modal({ title: 'Change password', body: pwForm(false) });
  App.actions['pw-save'] = async () => {
    const f = App.formData(document.getElementById('pw-form'));
    const msg = document.getElementById('pw-msg');
    if (f.next !== f.again) { msg.textContent = 'New passwords do not match'; return; }
    try {
      await api('POST', '/api/password', { current: f.current, next: f.next });
      toast('Password changed');
      App.closeModal();
      if (App.me.mustChange) { App.me.mustChange = false; await refresh(); listen(); }
    } catch (e) { msg.textContent = e.message; }
  };

  // ---------------------------------------------------------- delegation
  document.addEventListener('click', (ev) => {
    const el = ev.target.closest('[data-action]');
    if (!el) return;
    const fn = App.actions[el.dataset.action];
    if (fn) { if (el.tagName === 'A') ev.preventDefault(); fn(el, ev); }
  });
  const onChange = (ev) => {
    const el = ev.target.closest('[data-change]');
    if (!el) return;
    const fn = App.changes[el.dataset.change];
    if (fn) fn(el, ev);
  };
  document.addEventListener('change', onChange);
  document.addEventListener('input', (ev) => { if (ev.target.closest('[data-live]')) onChange(ev); });

  // Forms never submit to the server; buttons do the work. (No inline handlers, so the
  // app runs under a strict Content-Security-Policy.)
  document.addEventListener('submit', (ev) => ev.preventDefault());
  App.actions['print'] = () => window.print();

  App.actions['toggle-theme'] = () => {
    const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
    localStorage.setItem('psap.theme', next);
    render();
  };
  App.actions['go'] = (el) => App.go(el.dataset.to);
  App.changes['view-as'] = (el) => {
    localStorage.setItem(VIEW_AS, JSON.stringify(el.value ? { employeeId: el.value } : null));
    App.me = localViewAs();
    App.go(App.isSup() ? 'dashboard' : 'me');
    render();
  };

  function tick() {
    const d = new Date();
    const c = document.getElementById('clock');
    if (c) c.textContent = `${P.shortDate(P.todayNum(d))} ${P.pad(d.getHours())}${P.pad(d.getMinutes())}`;
  }

  App.start = async function () {
    window.addEventListener('hashchange', () => { if (modalState) App.closeModal(); render(); window.scrollTo(0, 0); });
    tick();
    setInterval(tick, 15000);
    let lastHour = new Date().getHours();
    setInterval(() => { const h = new Date().getHours(); if (h !== lastHour) { lastHour = h; if (!modalState && S) render(); } }, 60000);
    if (location.protocol === 'http:' || location.protocol === 'https:') {
      try {
        const r = await fetch('/api/me', { credentials: 'same-origin' });
        if (r.status === 200 || r.status === 401 || r.status === 403) {
          App.mode = 'server';
          if (r.status === 200) { App.me = (await r.json()).user; if (!App.me.mustChange) { await refresh(); listen(); return; } }
          render();
          return;
        }
      } catch { /* no server: fall through to local mode */ }
    }
    App.mode = 'local';
    S = loadLocal();
    saveLocal();
    App.me = localViewAs();
    render();
  };
})();
