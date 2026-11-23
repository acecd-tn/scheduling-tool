(function () {
  'use strict';
  const { P, esc, hrs } = App;
  const S = () => App.S;

  App.ui.bid = { tab: 'lines', bidId: null, showPast: false };

  const patLabel = (st, id) => (st.patterns.find((p) => p.id === id) || {}).name || '—';

  App.views.bid = {
    render(st, ui) {
      const u = ui.bid;
      const tabs = `<div class="tabs"><button class="${u.tab === 'lines' ? 'on' : ''}" data-action="bid-tab" data-tab="lines">Current lines</button><button class="${u.tab === 'bids' ? 'on' : ''}" data-action="bid-tab" data-tab="bids">Shift bids (${st.bids.filter((b) => b.status !== 'applied').length} open)</button></div>`;
      return `<div class="page-head"><div><h1>Lines & Shift Bid</h1><p>A line = shift + rotation pattern + start date. Mix 8, 10 and 12-hour lines freely; switch schedules by bidding a new set of lines with an effective date.</p></div></div>
        ${tabs}${u.tab === 'lines' ? linesTab(st, u) : bidsTab(st, u)}`;
    },
  };

  // ------------------------------------------------------------ lines tab
  function linesTab(st, u) {
    const today = P.todayNum();
    const lines = st.lines.filter((l) => u.showPast || !l.effectiveTo || P.parseDate(l.effectiveTo) >= today);
    const posOrder = {}; st.positions.forEach((p, i) => { posOrder[p.id] = i; });
    lines.sort((a, b) => posOrder[a.positionId] - posOrder[b.positionId] || String(a.name).localeCompare(b.name, undefined, { numeric: true }));
    const assigned = new Set(st.lines.filter((l) => l.employeeId && (!l.effectiveTo || P.parseDate(l.effectiveTo) >= today)).map((l) => l.employeeId));
    const unassignedEmps = st.employees.filter((e) => e.status !== 'inactive' && !assigned.has(e.id));
    const vacantLines = lines.filter((l) => !l.employeeId && (!l.effectiveTo || P.parseDate(l.effectiveTo) >= today));
    const summary = st.positions.map((p) => {
      const ls = lines.filter((l) => l.positionId === p.id && P.lineActiveOn(l, today));
      const byShift = {};
      for (const l of ls) { const t = App.tpl(l.shiftTemplateId); const k = t ? t.code : '?'; byShift[k] = (byShift[k] || 0) + 1; }
      return `<span class="badge info">${esc(p.name)}: ${ls.length} lines (${Object.entries(byShift).map(([k, v]) => `${v}×${k}`).join(', ')})</span>`;
    }).join(' ');
    return `<div class="panel">
      <div class="page-head" style="margin-bottom:8px"><div class="pill-list">${summary}</div>
        <div class="toolbar"><label class="check"><input type="checkbox" ${u.showPast ? 'checked' : ''} data-change="lines-past"> Show ended lines</label>
        <button class="btn" data-action="line-add">+ Line</button><button class="btn primary" data-action="line-gen" data-target="current">Generate lines…</button></div></div>
      ${unassignedEmps.length ? `<div class="callout warn">No line assigned: ${unassignedEmps.map((e) => esc(P.empName(e))).join(', ')}</div>` : ''}
      ${vacantLines.length ? `<div class="callout">${vacantLines.length} vacant line(s) — these produce structural openings until filled.</div>` : ''}
      <div class="table-wrap"><table><thead><tr><th>Line</th><th>Position</th><th>Shift</th><th>Pattern</th><th>Rotation anchor</th><th>Effective</th><th>Ends</th><th>Employee</th><th class="num">Avg h/wk</th><th></th></tr></thead><tbody>
      ${lines.map((l) => lineRow(st, l, 'line')).join('') || '<tr><td colspan="10" class="empty">No lines yet.</td></tr>'}
      </tbody></table></div>
      <p class="small muted">Rotation anchor = the date the line is on day 1 of its pattern. Lines with the same anchor rotate together (a "team"). Edits save immediately.</p></div>`;
  }

  function lineRow(st, l, kind, bid) {
    const pat = st.patterns.find((p) => p.id === l.patternId);
    const wk = pat ? P.patternWeeklyHours(st, pat, l.shiftTemplateId) : 0;
    const empSel = kind === 'line'
      ? `<select data-change="line-field" data-id="${l.id}" data-f="employeeId"><option value="">— vacant —</option>${App.opts(st.employees.filter((e) => e.status !== 'inactive' && P.qualifiedFor(e, l.positionId)).sort((a, b) => P.empName(a).localeCompare(P.empName(b))), l.employeeId, P.empName)}</select>`
      : '';
    const ended = l.effectiveTo && P.parseDate(l.effectiveTo) < P.todayNum();
    const ch = kind === 'line' ? 'line-field' : 'bidline-field';
    return `<tr class="${ended ? 'dim' : ''}"><td><input value="${esc(l.name)}" data-change="${ch}" data-id="${l.id}" data-f="name" style="min-width:90px"></td>
      <td>${kind === 'line' ? `<select data-change="${ch}" data-id="${l.id}" data-f="positionId">${App.opts(st.positions, l.positionId)}</select>` : esc(App.posName(l.positionId))}</td>
      <td><select data-change="${ch}" data-id="${l.id}" data-f="shiftTemplateId">${App.opts(st.shiftTemplates, l.shiftTemplateId, (t) => `${t.code} ${t.start.replace(':', '')} ${t.hours}h`)}</select></td>
      <td><select data-change="${ch}" data-id="${l.id}" data-f="patternId">${App.opts(st.patterns, l.patternId)}</select></td>
      <td><input type="date" value="${esc(l.anchorDate || l.effectiveFrom)}" data-change="${ch}" data-id="${l.id}" data-f="anchorDate"></td>
      ${kind === 'line' ? `<td><input type="date" value="${esc(l.effectiveFrom)}" data-change="${ch}" data-id="${l.id}" data-f="effectiveFrom"></td>
      <td><input type="date" value="${esc(l.effectiveTo || '')}" data-change="${ch}" data-id="${l.id}" data-f="effectiveTo"></td><td>${empSel}</td>` : ''}
      <td class="num">${hrs(wk)}</td>
      <td><button class="btn sm danger" data-action="${kind === 'line' ? 'line-del' : 'bidline-del'}" data-id="${l.id}" title="Delete line">✕</button></td></tr>`;
  }

  App.actions['bid-tab'] = (el) => { App.ui.bid.tab = el.dataset.tab; App.render(); };
  App.changes['lines-past'] = (el) => { App.ui.bid.showPast = el.checked; App.render(); };
  App.changes['line-field'] = (el) => {
    App.commit((s) => { const l = s.lines.find((x) => x.id === el.dataset.id); if (l) l[el.dataset.f] = el.value || null; });
  };
  App.actions['line-del'] = (el) => App.confirm('Delete this line? Past schedule history for it will disappear. To end a line but keep history, set an end date instead.', () => App.commit((s) => { s.lines = s.lines.filter((l) => l.id !== el.dataset.id); }, 'Line deleted'), 'Delete');
  App.actions['line-add'] = () => {
    const st = S();
    const t = P.fmtDate(P.todayNum());
    App.commit((s) => s.lines.push({ id: P.uid('ln'), name: 'New line', positionId: st.positions[0].id, shiftTemplateId: st.shiftTemplates[0].id, patternId: st.patterns[0].id, anchorDate: t, effectiveFrom: t, effectiveTo: null, employeeId: null }), 'Line added');
  };

  // Generator — used for current lines and for bid packages.
  App.actions['line-gen'] = (el) => {
    const st = S();
    const target = el.dataset.target;
    const bid = target === 'bid' ? st.bids.find((b) => b.id === App.ui.bid.bidId) : null;
    const anchor = bid ? bid.effectiveDate : P.fmtDate(P.periodOf(st, P.todayNum()).start);
    App.modal({
      title: 'Generate lines',
      body: `<div class="form-grid">
        ${bid ? `<input type="hidden" name="positionId" value="${bid.positionId}">` : `<div class="field"><label>Position</label><select name="positionId">${App.opts(st.positions, '')}</select></div>`}
        <div class="field"><label>Shift</label><select name="shiftTemplateId">${App.opts(st.shiftTemplates, '', (t) => `${t.code} — ${t.name} ${t.start.replace(':', '')} ${t.hours}h`)}</select></div>
        <div class="field"><label>Pattern</label><select name="patternId">${App.opts(st.patterns, '')}</select></div>
        <div class="field"><label>Number of lines</label><input type="number" name="count" min="1" value="10"></div>
        <div class="field"><label>Teams (start offsets)</label><input type="number" name="teams" min="1" value="2"></div>
        <div class="field"><label>Rotation anchor</label><input type="date" name="anchorDate" value="${anchor}"></div>
        <div class="field"><label>Name prefix</label><input name="prefix" placeholder="e.g. D12"></div>
      </div>
      <p class="small muted">Teams spread start dates evenly across the pattern. Examples: Pitman 12s → 2 teams per shift (A/B, offset 7 days). 5-on/2-off → 7 teams to stagger days off. 4-on/4-off → 2 teams.</p>`,
      footer: '<button class="btn" data-action="modal-close">Cancel</button><button class="btn primary" data-action="line-gen-go" data-target="' + target + '">Create</button>',
    });
  };
  App.actions['line-gen-go'] = (el) => {
    const f = App.modalForm();
    const st = S();
    const isBid = el.dataset.target === 'bid';
    const lines = P.generateLines(st, Object.assign({}, f, { effectiveFrom: isBid ? undefined : f.anchorDate }));
    App.commit((s) => {
      if (isBid) { const b = s.bids.find((x) => x.id === App.ui.bid.bidId); b.lines.push(...lines.map((l) => Object.assign(l, { effectiveFrom: b.effectiveDate }))); }
      else s.lines.push(...lines);
    }, `${lines.length} lines created`);
    App.closeModal();
  };

  // -------------------------------------------------------------- bids tab
  function bidsTab(st, u) {
    const bid = st.bids.find((b) => b.id === u.bidId);
    const list = `<div class="panel"><h2>Bid packages <button class="btn sm primary" data-action="bid-new">+ New bid</button></h2>
      ${st.bids.length ? `<table><thead><tr><th>Name</th><th>Position</th><th>Effective</th><th>Lines</th><th>Picked</th><th>Status</th><th></th></tr></thead><tbody>
      ${st.bids.map((b) => `<tr class="${b.id === u.bidId ? 'bidder-now' : ''}"><td>${esc(b.name)}</td><td>${esc(App.posName(b.positionId))}</td><td>${esc(b.effectiveDate)}</td><td>${b.lines.length}</td>
        <td>${Object.keys(b.picks || {}).length}/${P.bidOrder(st, b).length}</td><td><span class="badge ${b.status === 'applied' ? 'ok' : b.status === 'open' ? 'warn' : ''}">${b.status}</span></td>
        <td class="nowrap"><button class="btn sm" data-action="bid-open" data-id="${b.id}">Open</button> <button class="btn sm danger" data-action="bid-del" data-id="${b.id}">✕</button></td></tr>`).join('')}
      </tbody></table>` : '<div class="empty">No bids yet. Create one to re-bid the current lines or to move to a new schedule (e.g. 8s → 12s) on an effective date.</div>'}</div>`;
    return list + (bid ? bidDetail(st, bid) : '');
  }

  function bidDetail(st, bid) {
    const order = P.bidOrder(st, bid);
    const picks = bid.picks || {};
    const byLine = {}; for (const [e, l] of Object.entries(picks)) byLine[l] = e;
    const cur = bid.status === 'open' ? P.currentBidder(st, bid) : null;
    const eff = P.parseDate(bid.effectiveDate);
    const cyc = Math.max(7, ...bid.lines.map((l) => ((st.patterns.find((p) => p.id === l.patternId) || {}).cycle || []).length));
    const days = Math.min(56, cyc);
    const prev = P.previewLines(st, bid.positionId, bid.lines, eff, days);
    const cov = prev.cov;
    let shortH = 0;
    const short = new Array(24).fill(0), minS = new Array(24).fill(Infinity), req = new Array(24).fill(0);
    for (let i = 0; i < cov.n; i++) {
      const s = cov.staffed[bid.positionId][i], r = cov.required[bid.positionId][i];
      const h = i % 24;
      if (s < minS[h]) minS[h] = s;
      req[h] = Math.max(req[h], r);
      if (s + 1e-6 < r) { short[h] += 1; shortH += Math.ceil(r - s - 1e-6); }
    }
    const lineHrs = bid.lines.reduce((s, l) => { const p = st.patterns.find((x) => x.id === l.patternId); return s + (p ? P.patternWeeklyHours(st, p, l.shiftTemplateId) : 0); }, 0);
    const reqHrs = P.requiredWeeklyHours(st, bid.positionId);
    const editable = bid.status !== 'applied';
    const orderRows = order.map((e, i) => {
      const ln = picks[e.id] ? bid.lines.find((l) => l.id === picks[e.id]) : null;
      const skipped = (bid.skipped || []).includes(e.id);
      return `<tr class="${cur && cur.id === e.id ? 'bidder-now' : ''}"><td>${i + 1}</td><td>${esc(P.empName(e))}${e.status === 'trainee' ? ' <span class="badge warn">T</span>' : ''}</td><td class="small">${esc(e.seniorityDate || e.hireDate || '')}</td>
        <td>${ln ? esc(ln.name) : skipped ? '<span class="badge warn">skipped</span>' : cur && cur.id === e.id ? '<span class="badge info">up now</span>' : '<span class="muted">—</span>'}</td>
        <td class="nowrap">${editable ? `${i > 0 ? `<button class="btn sm ghost" data-action="bid-move" data-emp="${e.id}" data-dir="-1" title="Move up">▲</button>` : ''}${i < order.length - 1 ? `<button class="btn sm ghost" data-action="bid-move" data-emp="${e.id}" data-dir="1" title="Move down">▼</button>` : ''}${ln || skipped ? `<button class="btn sm ghost" data-action="bid-undo" data-emp="${e.id}" title="Undo pick">↺</button>` : ''}` : ''}</td></tr>`;
    }).join('');
    const lineRows = bid.lines.map((l) => {
      const t = App.tpl(l.shiftTemplateId);
      const by = byLine[l.id];
      const pat = st.patterns.find((p) => p.id === l.patternId);
      return `<tr class="${by ? 'dim' : ''}"><td>${esc(l.name)}</td><td>${t ? `${esc(t.code)} ${t.start.replace(':', '')}` : '?'}</td><td class="small">${esc(pat ? pat.name : '')}</td><td>${esc(l.anchorDate)}</td>
        <td>${pat ? daysOffText(pat, l, eff) : ''}</td>
        <td>${by ? esc(P.empName(App.emp(by))) : cur ? `<button class="btn sm primary" data-action="bid-pick" data-line="${l.id}">Pick for ${esc(cur.lastName)}</button>` : '<span class="muted">open</span>'}</td>
        ${editable ? `<td><button class="btn sm danger" data-action="bidline-del" data-id="${l.id}">✕</button></td>` : '<td></td>'}</tr>`;
    }).join('');
    return `<div class="panel" style="margin-top:14px">
      <h2>${esc(bid.name)} — ${esc(App.posName(bid.positionId))}, effective ${P.shortDate(eff)}
        <span class="toolbar">${bid.status === 'draft' ? '<button class="btn sm primary" data-action="bid-status" data-s="open">Open bidding</button>' : ''}
        ${bid.status === 'open' ? `<button class="btn sm" data-action="bid-skip" ${cur ? '' : 'disabled'}>Skip current</button><button class="btn sm" data-action="bid-auto">Auto-assign remaining</button><button class="btn sm" data-action="bid-status" data-s="draft">Back to draft</button>` : ''}
        ${editable ? '<button class="btn sm" data-action="line-gen" data-target="bid">+ Generate lines</button><button class="btn sm" data-action="bid-copy-current">+ Copy current lines</button>' : ''}
        ${bid.status !== 'applied' ? '<button class="btn sm primary" data-action="bid-apply">Apply to schedule</button>' : '<span class="badge ok">Applied</span>'}
        <button class="btn sm" onclick="window.print()">Print</button></span></h2>
      <div class="kpis">
        ${App.kpi('Lines / bidders', `${bid.lines.length} / ${order.length}`, bid.lines.length < order.length ? 'Not enough lines for everyone' : bid.lines.length > order.length ? `${bid.lines.length - order.length} line(s) will be vacant` : 'One line per bidder', bid.lines.length < order.length ? 'bad' : bid.lines.length > order.length ? 'warn' : 'ok')}
        ${App.kpi('Line hours vs minimum', `${hrs(lineHrs)} / ${hrs(reqHrs)}`, 'avg weekly hours if every line is filled, before leave', lineHrs < reqHrs ? 'bad' : lineHrs < reqHrs * 1.12 ? 'warn' : 'ok')}
        ${App.kpi(`Short person-hours (${days} days)`, shortH, 'with every line filled and nobody on leave', shortH ? 'bad' : 'ok')}
        ${App.kpi('Next up', cur ? esc(P.empName(cur)) : '—', bid.status === 'open' ? 'senior-most remaining bidder' : `bid is ${bid.status}`)}
      </div>
      <h3>Coverage these lines produce — lowest staffing at each hour across the ${days}-day cycle</h3>
      <div class="strip" style="margin-bottom:2px">${minS.map((v, h) => `<div class="${App.covClass(v === Infinity ? 0 : v, req[h])}" title="${P.pad(h)}00 — lowest ${App.fmtStaff(v)} vs min ${req[h]}; short on ${short[h]} of ${days} days">${App.fmtStaff(v === Infinity ? 0 : v)}/${req[h]}</div>`).join('')}</div>
      <div class="strip-labels" style="margin-bottom:14px">${minS.map((_, h) => `<span>${P.pad(h)}</span>`).join('')}</div>
      <div class="grid g2">
        <div><h3>Bid order (seniority)</h3><div class="table-wrap" style="max-height:520px"><table><thead><tr><th>#</th><th>Employee</th><th>Seniority</th><th>Line</th><th></th></tr></thead><tbody>${orderRows}</tbody></table></div></div>
        <div><h3>Lines</h3><div class="table-wrap" style="max-height:520px"><table><thead><tr><th>Line</th><th>Shift</th><th>Pattern</th><th>Anchor</th><th>First 14 days</th><th>Bidder</th><th></th></tr></thead><tbody>${lineRows || '<tr><td colspan="7" class="empty">No lines in this bid yet — generate or copy them.</td></tr>'}</tbody></table></div></div>
      </div></div>`;
  }

  function daysOffText(pat, l, eff) {
    const anchor = P.parseDate(l.anchorDate || P.fmtDate(eff));
    let s = '';
    for (let d = eff; d < eff + 14; d++) {
      const tok = pat.cycle[P.mod(d - anchor, pat.cycle.length)];
      const on = tok && tok !== '0';
      s += `<span title="${P.shortDate(d)}" style="display:inline-block;width:9px;height:12px;margin-right:1px;border-radius:2px;background:${on ? 'var(--accent)' : 'var(--panel-2)'};border:1px solid var(--border)"></span>`;
    }
    return `<span class="nowrap">${s}</span>`;
  }

  const curBid = () => S().bids.find((b) => b.id === App.ui.bid.bidId);
  App.actions['bid-new'] = () => {
    const st = S();
    const t = P.todayNum();
    const eff = P.periodOf(st, t + 60).start;
    App.modal({
      title: 'New shift bid',
      body: `<div class="form-grid"><div class="field"><label>Name</label><input name="name" value="${esc(`${new Date(eff * 86400000).getUTCFullYear()} shift bid`)}"></div>
        <div class="field"><label>Position</label><select name="positionId">${App.opts(st.positions, '')}</select></div>
        <div class="field"><label>Effective date</label><input type="date" name="effectiveDate" value="${P.fmtDate(eff)}"></div>
        <div class="field"><label>Start with</label><select name="seed"><option value="copy">Copy current lines</option><option value="empty">Empty (generate new lines)</option></select></div></div>
        <p class="small muted">Bid order defaults to seniority date (earliest first); you can reorder before or during the bid. Nothing changes on the schedule until you click "Apply".</p>`,
      footer: '<button class="btn" data-action="modal-close">Cancel</button><button class="btn primary" data-action="bid-create">Create</button>',
    });
  };
  function copyCurrent(st, positionId, eff) {
    const effN = P.parseDate(eff);
    return st.lines.filter((l) => l.positionId === positionId && (P.lineActiveOn(l, effN) || (!l.effectiveTo && P.parseDate(l.effectiveFrom) <= effN)))
      .map((l) => ({ id: P.uid('bl'), name: l.name, positionId, shiftTemplateId: l.shiftTemplateId, patternId: l.patternId, anchorDate: l.anchorDate || l.effectiveFrom, effectiveFrom: eff }));
  }
  App.actions['bid-create'] = () => {
    const f = App.modalForm();
    const st = S();
    const bid = { id: P.uid('bid'), name: f.name, positionId: f.positionId, effectiveDate: f.effectiveDate, status: 'draft', lines: f.seed === 'copy' ? copyCurrent(st, f.positionId, f.effectiveDate) : [], picks: {}, skipped: [], order: [], createdAt: new Date().toISOString() };
    App.ui.bid.bidId = bid.id;
    App.commit((s) => s.bids.push(bid), 'Bid created');
    App.closeModal();
  };
  App.actions['bid-copy-current'] = () => App.commit((s) => { const b = s.bids.find((x) => x.id === App.ui.bid.bidId); b.lines.push(...copyCurrent(s, b.positionId, b.effectiveDate)); }, 'Lines copied');
  App.actions['bid-open'] = (el) => { App.ui.bid.bidId = el.dataset.id; App.render(); };
  App.actions['bid-del'] = (el) => App.confirm('Delete this bid package?', () => App.commit((s) => { s.bids = s.bids.filter((b) => b.id !== el.dataset.id); }, 'Bid deleted'), 'Delete');
  App.actions['bid-status'] = (el) => App.commit(() => { curBid().status = el.dataset.s; });
  App.actions['bid-pick'] = (el) => App.commit((s) => {
    const b = curBid(); const cur = P.currentBidder(s, b);
    if (cur) { b.picks[cur.id] = el.dataset.line; (b.log ||= []).push({ at: new Date().toISOString(), employeeId: cur.id, lineId: el.dataset.line }); }
  }, 'Pick recorded');
  App.actions['bid-skip'] = () => App.commit((s) => { const b = curBid(); const cur = P.currentBidder(s, b); if (cur) (b.skipped ||= []).push(cur.id); });
  App.actions['bid-undo'] = (el) => App.commit(() => { const b = curBid(); delete b.picks[el.dataset.emp]; b.skipped = (b.skipped || []).filter((x) => x !== el.dataset.emp); });
  App.actions['bid-move'] = (el) => App.commit((s) => {
    const b = curBid();
    const ids = P.bidOrder(s, b).map((e) => e.id);
    const i = ids.indexOf(el.dataset.emp), j = i + (+el.dataset.dir);
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    b.order = ids;
  });
  App.actions['bid-auto'] = () => App.confirm('Assign every remaining (and skipped) bidder the first open line, in bid order?', () => App.commit((s) => {
    const b = curBid();
    b.skipped = [];
    const taken = new Set(Object.values(b.picks));
    for (const e of P.bidOrder(s, b)) {
      if (b.picks[e.id]) continue;
      const l = b.lines.find((x) => !taken.has(x.id));
      if (!l) break;
      b.picks[e.id] = l.id; taken.add(l.id);
    }
  }, 'Remaining bidders assigned'));
  App.actions['bid-apply'] = () => {
    const b = curBid();
    const st = S();
    const unpicked = P.bidOrder(st, b).filter((e) => !b.picks[e.id]).length;
    App.confirm(`Apply "${esc(b.name)}" effective ${esc(b.effectiveDate)}? Current ${esc(App.posName(b.positionId))} lines will end on ${P.fmtDate(P.parseDate(b.effectiveDate) - 1)} and the ${b.lines.length} bid lines start.${unpicked ? ` <b>${unpicked} employee(s) have no line</b> and will not be scheduled.` : ''} Leave already entered after that date stays in place; check it against the new schedule.`,
      () => App.commit((s) => P.applyBid(s, s.bids.find((x) => x.id === b.id)), 'Bid applied to schedule'), 'Apply');
  };
  App.changes['bidline-field'] = (el) => App.commit(() => { const l = curBid().lines.find((x) => x.id === el.dataset.id); if (l) l[el.dataset.f] = el.value; });
  App.actions['bidline-del'] = (el) => App.commit(() => {
    const b = curBid();
    b.lines = b.lines.filter((l) => l.id !== el.dataset.id);
    for (const [e, l] of Object.entries(b.picks)) if (l === el.dataset.id) delete b.picks[e];
  });
})();
