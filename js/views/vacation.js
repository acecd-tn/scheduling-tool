(function () {
  'use strict';
  const { P, A, esc } = App;

  App.ui.vac = { id: null, pos: null };

  App.views.vacation = {
    render(st, ui) {
      const list = st.vacationBids.filter((v) => App.isSup() || v.status !== 'draft');
      if (!ui.vac.id || !list.some((v) => v.id === ui.vac.id)) ui.vac.id = (list.find((v) => v.status === 'open') || list[list.length - 1] || {}).id || null;
      const vb = list.find((v) => v.id === ui.vac.id);
      return `<div class="page-head"><div><h1>Vacation bid</h1><p>Seniority-order vacation picks with a daily limit per discipline. Each pick is approved the moment it's made.</p></div>
        <div class="toolbar">${list.length ? `<select data-change="vac-sel">${App.opts(list, ui.vac.id, (v) => `${v.name} (${v.status})`)}</select>` : ''}${App.isSup() ? '<button class="btn primary" data-action="vac-new">+ New vacation bid</button>' : ''}</div></div>
        ${vb ? detail(st, vb, ui) : `<div class="panel empty">${App.isSup() ? 'No vacation bids yet. Create one for the coming year.' : 'No vacation bid is open.'}</div>`}`;
    },
  };

  function detail(st, vb, ui) {
    const order = A.vacOrder(st, vb);
    const turn = A.vacTurn(st, vb);
    const me = App.me.employeeId;
    const myTurn = turn && turn.employee.id === me;
    const canPick = turn && (myTurn || App.isSup());
    const rounds = +vb.rounds || 1;
    const picksOf = (id, r) => (vb.picks || []).find((x) => x.employeeId === id && x.round === r);
    // Limits and the calendar are per job class.
    const classIdsInBid = vb.jobClassIds || [];
    const positions = P.jobClasses(st).filter((c) => !classIdsInBid.length || classIdsInBid.includes(c.id));
    const myClass = App.emp(me) ? P.jobClassOf(st, App.emp(me).positionId) : null;
    if (!ui.vac.pos || !positions.some((p) => p.id === ui.vac.pos)) ui.vac.pos = (myClass && positions.some((p) => p.id === myClass.id) ? myClass.id : (positions[0] || {}).id);
    const rows = order.map((e, i) => `<tr class="${turn && turn.employee.id === e.id ? 'bidder-now' : ''}"><td>${i + 1}</td><td>${esc(P.empName(e))}</td><td class="small">${esc((P.jobClassOf(st, e.positionId) || {}).name || '')}</td>
      ${Array.from({ length: rounds }, (_, r) => { const pk = picksOf(e.id, r + 1); return `<td class="small nowrap">${pk ? (pk.passed ? '<span class="muted">pass</span>' : `${pk.from.slice(5)}${pk.to !== pk.from ? '→' + pk.to.slice(5) : ''}`) : turn && turn.employee.id === e.id && turn.round === r + 1 ? '<span class="badge info">up now</span>' : ''}</td>`; }).join('')}</tr>`).join('');
    const capOf = (pid) => vb.caps && vb.caps[pid] !== '' && vb.caps[pid] != null ? +vb.caps[pid] : null;
    const pickForm = canPick ? `<div class="panel" style="margin-bottom:14px"><h2>${myTurn ? 'Your turn' : `Pick for ${esc(P.empName(turn.employee))}`} — round ${turn.round}</h2>
      <div class="form-grid"><div class="field"><label>First day off</label><input type="date" id="vac-from" min="${esc(vb.from)}" max="${esc(vb.to)}"></div>
      <div class="field"><label>Last day off</label><input type="date" id="vac-to" min="${esc(vb.from)}" max="${esc(vb.to)}"></div>
      <div class="field"><label>&nbsp;</label><div><button class="btn primary" data-action="vac-pick">Pick</button> <button class="btn" data-action="vac-pass">Pass this round</button></div></div></div>
      <p class="small muted">Up to ${vb.maxDaysPerPick || '∞'} ${vb.pickUnit === 'calendar' ? 'calendar days' : 'scheduled workdays'} per pick. Red days on the calendar are already at the ${esc((P.jobClassOf(st, turn.employee.positionId) || {}).name || '')} limit.</p></div>` : '';
    const status = turn ? (myTurn ? '' : `<div class="callout">Now picking: <b>${esc(P.empName(turn.employee))}</b> (round ${turn.round}).${me && order.some((e) => e.id === me) ? ` You are #${order.findIndex((e) => e.id === me) + 1} in order.` : ''}</div>`) : `<div class="callout">${vb.status === 'draft' ? 'Draft — not open yet.' : 'This bid is closed.'}</div>`;
    return `${status}${pickForm}
      ${App.isSup() ? `<div class="toolbar" style="margin-bottom:12px">${vb.status === 'draft' ? '<button class="btn primary" data-action="vac-open">Open bidding & notify staff</button>' : ''}${vb.status === 'open' ? '<button class="btn" data-action="vac-close">Close</button>' : ''}${(vb.picks || []).length ? '<button class="btn" data-action="vac-undo">Undo last pick</button>' : ''}<button class="btn danger" data-action="vac-del">Delete</button>
        <span class="small muted">${esc(vb.from)} → ${esc(vb.to)} · ${rounds} round(s) · limits: ${positions.map((p) => `${esc(p.name)} ${capOf(p.id) ?? '∞'}/day`).join(', ')}</span></div>` : ''}
      <div class="grid g2">
        <div class="panel"><h2>Bid order (seniority)</h2><div class="table-wrap" style="max-height:640px"><table><thead><tr><th>#</th><th>Employee</th><th>Job class</th>${Array.from({ length: rounds }, (_, r) => `<th>Round ${r + 1}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div></div>
        <div class="panel"><h2>Days taken <select data-change="vac-pos">${App.opts(positions, ui.vac.pos)}</select></h2>${calendar(st, vb, ui.vac.pos, capOf(ui.vac.pos), me)}
          <div class="legend"><span class="badge bad">at limit</span><span class="badge warn">some off</span><span>number = people off</span></div></div>
      </div>`;
  }

  function calendar(st, vb, pid, cap, me) {
    const from = P.parseDate(vb.from), to = P.parseDate(vb.to);
    const months = [];
    let d = from;
    while (d <= to && months.length < 14) {
      const dt = new Date(d * 86400000);
      const y = dt.getUTCFullYear(), m = dt.getUTCMonth();
      const first = Math.floor(Date.UTC(y, m, 1) / 86400000), next = Math.floor(Date.UTC(y, m + 1, 1) / 86400000);
      let cells = '';
      for (let k = 0; k < P.dow(first); k++) cells += '<div class="out"></div>';
      for (let x = first; x < next; x++) {
        const who = P.plannedLeaveOn(st, x, pid);
        const out = x < from || x > to;
        const cls = out ? 'out' : cap != null && who.size >= cap ? 'full' : who.size ? 'some' : '';
        cells += `<div class="${cls} ${who.has(me) ? 'mine' : ''}" title="${P.fmtDate(x)}: ${who.size}${cap != null ? ' of ' + cap : ''} off">${who.size || new Date(x * 86400000).getUTCDate()}</div>`;
      }
      months.push(`<div><div class="small"><b>${dt.toLocaleString(undefined, { month: 'long', timeZone: 'UTC' })} ${y}</b></div><div class="mini-cal">${['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((x) => `<div style="background:none">${x}</div>`).join('')}${cells}</div></div>`);
      d = next;
    }
    return `<div class="months">${months.join('')}</div>`;
  }

  const cur = () => App.S.vacationBids.find((v) => v.id === App.ui.vac.id);
  App.changes['vac-sel'] = (el) => { App.ui.vac.id = el.value; App.render(); };
  App.changes['vac-pos'] = (el) => { App.ui.vac.pos = el.value; App.render(); };
  App.actions['vac-pick'] = () => {
    const from = document.getElementById('vac-from').value, to = document.getElementById('vac-to').value || from;
    if (!from) return App.toast('Pick a first day', true);
    App.act('vacPick', { bidId: App.ui.vac.id, from, to });
  };
  App.actions['vac-pass'] = () => App.confirm('Pass this round? You keep your place for later rounds.', () => App.act('vacPass', { bidId: App.ui.vac.id }), 'Pass');
  App.actions['vac-undo'] = () => App.act('vacUndo', { bidId: App.ui.vac.id });
  App.actions['vac-open'] = () => App.act('vacOpen', { bidId: App.ui.vac.id });
  App.actions['vac-close'] = () => App.commit(() => { cur().status = 'closed'; }, 'Vacation bid closed');
  App.actions['vac-del'] = () => App.confirm('Delete this vacation bid? Vacation already picked stays on the schedule.', () => App.commit((s) => { s.vacationBids = s.vacationBids.filter((v) => v.id !== App.ui.vac.id); }, 'Deleted'), 'Delete');
  App.actions['vac-new'] = () => {
    const st = App.S;
    const y = new Date().getFullYear() + 1;
    App.modal({
      title: 'New vacation bid',
      body: `<div class="form-grid"><div class="field"><label>Name</label><input name="name" value="${y} vacation bid"></div>
        <div class="field"><label>Leave from</label><input type="date" name="from" value="${y}-01-01"></div>
        <div class="field"><label>Leave through</label><input type="date" name="to" value="${y}-12-31"></div>
        <div class="field"><label>Rounds</label><input type="number" name="rounds" min="1" value="3"></div>
        <div class="field"><label>Max per pick</label><input type="number" name="maxDaysPerPick" min="1" value="5"></div>
        <div class="field"><label>Counted as</label><select name="pickUnit"><option value="shifts">scheduled workdays</option><option value="calendar">calendar days</option></select></div></div>
        <div class="field"><label>Job classes in this bid (one combined seniority list)</label><div class="pill-list">${P.jobClasses(st).map((c) => `<label class="check"><input type="checkbox" data-multi="1" name="jobClassIds" value="${esc(c.id)}" checked> ${esc(c.name)}</label>`).join('')}</div></div>
        <div class="field"><label>Most people off per day, by job class (blank = no limit)</label><div class="form-grid">${P.jobClasses(st).map((c) => `<div class="field"><label>${esc(c.name)}</label><input type="number" min="0" name="cap_${esc(c.id)}" value="${c.maxOffPerDay != null && c.maxOffPerDay !== '' ? c.maxOffPerDay : 1}"></div>`).join('')}</div></div>
        <p class="small muted">The limit counts approved and pending vacation, comp and holiday leave already on the books.</p>`,
      footer: '<button class="btn" data-action="modal-close">Cancel</button><button class="btn primary" data-action="vac-create">Create (draft)</button>',
    });
  };
  App.actions['vac-create'] = () => {
    const f = App.modalForm();
    if (!f.from || !f.to || f.to < f.from) return App.toast('Check the dates', true);
    const caps = {};
    for (const c of P.jobClasses(App.S)) if (f['cap_' + c.id] !== undefined && f['cap_' + c.id] !== '') caps[c.id] = +f['cap_' + c.id];
    const vb = { id: P.uid('vb'), name: f.name, from: f.from, to: f.to, rounds: Math.max(1, +f.rounds || 1), maxDaysPerPick: +f.maxDaysPerPick || null, pickUnit: f.pickUnit, jobClassIds: f.jobClassIds || [], caps, status: 'draft', picks: [], createdAt: new Date().toISOString() };
    App.ui.vac.id = vb.id;
    App.commit((s) => s.vacationBids.push(vb), 'Vacation bid created');
    App.closeModal();
  };
})();
