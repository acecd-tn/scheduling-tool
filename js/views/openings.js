(function () {
  'use strict';
  const { P, esc, money, hrs } = App;
  const S = () => App.S;

  App.ui.open = { days: 14 };

  App.views.openings = {
    render(st, ui) {
      const today = P.todayNum();
      const now = P.nowAbs();
      const to = today + ui.open.days - 1;
      const op = P.openings(st, today, to);
      const slots = op.slots.filter((s) => s.end > now);
      const totalCost = slots.reduce((s, x) => s + P.slotCost(st, x), 0);
      const pending = st.exceptions.filter((e) => e.status === 'pending').sort((a, b) => a.date.localeCompare(b.date));
      const upcoming = st.exceptions.filter((e) => e.status === 'approved' && P.exceptionRange(e)[1] >= today && P.parseDate(e.date) <= to)
        .sort((a, b) => a.date.localeCompare(b.date));
      const byCause = {};
      for (const s of slots) { const r = P.slotReason(s); byCause[r] = (byCause[r] || 0) + s.hours; }

      return `<div class="page-head"><div><h1>Openings</h1><p>Every hour below minimum staffing, why it is open, and who can fill it.</p></div>
        <div class="toolbar"><select data-change="open-days">${App.opts([{ id: 7, name: 'Next 7 days' }, { id: 14, name: 'Next 14 days' }, { id: 28, name: 'Next 28 days' }, { id: 56, name: 'Next 8 weeks' }], ui.open.days)}</select></div></div>
      <div class="kpis">
        ${App.kpi('Open slots', slots.length, `${hrs(slots.reduce((s, x) => s + x.hours, 0))} person-hours`, slots.length ? 'bad' : 'ok')}
        ${App.kpi('Cost if filled with OT', money(totalCost), 'at average position rate × OT multiplier')}
        ${Object.entries(byCause).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => App.kpi(App.reasonLabel(k), hrs(v) + ' h', 'open hours by cause')).join('')}
      </div>
      <div class="grid">
        <div class="panel"><h2>Unfilled openings</h2>
        ${slots.length ? `<div class="table-wrap"><table><thead><tr><th>When</th><th>Position</th><th class="num">Hours</th><th>Need</th><th>Cause</th><th class="num">Est. OT cost</th><th></th></tr></thead><tbody>
          ${slots.map((s) => `<tr><td class="nowrap">${App.slotTime(s)}</td><td>${esc(App.posName(s.positionId))}</td><td class="num">${hrs(s.hours)}</td>
            <td>${s.level > 1 ? `<span class="badge bad">${s.level}${['', 'st', 'nd', 'rd'][s.level] || 'th'} person</span>` : '<span class="badge bad">1 person</span>'}</td>
            <td class="small">${s.causes.length ? s.causes.map((c) => `${esc(P.empName(App.emp(c.employeeId)))} <span class="badge">${esc(App.excType(c.type).abbr)}</span>`).join(' ') : '<span class="muted">Structural — vacancy, trainee or vacant line</span>'}</td>
            <td class="num">${money(P.slotCost(st, s))}</td>
            <td><button class="btn sm primary" data-action="fill-slot" data-slot="${esc(s.id)}" data-from="${today}" data-to="${to}">Fill…</button></td></tr>`).join('')}
        </tbody></table></div>` : '<div class="empty">No openings — every hour meets minimum staffing.</div>'}
        </div>
        <div class="grid g2">
          <div class="panel"><h2>Pending time-off requests</h2>
          ${pending.length ? `<div class="table-wrap"><table><thead><tr><th>Employee</th><th>Type</th><th>Dates</th><th class="num">Leave hrs</th><th>Impact if approved</th><th></th></tr></thead><tbody>
            ${pending.map((e) => {
              const imp = P.requestImpact(st, e.id);
              return `<tr><td>${esc(P.empName(App.emp(e.employeeId)))}</td><td>${esc(App.excType(e.type).label)}</td>
              <td class="nowrap">${P.shortDate(P.parseDate(e.date))}${e.endDate ? ' → ' + P.shortDate(P.parseDate(e.endDate)) : ''}</td>
              <td class="num">${hrs(imp.leaveHours)}</td>
              <td>${imp.addedGapHours ? `<span class="badge bad">+${hrs(imp.addedGapHours)} h below min</span> <span class="small muted">≈ ${money(imp.cost)} OT</span>` : '<span class="badge ok">No coverage impact</span>'}</td>
              <td class="nowrap"><button class="btn sm primary" data-action="exc-status" data-id="${e.id}" data-status="approved">Approve</button> <button class="btn sm" data-action="exc-status" data-id="${e.id}" data-status="denied">Deny</button></td></tr>`;
            }).join('')}
          </tbody></table></div>` : '<div class="empty">No pending requests.</div>'}
          <p class="small muted">Add requests from the Schedule page (click a cell → status "Pending request").</p></div>
          <div class="panel"><h2>Approved leave in window</h2>
          ${upcoming.length ? `<div class="table-wrap"><table><thead><tr><th>Employee</th><th>Type</th><th>Dates</th><th></th></tr></thead><tbody>
            ${upcoming.map((e) => `<tr><td>${esc(P.empName(App.emp(e.employeeId)))}</td><td>${esc(App.excType(e.type).label)}${e.start ? ` <span class="small muted">${e.start} ${e.hours}h</span>` : ''}</td>
              <td class="nowrap">${P.shortDate(P.parseDate(e.date))}${e.endDate ? ' → ' + P.shortDate(P.parseDate(e.endDate)) : ''}</td>
              <td><button class="btn sm" data-action="day-cell" data-emp="${e.employeeId}" data-day="${Math.max(P.parseDate(e.date), today)}">Open</button></td></tr>`).join('')}
          </tbody></table></div>` : '<div class="empty">None.</div>'}</div>
        </div>
      </div>`;
    },
  };
  App.changes['open-days'] = (el) => { App.ui.open.days = +el.value; App.render(); };
  App.actions['fill-slot'] = (el) => {
    const op = P.openings(S(), +el.dataset.from, +el.dataset.to);
    const slot = op.slots.find((s) => s.id === el.dataset.slot);
    if (slot) App.openFill(slot); else App.toast('That opening is already covered');
  };

  // ------------------------------------------------------------ fill dialog
  let F = null;
  App.openFill = function (slot) {
    const maxH = +S().center.maxShiftHours || 16;
    F = { slot, start: slot.start, hours: Math.min(slot.hours, Math.max(4, Math.min(12, maxH))), order: 'voluntary', showAll: false };
    if (slot.hours <= 12) F.hours = slot.hours;
    App.modal({ title: `Fill opening — ${App.posName(slot.positionId)}`, wide: true, body: fillBody, footer: '<button class="btn" data-action="modal-close">Close</button>' });
  };

  function fillBody() {
    const st = S();
    const slot = F.slot;
    const target = { positionId: slot.positionId, start: F.start, end: F.start + Math.round(F.hours * 60) };
    const cands = P.fillCandidates(st, target, { order: F.order });
    const shown = F.showAll ? cands : cands.filter((c) => c.eligible);
    const hidden = cands.length - cands.filter((c) => c.eligible).length;
    const d = Math.floor(F.start / P.DAY);
    return `
      <div class="callout"><b>${App.slotTime(slot)}</b> · ${hrs(slot.hours)} h below minimum · ${slot.causes.length ? 'cause: ' + slot.causes.map((c) => esc(`${P.empName(App.emp(c.employeeId))} — ${c.label}`)).join('; ') : 'structural shortage (vacancy / trainee / vacant line)'}</div>
      <div class="form-grid">
        <div class="field"><label>Date</label><input type="date" name="fDate" value="${P.fmtDate(d)}" data-change="fill-param"></div>
        <div class="field"><label>Start</label><input type="time" name="fStart" value="${P.timeStr(F.start)}" data-change="fill-param"></div>
        <div class="field"><label>Hours</label><input type="number" step="0.5" min="0.5" name="fHours" value="${F.hours}" data-change="fill-param"></div>
        <div class="field"><label>List order</label><div class="seg"><button type="button" class="${F.order === 'voluntary' ? 'on' : ''}" data-action="fill-order" data-order="voluntary">Voluntary</button><button type="button" class="${F.order === 'mandatory' ? 'on' : ''}" data-action="fill-order" data-order="mandatory">Mandatory / force</button></div></div>
      </div>
      ${slot.hours > F.hours ? `<p class="small muted">Opening is ${hrs(slot.hours)} h; this assignment covers ${hrs(F.hours)} h. The remainder stays open so you can split it (e.g. holdover + early-in).</p>` : ''}
      <p class="small muted">${F.order === 'voluntary' ? 'Voluntary order: holdover / early-in first, then fewest OT hours this fiscal year, then seniority.' : 'Force order: never / least-recently forced first, then least senior.'}
        Hard rules: not already working, not on leave, ≥ ${st.center.minRestHours} h rest, ≤ ${st.center.maxShiftHours} h continuous.</p>
      <div class="table-wrap" style="max-height:48vh"><table><thead><tr><th>#</th><th>Employee</th><th>Fit</th><th class="num">Hrs last 7d</th><th class="num">OT hrs FY</th><th>Last forced</th><th class="num">OT hrs added</th><th class="num">Est. cost</th><th></th></tr></thead><tbody>
      ${shown.map((c, i) => `<tr class="${c.eligible ? '' : 'dim'}"><td>${i + 1}</td><td>${esc(P.empName(c.emp))} <span class="small muted">#${esc(c.emp.badge || '')} · ${esc(App.posName(c.emp.positionId))}</span></td>
        <td class="small">${c.holdover ? '<span class="badge info">holdover</span> ' : ''}${c.earlyIn ? '<span class="badge info">early-in</span> ' : ''}${c.issues.map((x) => `<span class="badge bad">${esc(x)}</span>`).join(' ')} ${c.warnings.map((x) => `<span class="badge warn">${esc(x)}</span>`).join(' ')}</td>
        <td class="num">${hrs(c.hours7)}</td><td class="num">${hrs(c.otFyHours)}</td><td class="nowrap">${c.lastForced || '<span class="muted">never</span>'}</td>
        <td class="num">${hrs(c.otHours)}</td><td class="num">${money(c.cost)}</td>
        <td><button type="button" class="btn sm ${c.eligible ? 'primary' : ''}" data-action="fill-assign" data-emp="${c.emp.id}" data-hold="${c.holdover ? 1 : c.earlyIn ? 2 : 0}">${c.eligible ? 'Assign' : 'Override'}</button></td></tr>`).join('') || '<tr><td colspan="9" class="empty">No eligible candidates — try the full list, or split the opening.</td></tr>'}
      </tbody></table></div>
      ${hidden ? `<p><label class="check"><input type="checkbox" ${F.showAll ? 'checked' : ''} data-change="fill-showall"> Show ${hidden} ineligible employee(s)</label></p>` : ''}`;
  }

  App.changes['fill-param'] = () => {
    const f = App.modalForm();
    if (!f.fDate || !f.fStart) return;
    F.start = P.parseDate(f.fDate) * P.DAY + P.parseTime(f.fStart);
    F.hours = Math.max(0.5, +f.fHours || 1);
    App.redrawModal();
  };
  App.changes['fill-showall'] = (el) => { F.showAll = el.checked; App.redrawModal(); };
  App.actions['fill-order'] = (el) => { F.order = el.dataset.order; App.redrawModal(); };
  App.actions['fill-assign'] = (el) => {
    const hold = +el.dataset.hold;
    const type = F.order === 'mandatory' ? 'mandatory' : hold === 1 ? 'holdover' : hold === 2 ? 'earlyin' : 'voluntary';
    const slot = F.slot;
    const fill = {
      id: P.uid('ot'), date: P.fmtDate(Math.floor(F.start / P.DAY)), start: P.timeStr(F.start), hours: F.hours,
      positionId: slot.positionId, employeeId: el.dataset.emp, type, reason: P.slotReason(slot),
      exceptionId: slot.causes[0] ? slot.causes[0].exceptionId : null, status: 'scheduled', note: '', createdAt: new Date().toISOString(),
    };
    App.commit((s) => s.fills.push(fill), `${P.empName(App.emp(fill.employeeId))} assigned (${App.fillType(type)})`);
    // If part of the opening is still open, keep the dialog going on the remainder.
    const d0 = Math.floor(slot.start / P.DAY);
    const rest = P.openings(S(), d0, Math.floor((slot.end - 1) / P.DAY)).slots.filter((x) => x.positionId === slot.positionId && x.start < slot.end && x.end > slot.start && x.end > P.nowAbs());
    if (rest.length) { App.openFill(rest[0]); App.toast(`${hrs(rest[0].hours)} h still open in this block`); }
    else App.closeModal();
  };
})();
