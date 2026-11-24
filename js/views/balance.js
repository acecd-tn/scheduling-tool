/* Suggest lines (Schedules & Bids, and Fix coverage → Rebalance schedule slots). Day-to-day balancing is on the Fix coverage page. */
(function () {
  'use strict';
  const { P, esc, money, hrs } = App;
  const B = window.PSAPBalance;
  const S = () => App.S;

  // ------------------------------------------------------- suggest schedule slots
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
    const jc = bid ? P.bidClass(st, bid) : (classes.find((c) => c.id === opts.jobClassId) || classes[0] || null);
    if (!jc) return App.toast('Add a job class with people first', true);
    const used = new Set(st.lines.filter((l) => (P.lineClass(st, l) || {}).id === jc.id).map((l) => l.shiftTemplateId));
    const notice = +st.center.dayOffNoticeDays || 0;
    const eff = bid ? P.parseDate(bid.effectiveDate) : (() => { const d = P.todayNum() + notice; const wk = P.workWeek(st, d); return wk.start === d ? d : wk.start + 7; })();
    App.ui.sug = {
      bidId: bid ? bid.id : null, jobClassId: jc.id, headcount: '', margin: '', mode: st.center.lineMode === 'weekly' ? 'weekly' : 'rotation', keep: true,
      templateIds: st.shiftTemplates.filter((t) => used.has(t.id) || [8, 10, 12].includes(+t.hours)).map((t) => t.id),
      effective: P.fmtDate(eff), result: null,
    };
    App.modal({ title: bid ? `Suggest schedule slots — ${bid.name}` : 'Rebalance schedule slots', wide: true, body: suggestBody, footer: '<button class="btn" data-action="modal-close">Close</button>' });
  };

  function suggestBody() {
    const st = S();
    const u = App.ui.sug;
    const jc = P.jobClassById(st, u.jobClassId);
    const lvl = P.staffingLevel(st, jc, P.parseDate(u.effective));
    const rule = P.levelRule(st, lvl.level);
    const ftCount = P.classMembers(st, jc).filter((e) => !P.isPartTime(e)).length;
    const r = u.result;
    const rot = u.mode === 'rotation';
    const tl = (id) => { const t = App.tpl(id); return t ? `${t.code} ${t.start.replace(':', '')}` : '—'; };
    let res = '';
    if (r && r.error) res = `<div class="callout bad">${esc(r.error)}</div>`;
    else if (r) {
      const groups = {};
      for (const l of r.lines) {
        const pat = st.patterns.find((p) => p.id === l.patternId);
        const k = `${tl(l.shiftTemplateId)} · ${pat ? pat.name : l.patternId}`;
        (groups[k] ||= []).push(l);
      }
      const ix = P.index(st);
      const offDays = (l) => { const days = []; for (let d = r.start; d < r.start + 7; d++) if (!P.lineShiftOn(Object.assign({ jobClassId: jc.id }, l, { effectiveFrom: P.fmtDate(r.start - 400), effectiveTo: null }), d, ix)) days.push(P.DOW[P.dow(d)]); return days.join('/'); };
      const kept = r.lines.filter((l) => l.employeeId && !l.changed).length;
      res = `<div class="kpis" style="margin-top:12px">
          ${App.kpi('Uncovered h / week', `${hrs(r.before.uncov)} → <b>${hrs(r.after.uncov)}</b>`, rot ? 'average over the 7-week rotation' : 'before → suggested', r.after.uncov ? 'bad' : 'ok')}
          ${App.kpi(`Above ${r.margin ? 'margin' : 'minimum'} h / week`, `${hrs(r.before.surplus)} → <b>${hrs(r.after.surplus)}</b>`, `relief margin ${r.margin} per console-hour`)}
          ${App.kpi('Hours: schedule slots vs minimum', `${hrs(r.lineHours)} / ${hrs(r.minHours)}`, `${r.headcount} × 40 h schedule slots a week`, r.lineHours < r.minHours ? 'bad' : '')}
        </div>
        ${r.lineHours < r.minHours ? `<div class="callout bad">${r.headcount} people × 40 h can't reach ${hrs(r.minHours)} minimum person-hours a week: about ${hrs(r.minHours - r.lineHours)} h/week needs part-timers, overtime or more staff. Gaps are spread as evenly as possible.</div>` : ''}
        <div class="grid g2">
          <div><h3>Suggested${rot ? ' — lowest week of the 7' : ''}</h3>${weekHeat(st, r.after.v, r.min, r.target)}</div>
          <div><h3>Current schedule slots${rot ? ' — lowest week of the 7' : ''}</h3>${weekHeat(st, r.before.v, r.min, r.target)}</div>
        </div>
        <div class="legend" style="margin:6px 0 10px"><span class="badge bad">below minimum</span><span class="badge warn">at minimum / within margin</span><span class="badge ok">above margin</span></div>
        ${u.bidId ? `<h3>Suggested schedule slots (${r.lines.length})</h3>
          <table><thead><tr><th class="num">Schedule slots</th><th>Shift · pattern</th><th>Days off the first week</th></tr></thead><tbody>
          ${Object.entries(groups).map(([k, ls]) => `<tr><td class="num">${ls.length}</td><td>${esc(k)}</td><td class="small">${ls.map(offDays).join(' · ')}</td></tr>`).join('')}
          </tbody></table>`
        : `<h3>Who changes (${r.changes.length})</h3>
          ${r.changes.length ? `<table><thead><tr><th>Employee</th><th>Shift</th><th>Days off the week of ${P.shortDate(r.start)}</th></tr></thead><tbody>
            ${r.changes.map((c) => `<tr><td>${esc(P.empName(App.emp(c.employeeId)))}</td><td>${esc(tl(c.to.tplId))}${c.to.tplId !== c.from.tplId ? ` <span class="badge warn">was ${esc(tl(c.from.tplId))}</span>` : ''}</td><td>${esc(c.from.off)} → <b>${esc(c.to.off)}</b></td></tr>`).join('')}
          </tbody></table>` : '<p class="small muted">Nobody needs to change: the current schedule slots are already the best fit.</p>'}
          <p class="small muted">${kept} people keep their schedule slot exactly. ${rot ? 'Everyone keeps their shift; only the week of the rotation they start on changes, so their days off still move one day later each week.' : ''}${r.lines.some((l) => !l.employeeId) ? ` ${r.lines.filter((l) => !l.employeeId).length} vacant schedule slot(s) included.` : ''}</p>`}
        <div class="section toolbar">
          ${u.bidId ? `<button class="btn primary" data-action="sug-to-bid">Use these schedule slots in the bid</button><span class="small muted">Replaces the bid's schedule slots and clears picks.</span>`
          : `<label class="small muted" style="margin:0">Starting <input type="date" id="sug-eff" value="${esc(P.fmtDate(r.start))}"></label>
             <button class="btn primary" data-action="sug-to-lines" ${r.changes.length || r.lines.some((l) => !l.employeeId) ? '' : 'disabled'}>Approve and notify</button>
             <button class="btn" data-action="sug-new-bid">Start a shift bid instead</button>`}
        </div>
        ${!u.bidId ? `<p class="small muted">Starts on a work-week boundary so every week stays at 40 hours. ${+st.center.dayOffNoticeDays ? `Your notice period is ${st.center.dayOffNoticeDays} days.` : ''} Only the people listed are notified.</p>` : ''}
        ${u.changeover ? `<div class="callout warn">${esc(u.changeover)}</div>` : ''}`;
    }
    return `<p class="small muted" style="margin-top:0">${rot ? 'Builds the rotation: everyone keeps their shift (days stay days, nights stay nights) and works 3 twelves plus one 4-hour shift a week. The tool picks which week of the 7-week rotation each person starts on so every hour is at minimum, extra hours stay within the relief margin, and 4-hour days are spread across the week.' : 'Builds fixed 7-day, 40-hour schedule slots (no built-in overtime).'} Part-timers' schedule slots stay as they are. Nothing changes until you approve.</p>
      <div class="form-grid">
        <div class="field"><label>Job class</label>${u.bidId ? `<div>${esc(jc.name)}</div>` : `<select data-change="sug-param" name="sugClass" data-keep="1">${App.opts(P.jobClasses(st).filter((c) => P.classMembers(st, c).length), u.jobClassId)}</select>`}</div>
        <div class="field"><label>Full-time schedule slots</label><input type="number" min="0" name="sugN" value="${esc(u.headcount)}" placeholder="${ftCount}"></div>
        <div class="field"><label>Staffing level</label><div>${App.levelBadge(lvl)}</div></div>
      </div>
      <details class="section"><summary class="small">Advanced</summary>
        <div class="form-grid">
          <div class="field"><label>Relief margin (per console-hour)</label><input type="number" min="0" name="sugMargin" value="${esc(u.margin)}" placeholder="${lvl.level === 'normal' ? rule.reliefMargin : 0} (${lvl.level})"></div>
          <div class="field"><label>Schedule slot type</label><select name="sugMode">${App.opts([{ id: 'rotation', name: 'Rotation (3 × 12 + one 4-hour)' }, { id: 'weekly', name: 'Fixed 7-day patterns' }], u.mode)}</select></div>
          <div class="field"><label class="check"><input type="checkbox" name="sugKeep" ${u.keep ? 'checked' : ''}> People keep their shift</label></div>
        </div>
        <div class="field"><label>Shifts the suggestion may use</label><div class="pill-list">${st.shiftTemplates.map((t) => `<label class="check"><input type="checkbox" data-multi="1" name="sugTpl" value="${t.id}" ${u.templateIds.includes(t.id) ? 'checked' : ''}> ${esc(t.code)} ${t.start.replace(':', '')} ${t.hours}h</label>`).join('')}</div></div>
      </details>
      <button type="button" class="btn primary" data-action="sug-run">${r ? 'Run again' : 'Suggest'}</button>
      ${res}`;
  }

  App.changes['sug-param'] = () => { const f = App.modalForm(); App.ui.sug.jobClassId = f.sugClass; App.ui.sug.result = null; App.redrawModal(); };
  App.actions['sug-run'] = () => {
    const u = App.ui.sug;
    const f = App.modalForm();
    if (f.sugClass) u.jobClassId = f.sugClass;
    u.headcount = f.sugN; u.margin = f.sugMargin; u.templateIds = f.sugTpl || [];
    if (f.sugMode) u.mode = f.sugMode;
    u.keep = !!f.sugKeep;
    const effEl = document.getElementById('sug-eff'); if (effEl && effEl.value) u.effective = effEl.value;
    u.changeover = '';
    // Rotation: any 12-hour shift may be used; the shift list is for fixed patterns.
    u.result = B.suggestLines(S(), u.jobClassId, { headcount: u.headcount, reliefMargin: u.margin, templateIds: u.mode === 'rotation' ? null : u.templateIds, effectiveDate: u.effective, mode: u.mode, keepShifts: u.keep });
    App.redrawModal();
  };
  const bidLinesFrom = (st, r, eff) => B.toLineRecords(st, r, eff).map((l) => Object.assign(l, { id: P.uid('bl'), effectiveFrom: eff }));
  App.actions['sug-to-bid'] = () => {
    const u = App.ui.sug;
    App.commit((s) => {
      const b = s.bids.find((x) => x.id === u.bidId);
      b.lines = bidLinesFrom(s, u.result, b.effectiveDate);
      b.picks = {}; b.skipped = [];
    }, `Bid now has ${u.result.lines.length} suggested schedule slots`);
    App.closeModal();
  };
  App.actions['sug-new-bid'] = () => {
    const u = App.ui.sug;
    const effEl = document.getElementById('sug-eff'); const eff = effEl && effEl.value ? effEl.value : u.effective;
    const jc = u.result.jobClass;
    const bid = { id: P.uid('bid'), name: `${jc.name} bid ${eff}`, jobClassId: jc.id, positionId: null, effectiveDate: eff, status: 'draft', lines: bidLinesFrom(S(), u.result, eff), picks: {}, skipped: [], order: [], createdAt: new Date().toISOString() };
    App.ui.bid.bidId = bid.id; App.ui.bid.tab = 'bids';
    App.commit((s) => s.bids.push(bid), 'Draft bid created with the suggested schedule slots');
    App.closeModal();
  };
  App.actions['sug-to-lines'] = () => {
    const u = App.ui.sug;
    const effEl = document.getElementById('sug-eff'); const eff = effEl && effEl.value ? effEl.value : u.effective;
    const st = S();
    const short = P.parseDate(eff) < P.todayNum() + (+st.center.dayOffNoticeDays || 0);
    const wk = P.workWeek(st, P.parseDate(eff));
    if (wk.start !== P.parseDate(eff)) return App.toast(`Start on a work-week boundary (e.g. ${P.shortDate(wk.start + 7)}) so every week stays at 40 hours.`, true);
    const d0 = P.parseDate(eff);
    const near = (s) => P.openings(s, d0 - 1, d0 + 1).slots.filter((x) => P.classConsoles(s, u.result.jobClass).includes(x.positionId)).reduce((t, x) => t + x.hours, 0);
    const gapsBefore = near(st);
    App.confirm(`Change ${u.result.changes.length} people's schedule slots in ${esc(u.result.jobClass.name)} from ${esc(eff)}? Their current schedule slots end ${P.fmtDate(P.parseDate(eff) - 1)} and they are notified. Everyone else keeps their schedule slot.${short ? ` <b>That's inside your ${st.center.dayOffNoticeDays}-day notice period.</b>` : ''}`, () => {
      let msg = '';
      App.commit((s) => {
        const res = B.applyToCurrentLines(s, u.result, eff);
        if (res.changed.length) App.A.notify(s, res.changed, 'Your days off are changing', `From ${eff} your days off change (same shift, still 40 hours a week). Check My Schedule.`, { now: new Date().toISOString() }, 'me');
        // Warn about the first night after the changeover.
        const added = near(s) - gapsBefore;
        if (added > 0.01) msg = `The changeover adds ${hrs(added)} uncovered hours (often the first overnight). Check Openings for ${P.fmtDate(d0 - 1)} to ${P.fmtDate(d0 + 1)}.`;
        msg = msg || '';
        App.toast(`${res.changed.length} ${res.changed.length === 1 ? "person's schedule slot changes" : "people's schedule slots change"} from ${eff} (notified); ${res.kept} unchanged${res.vacant ? `; ${res.vacant} vacant` : ''}`);
      });
      if (msg) App.toast(msg, true);
    }, 'Apply');
  };

  // Undo an approved day-off move (Schedule day details).
  App.actions['bal-undo'] = (el) => App.confirm('Undo this day-off move? The employee is notified.', () => {
    const m = S().shiftMoves.find((x) => x.id === el.dataset.id);
    App.commit((s) => {
      s.shiftMoves = s.shiftMoves.filter((x) => x.id !== el.dataset.id);
      if (m) App.A.notify(s, m.employeeId, 'Day-off change cancelled', `Your usual schedule applies again: off ${P.shortDate(P.parseDate(m.workDate))}, working ${P.shortDate(P.parseDate(m.offDate))}.`, { now: new Date().toISOString() }, 'me');
    }, 'Move undone');
    App.closeModal();
  }, 'Undo');
})();
