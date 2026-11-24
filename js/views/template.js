/* Upload a schedule template (Schedules & Bids → Schedule template): one schedule slot per row block. */
(function () {
  'use strict';
  const { P, esc, hrs } = App;
  const T = window.PSAPTemplate;
  const X = window.PSAPXlsx;
  const S = () => App.S;

  const fresh = () => ({ parsed: null, fileName: '', text: '', jobClassId: '', anchor: '', effective: '', assign: {}, applyFixes: true, endCurrent: true, matchWeek: true, error: '' });
  App.ui.tpl = fresh();

  const cellCode = (st, tok, baseId) => {
    if (!tok) return '';
    const t = st.shiftTemplates.find((x) => x.id === (tok === 1 ? baseId : tok));
    return t ? t.code : '?';
  };

  App.templateTab = function (st) {
    const u = App.ui.tpl;
    const limit = +st.center.maxConsecutiveDays || 4;
    const intro = `<div class="panel"><h2>Upload your schedule template</h2>
      <p class="small muted" style="margin:0 0 8px">Use the spreadsheet you already schedule from: a block per shift with a title like <b>Days (0700 - 1900)</b>, then one row per slot and week (<b>Day 1 · Week 1 · Mon … Sun</b>) with <b>Work</b>, <b>RDO</b> or a time like <b>1100-1500</b>. A slot with its own hours can say so in its name, e.g. <b>Mid-Shift (1100-2300)</b>. Each slot becomes a schedule slot that repeats every 2 weeks (or however many weeks it has).</p>
      <div class="toolbar">
        <label class="btn primary">Choose .xlsx or .csv<input type="file" accept=".xlsx,.csv,.txt,.tsv" data-change="tpl-file" hidden></label>
        <span class="small muted">or paste the rows:</span>
      </div>
      <textarea rows="4" style="width:100%;margin-top:8px;font-family:monospace;font-size:12px" placeholder="Days (0700 - 1900)&#10;Employee&#9;Week&#9;Mon&#9;Tue&#9;…&#10;Day 1&#9;Week 1&#9;Work&#9;1100-1500&#9;…" data-change="tpl-text">${esc(u.text)}</textarea>
      <div class="toolbar" style="margin-top:6px"><button class="btn" data-action="tpl-read-text">Read pasted rows</button>${u.parsed ? '<button class="btn" data-action="tpl-reset">Start over</button>' : ''}</div>
      ${u.error ? `<div class="callout bad" style="margin-top:8px">${esc(u.error)}</div>` : ''}</div>`;
    if (!u.parsed) return intro;

    const parsed = u.parsed;
    const pv = T.preview(st, parsed, limit);
    const tmpTpl = st.shiftTemplates.concat(pv.templates);
    const stTmp = Object.assign({}, st, { shiftTemplates: tmpTpl });
    const classes = P.jobClasses(st);
    if (!u.jobClassId) u.jobClassId = (classes.find((c) => /telecom|dispatch/i.test(c.name)) || classes[0] || {}).id || '';
    const jc = P.jobClassById(st, u.jobClassId);
    const people = jc ? P.classMembers(st, jc).filter((e) => !P.isPartTime(e)).sort((a, b) => P.empName(a).localeCompare(P.empName(b))) : [];
    // Default holders: whoever holds a current slot with the same name.
    for (const r of pv.rows) if (u.assign[r.name] == null) {
      const l = st.lines.find((x) => x.name === r.name && x.employeeId && !x.effectiveTo);
      u.assign[r.name] = l ? l.employeeId : '';
    }
    const weeks = Math.max(...parsed.slots.map((x) => x.weeks.length));
    const dows = Array.from({ length: 7 }, (_, i) => P.DOW[(parsed.firstDow + i) % 7]);
    const used = Object.values(u.assign).filter(Boolean);
    const dup = new Set(used.filter((id, i) => used.indexOf(id) !== i));
    const rows = pv.rows.map((r) => {
      const cyc = u.applyFixes ? r.fixedCycle : r.cycle;
      const run = u.applyFixes ? r.fixedRun : r.maxRun;
      const cells = cyc.map((tok, i) => {
        const moved = u.applyFixes && String(tok || 0) !== String(r.cycle[i] || 0);
        return `<td class="${i % 7 === 0 && i ? 'wk-start' : ''} ${tok ? '' : 'muted'} ${moved ? 'traded' : ''}" style="text-align:center" ${moved ? 'title="Changed by a trade"' : ''}>${esc(cellCode(stTmp, tok, r.baseId)) || '·'}</td>`;
      }).join('');
      const id = u.assign[r.name] || '';
      return `<tr><td class="nowrap"><b>${esc(r.name)}</b></td>${cells}
        <td class="num nowrap">${r.weekHours.map((h) => (h > (+st.center.otThresholdHours || 40) ? `<b>${hrs(h)}</b>` : hrs(h))).join(' / ')}</td>
        <td class="num">${run > limit ? `<span class="badge bad">${run}</span>` : run}</td>
        <td><select data-change="tpl-assign" data-slot="${esc(r.name)}"><option value="">— vacant —</option>${App.opts(people, id, P.empName)}</select>${id && dup.has(id) ? ' <span class="badge bad">twice</span>' : ''}</td></tr>`;
    }).join('');
    const head = `<tr><th>Slot</th>${Array.from({ length: weeks * 7 }, (_, i) => `<th class="${i % 7 === 0 && i ? 'wk-start' : ''}" style="text-align:center">${i % 7 === 0 ? `<div class="small muted">Wk ${i / 7 + 1}</div>` : ''}${dows[i % 7]}</th>`).join('')}<th class="num">Hours / week</th><th class="num" title="Most days worked in a row">In a row</th><th>Who holds it</th></tr>`;
    const over = pv.rows.filter((r) => r.maxRun > limit);
    const trades = pv.trades.map((t) => {
      const wk = `week ${t.week + 1}`;
      return `<li><b>${esc(t.a)}</b> works ${dows[t.y]} instead of ${dows[t.x]}, and <b>${esc(t.b)}</b> works ${dows[t.x]} instead of ${dows[t.y]} (${wk}).</li>`;
    }).join('');
    const otStartDow = P.dow(P.parseDate(st.center.otPeriodStart || '2026-01-04'));
    const weekMismatch = (+st.center.otPeriodDays || 7) === 7 && otStartDow !== parsed.firstDow;
    if (!u.anchor) u.anchor = parsed.start != null ? P.fmtDate(parsed.start) : (() => { const d = P.todayNum(); return P.fmtDate(d + P.mod(parsed.firstDow - P.dow(d), 7)); })();
    const cycleDays = weeks * 7;
    if (!u.effective) { const a = P.parseDate(u.anchor), t = P.todayNum(); u.effective = P.fmtDate(a >= t ? a : a + Math.ceil((t - a) / cycleDays) * cycleDays); }
    const builtIn = pv.rows.reduce((t, r) => t + r.weekHours.reduce((a, h) => a + Math.max(0, h - (+st.center.otThresholdHours || 40)), 0) / r.weekHours.length, 0);
    return intro + `<div class="panel" style="margin-top:14px"><h2>${esc(u.fileName || 'Template')}: ${pv.rows.length} schedule slots</h2>
      ${parsed.warnings.length ? `<div class="callout warn">${parsed.warnings.map(esc).join('<br>')}</div>` : ''}
      <div class="table-wrap"><table class="tpl-grid small"><thead>${head}</thead><tbody>${rows}</tbody></table></div>
      ${pv.templates.length ? `<p class="small muted">New shift times added: ${pv.templates.map((t) => `${esc(t.code)} (${t.start.replace(':', '')}, ${t.hours}h)`).join(', ')}.</p>` : ''}
      <p class="small">Scheduled overtime built into this template: about <b>${hrs(builtIn)} h a week</b> (weeks over ${+st.center.otThresholdHours || 40} hours). Fix coverage suggests part-timers to cut it.</p>
      ${over.length ? `<div class="callout ${u.applyFixes && !pv.remaining.length ? '' : 'warn'}"><b>${over.length} slot(s) work more than ${limit} days in a row</b> (${over.map((r) => esc(r.name)).join(', ')}).
        ${pv.trades.length ? `These trades (highlighted above) fix it without changing who is on duty any day or anyone's weekly hours:<ul style="margin:6px 0">${trades}</ul>
        <label class="check"><input type="checkbox" data-change="tpl-fixes" ${u.applyFixes ? 'checked' : ''}> Use these trades${pv.remaining.length ? ` (still over: ${pv.remaining.map(esc).join(', ')})` : ''}</label>` : 'No trade between slots on the same shift fixes it; edit the template.'}</div>` : `<p class="small"><span class="badge ok">OK</span> Nobody works more than ${limit} days in a row.</p>`}
      <div class="form-grid">
        <div class="field"><label>Job class</label><select data-change="tpl-class">${App.opts(classes, u.jobClassId)}</select></div>
        <div class="field"><label>Week 1 starts (the template's first ${dows[0]})</label><input type="date" value="${esc(u.anchor)}" data-change="tpl-anchor"></div>
        <div class="field"><label>Use it from</label><input type="date" value="${esc(u.effective)}" data-change="tpl-eff"></div>
      </div>
      <label class="check"><input type="checkbox" data-change="tpl-end" ${u.endCurrent ? 'checked' : ''}> End the job class's current full-time schedule slots the day before</label>
      ${weekMismatch ? `<label class="check"><input type="checkbox" data-change="tpl-week" ${u.matchWeek ? 'checked' : ''}> Count overtime by ${dows[0]}–${dows[6]} weeks, like this template (now ${P.DOW[otStartDow]}–${P.DOW[(otStartDow + 6) % 7]})</label>` : ''}
      <div class="toolbar" style="margin-top:10px"><button class="btn primary" data-action="tpl-apply">Create ${pv.rows.length} schedule slots</button>
        <span class="small muted">People you assign are notified. Fix coverage then helps with call-outs, vacations and overtime.</span></div>
    </div>`;
  };

  function readSheets(sheets, name) {
    const u = App.ui.tpl;
    try {
      const parsed = T.parse(sheets);
      if (!parsed.slots.length) throw new Error('No slots found. The sheet needs a header row with the days of the week and rows like "Day 1 | Week 1 | Work | RDO | …".');
      Object.assign(u, fresh(), { parsed, fileName: name, text: u.text });
    } catch (e) { u.parsed = null; u.error = e.message; }
    App.render();
  }
  App.changes['tpl-file'] = (el) => {
    const f = el.files && el.files[0];
    if (!f) return;
    if (/\.xlsx$/i.test(f.name)) {
      f.arrayBuffer().then((b) => X.read(b)).then((sh) => readSheets(sh, f.name)).catch((e) => { App.ui.tpl.error = 'Could not read that file: ' + e.message; App.render(); });
    } else f.text().then((t) => readSheets(T.sheetFromText(t), f.name)).catch((e) => App.toast(e.message, true));
  };
  App.changes['tpl-text'] = (el) => { App.ui.tpl.text = el.value; };
  App.actions['tpl-read-text'] = () => { const t = App.ui.tpl.text; if (t.trim()) readSheets(T.sheetFromText(t), 'Pasted template'); };
  App.actions['tpl-reset'] = () => { App.ui.tpl = fresh(); App.render(); };
  App.changes['tpl-assign'] = (el) => { App.ui.tpl.assign[el.dataset.slot] = el.value; App.render(); };
  App.changes['tpl-fixes'] = (el) => { App.ui.tpl.applyFixes = el.checked; App.render(); };
  App.changes['tpl-class'] = (el) => { App.ui.tpl.jobClassId = el.value; App.ui.tpl.assign = {}; App.render(); };
  App.changes['tpl-anchor'] = (el) => { App.ui.tpl.anchor = el.value; App.ui.tpl.effective = ''; App.render(); };
  App.changes['tpl-eff'] = (el) => { App.ui.tpl.effective = el.value; };
  App.changes['tpl-end'] = (el) => { App.ui.tpl.endCurrent = el.checked; };
  App.changes['tpl-week'] = (el) => { App.ui.tpl.matchWeek = el.checked; };
  App.actions['tpl-apply'] = () => {
    const u = App.ui.tpl;
    const st = S();
    if (!u.jobClassId) return App.toast('Pick a job class', true);
    if (!u.anchor || !u.effective) return App.toast('Pick the start dates', true);
    const anchor = P.parseDate(u.anchor);
    if (P.dow(anchor) !== u.parsed.firstDow) return App.toast(`Week 1 must start on a ${P.DOW[u.parsed.firstDow]}`, true);
    const used = Object.values(u.assign).filter(Boolean);
    if (new Set(used).size !== used.length) return App.toast('Someone is assigned to two slots', true);
    const n = u.parsed.slots.length;
    App.confirm(`Create ${n} schedule slots for ${esc((P.jobClassById(st, u.jobClassId) || {}).name || '')} from ${esc(u.effective)}?${u.endCurrent ? ' Current full-time slots in that job class end the day before.' : ''} ${used.length} people are notified.`, () => {
      let res;
      App.commit((s) => {
        res = T.apply(s, u.parsed, { jobClassId: u.jobClassId, effectiveFrom: u.effective, anchor: u.anchor, assign: u.assign, applyFixes: u.applyFixes, endCurrent: u.endCurrent, limit: +s.center.maxConsecutiveDays || 4 });
        if (u.matchWeek && (+s.center.otPeriodDays || 7) === 7) s.center.otPeriodStart = u.anchor;
        const ctx = { now: new Date().toISOString() };
        for (const l of res.lines) if (l.employeeId) App.A.notify(s, l.employeeId, 'Your schedule', `From ${u.effective} you hold schedule slot "${l.name}". Check My Schedule.`, ctx, 'me');
      }, `${n} schedule slots created`);
      App.ui.tpl = fresh();
      App.ui.bid.tab = 'lines';
      App.render();
    }, 'Create');
  };
})();
