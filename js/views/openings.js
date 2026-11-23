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
        ${App.kpi('Cost if filled with OT', money(totalCost), 'at the average rate of staff certified on that console × OT multiplier')}
        ${Object.entries(byCause).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => App.kpi(App.reasonLabel(k), hrs(v) + ' h', 'open hours by cause')).join('')}
      </div>
      <div class="grid">
        <div class="panel"><h2>Unfilled openings</h2>
        ${slots.length ? `<div class="table-wrap"><table><thead><tr><th>When</th><th>Console</th><th class="num">Hours</th><th>Need</th><th>Cause</th><th class="num">Est. OT cost</th><th></th></tr></thead><tbody>
          ${slots.map((s) => `<tr><td class="nowrap">${App.slotTime(s)}</td><td>${esc(App.posName(s.positionId))}</td><td class="num">${hrs(s.hours)}</td>
            <td>${s.level > 1 ? `<span class="badge bad">${s.level}${['', 'st', 'nd', 'rd'][s.level] || 'th'} person</span>` : '<span class="badge bad">1 person</span>'}</td>
            <td class="small">${s.causes.length ? s.causes.map((c) => `${esc(P.empName(App.emp(c.employeeId)))} <span class="badge">${esc(App.excType(c.type).abbr)}</span>`).join(' ') : '<span class="muted">Structural — vacancy, trainee or vacant line</span>'}</td>
            <td class="num">${money(P.slotCost(st, s))}</td>
            <td><button class="btn sm primary" data-action="fill-slot" data-slot="${esc(s.id)}" data-from="${today}" data-to="${to}">Fill…</button></td></tr>`).join('')}
        </tbody></table></div>` : '<div class="empty">No openings — every hour meets minimum staffing.</div>'}
        </div>
        ${postingsPanel(st, today)}
        ${tradesPanel(st)}
        <div class="grid g2">
          <div class="panel"><h2>Pending time-off requests</h2>
          ${pending.length ? `<div class="table-wrap"><table><thead><tr><th>Employee</th><th>Type</th><th>Dates</th><th class="num">Leave hrs</th><th>Impact if approved</th><th></th></tr></thead><tbody>
            ${pending.map((e) => {
              const imp = P.requestImpact(st, e.id);
              return `<tr><td>${esc(P.empName(App.emp(e.employeeId)))}</td><td>${esc(App.excType(e.type).label)}</td>
              <td class="nowrap">${P.shortDate(P.parseDate(e.date))}${e.endDate ? ' → ' + P.shortDate(P.parseDate(e.endDate)) : ''}</td>
              <td class="num">${hrs(imp.leaveHours)}</td>
              <td>${(() => { const ov = P.overLeaveLimit(st, e); return ov.length ? `<span class="badge bad" title="${esc(ov.map((o) => P.shortDate(o.day) + ': ' + o.others.map((id) => P.empName(App.emp(id))).join(', ')).join('; '))}">over daily limit ${ov.length} day(s)</span> ` : ''; })()}${imp.addedGapHours ? `<span class="badge bad">+${hrs(imp.addedGapHours)} h below min</span> <span class="small muted">≈ ${money(imp.cost)} OT</span>` : '<span class="badge ok">No coverage impact</span>'}</td>
              <td class="nowrap"><button class="btn sm primary" data-action="exc-status" data-id="${e.id}" data-status="approved">Approve</button> <button class="btn sm" data-action="exc-status" data-id="${e.id}" data-status="denied">Deny</button></td></tr>`;
            }).join('')}
          </tbody></table></div>` : '<div class="empty">No pending requests.</div>'}
          <p class="small muted">Employees submit requests from My Schedule; you can also add them from the Schedule page.</p></div>
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
  function postingsPanel(st, today) {
    const list = st.postings.filter((p) => p.status === 'open' || (p.status === 'awarded' && P.parseDate(p.date) >= today)).sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));
    if (!list.length) return '';
    const rows = list.map((po) => {
      const slot = App.A.postingSlot(po);
      let vols = '';
      if (po.status === 'open') {
        const ranked = P.fillCandidates(st, slot, { order: 'voluntary' });
        const rank = {}; ranked.forEach((c, i) => { rank[c.emp.id] = { i, c }; });
        const v = (po.volunteers || []).slice().sort((a, b) => po.mode === 'first' ? a.at.localeCompare(b.at) : ((rank[a.employeeId] || { i: 999 }).i - (rank[b.employeeId] || { i: 999 }).i));
        vols = v.map((x) => { const r = rank[x.employeeId]; const ok = r && r.c.eligible; return `<div>${esc(P.empName(App.emp(x.employeeId)))} ${ok ? '' : `<span class="badge bad">${esc(r ? r.c.issues.join(', ') : 'not qualified')}</span>`} <span class="small muted">${r ? hrs(r.c.otFyHours) + ' OT h FY' : ''}</span> <button class="btn sm ${ok ? 'primary' : ''}" data-action="po-award" data-id="${po.id}" data-emp="${x.employeeId}">Award</button></div>`; }).join('') || '<span class="muted">No volunteers yet</span>';
      } else vols = `Awarded to <b>${esc(P.empName(App.emp(po.awardedTo)))}</b>`;
      return `<tr><td class="nowrap">${App.slotTime(slot)}</td><td>${esc(App.posName(po.positionId))}</td><td class="num">${hrs(po.hours)}</td><td>${po.mode === 'first' ? 'first-come' : 'OT list'}</td><td>${App.statusBadge(po.status)}</td><td>${vols}</td>
        <td>${po.status === 'open' ? `<button class="btn sm danger" data-action="po-cancel" data-id="${po.id}">Cancel</button>` : ''}</td></tr>`;
    }).join('');
    return `<div class="panel"><h2>Posted for volunteers</h2><div class="table-wrap"><table><thead><tr><th>When</th><th>Console</th><th class="num">Hrs</th><th>Award</th><th>Status</th><th>Volunteers (OT-list order)</th><th></th></tr></thead><tbody>${rows}</tbody></table></div></div>`;
  }
  function tradesPanel(st) {
    const list = st.trades.filter((t) => t.status === 'accepted');
    if (!list.length) return '';
    return `<div class="panel"><h2>Shift trades awaiting approval</h2><table><thead><tr><th>Requester</th><th>Partner</th><th>Shift(s)</th><th>Note</th><th></th></tr></thead><tbody>
      ${list.map((t) => `<tr><td>${esc(P.empName(App.emp(t.requesterId)))}</td><td>${esc(P.empName(App.emp(t.partnerId)))}</td>
        <td class="small">${(t.legs || []).map((l) => `${esc(P.empName(App.emp(l.toId)))} works ${esc(P.empName(App.emp(l.fromId)))}'s ${P.shortDate(P.parseDate(l.date))} ${l.start.replace(':', '')} (${l.hours}h)`).join('<br>')}</td>
        <td class="small">${esc(t.note || '')}</td>
        <td class="nowrap"><button class="btn sm primary" data-action="tr-decide" data-id="${t.id}" data-ok="1">Approve</button> <button class="btn sm" data-action="tr-decide" data-id="${t.id}" data-ok="0">Deny</button></td></tr>`).join('')}
    </tbody></table><p class="small muted">Trades are straight time: the person covering doesn't earn OT for it, and the original employee is credited as if they worked (FLSA 7(p)(3)).</p></div>`;
  }
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
    App.modal({ title: `Fill opening — ${App.posName(slot.positionId)} console`, wide: true, body: fillBody, footer: '<button class="btn" data-action="modal-close">Close</button>' });
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
      <p class="small muted">${F.order === 'voluntary' ? (st.center.partTimeFirst !== false ? 'Voluntary order: part-timers at straight time first, then holdover / early-in, then fewest OT hours this fiscal year, then seniority.' : 'Voluntary order: holdover / early-in first, then fewest OT hours this fiscal year, then seniority.') : (st.center.forceOrderBasis === 'lastForced' ? 'Force order: longest since last forced first, then least senior.' : 'Force order: longest since last overtime worked first, then least senior.')}
        Hard rules: not already working, not on leave, ≥ ${st.center.minRestHours} h rest, ≤ ${st.center.maxShiftHours} h continuous.</p>
      <div class="table-wrap" style="max-height:48vh"><table><thead><tr><th>#</th><th>Employee</th><th>Fit</th><th class="num">Hrs last 7d</th><th class="num">OT hrs FY</th><th>${st.center.forceOrderBasis === 'lastForced' ? 'Last forced' : 'Last OT'}</th><th class="num">OT hrs added</th><th class="num">Est. cost</th><th></th></tr></thead><tbody>
      ${shown.map((c, i) => `<tr class="${c.eligible ? '' : 'dim'}"><td>${i + 1}</td><td>${esc(P.empName(c.emp))} <span class="small muted">#${esc(c.emp.badge || '')} · ${esc((P.empClass(st, c.emp) || {}).name || 'no job class')}</span></td>
        <td class="small">${c.partTime ? `<span class="badge ok" title="Part-time: straight time, capped at ${c.cap} h/week">part-time ${App.hrs(c.weekHours)}/${c.cap} h</span> ` : ''}${c.holdover ? '<span class="badge info">holdover</span> ' : ''}${c.earlyIn ? '<span class="badge info">early-in</span> ' : ''}${c.issues.map((x) => `<span class="badge bad">${esc(x)}</span>`).join(' ')} ${c.warnings.map((x) => `<span class="badge warn">${esc(x)}</span>`).join(' ')}</td>
        <td class="num">${hrs(c.hours7)}</td><td class="num">${hrs(c.otFyHours)}</td><td class="nowrap">${(st.center.forceOrderBasis === 'lastForced' ? c.lastForced : c.lastOT) || '<span class="muted">never</span>'}${c.forcedCount ? ` <span class="small muted">(${c.forcedCount} forced FY)</span>` : ''}</td>
        <td class="num">${hrs(c.otHours)}</td><td class="num">${money(c.cost)}</td>
        <td><button type="button" class="btn sm ${c.eligible ? 'primary' : ''}" data-action="fill-assign" data-emp="${c.emp.id}" data-hold="${c.holdover ? 1 : c.earlyIn ? 2 : 0}">${c.eligible ? 'Assign' : 'Override'}</button></td></tr>`).join('') || '<tr><td colspan="9" class="empty">No eligible candidates — try the full list, or split the opening.</td></tr>'}
      </tbody></table></div>
      ${hidden ? `<p><label class="check"><input type="checkbox" ${F.showAll ? 'checked' : ''} data-change="fill-showall"> Show ${hidden} ineligible employee(s)</label></p>` : ''}
      <div class="section"><h3>…or post it for volunteers</h3>
        <div class="form-grid"><div class="field"><label>Award by</label><select name="postMode"><option value="list">OT list (supervisor awards)</option><option value="first">First eligible volunteer</option></select></div>
        <div class="field" style="grid-column: span 2"><label>Note</label><input name="postNote" placeholder="optional" style="width:100%"></div></div>
        <button type="button" class="btn" data-action="fill-post">Post & notify eligible staff</button>
        <span class="small muted">Everyone qualified and eligible for ${P.mil(F.start)} × ${hrs(F.hours)} h is notified.</span></div>`;
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
    const { id: _ignore, ...payload } = fill;
    App.act('assignFill', { fill: payload }).then((r) => { if (r) afterAssign(slot); });
  };
  function afterAssign(slot) {
    // If part of the opening is still open, keep the dialog going on the remainder.
    const d0 = Math.floor(slot.start / P.DAY);
    const rest = P.openings(S(), d0, Math.floor((slot.end - 1) / P.DAY)).slots.filter((x) => x.positionId === slot.positionId && x.start < slot.end && x.end > slot.start && x.end > P.nowAbs());
    if (rest.length) { App.openFill(rest[0]); App.toast(`${hrs(rest[0].hours)} h still open in this block`); }
    else App.closeModal();
  }
  App.actions['fill-post'] = () => {
    const f = App.modalForm();
    const slot = F.slot;
    App.act('postOpening', {
      positionId: slot.positionId, date: P.fmtDate(Math.floor(F.start / P.DAY)), start: P.timeStr(F.start), hours: F.hours,
      mode: f.postMode, note: f.postNote, reason: P.slotReason(slot), exceptionId: slot.causes[0] ? slot.causes[0].exceptionId : null,
    }).then((r) => { if (r) App.closeModal(); });
  };
  App.actions['po-award'] = (el) => App.act('awardPosting', { id: el.dataset.id, employeeId: el.dataset.emp });
  App.actions['po-cancel'] = (el) => App.confirm('Cancel this posting? Volunteers will be notified.', () => App.act('cancelPosting', { id: el.dataset.id }), 'Cancel posting');
  App.actions['tr-decide'] = (el) => App.act('decideTrade', { id: el.dataset.id, approve: el.dataset.ok === '1' });
})();
