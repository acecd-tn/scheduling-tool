(function () {
  'use strict';
  const { P, esc } = App;
  const S = () => App.S;

  App.ui.settings = { pos: null };

  const tokStr = (st, cycle) => cycle.map((t) => (!t || t === '0') ? 'O' : (t === 1 || t === '1') ? 'W' : ((st.shiftTemplates.find((x) => x.id === t) || {}).code || '?')).join(' ');
  function parseTokens(st, str) {
    const toks = String(str).trim().split(/[\s,]+/).filter(Boolean);
    const out = [];
    for (const t of toks) {
      const u = t.toUpperCase();
      if (u === 'O' || u === '-' || u === '0' || u === 'X') out.push(0);
      else if (u === 'W' || u === '1') out.push(1);
      else {
        const tpl = st.shiftTemplates.find((x) => x.code.toUpperCase() === u);
        if (!tpl) throw new Error(`Unknown token "${t}" — use W (work), O (off) or a shift code`);
        out.push(tpl.id);
      }
    }
    if (!out.length) throw new Error('Pattern is empty');
    return out;
  }

  App.views.settings = {
    render(st, ui) {
      const c = st.center;
      const u = ui.settings;
      if (!u.pos || !st.positions.some((p) => p.id === u.pos)) u.pos = st.positions[0] && st.positions[0].id;
      const grid = st.minimums[u.pos] || [];
      const num = (k, step = 1, extra = '') => `<input type="number" step="${step}" value="${esc(c[k])}" data-change="center" data-k="${k}" data-type="num" ${extra}>`;
      const chk = (k) => `<input type="checkbox" ${c[k] ? 'checked' : ''} data-change="center" data-k="${k}" data-type="bool">`;
      return `<div class="page-head"><div><h1>Settings</h1><p>Center rules, minimum staffing, shifts and rotation patterns.</p></div></div>
      <div class="grid g2">
        <div class="panel"><h2>Center & overtime rules</h2>
          <div class="form-grid">
            <div class="field" style="grid-column:1/-1"><label>Center name</label><input value="${esc(c.name)}" data-change="center" data-k="name" style="width:100%"></div>
            <div class="field"><label>OT period (days)</label>${num('otPeriodDays', 1, 'min="1"')}</div>
            <div class="field"><label>OT threshold (hours per period)</label>${num('otThresholdHours', 0.5)}</div>
            <div class="field"><label>A period starts on</label><input type="date" value="${esc(c.otPeriodStart)}" data-change="center" data-k="otPeriodStart"></div>
            <div class="field"><label>OT multiplier</label>${num('otMultiplier', 0.05)}</div>
            <div class="field"><label>Fiscal year starts (MM-DD)</label><input value="${esc(c.fiscalYearStart)}" data-change="center" data-k="fiscalYearStart" pattern="\\d{2}-\\d{2}"></div>
            <div class="field"><label>Annual OT budget ($)</label>${num('annualOtBudget', 1000)}</div>
          </div>
          <label class="check">${chk('extraShiftsAlwaysOT')} Extra (non-scheduled) shifts are always paid as OT</label>
          <label class="check">${chk('leaveCountsTowardOT')} Paid leave counts toward the OT threshold</label>
          <p class="small muted">FLSA default is a 7-day / 40-hour work week, paid leave not counted. Many 12-hour centers use 14/80 or a 7(k)-style period; check your policy / MOU.</p>
          <h3 style="margin-top:12px">Console coverage</h3>
          <div class="form-grid">
            <div class="field"><label>Scheduling day starts at</label><select data-change="center" data-k="dayStartHour"><option value="">Auto: earliest regular shift (now ${P.mil(P.schedulingDayStart(Object.assign({}, st, { center: Object.assign({}, c, { dayStartHour: '' }) })))})</option>${Array.from({ length: 24 }, (_, h) => `<option value="${h}" ${c.dayStartHour !== '' && c.dayStartHour != null && +c.dayStartHour === h ? 'selected' : ''}>${P.pad(h)}00</option>`).join('')}</select></div>
            <div class="field"><label>Shift changes (optional)</label><input value="${esc(c.shiftBoundaries || '')}" placeholder="e.g. 0700,1900 — blank = from your shifts" data-change="center" data-k="shiftBoundaries"></div>
          </div>
          <p class="small muted">Consoles, Coverage and the Dashboard run from this time to the same time the next day, so a 1900-0700 night shift stays in one day. Shift changes divide that day into shifts (${P.shiftBlocks(st, P.todayNum()).map((b) => `${P.mil(b.start)}–${P.mil(b.end)}`).join(', ')}).</p>
          <div class="form-grid">
            <div class="field"><label>Count staff toward minimums by</label><select data-change="center" data-k="coverageMode"><option value="assigned" ${c.coverageMode !== 'home' ? 'selected' : ''}>Console assignment (use cross-training)</option><option value="home" ${c.coverageMode === 'home' ? 'selected' : ''}>Preferred console only</option></select></div>
            <div class="field"><label>Counts for an hour if on duty ≥ (min)</label>${num('minPresenceMinutes', 5)}</div>
          </div>
          <label class="check">${chk('tradeRequiresApproval')} Shift trades need supervisor approval</label>
          <div class="field" style="margin-top:8px"><label>Mandatory (forced) OT order</label><select data-change="center" data-k="forceOrderBasis">
            <option value="lastOT" ${c.forceOrderBasis !== 'lastForced' ? 'selected' : ''}>Longest since any OT worked, then least senior</option>
            <option value="lastForced" ${c.forceOrderBasis === 'lastForced' ? 'selected' : ''}>Longest since last forced, then least senior</option></select></div>
          <h3 style="margin-top:12px">Part-time staff</h3>
          <label class="check">${chk('partTimeFirst')} Offer open shifts to part-timers first (straight time, before full-time OT)</label>
          <div class="form-grid"><div class="field"><label>Default weekly cap (h)</label>${num('partTimeDefaultCap', 0.5)}</div></div>
          <p class="small muted">Part-timers are never on the forced list. A different cap can be set per person on the Staff page.</p>
          <h3 style="margin-top:12px">Fatigue & fill rules</h3>
          <div class="form-grid">
            <div class="field"><label>Min rest between shifts (h)</label>${num('minRestHours', 0.5)}</div>
            <div class="field"><label>Max continuous hours</label>${num('maxShiftHours', 0.5)}</div>
            <div class="field"><label>Warn above hours in 7 days</label>${num('maxHours7Days', 1)}</div>
          </div>
        </div>
        <div class="panel"><h2>Data</h2>
          ${App.mode === 'server' ? `<p>Data is stored on the server${App.isAdmin() ? '. Back it up by copying the data folder or exporting here.' : '. Admins can export and import backups.'}</p>
          ${App.isAdmin() ? `<div class="toolbar"><a class="btn" href="/api/export">Export backup (JSON)</a>
            <label class="btn">Import backup<input type="file" accept=".json,application/json" data-change="data-import" hidden></label>
            <button class="btn" data-action="data-demo">Load demo data</button><button class="btn danger" data-action="data-reset">Start empty</button></div>` : ''}`
          : `<p>Data is saved in this browser only. Export regularly as a backup or to move it to another computer. For logins and shared access, run the server (see README).</p>
          <div class="toolbar"><button class="btn" data-action="data-export">Export backup (JSON)</button>
            <label class="btn">Import backup<input type="file" accept=".json,application/json" data-change="data-import" hidden></label>
            <button class="btn" data-action="data-demo">Load demo data</button>
            <button class="btn danger" data-action="data-reset">Start empty</button></div>`}
          <div class="section"><h3>Special-day minimums</h3>
            <p class="small muted">Raise (or lower) minimums for a specific date: holidays, July 4th, New Year's Eve, storms, big events.</p>
            <table><thead><tr><th>Date</th><th>Console</th><th>From hr</th><th>To hr</th><th>Min</th><th>Note</th><th></th></tr></thead><tbody>
            ${st.minimumOverrides.map((o, i) => `<tr><td>${esc(o.date)}</td><td>${esc(App.posName(o.positionId))}</td><td>${o.startHour}</td><td>${o.endHour}</td><td>${o.minimum}</td><td>${esc(o.note || '')}</td><td><button class="btn sm danger" data-action="ovr-del" data-i="${i}">✕</button></td></tr>`).join('') || '<tr><td colspan="7" class="muted">None</td></tr>'}
            <tr><td><input type="date" id="ovr-date"></td><td><select id="ovr-pos">${App.opts(st.positions, '')}</select></td><td><input type="number" id="ovr-s" min="0" max="23" value="0" style="width:60px"></td><td><input type="number" id="ovr-e" min="1" max="24" value="24" style="width:60px"></td><td><input type="number" id="ovr-m" min="0" value="6" style="width:60px"></td><td><input id="ovr-note" placeholder="e.g. NYE"></td><td><button class="btn sm primary" data-action="ovr-add">Add</button></td></tr>
            </tbody></table></div>
        </div>
      </div>
      <div class="panel" style="margin-top:14px"><h2>Minimum staffing by hour, per console <span class="toolbar"><select data-change="set-pos">${App.opts(st.positions, u.pos)}</select></span></h2>
        <p class="small muted">Minimum number of people (consoles for console positions) required each hour. Edits save as you go.</p>
        <div class="toolbar" style="margin-bottom:8px">Set
          ${P.DOW.map((d, i) => `<label class="check"><input type="checkbox" class="qf-day" value="${i}" checked> ${d}</label>`).join('')}
          from <input type="number" id="qf-s" min="0" max="23" value="0" style="width:60px"> to <input type="number" id="qf-e" min="1" max="24" value="24" style="width:60px">
          = <input type="number" id="qf-v" min="0" value="4" style="width:60px"> <button class="btn sm primary" data-action="qf-apply">Apply</button>
        </div>
        <div class="table-wrap"><table class="mingrid"><thead><tr><th></th>${Array.from({ length: 24 }, (_, h) => `<th>${P.pad(h)}</th>`).join('')}<th>Person-h</th></tr></thead><tbody>
        ${P.DOW.map((d, di) => `<tr><th>${d}</th>${Array.from({ length: 24 }, (_, h) => `<td><input type="number" min="0" value="${(grid[di] || [])[h] || 0}" data-change="min-cell" data-d="${di}" data-h="${h}"></td>`).join('')}<td class="num">${(grid[di] || []).reduce((s, v) => s + (+v || 0), 0)}</td></tr>`).join('')}
        </tbody></table></div></div>
      ${App.mode === 'server' ? `<div class="panel" style="margin-top:14px"><h2>Audit log <button class="btn sm" data-action="audit-load">${App.ui.audit ? 'Refresh' : 'Load'}</button></h2>${auditTable()}</div>` : ''}
      <div class="grid g2" style="margin-top:14px">
        <div class="panel"><h2>Shift templates <button class="btn sm" data-action="tpl-add">+ Shift</button></h2>
          <table><thead><tr><th>Code</th><th>Name</th><th>Start</th><th>Hours</th><th>Color</th><th></th></tr></thead><tbody>
          ${st.shiftTemplates.map((t) => `<tr><td><input value="${esc(t.code)}" data-change="tpl" data-id="${t.id}" data-f="code" style="width:70px"></td><td><input value="${esc(t.name)}" data-change="tpl" data-id="${t.id}" data-f="name"></td>
            <td><input type="time" value="${esc(t.start)}" data-change="tpl" data-id="${t.id}" data-f="start"></td><td><input type="number" step="0.25" min="0.25" max="24" value="${t.hours}" data-change="tpl" data-id="${t.id}" data-f="hours" style="width:70px"></td>
            <td><input type="color" value="${esc(t.color)}" data-change="tpl" data-id="${t.id}" data-f="color" style="width:44px;padding:0"></td><td><button class="btn sm danger" data-action="tpl-del" data-id="${t.id}">✕</button></td></tr>`).join('')}
          </tbody></table></div>
        <div class="panel"><h2>Rotation patterns <button class="btn sm" data-action="pat-add">+ Pattern</button></h2>
          <p class="small muted">One token per day: <b>W</b> = work the line's shift, <b>O</b> = off, or a shift code (e.g. <b>N12</b>) for rotating patterns.</p>
          <table><thead><tr><th>Name</th><th>Days</th><th>Cycle</th><th></th></tr></thead><tbody>
          ${st.patterns.map((p) => `<tr><td><input value="${esc(p.name)}" data-change="pat-name" data-id="${p.id}"></td><td class="num">${p.cycle.length}</td>
            <td><input value="${esc(tokStr(st, p.cycle))}" data-change="pat-cycle" data-id="${p.id}" style="min-width:260px;font-family:monospace"></td><td><button class="btn sm danger" data-action="pat-del" data-id="${p.id}">✕</button></td></tr>`).join('')}
          </tbody></table></div>
      </div>`;
    },
  };

  function auditTable() {
    const list = App.ui.audit;
    if (!list) return '<p class="small muted">Every change — who, what, when, before and after — is recorded on the server.</p>';
    const summary = (e) => {
      if (!e.detail || !e.detail.changes) return e.detail ? esc(JSON.stringify(e.detail).slice(0, 160)) : '';
      return e.detail.changes.slice(0, 6).map((c) => {
        const x = c.after || c.before || {};
        const who = x.employeeId ? P.empName(App.emp(x.employeeId)) : x.lastName ? P.empName(x) : '';
        return `${esc(c.op)} ${esc(c.kind)}${who ? ' · ' + esc(who) : ''}${x.date ? ' · ' + esc(x.date) : ''}${x.status ? ' · ' + esc(x.status) : ''}`;
      }).join('<br>') + (e.detail.changes.length > 6 ? `<br>+${e.detail.changes.length - 6} more` : '');
    };
    return `<div class="table-wrap" style="max-height:420px"><table><thead><tr><th>When</th><th>User</th><th>Action</th><th>Changes</th></tr></thead><tbody>
      ${list.map((e) => `<tr><td class="nowrap small">${esc(new Date(e.at).toLocaleString())}</td><td>${esc(e.username || '')}</td><td class="small">${esc(e.action)}</td><td class="small">${summary(e)}</td></tr>`).join('')}
    </tbody></table></div>`;
  }
  App.actions['audit-load'] = () => App.api('GET', '/api/audit?limit=300').then((r) => { App.ui.audit = r.entries; App.render(); }).catch((e) => App.toast(e.message, true));

  App.changes['center'] = (el) => App.commit((s) => {
    const k = el.dataset.k;
    s.center[k] = el.dataset.type === 'num' ? +el.value : el.dataset.type === 'bool' ? el.checked : el.value;
  }, 'Saved');
  App.changes['set-pos'] = (el) => { App.ui.settings.pos = el.value; App.render(); };
  App.changes['min-cell'] = (el) => App.silent((s) => { s.minimums[App.ui.settings.pos][+el.dataset.d][+el.dataset.h] = Math.max(0, +el.value || 0); });
  App.actions['qf-apply'] = () => {
    const days = [...document.querySelectorAll('.qf-day:checked')].map((x) => +x.value);
    const a = +document.getElementById('qf-s').value, b = +document.getElementById('qf-e').value, v = +document.getElementById('qf-v').value;
    App.commit((s) => { for (const d of days) for (let h = a; h < b; h++) s.minimums[App.ui.settings.pos][d][h] = v; }, 'Minimums updated');
  };
  App.actions['ovr-add'] = () => {
    const date = document.getElementById('ovr-date').value;
    if (!date) return App.toast('Pick a date', true);
    App.commit((s) => s.minimumOverrides.push({ date, positionId: document.getElementById('ovr-pos').value, startHour: +document.getElementById('ovr-s').value, endHour: +document.getElementById('ovr-e').value, minimum: +document.getElementById('ovr-m').value, note: document.getElementById('ovr-note').value }), 'Special-day minimum added');
  };
  App.actions['ovr-del'] = (el) => App.commit((s) => s.minimumOverrides.splice(+el.dataset.i, 1));

  App.changes['tpl'] = (el) => App.commit((s) => { const t = s.shiftTemplates.find((x) => x.id === el.dataset.id); t[el.dataset.f] = el.dataset.f === 'hours' ? +el.value : el.value; });
  App.actions['tpl-add'] = () => App.commit((s) => s.shiftTemplates.push({ id: P.uid('t'), code: 'NEW', name: 'New shift', start: '08:00', hours: 8, color: '#64748b' }));
  App.actions['tpl-del'] = (el) => {
    const st = S();
    const used = st.lines.some((l) => l.shiftTemplateId === el.dataset.id) || st.patterns.some((p) => p.cycle.includes(el.dataset.id));
    if (used) return App.toast('This shift is used by a line or pattern', true);
    App.commit((s) => { s.shiftTemplates = s.shiftTemplates.filter((t) => t.id !== el.dataset.id); });
  };
  App.changes['pat-name'] = (el) => App.silent((s) => { s.patterns.find((p) => p.id === el.dataset.id).name = el.value; });
  App.changes['pat-cycle'] = (el) => {
    try { const cyc = parseTokens(S(), el.value); App.commit((s) => { s.patterns.find((p) => p.id === el.dataset.id).cycle = cyc; }, 'Pattern saved'); }
    catch (e) { App.toast(e.message, true); }
  };
  App.actions['pat-add'] = () => App.commit((s) => s.patterns.push({ id: P.uid('p'), name: 'New pattern', cycle: [1, 1, 1, 1, 1, 0, 0] }));
  App.actions['pat-del'] = (el) => {
    if (S().lines.some((l) => l.patternId === el.dataset.id)) return App.toast('This pattern is used by a line', true);
    App.commit((s) => { s.patterns = s.patterns.filter((p) => p.id !== el.dataset.id); });
  };

  App.actions['data-export'] = () => App.download(`psap-scheduler-backup-${P.fmtDate(P.todayNum())}.json`, JSON.stringify(S(), null, 1));
  App.changes['data-import'] = (el) => {
    const file = el.files && el.files[0];
    if (!file) return;
    file.text().then((txt) => {
      const data = JSON.parse(txt);
      if (!data || !Array.isArray(data.employees)) throw new Error('Not a PSAP Scheduler backup');
      App.confirm('Replace ALL current data with this backup?', () => App.replaceState(data, 'Backup imported'), 'Replace');
    }).catch((e) => App.toast('Import failed: ' + e.message, true));
  };
  App.actions['data-demo'] = () => App.confirm('Replace all current data with demo data?', () => App.replaceState(P.demoState(), 'Demo data loaded'), 'Load demo');
  App.actions['data-reset'] = () => App.confirm('Erase everything and start with an empty center? Export a backup first if you need it.', () => App.replaceState(P.emptyState(), 'Started empty'), 'Erase');
})();
