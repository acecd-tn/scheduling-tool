/*
 * PSAP Scheduler — workflow actions.
 *
 * Every self-service and approval workflow goes through here: time-off
 * requests, shift trades, posted OT openings, shift-bid and vacation-bid picks.
 * The server runs these (so an employee can never write directly to the
 * schedule); in single-computer mode the browser runs the same code.
 *
 * Each action: (state, actor, payload, ctx) -> { message }  — mutates state,
 * throws ActionError on a rule violation. actor = { userId, role, employeeId }.
 */
(function (global) {
  'use strict';
  const P = global.PSAP || (typeof require !== 'undefined' ? require('./core.js') : null);

  class ActionError extends Error {}
  const fail = (msg) => { throw new ActionError(msg); };
  const isSup = (a) => a && (a.role === 'admin' || a.role === 'supervisor');
  const needSup = (a) => { if (!isSup(a)) fail('Supervisor access required'); };
  const nowIso = (ctx) => (ctx && ctx.now) || new Date().toISOString();
  const today = (ctx) => (ctx && ctx.today != null ? ctx.today : P.todayNum());
  const find = (arr, id, what) => arr.find((x) => x.id === id) || fail(`${what} not found`);
  const empOf = (state, id) => state.employees.find((e) => e.id === id);
  const name = (state, id) => P.empName(empOf(state, id));

  /** Target employee: employees act only for themselves; supervisors may act for anyone. */
  function subject(actor, payload) {
    if (isSup(actor) && payload.employeeId) return payload.employeeId;
    if (!actor.employeeId) fail('Your login is not linked to an employee record');
    return actor.employeeId;
  }

  function notify(state, to, title, body, ctx, link) {
    const base = { title, body, link: link || '', at: nowIso(ctx), read: false, delivered: false };
    const list = Array.isArray(to) ? to : [to];
    for (const r of list) {
      if (!r) continue;
      if (r === 'supervisors') state.notifications.push(Object.assign({ id: P.uid('nt'), role: 'supervisor', employeeId: null, readBy: [] }, base));
      else state.notifications.push(Object.assign({ id: P.uid('nt'), role: null, employeeId: r }, base));
    }
  }

  function shiftOn(state, empId, day) {
    return P.regularShifts(state, day, day).find((r) => r.employeeId === empId) || null;
  }
  function hasLeaveOn(state, empId, day) {
    return state.exceptions.some((e) => {
      if (e.employeeId !== empId || e.status !== 'approved') return false;
      const [a, b] = P.exceptionRange(e);
      return a <= day && day <= b && !e.start;
    });
  }
  const fmtShift = (st, r) => `${P.shortDate(r.day)} ${P.mil(r.start)}–${P.mil(r.end)}`;

  /** Can `empId` legally work [start,end) for positionId? Returns list of problems. */
  function workProblems(state, empId, positionId, start, end) {
    const emp = empOf(state, empId);
    if (!emp) return ['Unknown employee'];
    const c = P.fillCandidates(state, { positionId, start, end }).find((x) => x.emp.id === empId);
    if (!c) return [P.countable(emp) ? 'Not certified for that position' : 'Not cleared to work solo'];
    return c.issues;
  }

  // ----------------------------------------------------------- time off
  function requestLeave(state, actor, p, ctx) {
    const empId = subject(actor, p);
    const type = P.EXCEPTION_TYPES.find((t) => t.id === p.type);
    if (!type || type.system) fail('Choose a leave type');
    if (!p.date) fail('Date is required');
    const d0 = P.parseDate(p.date);
    if (!isSup(actor) && d0 < today(ctx)) fail('Requests must be for today or later — contact a supervisor for past dates');
    if (p.endDate && P.parseDate(p.endDate) < d0) fail('End date is before start date');
    const partial = !!p.start;
    if (partial && !(+p.hours > 0)) fail('Hours are required for a partial shift');
    const status = isSup(actor) && p.status === 'approved' ? 'approved' : 'pending';
    const exc = {
      id: P.uid('ex'), employeeId: empId, date: p.date, endDate: p.endDate && p.endDate !== p.date ? p.endDate : null,
      start: partial ? p.start : null, hours: partial ? +p.hours : null, type: type.id, status,
      note: String(p.note || '').slice(0, 500), createdAt: nowIso(ctx), requestedBy: actor.userId || null,
    };
    state.exceptions.push(exc);
    if (status === 'pending') notify(state, 'supervisors', 'Time-off request', `${name(state, empId)}: ${type.label}, ${p.date}${exc.endDate ? ' → ' + exc.endDate : ''}`, ctx, 'openings');
    return { message: status === 'pending' ? 'Request submitted' : 'Leave recorded', id: exc.id };
  }

  function cancelRequest(state, actor, p) {
    const e = find(state.exceptions, p.id, 'Request');
    if (!isSup(actor)) {
      if (e.employeeId !== actor.employeeId) fail('Not your request');
      if (e.status !== 'pending') fail('Only pending requests can be withdrawn — ask a supervisor to cancel approved leave');
    }
    state.exceptions = state.exceptions.filter((x) => x.id !== e.id);
    return { message: 'Request withdrawn' };
  }

  function decideLeave(state, actor, p, ctx) {
    needSup(actor);
    const e = find(state.exceptions, p.id, 'Request');
    if (!['approved', 'denied'].includes(p.status)) fail('Bad status');
    e.status = p.status;
    e.decidedAt = nowIso(ctx);
    e.decidedBy = actor.userId || null;
    if (p.note) e.decisionNote = String(p.note).slice(0, 500);
    const t = P.EXCEPTION_TYPES.find((x) => x.id === e.type) || { label: e.type };
    notify(state, e.employeeId, `Request ${p.status}`, `${t.label} ${e.date}${e.endDate ? ' → ' + e.endDate : ''} was ${p.status}.${p.note ? ' ' + p.note : ''}`, ctx, 'me');
    return { message: `Request ${p.status}` };
  }

  // ------------------------------------------------------------- trades
  /**
   * A trade has one or two legs: the requester's shift worked by the partner,
   * and optionally a payback shift of the partner's worked by the requester.
   */
  function tradeLegs(state, t) {
    const legs = [];
    const mk = (fromId, toId, dateStr) => {
      const day = P.parseDate(dateStr);
      const r = shiftOn(state, fromId, day);
      if (!r) fail(`${name(state, fromId)} is not scheduled on ${dateStr}`);
      if (hasLeaveOn(state, fromId, day)) fail(`${name(state, fromId)} already has leave or a trade on ${dateStr}`);
      return { fromId, toId, date: dateStr, start: P.timeStr(r.start), hours: (r.end - r.start) / 60, positionId: r.positionId, abs: [r.start, r.end] };
    };
    legs.push(mk(t.requesterId, t.partnerId, t.date));
    if (t.paybackDate) legs.push(mk(t.partnerId, t.requesterId, t.paybackDate));
    return legs;
  }
  function checkLegs(state, legs) {
    for (const l of legs) {
      const probs = workProblems(state, l.toId, l.positionId, l.abs[0], l.abs[1]);
      if (probs.length) fail(`${name(state, l.toId)} can't work ${l.date} ${l.start}: ${probs.join(', ')}`);
    }
  }

  function proposeTrade(state, actor, p, ctx) {
    const me = subject(actor, p);
    if (!p.partnerId || p.partnerId === me) fail('Choose who you are trading with');
    if (!p.date) fail('Choose the shift you want covered');
    if (P.parseDate(p.date) < today(ctx)) fail('That shift is in the past');
    const t = { id: P.uid('tr'), requesterId: me, partnerId: p.partnerId, date: p.date, paybackDate: p.paybackDate || null, note: String(p.note || '').slice(0, 300), status: 'proposed', createdAt: nowIso(ctx) };
    const legs = tradeLegs(state, t);
    checkLegs(state, legs);
    t.legs = legs.map(({ abs, ...l }) => l);
    state.trades.push(t);
    notify(state, t.partnerId, 'Shift trade request', `${name(state, me)} asks you to work ${t.legs[0].date} ${t.legs[0].start} (${t.legs[0].hours}h)${t.paybackDate ? `; they'd work your ${t.paybackDate} shift` : ''}.`, ctx, 'trades');
    return { message: 'Trade sent to ' + name(state, t.partnerId), id: t.id };
  }

  function applyTrade(state, t, actor, ctx) {
    const legs = tradeLegs(state, t);
    checkLegs(state, legs);
    t.records = [];
    for (const l of legs) {
      const ex = { id: P.uid('ex'), employeeId: l.fromId, date: l.date, endDate: null, start: null, hours: null, type: 'trade', status: 'approved', note: `Trade with ${name(state, l.toId)}`, tradeId: t.id, createdAt: nowIso(ctx) };
      const f = { id: P.uid('ot'), date: l.date, start: l.start, hours: l.hours, positionId: l.positionId, employeeId: l.toId, type: 'trade', reason: 'trade', exceptionId: ex.id, tradeId: t.id, status: 'scheduled', note: `Trade for ${name(state, l.fromId)}`, createdAt: nowIso(ctx) };
      state.exceptions.push(ex);
      state.fills.push(f);
      t.records.push(ex.id, f.id);
    }
    t.status = 'approved';
    t.approvedAt = nowIso(ctx);
    t.approvedBy = actor.userId || null;
    notify(state, [t.requesterId, t.partnerId], 'Trade approved', `${name(state, t.requesterId)} ⇄ ${name(state, t.partnerId)}: ${t.date}${t.paybackDate ? ' / ' + t.paybackDate : ''} is on the schedule.`, ctx, 'trades');
  }

  function respondTrade(state, actor, p, ctx) {
    const t = find(state.trades, p.id, 'Trade');
    if (!isSup(actor) && t.partnerId !== actor.employeeId) fail('This trade was not sent to you');
    if (t.status !== 'proposed') fail('This trade is no longer waiting on you');
    if (!p.accept) {
      t.status = 'declined';
      notify(state, t.requesterId, 'Trade declined', `${name(state, t.partnerId)} declined your ${t.date} trade.`, ctx, 'trades');
      return { message: 'Trade declined' };
    }
    checkLegs(state, tradeLegs(state, t));
    t.status = 'accepted';
    t.acceptedAt = nowIso(ctx);
    if (state.center.tradeRequiresApproval === false) { applyTrade(state, t, actor, ctx); return { message: 'Trade accepted and scheduled' }; }
    notify(state, t.requesterId, 'Trade accepted', `${name(state, t.partnerId)} accepted. Waiting on supervisor approval.`, ctx, 'trades');
    notify(state, 'supervisors', 'Trade awaiting approval', `${name(state, t.requesterId)} ⇄ ${name(state, t.partnerId)}, ${t.date}${t.paybackDate ? ' / ' + t.paybackDate : ''}`, ctx, 'openings');
    return { message: 'Trade accepted — sent for supervisor approval' };
  }

  function decideTrade(state, actor, p, ctx) {
    needSup(actor);
    const t = find(state.trades, p.id, 'Trade');
    if (t.status !== 'accepted') fail('Only accepted trades can be approved');
    if (p.approve) { applyTrade(state, t, actor, ctx); return { message: 'Trade approved' }; }
    t.status = 'denied';
    t.decisionNote = String(p.note || '');
    notify(state, [t.requesterId, t.partnerId], 'Trade denied', `${t.date} trade was denied.${p.note ? ' ' + p.note : ''}`, ctx, 'trades');
    return { message: 'Trade denied' };
  }

  function cancelTrade(state, actor, p, ctx) {
    const t = find(state.trades, p.id, 'Trade');
    const mine = t.requesterId === actor.employeeId || t.partnerId === actor.employeeId;
    if (!isSup(actor)) {
      if (!mine) fail('Not your trade');
      if (t.status === 'approved') fail('Approved trades can only be cancelled by a supervisor');
    }
    if (t.status === 'approved' && t.records) {
      const ids = new Set(t.records);
      state.exceptions = state.exceptions.filter((x) => !ids.has(x.id));
      state.fills = state.fills.filter((x) => !ids.has(x.id));
    }
    t.status = 'cancelled';
    notify(state, [t.requesterId, t.partnerId].filter((x) => x !== actor.employeeId), 'Trade cancelled', `The ${t.date} trade was cancelled.`, ctx, 'trades');
    return { message: 'Trade cancelled' };
  }

  // ------------------------------------------------------- OT postings
  function postingSlot(po) {
    const start = P.parseDate(po.date) * P.DAY + P.parseTime(po.start);
    return { positionId: po.positionId, start, end: start + Math.round(+po.hours * 60) };
  }

  function postOpening(state, actor, p, ctx) {
    needSup(actor);
    if (!p.positionId || !p.date || !p.start || !(+p.hours > 0)) fail('Position, date, start and hours are required');
    const po = {
      id: P.uid('po'), positionId: p.positionId, date: p.date, start: p.start, hours: +p.hours,
      mode: p.mode === 'first' ? 'first' : 'list', reason: p.reason || 'vacancy', exceptionId: p.exceptionId || null,
      note: String(p.note || '').slice(0, 300), status: 'open', volunteers: [], postedBy: actor.userId || null, postedAt: nowIso(ctx),
    };
    state.postings.push(po);
    const slot = postingSlot(po);
    const eligible = P.fillCandidates(state, slot).filter((c) => c.eligible).map((c) => c.emp.id);
    const pos = state.positions.find((x) => x.id === po.positionId) || { name: '' };
    notify(state, eligible, 'Overtime available', `${pos.name} ${P.shortDate(P.parseDate(po.date))} ${po.start.replace(':', '')} for ${po.hours}h — ${po.mode === 'first' ? 'first eligible volunteer gets it' : 'awarded by OT list'}.`, ctx, 'open');
    return { message: `Posted — ${eligible.length} eligible employee(s) notified`, id: po.id };
  }

  function award(state, po, empId, actor, ctx, type) {
    const slot = postingSlot(po);
    const c = P.fillCandidates(state, slot).find((x) => x.emp.id === empId);
    const f = {
      id: P.uid('ot'), date: po.date, start: po.start, hours: po.hours, positionId: po.positionId, employeeId: empId,
      type: type || (c && c.holdover ? 'holdover' : c && c.earlyIn ? 'earlyin' : 'voluntary'),
      reason: po.reason, exceptionId: po.exceptionId, postingId: po.id, status: 'scheduled', note: '', createdAt: nowIso(ctx),
    };
    state.fills.push(f);
    po.status = 'awarded';
    po.awardedTo = empId;
    po.awardedAt = nowIso(ctx);
    po.fillId = f.id;
    notify(state, empId, 'Overtime awarded to you', `${P.shortDate(P.parseDate(po.date))} ${po.start.replace(':', '')} for ${po.hours}h is on your schedule.`, ctx, 'me');
    const others = (po.volunteers || []).map((v) => v.employeeId).filter((x) => x !== empId);
    notify(state, others, 'Overtime filled', `${P.shortDate(P.parseDate(po.date))} ${po.start.replace(':', '')} was awarded to someone else.`, ctx, 'open');
    return f;
  }

  function volunteer(state, actor, p, ctx) {
    const me = subject(actor, p);
    const po = find(state.postings, p.id, 'Posting');
    if (po.status !== 'open') fail('This opening is no longer available');
    if ((po.volunteers || []).some((v) => v.employeeId === me)) fail('You already signed up');
    const slot = postingSlot(po);
    const probs = workProblems(state, me, po.positionId, slot.start, slot.end);
    if (probs.length) fail(`You can't take this shift: ${probs.join(', ')}`);
    (po.volunteers ||= []).push({ employeeId: me, at: nowIso(ctx) });
    if (po.mode === 'first') { award(state, po, me, actor, ctx); return { message: 'It\'s yours — added to your schedule' }; }
    return { message: 'Signed up — a supervisor will award it by the OT list' };
  }

  function withdraw(state, actor, p) {
    const me = subject(actor, p);
    const po = find(state.postings, p.id, 'Posting');
    if (po.status !== 'open') fail('Already closed');
    po.volunteers = (po.volunteers || []).filter((v) => v.employeeId !== me);
    return { message: 'Removed from sign-up' };
  }

  function awardPosting(state, actor, p, ctx) {
    needSup(actor);
    const po = find(state.postings, p.id, 'Posting');
    if (po.status !== 'open') fail('Already closed');
    award(state, po, p.employeeId, actor, ctx, p.type);
    return { message: `Awarded to ${name(state, p.employeeId)}` };
  }

  function cancelPosting(state, actor, p, ctx) {
    needSup(actor);
    const po = find(state.postings, p.id, 'Posting');
    po.status = 'cancelled';
    notify(state, (po.volunteers || []).map((v) => v.employeeId), 'Overtime posting cancelled', `${P.shortDate(P.parseDate(po.date))} ${po.start.replace(':', '')} is no longer needed.`, ctx, 'open');
    return { message: 'Posting cancelled' };
  }

  /** Supervisor assigns OT directly (fill dialog). */
  function assignFill(state, actor, p, ctx) {
    needSup(actor);
    const f = Object.assign({ id: P.uid('ot'), status: 'scheduled', note: '', createdAt: nowIso(ctx) }, p.fill);
    if (!f.employeeId || !f.date || !f.start || !(+f.hours > 0)) fail('Incomplete assignment');
    state.fills.push(f);
    const kind = f.type === 'mandatory' ? 'Mandatory overtime' : 'Overtime';
    notify(state, f.employeeId, `${kind} assigned`, `${P.shortDate(P.parseDate(f.date))} ${f.start.replace(':', '')} for ${f.hours}h.`, ctx, 'me');
    return { message: `${name(state, f.employeeId)} assigned`, id: f.id };
  }

  function markRead(state, actor, p) {
    for (const n of state.notifications) {
      if (p.ids && !p.ids.includes(n.id)) continue;
      if (n.employeeId && n.employeeId === actor.employeeId) n.read = true;
      else if (n.role === 'supervisor' && isSup(actor)) { n.readBy ||= []; if (!n.readBy.includes(actor.userId || 'local')) n.readBy.push(actor.userId || 'local'); }
    }
    return { message: '' };
  }

  // ---------------------------------------------------------- shift bid
  function shiftBidPick(state, actor, p, ctx) {
    const bid = find(state.bids, p.bidId, 'Bid');
    if (bid.status !== 'open') fail('Bidding is not open');
    const cur = P.currentBidder(state, bid);
    if (!cur) fail('Everyone has picked');
    if (!isSup(actor) && cur.id !== actor.employeeId) fail('It is not your turn yet');
    if (!bid.lines.some((l) => l.id === p.lineId)) fail('Unknown line');
    if (Object.values(bid.picks || {}).includes(p.lineId)) fail('That line is taken');
    (bid.picks ||= {})[cur.id] = p.lineId;
    (bid.log ||= []).push({ at: nowIso(ctx), employeeId: cur.id, lineId: p.lineId, by: actor.userId || null });
    const next = P.currentBidder(state, bid);
    if (next) notify(state, next.id, 'Your turn to bid', `${bid.name}: it's your turn to pick a line.`, ctx, 'bid');
    else notify(state, 'supervisors', 'Shift bid complete', `${bid.name}: every bidder has picked.`, ctx, 'bid');
    return { message: 'Line picked' };
  }

  // ------------------------------------------------------- vacation bid
  function vacOrder(state, vb) {
    const sen = (e) => P.parseDate(e.seniorityDate || e.hireDate || '2000-01-01');
    let list = state.employees.filter((e) => e.status !== 'inactive' && (!vb.positionIds || !vb.positionIds.length || vb.positionIds.includes(e.positionId)));
    list.sort((a, b) => sen(a) - sen(b) || String(a.lastName).localeCompare(b.lastName));
    if (Array.isArray(vb.order) && vb.order.length) {
      const pos = {}; vb.order.forEach((id, i) => { pos[id] = i; });
      list.sort((a, b) => (pos[a.id] ?? 1e9) - (pos[b.id] ?? 1e9));
    }
    return list;
  }
  /** Whose turn it is: rounds in seniority order; one pick or pass per person per round. */
  function vacTurn(state, vb) {
    if (vb.status !== 'open') return null;
    const order = vacOrder(state, vb);
    for (let r = 1; r <= (+vb.rounds || 1); r++) {
      for (const e of order) if (!(vb.picks || []).some((x) => x.employeeId === e.id && x.round === r)) return { round: r, employee: e };
    }
    return null;
  }
  /** Days in [from,to] where a discipline is already at its cap. */
  function vacConflicts(state, vb, empId, from, to) {
    const emp = empOf(state, empId);
    const cap = vb.caps && vb.caps[emp.positionId] != null && vb.caps[emp.positionId] !== '' ? +vb.caps[emp.positionId] : Infinity;
    const full = [];
    for (let d = from; d <= to; d++) {
      const who = P.plannedLeaveOn(state, d, emp.positionId);
      who.delete(empId);
      if (who.size >= cap) full.push(P.fmtDate(d));
    }
    return full;
  }
  function vacPick(state, actor, p, ctx) {
    const vb = find(state.vacationBids, p.bidId, 'Vacation bid');
    const turn = vacTurn(state, vb);
    if (!turn) fail('The vacation bid is not open');
    if (!isSup(actor) && turn.employee.id !== actor.employeeId) fail('It is not your turn yet');
    const empId = turn.employee.id;
    const from = P.parseDate(p.from), to = P.parseDate(p.to || p.from);
    if (to < from) fail('End date is before start date');
    if (from < P.parseDate(vb.from) || to > P.parseDate(vb.to)) fail(`Picks must be between ${vb.from} and ${vb.to}`);
    if (vb.maxDaysPerPick && to - from + 1 > +vb.maxDaysPerPick) fail(`At most ${vb.maxDaysPerPick} calendar days per pick`);
    const full = vacConflicts(state, vb, empId, from, to);
    if (full.length) fail(`Already at the limit for your discipline on ${full.join(', ')}`);
    const scheduled = P.regularShifts(state, from, to).filter((r) => r.employeeId === empId).length;
    if (!scheduled) fail('You are not scheduled on any of those days');
    const ex = { id: P.uid('ex'), employeeId: empId, date: P.fmtDate(from), endDate: to > from ? P.fmtDate(to) : null, start: null, hours: null, type: 'vacation', status: 'approved', note: `${vb.name} — round ${turn.round}`, vacationBidId: vb.id, createdAt: nowIso(ctx) };
    state.exceptions.push(ex);
    (vb.picks ||= []).push({ employeeId: empId, round: turn.round, from: ex.date, to: P.fmtDate(to), exceptionId: ex.id, at: nowIso(ctx), by: actor.userId || null });
    advanceVac(state, vb, ctx);
    return { message: `Vacation ${ex.date}${ex.endDate ? ' → ' + ex.endDate : ''} approved` };
  }
  function vacPass(state, actor, p, ctx) {
    const vb = find(state.vacationBids, p.bidId, 'Vacation bid');
    const turn = vacTurn(state, vb);
    if (!turn) fail('The vacation bid is not open');
    if (!isSup(actor) && turn.employee.id !== actor.employeeId) fail('It is not your turn yet');
    (vb.picks ||= []).push({ employeeId: turn.employee.id, round: turn.round, passed: true, at: nowIso(ctx), by: actor.userId || null });
    advanceVac(state, vb, ctx);
    return { message: 'Passed this round' };
  }
  function vacUndo(state, actor, p) {
    needSup(actor);
    const vb = find(state.vacationBids, p.bidId, 'Vacation bid');
    const last = (vb.picks || []).pop();
    if (last && last.exceptionId) state.exceptions = state.exceptions.filter((x) => x.id !== last.exceptionId);
    return { message: last ? 'Last pick undone' : 'Nothing to undo' };
  }
  function advanceVac(state, vb, ctx) {
    const next = vacTurn(state, vb);
    if (next) notify(state, next.employee.id, 'Your turn: vacation bid', `${vb.name}, round ${next.round}: it's your turn to pick.`, ctx, 'vacation');
    else { vb.status = 'closed'; notify(state, 'supervisors', 'Vacation bid complete', `${vb.name} is complete.`, ctx, 'vacation'); }
  }
  function vacOpen(state, actor, p, ctx) {
    needSup(actor);
    const vb = find(state.vacationBids, p.bidId, 'Vacation bid');
    vb.status = 'open';
    const t = vacTurn(state, vb);
    notify(state, vacOrder(state, vb).map((e) => e.id), 'Vacation bid is open', `${vb.name}: ${vb.from} → ${vb.to}, ${vb.rounds} round(s). You'll be notified when it's your turn.`, ctx, 'vacation');
    if (t) notify(state, t.employee.id, 'Your turn: vacation bid', `${vb.name}, round ${t.round}: it's your turn to pick.`, ctx, 'vacation');
    return { message: 'Vacation bid opened' };
  }

  const ACTIONS = {
    requestLeave, cancelRequest, decideLeave,
    proposeTrade, respondTrade, decideTrade, cancelTrade,
    postOpening, volunteer, withdraw, awardPosting, cancelPosting, assignFill, markRead,
    shiftBidPick, vacPick, vacPass, vacUndo, vacOpen,
  };

  function run(state, actor, name, payload, ctx) {
    const fn = ACTIONS[name];
    if (!fn) throw new ActionError('Unknown action: ' + name);
    return fn(state, actor, payload || {}, ctx || {}) || {};
  }

  const api = { ActionError, ACTIONS, run, isSup, vacOrder, vacTurn, vacConflicts, notify, postingSlot };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.PSAPActions = api;
})(typeof window !== 'undefined' ? window : globalThis);
