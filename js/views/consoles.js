(function () {
  'use strict';
  const { P, esc } = App;

  App.ui.consoles = { day: null };

  /**
   * Console assignment sheet: who sits on which console, hour block by hour
   * block, from certifications and fill priority. Supervisors can pin a person
   * to one console for their whole shift.
   */
  App.views.consoles = {
    render(st, ui) {
      const today = P.todayNum();
      if (ui.consoles.day == null) ui.consoles.day = today;
      const day = ui.consoles.day;
      const cov = P.coverage(st, day, day, { keepAssign: true });
      const order = P.positionOrder(st);
      const ix = cov.wi.ix;
      // Blocks of consecutive hours with the same placement and requirements.
      const sig = (h) => JSON.stringify([cov.assign[h] || {}, order.map((p) => cov.required[p.id][h])]);
      const blocks = [];
      for (let h = 0; h < 24; h++) {
        const last = blocks[blocks.length - 1];
        if (last && last.sig === sig(h)) last.end = h + 1;
        else blocks.push({ start: h, end: h + 1, sig: sig(h) });
      }
      const pins = {};
      for (const pn of st.pins) if (P.parseDate(pn.date) === day) pins[pn.employeeId] = pn;
      const html = blocks.map((b) => {
        const where = cov.assign[b.start] || {};
        const rows = order.map((p) => {
          const people = Object.entries(where).filter(([, pid]) => pid === p.id).map(([id]) => ix.emp[id]).filter(Boolean)
            .sort((a, c) => P.empName(a).localeCompare(P.empName(c)));
          const req = cov.required[p.id][b.start];
          const short = Math.max(0, req - people.length);
          return `<tr><td><b>${esc(p.name)}</b></td><td class="num">${people.length} / ${req}</td>
            <td>${people.map((e) => `<span class="badge ${e.positionId === p.id ? '' : 'info'}" title="${e.positionId === p.id ? 'Home discipline' : 'Cross-trained (home: ' + esc(App.posName(e.positionId)) + ')'}">${esc(P.empName(e))}${pins[e.id] ? ' 📌' : ''}</span>`).join(' ')}
            ${short ? ` <span class="badge bad">short ${short}</span>` : ''}</td></tr>`;
        }).join('');
        return `<div class="console-block"><h2>${P.pad(b.start)}00 – ${P.pad(b.end % 24)}00</h2><table><thead><tr><th style="width:180px">Console</th><th class="num" style="width:90px">On / min</th><th>Assigned</th></tr></thead><tbody>${rows}</tbody></table></div>`;
      }).join('');
      // People whose shift starts today, for pinning.
      const starters = new Map();
      for (const iv of cov.wi.intervals) if (iv.day === day && P.countable(ix.emp[iv.employeeId])) {
        const cur = starters.get(iv.employeeId);
        if (!cur || iv.start < cur.start) starters.set(iv.employeeId, iv);
      }
      const pinRows = [...starters.values()].sort((a, b) => a.start - b.start || P.empName(ix.emp[a.employeeId]).localeCompare(P.empName(ix.emp[b.employeeId]))).map((iv) => {
        const e = ix.emp[iv.employeeId];
        const quals = st.positions.filter((p) => P.qualifiedFor(e, p.id));
        return `<tr><td>${esc(P.empName(e))}</td><td class="small">${P.mil(iv.start)}${iv.kind === 'ot' ? ' <span class="badge ok">OT</span>' : ''}</td><td>${esc(App.posName(e.positionId))}</td>
          <td class="small">${quals.map((p) => esc(p.name)).join(', ')}</td>
          <td>${App.isSup() ? `<select data-change="pin" data-emp="${e.id}"><option value="">Auto</option>${App.opts(quals, pins[e.id] ? pins[e.id].positionId : '')}</select>` : esc(pins[e.id] ? App.posName(pins[e.id].positionId) : 'Auto')}</td></tr>`;
      }).join('');
      return `<div class="page-head"><div><h1>Console assignments</h1><p>${P.shortDate(day)} · staff are placed on consoles by certification, filling disciplines in priority order (${order.map((p) => esc(p.name)).join(' → ')}).</p></div>
        <div class="toolbar"><button class="btn" data-action="con-move" data-dir="-1">◀</button><button class="btn" data-action="con-today">Today</button><button class="btn" data-action="con-move" data-dir="1">▶</button>
        <input type="date" value="${P.fmtDate(day)}" data-change="con-date"><button class="btn" onclick="window.print()">Print</button></div></div>
        ${st.center.coverageMode === 'home' ? '<div class="callout warn">Coverage is set to count home discipline only (Settings). Switch to console assignment to use cross-training.</div>' : ''}
        <div class="grid g2"><div>${html}</div>
        <div class="panel"><h2>Pin to a console</h2><p class="small muted">"Auto" lets the scheduler place the person. Pinning holds them on one console for their whole shift that starts on this date. Overnight hours before 0700 belong to the previous day's shift.</p>
          <div class="table-wrap"><table><thead><tr><th>Employee</th><th>Starts</th><th>Home</th><th>Certified</th><th>Console</th></tr></thead><tbody>${pinRows || '<tr><td colspan="5" class="empty">Nobody starts a shift this day.</td></tr>'}</tbody></table></div></div></div>`;
    },
  };
  App.actions['con-move'] = (el) => { App.ui.consoles.day += +el.dataset.dir; App.render(); };
  App.actions['con-today'] = () => { App.ui.consoles.day = P.todayNum(); App.render(); };
  App.changes['con-date'] = (el) => { if (el.value) { App.ui.consoles.day = P.parseDate(el.value); App.render(); } };
  App.changes['pin'] = (el) => {
    const date = P.fmtDate(App.ui.consoles.day);
    App.commit((s) => {
      s.pins = s.pins.filter((p) => !(p.employeeId === el.dataset.emp && p.date === date));
      if (el.value) s.pins.push({ id: P.uid('pin'), date, employeeId: el.dataset.emp, positionId: el.value });
    }, el.value ? 'Pinned' : 'Back to auto');
  };
})();
