/* Employee self-service pages: My Schedule, Open Shifts, Trades. */
(function () {
  'use strict';
  const { P, A, esc, hrs } = App;

  const myId = () => App.me && App.me.employeeId;
  const noLink = '<div class="panel callout warn">Your login is not linked to an employee record yet — ask a supervisor.</div>';

  /** My upcoming days: regular shifts, leave, trades, OT. */
  function myDays(st, from, to) {
    const me = myId();
    const ix = P.index(st);
    const regs = P.regularShifts(st, from, to, ix).filter((r) => r.employeeId === me);
    const wi = P.workIntervals(st, from, to, { ix, includePending: false });
    const days = [];
    for (let d = from; d <= to; d++) {
      const reg = regs.find((r) => r.day === d);
      const exc = st.exceptions.filter((e) => e.employeeId === me && e.status !== 'denied' && (() => { const [a, b] = P.exceptionRange(e); return a <= d && d <= b; })());
      const ot = wi.intervals.filter((iv) => iv.employeeId === me && iv.day === d && iv.kind === 'ot');
      if (reg || exc.length || ot.length) days.push({ d, reg, exc, ot, tpl: reg ? ix.tpl[reg.templateId] : null });
    }
    return days;
  }

  // ----------------------------------------------------------- My Schedule
  App.views.me = {
    render(st) {
      if (!myId()) return noLink;
      const today = P.todayNum();
      const me = App.emp(myId());
      const days = myDays(st, today, today + 27);
      const per = P.periodOf(st, today);
      const wi = P.workIntervals(st, per.start, per.end);
      const h = P.empHours(wi.intervals.filter((x) => x.employeeId === me.id), wi.leave.filter((x) => x.employeeId === me.id), per.start, per.end);
      const r = P.otCalc(st.center, h, me);
      const reqs = st.exceptions.filter((e) => e.employeeId === me.id && e.type !== 'trade' && P.exceptionRange(e)[1] >= today - 30).sort((a, b) => a.date.localeCompare(b.date));
      const notes = App.myNotifications().slice(0, 8);
      const rows = days.map((x) => {
        const full = x.exc.find((e) => !e.start && e.status === 'approved');
        const items = [];
        if (x.reg) items.push(full ? `<s class="muted">${esc(x.tpl.code)} ${P.mil(x.reg.start)}–${P.mil(x.reg.end)}</s>` : `<span class="shift" style="display:inline-block;padding:2px 8px;background:${esc(x.tpl.color)}">${esc(x.tpl.code)}</span> ${P.mil(x.reg.start)}–${P.mil(x.reg.end)}`);
        for (const e of x.exc) items.push(`<span class="badge ${e.status === 'pending' ? 'warn' : 'info'}">${esc(App.excType(e.type).label)}${e.start ? ` ${e.start} ${e.hours}h` : ''}${e.status === 'pending' ? ' (pending)' : ''}</span>`);
        for (const o of x.ot) items.push(`<span class="badge ok">${o.fillType === 'trade' ? 'Trade' : 'OT'} ${P.mil(o.start)}–${P.mil(o.end)} · ${esc(App.posName(o.positionId))}</span>`);
        return `<tr><td class="nowrap ${x.d === today ? 'today' : ''}"><b>${P.shortDate(x.d)}</b></td><td>${items.join(' ')}</td>
          <td style="text-align:right">${x.reg && !full ? `<button class="btn sm" data-action="me-request" data-day="${x.d}">Request off</button>` : ''}</td></tr>`;
      }).join('');
      return `<div class="page-head"><div><h1>${esc(P.empName(me))}</h1><p>${esc(App.posName(me.positionId))}${(me.qualifications || []).length ? ' · also certified: ' + me.qualifications.map((q) => esc(App.posName(q))).join(', ') : ''}</p></div>
        <div class="toolbar"><button class="btn primary" data-action="me-request">Request time off</button><button class="btn" data-action="go" data-to="open">Open shifts</button><button class="btn" data-action="go" data-to="trades">Trade a shift</button></div></div>
      <div class="kpis">
        ${P.isPartTime(me) ? (() => { const wk = P.workWeek(st, today); const hw = P.empHours(wi.intervals.filter((x) => x.employeeId === me.id), [], wk.start, wk.end); const used = hw.regular + hw.fill; const cap = P.partTimeCap(st, me);
          return App.kpi('This week (part-time)', `${hrs(used)} / ${hrs(cap)} h`, `${hrs(Math.max(0, cap - used))} h left to pick up · ${P.shortDate(wk.start)}–${P.shortDate(wk.end)}`, used >= cap ? 'warn' : ''); })()
          : App.kpi('This work week', `${hrs(r.worked)} h`, `${P.shortDate(per.start)}–${P.shortDate(per.end)} · OT after ${st.center.otThresholdHours} h`, r.worked > st.center.otThresholdHours ? 'warn' : '')}
        ${App.kpi('OT hours this week', hrs(r.otHours), 'scheduled through week end')}
        ${App.kpi('Pending requests', reqs.filter((e) => e.status === 'pending').length, '')}
        ${App.kpi('Unread notices', notes.filter((n) => n.unread).length, '<a href="#" data-action="bell">view</a>')}
      </div>
      <div class="grid g2">
        <div class="panel"><h2>Next 4 weeks</h2><table><tbody>${rows || '<tr><td class="empty">Nothing scheduled.</td></tr>'}</tbody></table></div>
        <div>
          <div class="panel" style="margin-bottom:14px"><h2>My requests</h2>${reqs.length ? `<table><thead><tr><th>Dates</th><th>Type</th><th>Status</th><th></th></tr></thead><tbody>
            ${reqs.map((e) => `<tr><td class="nowrap">${P.shortDate(P.parseDate(e.date))}${e.endDate ? ' → ' + P.shortDate(P.parseDate(e.endDate)) : ''}${e.start ? ` <span class="small muted">${e.start} ${e.hours}h</span>` : ''}</td><td>${esc(App.excType(e.type).label)}</td>
              <td>${App.statusBadge(e.status)}${e.decisionNote ? `<div class="small muted">${esc(e.decisionNote)}</div>` : ''}</td><td>${e.status === 'pending' ? `<button class="btn sm" data-action="me-withdraw" data-id="${e.id}">Withdraw</button>` : ''}</td></tr>`).join('')}
            </tbody></table>` : '<div class="empty">No requests.</div>'}</div>
          <div class="panel"><h2>Notifications <button class="btn sm" data-action="bell">All</button></h2>${notes.length ? `<table><tbody>${notes.map((n) => `<tr class="${n.unread ? '' : 'dim'}"><td><b>${esc(n.title)}</b><div class="small">${esc(n.body)}</div></td><td class="small muted nowrap">${esc(new Date(n.at).toLocaleDateString())}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">None.</div>'}</div>
        </div>
      </div>`;
    },
  };

  App.openRequest = function (day) {
    const st = App.S;
    const d = day != null ? day : P.todayNum() + 1;
    const reg = P.regularShifts(st, d, d).find((r) => r.employeeId === myId());
    App.modal({
      title: 'Request time off',
      body: `<div class="form-grid">
        <div class="field"><label>Type</label><select name="type">${App.opts(P.EXCEPTION_TYPES.filter((t) => !t.system && t.id !== 'sick'), 'vacation', (t) => t.label)}</select></div>
        <div class="field"><label>From</label><input type="date" name="date" value="${P.fmtDate(d)}" min="${P.fmtDate(P.todayNum())}"></div>
        <div class="field"><label>Through (optional)</label><input type="date" name="endDate" min="${P.fmtDate(P.todayNum())}"></div></div>
        <div class="form-grid"><div class="field"><label class="check"><input type="checkbox" name="partial"> Part of the shift only</label></div>
        <div class="field"><label>Start</label><input type="time" name="start" value="${reg ? P.timeStr(reg.start) : '07:00'}"></div>
        <div class="field"><label>Hours</label><input type="number" step="0.25" min="0.25" name="hours" value="4"></div></div>
        <div class="field"><label>Note to supervisor</label><input name="note" style="width:100%"></div>
        <p class="small muted">Calling out sick for a shift today? Call the on-duty supervisor — sick call-outs are recorded by them.</p>`,
      footer: '<button class="btn" data-action="modal-close">Cancel</button><button class="btn primary" data-action="me-request-send">Submit request</button>',
    });
  };
  App.actions['me-request'] = (el) => App.openRequest(el.dataset.day != null ? +el.dataset.day : null);
  App.actions['me-request-send'] = () => {
    const f = App.modalForm();
    App.act('requestLeave', { type: f.type, date: f.date, endDate: f.endDate || null, start: f.partial ? f.start : null, hours: f.partial ? +f.hours : null, note: f.note })
      .then((r) => { if (r) App.closeModal(); });
  };
  App.actions['me-withdraw'] = (el) => App.act('cancelRequest', { id: el.dataset.id });

  // ------------------------------------------------------------ Open Shifts
  App.views.open = {
    render(st) {
      if (!myId()) return noLink;
      const today = P.todayNum();
      const me = App.emp(myId());
      const list = st.postings.filter((p) => p.status === 'open' && P.parseDate(p.date) >= today && P.qualifiedFor(me, p.positionId))
        .sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));
      const mine = st.fills.filter((f) => f.employeeId === me.id && f.type !== 'trade' && P.parseDate(f.date) >= today).sort((a, b) => a.date.localeCompare(b.date));
      return `<div class="page-head"><div><h1>Open shifts</h1><p>Overtime posted by supervisors that you are certified for. You'll get a notification when new shifts are posted.</p></div></div>
        <div class="grid g2"><div class="panel"><h2>Available</h2>${list.length ? `<table><thead><tr><th>When</th><th>Console</th><th class="num">Hrs</th><th>Awarded by</th><th></th></tr></thead><tbody>
          ${list.map((po) => { const signed = (po.volunteers || []).some((v) => v.employeeId === me.id); return `<tr><td class="nowrap">${App.slotTime(A.postingSlot(po))}</td><td>${esc(App.posName(po.positionId))}</td><td class="num">${hrs(po.hours)}</td>
            <td>${po.mode === 'first' ? 'First eligible volunteer' : 'OT list'}${po.note ? `<div class="small muted">${esc(po.note)}</div>` : ''}</td>
            <td>${signed ? '<span class="badge ok">signed up</span> <button class="btn sm" data-action="po-withdraw" data-id="' + po.id + '">Withdraw</button>' : `<button class="btn sm primary" data-action="po-volunteer" data-id="${po.id}">${po.mode === 'first' ? 'Take it' : 'Sign up'}</button>`}</td></tr>`; }).join('')}
          </tbody></table>` : '<div class="empty">Nothing posted right now.</div>'}</div>
        <div class="panel"><h2>My upcoming overtime</h2>${mine.length ? `<table><tbody>${mine.map((f) => `<tr><td>${P.shortDate(P.parseDate(f.date))}</td><td>${f.start.replace(':', '')} · ${f.hours}h</td><td>${esc(App.posName(f.positionId))}</td><td>${f.type === 'mandatory' ? '<span class="badge bad">mandatory</span>' : esc(App.fillType(f.type))}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">None.</div>'}</div></div>`;
    },
  };
  App.actions['po-volunteer'] = (el) => App.act('volunteer', { id: el.dataset.id });
  App.actions['po-withdraw'] = (el) => App.act('withdraw', { id: el.dataset.id });

  // ----------------------------------------------------------------- Trades
  App.ui.trade = { date: '', partner: '' };
  App.views.trades = {
    render(st) {
      if (!myId()) return noLink;
      const me = myId();
      const mine = st.trades.filter((t) => t.requesterId === me || t.partnerId === me).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
      const legText = (t) => (t.legs || []).map((l) => `${l.toId === me ? 'You work' : esc(P.empName(App.emp(l.toId))) + ' works'} ${l.fromId === me ? 'your' : esc(P.empName(App.emp(l.fromId))) + "'s"} ${P.shortDate(P.parseDate(l.date))} ${l.start.replace(':', '')} (${l.hours}h)`).join('<br>');
      const rows = mine.map((t) => {
        const incoming = t.partnerId === me && t.status === 'proposed';
        const act = incoming ? `<button class="btn sm primary" data-action="tr-respond" data-id="${t.id}" data-ok="1">Accept</button> <button class="btn sm" data-action="tr-respond" data-id="${t.id}" data-ok="0">Decline</button>`
          : ['proposed', 'accepted'].includes(t.status) ? `<button class="btn sm" data-action="tr-cancel" data-id="${t.id}">Cancel</button>` : '';
        return `<tr><td>${t.requesterId === me ? 'You → ' + esc(P.empName(App.emp(t.partnerId))) : esc(P.empName(App.emp(t.requesterId))) + ' → you'}</td><td class="small">${legText(t)}${t.note ? `<div class="muted">${esc(t.note)}</div>` : ''}</td>
          <td>${App.statusBadge(t.status === 'accepted' ? 'awaiting supervisor' : t.status)}</td><td class="nowrap">${act}</td></tr>`;
      }).join('');
      return `<div class="page-head"><div><h1>Shift trades</h1><p>Trade a shift with a coworker who is certified for your console. Trades are straight time${st.center.tradeRequiresApproval !== false ? ' and need supervisor approval' : ''}.</p></div>
        <div class="toolbar"><button class="btn primary" data-action="tr-new">Propose a trade</button></div></div>
        <div class="panel">${rows ? `<table><thead><tr><th>Trade</th><th>Shifts</th><th>Status</th><th></th></tr></thead><tbody>${rows}</tbody></table>` : '<div class="empty">No trades yet.</div>'}</div>`;
    },
  };

  function tradeBody() {
    const st = App.S;
    const me = App.emp(myId());
    const today = P.todayNum();
    const ix = P.index(st);
    const mineShifts = myDays(st, today, today + 60).filter((x) => x.reg && !x.exc.some((e) => !e.start && e.status === 'approved'));
    const u = App.ui.trade;
    if (!u.date && mineShifts[0]) u.date = P.fmtDate(mineShifts[0].d);
    const myShift = mineShifts.find((x) => P.fmtDate(x.d) === u.date);
    // Partners: certified for my console and free during that shift.
    let partners = [];
    if (myShift) {
      partners = P.fillCandidates(st, { positionId: myShift.reg.positionId, start: myShift.reg.start, end: myShift.reg.end })
        .filter((c) => c.emp.id !== me.id && c.eligible).map((c) => c.emp).sort((a, b) => P.empName(a).localeCompare(P.empName(b)));
    }
    if (u.partner && !partners.some((e) => e.id === u.partner)) u.partner = '';
    const theirShifts = u.partner ? P.regularShifts(st, today, today + 60, ix).filter((r) => r.employeeId === u.partner) : [];
    return `<div class="field"><label>Shift you want covered</label><select name="tDate" data-change="tr-param" data-keep="1">${App.opts(mineShifts.map((x) => ({ id: P.fmtDate(x.d), name: `${P.shortDate(x.d)} ${x.tpl.code} ${P.mil(x.reg.start)}–${P.mil(x.reg.end)}` })), u.date)}</select></div>
      <div class="field"><label>Coworker (certified and free for that shift)</label><select name="tPartner" data-change="tr-param" data-keep="1"><option value="">— choose —</option>${App.opts(partners, u.partner, P.empName)}</select>
        ${myShift && !partners.length ? '<div class="small muted">Nobody is free and eligible for that shift.</div>' : ''}</div>
      <div class="field"><label>Payback — you work one of their shifts (optional)</label><select name="tPayback" data-keep="1"><option value="">No payback / settle later</option>${App.opts(theirShifts.map((r) => ({ id: P.fmtDate(r.day), name: `${P.shortDate(r.day)} ${P.mil(r.start)}–${P.mil(r.end)}` })), '')}</select></div>
      <div class="field"><label>Note</label><input name="tNote" style="width:100%"></div>`;
  }
  App.actions['tr-new'] = () => {
    App.ui.trade = { date: '', partner: '' };
    App.modal({ title: 'Propose a trade', body: tradeBody, footer: '<button class="btn" data-action="modal-close">Cancel</button><button class="btn primary" data-action="tr-send">Send to coworker</button>' });
  };
  App.changes['tr-param'] = () => { const f = App.modalForm(); App.ui.trade.date = f.tDate; App.ui.trade.partner = f.tPartner; App.redrawModal(); };
  App.actions['tr-send'] = () => {
    const f = App.modalForm();
    if (!f.tPartner) return App.toast('Choose a coworker', true);
    App.act('proposeTrade', { date: f.tDate, partnerId: f.tPartner, paybackDate: f.tPayback || null, note: f.tNote }).then((r) => { if (r) App.closeModal(); });
  };
  App.actions['tr-respond'] = (el) => App.act('respondTrade', { id: el.dataset.id, accept: el.dataset.ok === '1' });
  App.actions['tr-cancel'] = (el) => App.confirm('Cancel this trade?', () => App.act('cancelTrade', { id: el.dataset.id }), 'Cancel trade');
})();
