(function () {
  'use strict';
  const { P, esc, hrs } = App;
  const S = () => App.S;

  App.ui.sched = { start: null, days: 14, pos: 'all' };

  App.views.schedule = {
    render(st, ui) {
      const today = P.todayNum();
      const u = ui.sched;
      if (u.start == null) u.start = P.periodOf(st, today).start;
      const from = u.start, to = from + u.days - 1;
      const ix = P.index(st);
      const regs = P.regularShifts(st, from, to, ix);
      const regBy = {};
      for (const r of regs) (regBy[r.employeeId + '|' + r.day] ||= []).push(r);
      const fillBy = {};
      for (const f of st.fills) if (f.status !== 'cancelled') (fillBy[f.employeeId + '|' + P.parseDate(f.date)] ||= []).push(f);
      const excBy = {};
      for (const e of st.exceptions) {
        if (e.status === 'denied') continue;
        const [a, b] = P.exceptionRange(e);
        for (let d = Math.max(a, from); d <= Math.min(b, to); d++) (excBy[e.employeeId + '|' + d] ||= []).push(e);
      }
      const op = P.openings(st, from, to);
      const shortBy = {};
      for (const s of op.slots) {
        const d = Math.floor(s.start / P.DAY);
        const k = s.positionId + '|' + d;
        shortBy[k] = (shortBy[k] || 0) + s.hours;
      }
      const days = [];
      for (let d = from; d <= to; d++) days.push(d);

      // Group employees by position then by their primary shift.
      const lineOf = (emp) => st.lines.find((l) => l.employeeId === emp.id && P.lineActiveOn(l, Math.max(from, Math.min(to, today))))
        || st.lines.find((l) => l.employeeId === emp.id && P.lineActiveOn(l, from));
      const emps = st.employees.filter((e) => e.status !== 'inactive' && (u.pos === 'all' || e.positionId === u.pos));
      const posOrder = {}; st.positions.forEach((p, i) => { posOrder[p.id] = i; });
      const rows = emps.map((e) => {
        const ln = lineOf(e);
        const tpl = ln ? ix.tpl[ln.shiftTemplateId] : null;
        return { e, ln, tpl, key: tpl ? P.parseTime(tpl.start) : 9999 };
      }).sort((a, b) => posOrder[a.e.positionId] - posOrder[b.e.positionId] || a.key - b.key || String(a.ln ? a.ln.name : 'zz').localeCompare(b.ln ? b.ln.name : 'zz'));

      const head = `<tr><th class="name">Employee / line</th>${days.map((d) => `<th class="${d === today ? 'today' : ''} ${[0, 6].includes(P.dow(d)) ? 'wknd' : ''}">${P.DOW[P.dow(d)]}<br>${P.fmtDate(d).slice(5).replace('-', '/')}</th>`).join('')}</tr>`;
      let body = '', lastPos = null;
      for (const r of rows) {
        if (r.e.positionId !== lastPos) {
          if (lastPos) body += sumRow(lastPos);
          lastPos = r.e.positionId;
          body += `<tr class="group"><td colspan="${days.length + 1}">${esc(App.posName(lastPos))}</td></tr>`;
        }
        const flags = [];
        if (r.e.status === 'trainee') flags.push(`<span class="badge ${r.e.soloCleared ? 'info' : 'warn'}" title="${r.e.soloCleared ? 'Solo cleared' : 'With CTO — not counted'}">T</span>`);
        if (r.e.status === 'leave') flags.push('<span class="badge bad">LOA</span>');
        body += `<tr><td class="name">${esc(P.empName(r.e))} ${flags.join('')}<span class="small muted">${r.ln ? esc(r.ln.name) : 'no line'}</span></td>`;
        for (const d of days) {
          const k = r.e.id + '|' + d;
          body += `<td class="cell ${[0, 6].includes(P.dow(d)) ? 'wknd' : ''}" data-action="day-cell" data-emp="${r.e.id}" data-day="${d}">${cellHtml(regBy[k], excBy[k], fillBy[k], ix)}</td>`;
        }
        body += '</tr>';
      }
      if (lastPos) body += sumRow(lastPos);

      function sumRow(pid) {
        if (!App.isSup()) return '';
        return `<tr class="sum"><td class="name">Uncovered hrs vs minimum</td>${days.map((d) => {
          const v = shortBy[pid + '|' + d] || 0;
          return `<td>${v ? `<a href="#" data-action="cov-day" data-day="${d}" class="badge bad">${hrs(v)}</a>` : '<span class="muted">✓</span>'}</td>`;
        }).join('')}</tr>`;
      }

      return `
      <div class="page-head"><div><h1>Schedule</h1><p>${P.shortDate(from)} – ${P.shortDate(to)} · ${App.isSup() ? 'click any cell to record a call-out, time off, training or OT' : 'click one of your own days to request time off'}</p></div>
        <div class="toolbar">
          <button class="btn" data-action="sched-move" data-dir="-1">◀</button>
          <button class="btn" data-action="sched-today">This period</button>
          <button class="btn" data-action="sched-move" data-dir="1">▶</button>
          <input type="date" value="${P.fmtDate(from)}" data-change="sched-date">
          <select data-change="sched-days">${App.opts([{ id: 7, name: '1 week' }, { id: 14, name: '2 weeks' }, { id: 28, name: '4 weeks' }], u.days)}</select>
          <select data-change="sched-pos"><option value="all">All positions</option>${App.opts(st.positions, u.pos)}</select>
          <button class="btn" onclick="window.print()">Print</button>
        </div></div>
      <div class="panel"><div class="legend" style="margin-bottom:8px">
        ${st.shiftTemplates.map((t) => `<span><span class="shift" style="background:${esc(t.color)}">${esc(t.code)}</span>${esc(t.start.replace(':', ''))} ${t.hours}h</span>`).join('')}
        <span><span class="shift leave">S</span>call-out</span><span><span class="shift leave planned">V</span>planned leave</span>
        <span><span class="shift leave worked">T</span>training / trade</span><span><span class="shift pending" style="background:#64748b">D12</span>pending request</span><span><span class="shift ot">OT</span>overtime</span>
      </div>
      <div class="table-wrap" style="max-height:72vh"><table class="sched"><thead>${head}</thead><tbody>${body || `<tr><td class="empty" colspan="${days.length + 1}">No employees yet — add staff and lines first.</td></tr>`}</tbody></table></div></div>`;
    },
  };

  function cellHtml(regs, excs, fills, ix) {
    let h = '';
    const approved = (excs || []).filter((e) => e.status === 'approved');
    const pending = (excs || []).filter((e) => e.status === 'pending');
    for (const r of regs || []) {
      const tpl = ix.tpl[r.templateId];
      const full = approved.find((e) => !e.start);
      const part = approved.find((e) => e.start);
      const pend = pending.length ? ' pending' : '';
      const title = `${tpl.name} ${P.mil(r.start)}–${P.mil(r.end)}`;
      if (full) {
        const t = App.excType(full.type);
        const cls = t.worked ? 'worked' : (full.type === 'sick' || full.type === 'family' || full.type === 'injury') ? '' : 'planned';
        h += `<span class="shift leave ${cls}" title="${esc(t.label + ' — ' + title)}">${esc(t.abbr)}</span>`;
      } else {
        h += `<span class="shift${part ? ' partial' : ''}${pend}" style="background:${esc(tpl.color)}" title="${esc(title + (part ? ` · ${App.excType(part.type).label} ${part.start} ${part.hours}h` : '') + (pend ? ' · pending request' : ''))}">${esc(tpl.code)}</span>`;
      }
    }
    if (!(regs || []).length && pending.length) h += '<span class="shift pending muted" title="Pending request on a day off">?</span>';
    for (const f of fills || []) h += `<span class="shift ot" title="${esc(App.fillType(f.type))} ${f.start} ${f.hours}h — ${esc(App.posName(f.positionId))}">OT${f.hours !== 12 && f.hours !== 8 ? f.hours : ''}</span>`;
    return h;
  }

  App.actions['sched-move'] = (el) => { App.ui.sched.start += (+el.dataset.dir) * App.ui.sched.days; App.render(); };
  App.actions['sched-today'] = () => { App.ui.sched.start = P.periodOf(S(), P.todayNum()).start; App.render(); };
  App.changes['sched-date'] = (el) => { if (el.value) { App.ui.sched.start = P.parseDate(el.value); App.render(); } };
  App.changes['sched-days'] = (el) => { App.ui.sched.days = +el.value; App.render(); };
  App.changes['sched-pos'] = (el) => { App.ui.sched.pos = el.value; App.render(); };
  App.actions['cov-day'] = (el) => { const d = +el.dataset.day; App.ui.cov = Object.assign(App.ui.cov || {}, { start: d - P.dow(d) }); App.go('coverage'); };
  App.actions['day-cell'] = (el) => {
    if (App.isSup()) return App.openDay(el.dataset.emp, +el.dataset.day);
    if (el.dataset.emp === App.me.employeeId) return App.openRequest(+el.dataset.day);
  };

  // ------------------------------------------------------------ day dialog
  App.openDay = function (empId, day) {
    App.modal({
      title: `${P.empName(App.emp(empId))} — ${P.shortDate(day)}`,
      wide: false,
      body: () => dayBody(empId, day),
      footer: '<button class="btn" data-action="modal-close">Close</button>',
    });
  };

  function dayBody(empId, day) {
    const st = S();
    const emp = App.emp(empId);
    const ix = P.index(st);
    const regs = P.regularShifts(st, day, day, ix).filter((r) => r.employeeId === empId);
    const excs = st.exceptions.filter((e) => { const [a, b] = P.exceptionRange(e); return e.employeeId === empId && a <= day && day <= b; });
    const fills = st.fills.filter((f) => f.employeeId === empId && P.parseDate(f.date) === day && f.status !== 'cancelled');
    const reg = regs[0];
    const statusBadge = (s) => `<span class="badge ${s === 'approved' ? 'ok' : s === 'pending' ? 'warn' : 'bad'}">${s}</span>`;
    return `
      <p>${reg ? `Scheduled <b>${esc(ix.tpl[reg.templateId].name)}</b> ${P.mil(reg.start)}–${P.mil(reg.end)} · line ${esc((ix.line[reg.lineId] || {}).name || '')}` : '<span class="muted">Not scheduled (day off)</span>'}
        · ${esc(App.posName(emp.positionId))}</p>
      ${excs.length || fills.length ? `<table><tbody>
        ${excs.map((e) => `<tr><td>${esc(App.excType(e.type).label)} ${statusBadge(e.status)}<div class="small muted">${e.endDate ? `${e.date} → ${e.endDate}` : e.date}${e.start ? ` · ${e.start} for ${e.hours}h` : ' · full shift'}${e.note ? ' · ' + esc(e.note) : ''}</div></td>
          <td class="nowrap" style="text-align:right">${e.status === 'pending' ? `<button class="btn sm" data-action="exc-status" data-id="${e.id}" data-status="approved">Approve</button> <button class="btn sm" data-action="exc-status" data-id="${e.id}" data-status="denied">Deny</button> ` : ''}<button class="btn sm danger" data-action="exc-del" data-id="${e.id}">Remove</button></td></tr>`).join('')}
        ${fills.map((f) => `<tr><td><span class="badge ok">OT</span> ${esc(App.fillType(f.type))} · ${esc(App.posName(f.positionId))}<div class="small muted">${f.start} for ${f.hours}h · reason: ${esc(App.reasonLabel(f.reason))}</div></td>
          <td style="text-align:right"><button class="btn sm danger" data-action="fill-del" data-id="${f.id}">Remove</button></td></tr>`).join('')}
      </tbody></table>` : ''}
      <div class="section"><h3>Leave / call-out / training</h3>
        <div class="form-grid">
          <div class="field"><label>Type</label><select name="type">${App.opts(P.EXCEPTION_TYPES.filter((t) => !t.system), reg && day === P.todayNum() ? 'sick' : 'vacation', (t) => t.label)}</select></div>
          <div class="field"><label>Status</label><select name="status"><option value="approved">Approved</option><option value="pending">Pending request</option></select></div>
          <div class="field"><label>Through date (multi-day)</label><input type="date" name="endDate" min="${P.fmtDate(day)}"></div>
        </div>
        <div class="form-grid">
          <div class="field"><label class="check"><input type="checkbox" name="partial"> Partial shift only</label></div>
          <div class="field"><label>Start</label><input type="time" name="start" value="${reg ? P.timeStr(reg.start) : '08:00'}"></div>
          <div class="field"><label>Hours</label><input type="number" step="0.25" min="0.25" name="hours" value="4"></div>
        </div>
        <div class="field"><label>Note</label><input name="note" placeholder="optional"></div>
        <button class="btn primary" data-action="exc-add" data-emp="${empId}" data-day="${day}">Add</button>
        ${reg ? '' : '<span class="small muted"> Full-shift leave only applies to days the employee is scheduled.</span>'}
      </div>
      <div class="section"><h3>Overtime / extra shift</h3>
        <div class="form-grid">
          <div class="field"><label>Start</label><input type="time" name="otStart" value="${reg ? P.timeStr(reg.end) : '06:00'}"></div>
          <div class="field"><label>Hours</label><input type="number" step="0.25" min="0.25" name="otHours" value="${reg ? 4 : 12}"></div>
          <div class="field"><label>Covering position</label><select name="otPos">${App.opts(st.positions.filter((p) => P.qualifiedFor(emp, p.id)), emp.positionId)}</select></div>
          <div class="field"><label>Type</label><select name="otType">${App.opts(P.FILL_TYPES, reg ? 'holdover' : 'voluntary', (t) => t.label)}</select></div>
          <div class="field"><label>Reason</label><select name="otReason"><option value="vacancy">Vacancy / structural</option>${App.opts(P.EXCEPTION_TYPES, '', (t) => t.label)}<option value="event">Special event / weather</option></select></div>
        </div>
        <button class="btn primary" data-action="ot-add" data-emp="${empId}" data-day="${day}">Add OT</button>
      </div>`;
  }

  App.actions['exc-add'] = (el) => {
    const f = App.modalForm();
    const day = +el.dataset.day;
    const exc = {
      id: P.uid('ex'), employeeId: el.dataset.emp, date: P.fmtDate(day), endDate: f.endDate && P.parseDate(f.endDate) > day ? f.endDate : null,
      start: f.partial ? f.start : null, hours: f.partial ? +f.hours : null, type: f.type, status: f.status, note: f.note, createdAt: new Date().toISOString(),
    };
    App.commit((s) => s.exceptions.push(exc), `${App.excType(exc.type).label} ${exc.status === 'pending' ? 'request added' : 'recorded'}`);
    if (exc.status === 'approved') {
      const emp = App.emp(exc.employeeId);
      const [a, b] = P.exceptionRange(exc);
      const slots = P.openings(S(), a, b + 1).slots.filter((x) => x.positionId === emp.positionId && x.causes.some((c) => c.exceptionId === exc.id) && x.end > P.nowAbs());
      if (slots.length) {
        App.toast(`Creates ${slots.length} opening(s) below minimum`, true);
        App.openFill(slots[0]);
        return;
      }
    }
    App.redrawModal();
  };
  App.actions['ot-add'] = (el) => {
    const f = App.modalForm();
    App.act('assignFill', { fill: { date: P.fmtDate(+el.dataset.day), start: f.otStart, hours: +f.otHours, positionId: f.otPos, employeeId: el.dataset.emp, type: f.otType, reason: f.otReason || 'vacancy', exceptionId: null } });
  };
  App.actions['exc-status'] = (el) => App.act('decideLeave', { id: el.dataset.id, status: el.dataset.status });
  App.actions['exc-del'] = (el) => App.commit((s) => { s.exceptions = s.exceptions.filter((x) => x.id !== el.dataset.id); }, 'Removed');
  App.actions['fill-del'] = (el) => App.commit((s) => { s.fills = s.fills.filter((x) => x.id !== el.dataset.id); }, 'OT removed');
})();
