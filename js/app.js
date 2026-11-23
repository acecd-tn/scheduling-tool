/* PSAP Scheduler — app shell: storage, routing, modals, shared helpers. */
(function () {
  'use strict';
  const P = window.PSAP;
  const KEY = 'psap-scheduler.v1';
  let S = null;

  const App = window.App = {
    P,
    views: {},
    actions: {},
    changes: {},
    ui: {},
    get S() { return S; },
  };

  // ------------------------------------------------------------- storage
  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) return P.migrate(JSON.parse(raw));
    } catch (e) { console.warn('load failed', e); }
    return P.migrate(P.demoState());
  }
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(S)); }
    catch (e) { toast('Could not save: ' + e.message, true); }
  }
  /** Mutate state, persist, re-render. */
  App.commit = function (fn, msg) { fn(S); save(); render(); if (msg) toast(msg); };
  /** Mutate state and persist without re-rendering (inline edits keep focus). */
  App.silent = function (fn) { fn(S); save(); };
  App.replaceState = function (next, msg) { S = P.migrate(next); save(); render(); if (msg) toast(msg); };

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
  App.reasonLabel = (r) => r === 'vacancy' ? 'Vacancy / structural' : r === 'built-in' ? 'Built-in (schedule)' : App.excType(r).label;
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

  // --------------------------------------------------------------- toast
  function toast(msg, err) {
    const el = document.createElement('div');
    el.className = 'toast' + (err ? ' err' : '');
    el.textContent = msg;
    document.getElementById('toasts').appendChild(el);
    setTimeout(() => el.remove(), 3200);
  }
  App.toast = toast;

  // --------------------------------------------------------------- modal
  let modalState = null;
  App.modal = function (o) {
    modalState = o;
    drawModal();
  };
  function drawModal() {
    const root = document.getElementById('modal-root');
    if (!modalState) { root.innerHTML = ''; return; }
    const o = modalState;
    const body = typeof o.body === 'function' ? o.body() : o.body;
    root.innerHTML = `<div class="modal-back" data-action="modal-bg"><div class="modal ${o.wide ? 'wide' : ''}" role="dialog" aria-modal="true">
      <div class="modal-head"><h2>${esc(o.title)}</h2><button class="btn ghost sm" data-action="modal-close" aria-label="Close">✕</button></div>
      <form class="modal-body" id="modal-form" onsubmit="return false">${body}</form>
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
      if (el && !Array.isArray(v) && el.type !== 'checkbox' && el.type !== 'radio' && el.tagName !== 'BUTTON') el.value = v;
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
  const NAV = [
    ['dashboard', 'Dashboard'], ['schedule', 'Schedule'], ['coverage', 'Coverage'], ['openings', 'Openings'],
    ['overtime', 'Overtime'], ['bid', 'Lines & Bid'], ['staff', 'Staff'], ['planner', 'Planner'], ['settings', 'Settings'],
  ];
  function route() {
    const h = (location.hash || '#/dashboard').slice(2).split('?')[0];
    return App.views[h] ? h : 'dashboard';
  }
  App.go = (name) => { location.hash = '#/' + name; };

  function render() {
    const cur = route();
    const pending = S.exceptions.filter((e) => e.status === 'pending').length;
    document.getElementById('nav').innerHTML = NAV.map(([id, label]) =>
      `<a href="#/${id}" class="${id === cur ? 'active' : ''}">${label}${id === 'openings' && pending ? ` <span class="badge warn" title="Pending time-off requests">${pending}</span>` : ''}</a>`).join('');
    document.getElementById('center-name').textContent = S.center.name;
    document.documentElement.dataset.theme = S.center.theme === 'light' ? 'light' : 'dark';
    const v = App.views[cur];
    const root = document.getElementById('view');
    try {
      root.innerHTML = v.render(S, App.ui);
      if (v.after) v.after(root);
    } catch (e) {
      console.error(e);
      root.innerHTML = `<div class="panel callout bad"><b>Something went wrong rendering this page.</b><pre>${esc(e.stack || e)}</pre></div>`;
    }
    if (modalState) App.redrawModal();
  }
  App.render = render;

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

  App.actions['toggle-theme'] = () => App.commit((s) => { s.center.theme = s.center.theme === 'light' ? 'dark' : 'light'; });
  App.actions['go'] = (el) => App.go(el.dataset.to);

  function tick() {
    const d = new Date();
    const c = document.getElementById('clock');
    if (c) c.textContent = `${P.shortDate(P.todayNum(d))} ${P.pad(d.getHours())}${P.pad(d.getMinutes())}`;
  }

  App.start = function () {
    S = load();
    save();
    window.addEventListener('hashchange', () => { render(); window.scrollTo(0, 0); });
    render();
    tick();
    setInterval(tick, 15000);
    // refresh time-sensitive pages at the top of every hour
    let lastHour = new Date().getHours();
    setInterval(() => { const h = new Date().getHours(); if (h !== lastHour) { lastHour = h; if (!modalState) render(); } }, 60000);
  };
})();
