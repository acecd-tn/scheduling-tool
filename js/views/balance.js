/* Schedule balancer screens: Suggest lines (Lines & Bid) and Balance a week (Openings). */
(function () {
  'use strict';
  const { P, esc, money, hrs } = App;
  const B = window.PSAPBalance;
  const S = () => App.S;

  // ------------------------------------------------------- suggest lines
  App.ui.sug = null; // { bidId, jobClassId, headcount, templateIds, margin, effective, result }

  /** 7 rows (Sun..Sat) × 24 hours from the scheduling-day start: staffed / minimum. */
  function weekHeat(st, v, min, target) {
    const startH = Math.floor(P.schedulingDayStart(st) / 60);
    const rows = [];
    for (let d = 0; d < 7; d++) {
      const cells = [];
      for (let k = 0; k < 24; k++) {
        const h = (d * 24 + startH + k) % 168;
        const s = Math.round(v[h] * 10) / 10, m = min[h];
        const cls = s + 1e-6 < m ? 'short' : s > target[h] + 1e-6 ? 'over' : 'exact';
        cells.push(`<div class="${m || s ? cls : ''}" title="${P.DOW[d]} ${P.pad((startH + k) % 24)}00: ${s} on, minimum ${m}${target[h] > m ? `, margin to ${target[h]}` : ''}">${s}</div>`);
      }
      rows.push(`<div class="heat-row"><span>${P.DOW[d]}</span><div class="strip">${cells.join('')}</div></div>`);
    }
    const labels = Array.from({ length: 24 }, (_, k) => `<span>${P.pad((startH + k) % 24)}</span>`).join('');
    return `<div class="week-heat">${rows.join('')}<div class="heat-row"><span></span><div class="strip-labels">${labels}</div></div></div>`;
  }

  App.openSuggest = function (opts = {}) {
    const st = S();
    const bid = opts.bidId ? st.bids.find((b) => b.id === opts.bidId) : null;
    const classes = P.jobClasses(st).filter((c) => P.classMembers(st, c).length);
    const jc = bid ? P.bidClass(st, bid) : (classes[0] || null);
    if (!jc) return App.toast('Add a job class with people first', true);
    const used = new Set(st.lines.filter((l) => (P.lineClass(st, l) || {}).id === jc.id).map((l) => l.shiftTemplateId));
    const notice = +st.center.dayOffNoticeDays || 0;
    const eff = bid ? P.parseDate(bid.effectiveDate) : (() => { const d = P.todayNum() + notice; return d + P.mod(7 - P.dow(d), 7); })();
    App.ui.sug = {
      bidId: bid ? bid.id : null, jobClassId: jc.id, headcount: '', margin: '',
      templateIds: st.shiftTemplates.filter((t) => used.has(t.id) || [8, 10, 12].includes(+t.hours)).map((t) => t.id),
      effective: P.fmtDate(eff), result: null,
    };
    App.modal({ title: bid ? `Suggest lines — ${bid.name}` : 'Suggest lines', wide: true, body: suggestBody, footer: '<button class="btn" data-action="modal-close">Close</button>' });
  };

  function suggestBody() {
    const st = S();
    const u = App.ui.sug;
    const jc = P.jobClassById(st, u.jobClassId);
    const lvl = P.staffingLevel(st, jc, P.parseDate(u.effective));
    const rule = P.levelRule(st, lvl.level);
    const ftCount = P.classMembers(st, jc).filter((e) => !P.isPartTime(e)).length;
    const r = u.result;
    let res = '';
    if (r && r.error) res = `<div class="callout bad">${esc(r.error)}</div>`;
    else if (r) {
      const groups = {};
      for (const l of r.lines) {
        const pat = st.patterns.find((p) => p.id === l.patternId);
        const t = App.tpl(l.shiftTemplateId);
        const k = `${t ? `${t.code} ${t.start.replace(':', '')} ${t.hours}h` : ''} · ${pat ? pat.name : l.patternId}`;
        (groups[k] ||= []).push(l);
      }
      const offDays = (l) => { const pat = st.patterns.find((p) => p.id === l.patternId); return pat ? P.DOW.filter((_, dw) => { const tok = pat.cycle[P.mod(dw - l.offset, 7)]; return !tok || tok === '0'; }).join('/') : ''; };
      const changeover = u.changeover;
      res = `<div class="kpis" style="margin-top:12px">
          ${App.kpi('Uncovered h / week', `${hrs(r.before.uncov)} → <b>${hrs(r.after.uncov)}</b>`, 'before → suggested', r.after.uncov ? 'bad' : 'ok')}
          ${App.kpi(`Above ${r.margin ? 'margin' : 'minimum'} h / week`, `${hrs(r.before.surplus)} → <b>${hrs(r.after.surplus)}</b>`, `relief margin ${r.margin} per console-hour`)}
          ${App.kpi('Hours: lines vs minimum', `${hrs(r.lineHours)} / ${hrs(r.minHours)}`, `${r.headcount} × 40 h lines`, r.lineHours < r.minHours ? 'bad' : '')}
        </div>
        ${r.lineHours < r.minHours ? `<div class="callout bad">${r.headcount} people × 40 h can't reach ${hrs(r.minHours)} minimum person-hours a week: about ${hrs(r.minHours - r.lineHours)} h/week needs overtime or more staff. Gaps are spread as evenly as possible.</div>` : ''}
        <div class="grid g2">
          <div><h3>Suggested coverage (${esc(r.consoles.map((p) => App.posName(p)).join(' + '))})</h3>${weekHeat(st, r.after.v, r.min, r.target)}</div>
          <div><h3>Current lines</h3>${weekHeat(st, r.before.v, r.min, r.target)}</div>
        </div>
        <div class="legend" style="margin:6px 0 10px"><span class="badge bad">below minimum</span><span class="badge warn">at minimum / within margin</span><span class="badge ok">above margin</span></div>
        <h3>Suggested lines (${r.lines.length})</h3>
        <table><thead><tr><th class="num">Lines</th><th>Shift · pattern</th><th>Days off</th></tr></thead><tbody>
          ${Object.entries(groups).map(([k, ls]) => `<tr><td class="num">${ls.length}</td><td>${esc(k)}</td><td class="small">${ls.map(offDays).join(' · ')}</td></tr>`).join('')}
        </tbody></table>
        <div class="section toolbar">
          ${u.bidId ? `<button class="btn primary" data-action="sug-to-bid">Use these lines in the bid</button><span class="small muted">Replaces the bid's lines and clears picks.</span>`
          : `<label class="small muted" style="margin:0">Effective <input type="date" id="sug-eff" value="${esc(u.effective)}"></label>
             <button class="btn primary" data-action="sug-to-lines">Apply to current lines</button>
             <button class="btn" data-action="sug-new-bid">Start a shift bid with these lines</button>`}
        </div>
        ${!u.bidId ? `<p class="small muted">Apply to current lines: from the effective date, each line holder gets the suggested line closest to their current one (same shift and days off where possible) and is notified if theirs changes. Lines end the day before. ${+st.center.dayOffNoticeDays ? `Your notice period is ${st.center.dayOffNoticeDays} days.` : ''} A shift bid lets people pick in seniority order instead.</p>` : ''}
        ${changeover ? `<div class="callout warn">${esc(changeover)}</div>` : ''}`;
    }
    return `<div class="form-grid">
        <div class="field"><label>Job class</label>${u.bidId ? `<div>${esc(jc.name)}</div>` : `<select data-change="sug-param" name="sugClass" data-keep="1">${App.opts(P.jobClasses(st).filter((c) => P.classMembers(st, c).length), u.jobClassId)}</select>`}</div>
        <div class="field"><label>Headcount (full-time lines)</label><input type="number" min="0" name="sugN" value="${esc(u.headcount)}" placeholder="${ftCount}"></div>
        <div class="field"><label>Relief margin (per console-hour)</label><input type="number" min="0" name="sugMargin" value="${esc(u.margin)}" placeholder="${lvl.level === 'normal' ? rule.reliefMargin : 0} (${lvl.level})"></div>
        <div class="field"><label>Staffing level</label><div>${App.levelBadge(lvl)}</div></div>
      </div>
      <div class="field"><label>Shifts the suggestion may use</label><div class="pill-list">${st.shiftTemplates.map((t) => `<label class="check"><input type="checkbox" data-multi="1" name="sugTpl" value="${t.id}" ${u.templateIds.includes(t.id) ? 'checked' : ''}> ${esc(t.code)} ${t.start.replace(':', '')} ${t.hours}h</label>`).join('')}</div></div>
      <p class="small muted">Uses only 7-day, 40-hour patterns (no built-in overtime), covers every hour of ${esc(P.classConsoles(st, jc).map((p) => App.posName(p)).join(' + ') || 'its consoles')} at minimum first, then keeps hours above minimum to the relief margin. It treats the job class as one cross-trained pool; the Consoles page shows how people are actually placed. Part-timers' lines are kept as they are.</p>
      <button type="button" class="btn primary" data-action="sug-run">Suggest lines</button>
      ${res}`;
  }

  App.changes['sug-param'] = () => { const f = App.modalForm(); App.ui.sug.jobClassId = f.sugClass; App.ui.sug.result = null; App.redrawModal(); };
  App.actions['sug-run'] = () => {
    const u = App.ui.sug;
    const f = App.modalForm();
    if (f.sugClass) u.jobClassId = f.sugClass;
    u.headcount = f.sugN; u.margin = f.sugMargin; u.templateIds = f.sugTpl || [];
    const effEl = document.getElementById('sug-eff'); if (effEl && effEl.value) u.effective = effEl.value;
    u.changeover = '';
    u.result = B.suggestLines(S(), u.jobClassId, { headcount: u.headcount, reliefMargin: u.margin, templateIds: u.templateIds, effectiveDate: u.effective });
    App.redrawModal();
  };
  const bidLinesFrom = (st, r, eff) => B.toLineRecords(st, r, eff).map((l) => Object.assign(l, { id: P.uid('bl'), effectiveFrom: eff }));
  App.actions['sug-to-bid'] = () => {
    const u = App.ui.sug;
    App.commit((s) => {
      const b = s.bids.find((x) => x.id === u.bidId);
      b.lines = bidLinesFrom(s, u.result, b.effectiveDate);
      b.picks = {}; b.skipped = [];
    }, `Bid now has ${u.result.lines.length} suggested lines`);
    App.closeModal();
  };
  App.actions['sug-new-bid'] = () => {
    const u = App.ui.sug;
    const effEl = document.getElementById('sug-eff'); const eff = effEl && effEl.value ? effEl.value : u.effective;
    const jc = u.result.jobClass;
    const bid = { id: P.uid('bid'), name: `${jc.name} bid ${eff}`, jobClassId: jc.id, positionId: null, effectiveDate: eff, status: 'draft', lines: bidLinesFrom(S(), u.result, eff), picks: {}, skipped: [], order: [], createdAt: new Date().toISOString() };
    App.ui.bid.bidId = bid.id; App.ui.bid.tab = 'bids';
    App.commit((s) => s.bids.push(bid), 'Draft bid created with the suggested lines');
    App.closeModal();
  };
  App.actions['sug-to-lines'] = () => {
    const u = App.ui.sug;
    const effEl = document.getElementById('sug-eff'); const eff = effEl && effEl.value ? effEl.value : u.effective;
    const st = S();
    const short = P.parseDate(eff) < P.todayNum() + (+st.center.dayOffNoticeDays || 0);
    App.confirm(`Apply ${u.result.lines.length} suggested lines to ${esc(u.result.jobClass.name)} from ${esc(eff)}? Current lines end ${P.fmtDate(P.parseDate(eff) - 1)}; holders get the closest new line and are notified.${short ? ` <b>That's inside your ${st.center.dayOffNoticeDays}-day notice period.</b>` : ''}`, () => {
      let msg = '';
      App.commit((s) => {
        const res = B.applyToCurrentLines(s, u.result, eff);
        if (res.changed.length) App.A.notify(s, res.changed, 'Your schedule line is changing', `From ${eff} your line changes (new shift or days off). Check My Schedule.`, { now: new Date().toISOString() }, 'me');
        // Warn about the first night after the changeover.
        const d = P.parseDate(eff);
        const gaps = P.openings(s, d - 1, d + 1).slots.filter((x) => P.classConsoles(s, u.result.jobClass).includes(x.positionId));
        if (gaps.length) msg = `${hrs(gaps.reduce((t, x) => t + x.hours, 0))} h around the changeover are uncovered (often the first overnight). Check Openings for ${P.fmtDate(d - 1)} to ${P.fmtDate(d + 1)}.`;
        msg = msg || '';
        App.toast(`${res.created} lines from ${eff}; ${res.changed.length} people notified${res.vacant ? `; ${res.vacant} vacant` : ''}`);
      });
      if (msg) App.toast(msg, true);
    }, 'Apply');
  };

  // ---------------------------------------------------------- balance week
  App.ui.bal = { week: null, result: null, shortNotice: false, skipped: {} };

  App.balancePanel = function (st) {
    if (!App.isSup()) return '';
    const u = App.ui.bal;
    const notice = +st.center.dayOffNoticeDays || 0;
    if (u.week == null) { const d = P.todayNum() + notice; u.week = d - P.dow(d); }
    const r = u.result;
    let body = '';
    if (r) {
      const skip = u.skipped;
      const moves = r.moves.filter((m, i) => !skip['m' + i]);
      const pts = r.ptOffers.filter((o, i) => !skip['p' + i]);
      const crit = r.classes.filter((x) => x.level.level === 'critical');
      const tplLabel = (id) => { const t = App.tpl(id); return t ? `${t.code} ${t.start.replace(':', '')}` : ''; };
      body = `<div class="pill-list" style="margin:8px 0">${r.classes.filter((x) => P.classMembers(st, x.jobClass).length).map((x) => `<span class="badge">${esc(x.jobClass.name)}</span> ${App.levelBadge(x.level)} <span class="small muted">margin ${x.margin}</span>`).join(' &nbsp; ')}</div>
        <h3>1. Move days off (${moves.length})</h3>
        ${moves.length ? `<table><thead><tr><th>Employee</th><th>Change</th><th class="num">Gap hours closed</th><th></th></tr></thead><tbody>
          ${r.moves.map((m, i) => skip['m' + i] ? '' : `<tr><td>${esc(P.empName(App.emp(m.employeeId)))} <span class="small muted">${esc((P.jobClassById(st, m.jobClassId) || {}).name || '')}</span></td>
            <td>Off <b>${P.shortDate(P.parseDate(m.offDate))}</b> → works <b>${P.shortDate(P.parseDate(m.workDate))}</b> ${esc(tplLabel(m.templateId))}</td><td class="num">${hrs(m.gapHoursClosed)}</td>
            <td class="nowrap"><button class="btn sm primary" data-action="bal-move" data-i="${i}">Approve</button> <button class="btn sm" data-action="bal-skip" data-k="m${i}">Skip</button></td></tr>`).join('')}
        </tbody></table>` : '<p class="muted small">No day-off moves help this week.</p>'}
        ${r.skippedForNotice ? `<p class="small muted">${r.skippedForNotice} possible move(s) fall inside the ${r.noticeDays}-day notice period and weren't suggested. <label class="check" style="display:inline-flex"><input type="checkbox" data-change="bal-short" ${u.shortNotice ? 'checked' : ''}> Include short-notice moves (needs the employee's agreement)</label></p>` : ''}
        <h3>2. Offer to part-timers (${pts.length})</h3>
        ${pts.length ? `<table><thead><tr><th>Part-timer</th><th>Console</th><th>When</th><th class="num">Hrs</th><th class="num">Straight-time cost</th><th></th></tr></thead><tbody>
          ${r.ptOffers.map((o, i) => skip['p' + i] ? '' : `<tr><td>${esc(P.empName(App.emp(o.employeeId)))} <span class="small muted">${hrs(o.weekHours)}/${o.cap} h this week</span></td><td>${esc(App.posName(o.slot.positionId))}</td><td class="nowrap">${App.slotTime(o.slot)}</td><td class="num">${hrs(o.slot.hours)}</td><td class="num">${money(o.cost)}</td>
            <td class="nowrap"><button class="btn sm primary" data-action="bal-pt" data-i="${i}">Approve</button> <button class="btn sm" data-action="bal-skip" data-k="p${i}">Skip</button></td></tr>`).join('')}
        </tbody></table>` : '<p class="muted small">No part-timer offers (none needed, or none eligible under their cap).</p>'}
        <h3>3. Still needs overtime</h3>
        ${r.remaining.slots.length ? `<p><b>${hrs(r.remaining.hours)} h</b> can't be covered without overtime this week — about <b>${money(r.remaining.cost)}</b>. ${r.remaining.slots.length > 0 ? 'Fill them from the Openings list below.' : ''}</p>
          ${crit.length ? `<div class="callout bad">${crit.map((x) => `<b>${esc(x.jobClass.name)}</b> is Critical: gaps are spread across days as evenly as day-off moves allow. Consider lowering the daily vacation limit (now ${P.maxOffFor(st, x.jobClass) ?? 'none'}${P.maxOffFor(st, x.jobClass) ? `, e.g. to ${Math.max(0, P.maxOffFor(st, x.jobClass) - 1)}` : ''}) in Settings → Staffing levels.`).join('<br>')}</div>` : ''}
          <div class="table-wrap" style="max-height:220px"><table><tbody>${r.remaining.slots.slice(0, 30).map((s) => `<tr><td class="nowrap">${App.slotTime(s)}</td><td>${esc(App.posName(s.positionId))}</td><td class="num">${hrs(s.hours)} h</td><td class="num">${money(P.slotCost(st, s))}</td></tr>`).join('')}</tbody></table></div>`
        : '<p class="small"><span class="badge ok">None</span> Every hour this week is covered without overtime once the steps above are approved.</p>'}`;
    }
    const approved = (st.shiftMoves || []).filter((m) => m.status === 'approved' && P.parseDate(m.workDate) >= u.week && P.parseDate(m.workDate) <= u.week + 6);
    return `<div class="panel"><h2>Balance a week <span class="toolbar"><input type="date" value="${P.fmtDate(u.week)}" data-change="bal-week"><button class="btn primary" data-action="bal-run">${r ? 'Refresh' : 'Find suggestions'}</button></span></h2>
      <p class="small muted" style="margin:0">Moves people's days off from days with extra staff to days with gaps (same work week, so still 40 hours; rest rules and the ${notice}-day notice respected), then offers remaining gaps to part-timers under their cap, before any overtime. Nothing changes until you approve; the employee is notified.</p>
      ${body}
      ${approved.length ? `<div class="section"><h3>Approved day-off moves this week</h3><table><tbody>${approved.map((m) => `<tr><td>${esc(P.empName(App.emp(m.employeeId)))}</td><td>Off ${P.shortDate(P.parseDate(m.offDate))} → works ${P.shortDate(P.parseDate(m.workDate))}</td><td><button class="btn sm danger" data-action="bal-undo" data-id="${m.id}">Undo</button></td></tr>`).join('')}</tbody></table></div>` : ''}
    </div>`;
  };

  const run = () => {
    const u = App.ui.bal;
    u.skipped = {};
    u.result = B.balanceWeek(S(), u.week, { allowShortNotice: u.shortNotice });
    App.render();
  };
  App.runBalance = run;
  App.changes['bal-week'] = (el) => { if (el.value) { const d = P.parseDate(el.value); App.ui.bal.week = d - P.dow(d); App.ui.bal.result = null; App.render(); } };
  App.actions['bal-run'] = run;
  App.changes['bal-short'] = (el) => { App.ui.bal.shortNotice = el.checked; run(); };
  App.actions['bal-skip'] = (el) => { App.ui.bal.skipped[el.dataset.k] = true; App.render(); };
  App.actions['bal-move'] = (el) => {
    const m = App.ui.bal.result.moves[+el.dataset.i];
    const t = App.tpl(m.templateId);
    App.commit((s) => {
      s.shiftMoves.push({ id: P.uid('mv'), employeeId: m.employeeId, offDate: m.offDate, workDate: m.workDate, templateId: m.templateId, status: 'approved', approvedAt: new Date().toISOString(), approvedBy: App.me ? App.me.id : null });
      App.A.notify(s, m.employeeId, 'Your days off changed', `You're now off ${P.shortDate(P.parseDate(m.offDate))} and working ${P.shortDate(P.parseDate(m.workDate))}${t ? ` ${t.start.replace(':', '')} (${t.hours}h)` : ''}. Same hours that week.`, { now: new Date().toISOString() }, 'me');
    }, 'Day-off move approved; employee notified');
    run();
  };
  App.actions['bal-pt'] = (el) => {
    const o = App.ui.bal.result.ptOffers[+el.dataset.i];
    const { id: _x, ...fill } = o.fill;
    App.act('assignFill', { fill: Object.assign(fill, { type: 'voluntary', note: 'Balancer: part-time before overtime' }) }).then((r) => { if (r) run(); });
  };
  App.actions['bal-undo'] = (el) => App.confirm('Undo this day-off move? The employee is notified.', () => {
    const m = S().shiftMoves.find((x) => x.id === el.dataset.id);
    App.commit((s) => {
      s.shiftMoves = s.shiftMoves.filter((x) => x.id !== el.dataset.id);
      if (m) App.A.notify(s, m.employeeId, 'Day-off change cancelled', `Your usual schedule applies again: off ${P.shortDate(P.parseDate(m.workDate))}, working ${P.shortDate(P.parseDate(m.offDate))}.`, { now: new Date().toISOString() }, 'me');
    }, 'Move undone');
    if (App.ui.bal.result) run();
  }, 'Undo');
})();
