(function () {
  'use strict';
  const { P, esc } = App;
  const S = () => App.S;

  App.ui.settings = { pos: null };

  const tokStr = (st, cycle) => cycle.map((t) => (!t || t === '0') ? 'O' : (t === 1 || t === '1') ? 'W' : P.isShortTok(t) ? 'S' : ((st.shiftTemplates.find((x) => x.id === t) || {}).code || '?')).join(' ');
  function parseTokens(st, str) {
    const toks = String(str).trim().split(/[\s,]+/).filter(Boolean);
    const out = [];
    for (const t of toks) {
      const u = t.toUpperCase();
      if (u === 'O' || u === '-' || u === '0' || u === 'X') out.push(0);
      else if (u === 'W' || u === '1') out.push(1);
      else if (u === 'S') out.push('s');
      else {
        const tpl = st.shiftTemplates.find((x) => x.code.toUpperCase() === u);
        if (!tpl) throw new Error(`Unknown token "${t}" — use W (work), S (4-hour), O (off) or a shift code`);
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
      const B = window.PSAPBalance;
      const rotPat = B.rotationPattern(st);
      const base = rotPat ? (rotPat.base || '') : '';
      const fourH = st.shiftTemplates.filter((t) => +t.hours === 4);
      // 4-hour shift timing per job class and 12-hour shift in use.
      const shortRows = P.jobClasses(st).flatMap((jc) => {
        const mains = [...new Set(st.lines.filter((l) => (P.lineClass(st, l) || {}).id === jc.id && l.employeeId).map((l) => l.shiftTemplateId))]
          .map((id) => st.shiftTemplates.find((t) => t.id === id)).filter((t) => t && +t.hours === 12);
        return mains.map((t) => {
          const ix = P.index(st);
          const startShort = P.shortTemplateOf(null, ix, t.id);
          const cur = (jc.shortShift || {})[t.id] || '';
          const peak = B.suggestPeakStart(st, jc, t.id);
          const peakEnd = peak ? P.mil(P.parseTime(peak) + 240) : '';
          const others = fourH.filter((x) => x.id !== (startShort && startShort.id));
          return `<tr><td>${esc(jc.name)}</td><td>${esc(t.code)} ${t.start.replace(':', '')}</td><td>
            <select data-change="short-shift" data-jc="${jc.id}" data-tpl="${t.id}">
              <option value="" ${!cur ? 'selected' : ''}>When the shift starts${startShort ? ` (${startShort.start.replace(':', '')}–${P.mil(P.parseTime(startShort.start) + startShort.hours * 60)})` : ''}</option>
              ${peak && peak !== t.start ? `<option value="peak:${peak}">Peak call volume: ${peak.replace(':', '')}–${peakEnd} (suggested from minimums)</option>` : ''}
              ${others.map((x) => `<option value="${x.id}" ${cur === x.id ? 'selected' : ''}>${esc(x.code)} ${x.start.replace(':', '')}–${P.mil(P.parseTime(x.start) + 240)}</option>`).join('')}
            </select></td></tr>`;
        });
      }).join('');
      return `<div class="page-head"><div><h1>Settings</h1><p>Your rotation rules, minimum staffing and data. Rarely changed settings are under Advanced.</p></div></div>
      <div class="grid g2">
        <div class="panel"><h2>Rotation rules</h2>
          <div class="field"><label>Center name</label><input value="${esc(c.name)}" data-change="center" data-k="name" style="width:100%"></div>
          <ul class="small" style="margin:6px 0 10px;padding-left:18px;line-height:1.6">
            <li>Three 12-hour shifts plus one 4-hour shift a week: exactly ${c.otThresholdHours || 40} hours, never more.</li>
            <li>People keep their shift (days stay days, nights stay nights). Only days off move.</li>
            <li>Days off move one day later each week, through every combination in 7 weeks${base ? ` <span class="muted">(base week ${P.DOW.map((d, i) => `${d} ${base[i]}`).join(' · ')}; W = 12, S = 4-hour, O = off)</span>` : ''}.</li>
            <li>4-hour shifts are spread across the week so short days don't thin the same shift.</li>
          </ul>
          <div class="form-grid">
            <div class="field"><label>Most days in a row (a 4-hour shift counts)</label>${num('maxConsecutiveDays', 1, 'min="1" max="7"')}</div>
            <div class="field"><label>Notice for changing days off (days)</label>${num('dayOffNoticeDays', 1, 'min="0"')}</div>
            <div class="field"><label>Fix coverage looks ahead (weeks)</label>${num('fixHorizonWeeks', 1, 'min="1" max="12"')}</div>
          </div>
          <p class="small muted">One more day in a row is allowed only when a supervisor marks a move as an emergency on Fix coverage; it is flagged on the schedule.</p>
          <label class="check">${chk('offerTraining')} Offer 4-hour shifts for training when coverage stays at minimum without overtime</label>
          <h3 style="margin-top:12px">When the 4-hour shift is worked</h3>
          ${shortRows ? `<table class="small"><thead><tr><th>Job class</th><th>Shift</th><th>4-hour shift</th></tr></thead><tbody>${shortRows}</tbody></table>
            <p class="small muted">A single line can use its own 4-hour shift (Lines &amp; Bid → edit the line).</p>` : '<p class="small muted">Shows once people hold 12-hour lines.</p>'}
          <h3 style="margin-top:12px">Part-time staff</h3>
          <label class="check">${chk('partTimeFirst')} Offer open shifts to part-timers first (straight time, before full-time OT)</label>
          <div class="form-grid"><div class="field"><label>Default weekly cap (h)</label>${num('partTimeDefaultCap', 0.5)}</div></div>
          <p class="small muted">Part-timers are never forced. A different cap can be set per person on the Staff page.</p>
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
      <details class="panel advanced" style="margin-top:14px"><summary><h2 style="display:inline">Advanced</h2> <span class="small muted">overtime rules, staffing levels, coverage counting, fatigue limits, shifts and patterns</span></summary>
      <div class="grid g2" style="margin-top:10px">
        <div>
          <h3>Overtime</h3>
          <div class="form-grid">
            <div class="field"><label>OT period (days)</label>${num('otPeriodDays', 1, 'min="1"')}</div>
            <div class="field"><label>OT threshold (hours per period)</label>${num('otThresholdHours', 0.5)}</div>
            <div class="field"><label>A period starts on</label><input type="date" value="${esc(c.otPeriodStart)}" data-change="center" data-k="otPeriodStart"></div>
            <div class="field"><label>OT multiplier</label>${num('otMultiplier', 0.05)}</div>
            <div class="field"><label>Fiscal year starts (MM-DD)</label><input value="${esc(c.fiscalYearStart)}" data-change="center" data-k="fiscalYearStart" pattern="\\d{2}-\\d{2}"></div>
            <div class="field"><label>Annual OT budget ($)</label>${num('annualOtBudget', 1000)}</div>
          </div>
          <label class="check">${chk('extraShiftsAlwaysOT')} Extra (non-scheduled) shifts are always paid as OT</label>
          <label class="check">${chk('leaveCountsTowardOT')} Paid leave counts toward the OT threshold</label>
          <p class="small muted">Non-exempt: a 7-day / 40-hour work week, paid leave not counted. Lines always start on a period start so every week is 40 hours.</p>
          <div class="field" style="margin-top:8px"><label>Mandatory (forced) OT order</label><select data-change="center" data-k="forceOrderBasis">
            <option value="lastOT" ${c.forceOrderBasis !== 'lastForced' ? 'selected' : ''}>Longest since any OT worked, then least senior</option>
            <option value="lastForced" ${c.forceOrderBasis === 'lastForced' ? 'selected' : ''}>Longest since last forced, then least senior</option></select></div>
          <label class="check">${chk('tradeRequiresApproval')} Shift trades need supervisor approval</label>
          <h3 style="margin-top:12px">Fatigue &amp; fill rules</h3>
          <div class="form-grid">
            <div class="field"><label>Min rest between shifts (h)</label>${num('minRestHours', 0.5)}</div>
            <div class="field"><label>Max continuous hours</label>${num('maxShiftHours', 0.5)}</div>
            <div class="field"><label>Warn above hours in 7 days</label>${num('maxHours7Days', 1)}</div>
          </div>
          <h3 style="margin-top:12px">Lines</h3>
          <div class="form-grid">
            <div class="field"><label>Line tools build</label><select data-change="center" data-k="lineMode"><option value="rotation" ${c.lineMode !== 'weekly' ? 'selected' : ''}>The rotation (3 × 12 + one 4-hour)</option><option value="weekly" ${c.lineMode === 'weekly' ? 'selected' : ''}>Fixed 7-day patterns (8s, 10s...)</option></select></div>
            <div class="field"><label>Rotation base week (Sun → Sat)</label><input value="${esc(base)}" data-change="rot-base" maxlength="7" style="font-family:monospace;width:110px" title="7 letters: W = 12-hour, S = 4-hour, O = off"></div>
          </div>
          <p class="small muted">The base week sets where the 12s, the 4-hour shift and days off fall; each later week moves it one day. It must keep within the days-in-a-row limit.</p>
        </div>
        <div>
          <h3>Console coverage</h3>
          <div class="form-grid">
            <div class="field"><label>Scheduling day starts at</label><select data-change="center" data-k="dayStartHour"><option value="">Auto: earliest regular shift (now ${P.mil(P.schedulingDayStart(Object.assign({}, st, { center: Object.assign({}, c, { dayStartHour: '' }) })))})</option>${Array.from({ length: 24 }, (_, h) => `<option value="${h}" ${c.dayStartHour !== '' && c.dayStartHour != null && +c.dayStartHour === h ? 'selected' : ''}>${P.pad(h)}00</option>`).join('')}</select></div>
            <div class="field"><label>Shift changes (optional)</label><input value="${esc(c.shiftBoundaries || '')}" placeholder="e.g. 0700,1900 — blank = from your shifts" data-change="center" data-k="shiftBoundaries"></div>
          </div>
          <p class="small muted">Consoles, Coverage and the Dashboard run from this time to the same time the next day, so a 1900-0700 night shift stays in one day. Shifts: ${P.shiftBlocks(st, P.todayNum()).map((b) => `${P.mil(b.start)}–${P.mil(b.end)}`).join(', ')}.</p>
          <div class="form-grid">
            <div class="field"><label>Count staff toward minimums by</label><select data-change="center" data-k="coverageMode"><option value="assigned" ${c.coverageMode !== 'home' ? 'selected' : ''}>Console assignment (use cross-training)</option><option value="home" ${c.coverageMode === 'home' ? 'selected' : ''}>Preferred console only</option></select></div>
            <div class="field"><label>Counts for an hour if on duty ≥ (min)</label>${num('minPresenceMinutes', 5)}</div>
          </div>
          <h3 style="margin-top:12px">Staffing levels</h3>
          <div class="form-grid">
            <div class="field"><label>Normal at or above (% of authorized)</label>${num('levelNormalPct', 1)}</div>
            <div class="field"><label>Short at or above (below is Critical)</label>${num('levelShortPct', 1)}</div>
          </div>
          <table class="small"><thead><tr><th>Level</th><th title="People above minimum per console-hour that's acceptable">Relief margin</th><th title="Most people off per day in a job class; blank = the job class's own limit">Vacation limit / day</th><th>Balancing</th></tr></thead><tbody>
            ${['normal', 'short', 'critical'].map((lv) => { const r = (c.levelRules || {})[lv] || {}; return `<tr><td>${App.levelBadge({ level: lv, effective: 0, authorized: 0, pct: null })}</td>
              <td><input type="number" min="0" step="1" value="${esc(r.reliefMargin ?? '')}" data-change="level-rule" data-lv="${lv}" data-f="reliefMargin" style="width:70px" ${lv === 'normal' ? '' : 'title="Short and Critical always use 0 when balancing"'}></td>
              <td><input type="number" min="0" step="1" value="${esc(r.maxOffPerDay ?? '')}" placeholder="class" data-change="level-rule" data-lv="${lv}" data-f="maxOffPerDay" style="width:70px"></td>
              <td class="small muted">${lv === 'normal' ? 'Keeps the relief margin' : lv === 'short' ? 'Margin 0; part-timers before OT' : 'Minimums only; spreads gaps evenly; lists OT needed'}</td></tr>`; }).join('')}
          </tbody></table>
          <label class="check">${chk('levelIncludesPartTime')} Part-time FTE counts toward the staffing level</label>
          <div class="field" style="margin-top:6px"><label>Part-timers' scheduled lines</label><select data-change="center" data-k="partTimeOnLines">
            <option value="count" ${c.partTimeOnLines !== 'extra' ? 'selected' : ''}>Count toward minimums</option>
            <option value="extra" ${c.partTimeOnLines === 'extra' ? 'selected' : ''}>Are extra, on top of minimums (shifts they pick up still count)</option></select></div>
        </div>
      </div>
      <div class="grid g2" style="margin-top:14px">
        <div><h3>Shift templates <button class="btn sm" data-action="tpl-add">+ Shift</button></h3>
          <div class="table-wrap"><table><thead><tr><th>Code</th><th>Name</th><th>Start</th><th>Hours</th><th title="The 4-hour shift a line on this shift works (12-hour shifts)">4-hour shift</th><th>Color</th><th></th></tr></thead><tbody>
          ${st.shiftTemplates.map((t) => `<tr><td><input value="${esc(t.code)}" data-change="tpl" data-id="${t.id}" data-f="code" style="width:70px"></td><td><input value="${esc(t.name)}" data-change="tpl" data-id="${t.id}" data-f="name"></td>
            <td><input type="time" value="${esc(t.start)}" data-change="tpl" data-id="${t.id}" data-f="start"></td><td><input type="number" step="0.25" min="0.25" max="24" value="${t.hours}" data-change="tpl" data-id="${t.id}" data-f="hours" style="width:70px"></td>
            <td>${+t.hours >= 8 ? `<select data-change="tpl" data-id="${t.id}" data-f="shortTemplateId"><option value="">—</option>${App.opts(fourH.map((x) => ({ id: x.id, name: `${x.code} ${x.start.replace(':', '')}` })), t.shortTemplateId || '')}</select>` : ''}</td>
            <td><input type="color" value="${esc(t.color)}" data-change="tpl" data-id="${t.id}" data-f="color" style="width:44px;padding:0"></td><td><button class="btn sm danger" data-action="tpl-del" data-id="${t.id}">✕</button></td></tr>`).join('')}
          </tbody></table></div></div>
        <div><h3>Patterns <button class="btn sm" data-action="pat-add">+ Pattern</button></h3>
          <p class="small muted">One token per day: <b>W</b> = the line's shift, <b>S</b> = the line's 4-hour shift, <b>O</b> = off, or a shift code (e.g. <b>N12</b>).</p>
          <div class="table-wrap"><table><thead><tr><th>Name</th><th>Days</th><th>Cycle</th><th></th></tr></thead><tbody>
          ${st.patterns.map((p) => `<tr><td><input value="${esc(p.name)}" data-change="pat-name" data-id="${p.id}"></td><td class="num">${p.cycle.length}</td>
            <td>${p.rotation ? `<span class="small muted">Built from the base week (Advanced → Lines)</span>` : `<input value="${esc(tokStr(st, p.cycle))}" data-change="pat-cycle" data-id="${p.id}" style="min-width:260px;font-family:monospace">`}</td><td>${p.rotation ? '' : `<button class="btn sm danger" data-action="pat-del" data-id="${p.id}">✕</button>`}</td></tr>`).join('')}
          </tbody></table></div></div>
      </div>
      </details>
      ${App.mode === 'server' ? `<div class="panel" style="margin-top:14px"><h2>Audit log <button class="btn sm" data-action="audit-load">${App.ui.audit ? 'Refresh' : 'Load'}</button></h2>${auditTable()}</div>` : ''}
`;
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

  App.changes['level-rule'] = (el) => App.commit((s) => {
    const rules = JSON.parse(JSON.stringify(s.center.levelRules || {}));
    rules[el.dataset.lv] = Object.assign({}, rules[el.dataset.lv]);
    rules[el.dataset.lv][el.dataset.f] = el.value === '' ? '' : Math.max(0, +el.value);
    s.center.levelRules = rules;
  }, 'Saved');
  App.changes['center'] = (el) => App.commit((s) => {
    const k = el.dataset.k;
    s.center[k] = el.dataset.type === 'num' ? +el.value : el.dataset.type === 'bool' ? el.checked : el.value;
  }, 'Saved');
  // 4-hour shift timing for a job class's 12-hour shift: at shift start, peak hours or a chosen 4-hour shift.
  App.changes['short-shift'] = (el) => App.commit((s) => {
    const jc = s.jobClasses.find((x) => x.id === el.dataset.jc);
    if (!jc) return;
    let id = el.value;
    if (id.startsWith('peak:')) {
      const start = id.slice(5);
      let t = s.shiftTemplates.find((x) => +x.hours === 4 && x.start === start);
      if (!t) {
        const main = s.shiftTemplates.find((x) => x.id === el.dataset.tpl) || {};
        t = { id: P.uid('tpl'), code: `${(main.code || 'S').replace(/12$/, '')}4P`, name: `Peak 4 (${start.replace(':', '')})`, start, hours: 4, color: main.color || '#64748b' };
        s.shiftTemplates.push(t);
      }
      id = t.id;
    }
    jc.shortShift = Object.assign({}, jc.shortShift);
    if (id) jc.shortShift[el.dataset.tpl] = id; else delete jc.shortShift[el.dataset.tpl];
  }, '4-hour shift saved');
  App.changes['rot-base'] = (el) => {
    const st = S();
    let cyc;
    try { cyc = P.rotationCycle(el.value); } catch (e) { return App.toast(e.message, true); }
    const b = el.value.toUpperCase();
    if ((b.match(/W/g) || []).length !== 3 || (b.match(/S/g) || []).length !== 1) return App.toast('The base week needs three W (12-hour), one S (4-hour) and three O (off)', true);
    const lim = +st.center.maxConsecutiveDays || 7;
    if (P.cycleMaxRun(cyc) > lim) return App.toast(`That base week makes ${P.cycleMaxRun(cyc)} days in a row somewhere in the 7 weeks (limit ${lim})`, true);
    App.commit((s) => { const p = window.PSAPBalance.rotationPattern(s); if (p) { p.cycle = cyc; p.base = b; } }, `Rotation saved (most in a row: ${P.cycleMaxRun(cyc)})`);
  };
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
    const id = el.dataset.id;
    const used = st.lines.some((l) => l.shiftTemplateId === id || l.shortTemplateId === id) || st.patterns.some((p) => p.cycle.includes(id)) || st.shiftTemplates.some((t) => t.shortTemplateId === id) || st.jobClasses.some((jc) => Object.values(jc.shortShift || {}).includes(id));
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
