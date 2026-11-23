(function () {
  'use strict';
  const { P, esc } = App;

  App.ui.consoles = { day: null };

  /**
   * Console assignment sheet for one scheduling day (e.g. 0700 to 0700), grouped by
   * shift (0700-1900, 1900-0700). Inside a shift, sub-blocks show any change in who
   * sits where or in the minimums. Pins hold a person on one console for their shift
   * on this scheduling day.
   */
  App.views.consoles = {
    render(st, ui) {
      if (ui.consoles.day == null) ui.consoles.day = P.schedulingDayOf(st, P.nowAbs());
      const day = ui.consoles.day;
      const startMin = P.schedulingDayStart(st, day);
      const cov = P.coverage(st, day, day + 1, { keepAssign: true });
      const order = P.positionOrder(st);
      const ix = cov.wi.ix;
      const base = cov.base;
      const hourIdx = (abs) => Math.floor((abs - base) / 60);
      const nowIdx = hourIdx(P.nowAbs());
      const sig = (h) => JSON.stringify([cov.assign[h] || {}, order.map((p) => cov.required[p.id][h])]);
      const pins = {};
      for (const pn of st.pins) if (P.parseDate(pn.date) === day) pins[pn.employeeId] = pn;
      const sdStart = day * P.DAY + startMin, sdEnd = sdStart + P.DAY;

      // Who starts a shift in this scheduling day, and in which shift block.
      const starters = new Map();
      for (const iv of cov.wi.intervals) {
        if (iv.start < sdStart || iv.start >= sdEnd || !P.countable(ix.emp[iv.employeeId])) continue;
        const cur = starters.get(iv.employeeId);
        if (!cur || iv.start < cur.start) starters.set(iv.employeeId, iv);
      }

      const subTable = (h) => {
        const where = cov.assign[h] || {};
        return order.map((p) => {
          const people = Object.entries(where).filter(([, pid]) => pid === p.id).map(([id]) => ix.emp[id]).filter(Boolean)
            .sort((a, c) => P.empName(a).localeCompare(P.empName(c)));
          const req = cov.required[p.id][h];
          if (!req && !people.length) return '';
          const short = Math.max(0, req - people.length);
          return `<tr><td><b>${esc(p.name)}</b></td><td class="num">${people.length} / ${req}</td>
            <td>${people.map((e) => `<span class="badge" title="${esc((P.empClass(st, e) || {}).name || '')}${e.positionId === p.id ? ' · preferred console' : ''}">${esc(P.empName(e))}${pins[e.id] ? ' 📌' : ''}</span>`).join(' ')}
            ${short ? ` <span class="badge bad">short ${short}</span>` : ''}</td></tr>`;
        }).join('');
      };

      const html = P.shiftBlocks(st, day).map((blk) => {
        const h0 = hourIdx(blk.start), h1 = hourIdx(blk.end);
        // Sub-blocks: consecutive hours with the same placement and minimums.
        const subs = [];
        for (let h = h0; h < h1; h++) {
          const last = subs[subs.length - 1];
          if (last && last.sig === sig(h)) last.end = h + 1;
          else subs.push({ start: h, end: h + 1, sig: sig(h) });
        }
        const isNow = nowIdx >= h0 && nowIdx < h1;
        const label = (a, b) => `${P.mil(base + a * 60)}–${P.mil(base + b * 60)}`;
        const subHtml = subs.map((sb) => `<div class="sub-block">${subs.length > 1 ? `<h3>${label(sb.start, sb.end)}${nowIdx >= sb.start && nowIdx < sb.end ? ' <span class="badge info">now</span>' : ''}</h3>` : ''}
          <div class="table-wrap"><table><thead><tr><th style="width:180px">Console</th><th class="num" style="width:90px">On / min</th><th>Assigned</th></tr></thead><tbody>${subTable(sb.start)}</tbody></table></div></div>`).join('');
        // Pin controls for people whose shift starts in this block.
        const pinList = [...starters.values()].filter((iv) => iv.start >= blk.start && iv.start < blk.end);
        const pinRows = pinList
          .sort((a, b) => a.start - b.start || P.empName(ix.emp[a.employeeId]).localeCompare(P.empName(ix.emp[b.employeeId]))).map((iv) => {
            const e = ix.emp[iv.employeeId];
            const quals = st.positions.filter((p) => P.qualifiedFor(e, p.id));
            return `<tr><td>${esc(P.empName(e))}</td><td class="small">${P.mil(iv.start)}${iv.kind === 'ot' ? ' <span class="badge ok">OT</span>' : ''}</td><td>${esc((P.empClass(st, e) || {}).name || '')}</td>
              <td class="small">${quals.map((p) => esc(p.name)).join(', ')}</td>
              <td>${App.isSup() ? `<select data-change="pin" data-emp="${e.id}"><option value="">Auto</option>${App.opts(quals, pins[e.id] ? pins[e.id].positionId : '')}</select>` : esc(pins[e.id] ? App.posName(pins[e.id].positionId) : 'Auto')}</td></tr>`;
          }).join('');
        return `<div class="panel shift-block">
          <h2>${label(h0, h1)} shift ${isNow ? '<span class="badge info">now</span>' : ''} ${subs.length > 1 ? `<span class="small muted">${subs.length} changes during the shift</span>` : ''}</h2>
          ${subHtml}
          ${pinRows ? `<details class="pins"><summary>Pin to a console · ${pinList.length} ${pinList.length === 1 ? 'person starts' : 'people start'} this shift${pinList.some((iv) => pins[iv.employeeId]) ? ` · ${pinList.filter((iv) => pins[iv.employeeId]).length} pinned` : ''}</summary>
            <div class="table-wrap"><table><thead><tr><th>Employee</th><th>Starts</th><th>Job class</th><th>Certified</th><th>Console</th></tr></thead><tbody>${pinRows}</tbody></table></div></details>` : ''}
        </div>`;
      }).join('');

      return `<div class="page-head"><div><h1>Console assignments</h1>
          <p>${P.shortDate(day)} ${P.mil(sdStart)} → ${P.shortDate(day + 1)} ${P.mil(sdEnd)} · people on duty are placed on consoles by certification, filling consoles in priority order (${order.map((p) => esc(p.name)).join(' → ')}).</p></div>
        <div class="toolbar"><button class="btn" data-action="con-move" data-dir="-1">◀</button><button class="btn" data-action="con-today">Today</button><button class="btn" data-action="con-move" data-dir="1">▶</button>
        <input type="date" value="${P.fmtDate(day)}" data-change="con-date"><button class="btn" data-action="print" title="Print or save as PDF">Print</button></div></div>
        ${st.center.coverageMode === 'home' ? '<div class="callout warn">Coverage is set to count each person at their preferred console only (Settings). Switch to console assignment to use certifications.</div>' : ''}
        <div class="grid">${html}</div>
        <p class="small muted">The scheduling day runs ${P.mil(sdStart)} to ${P.mil(sdEnd)} (Settings → Console coverage). Pinning holds a person on one console for their shift on this scheduling day; "Auto" lets the scheduler place them.</p>`;
    },
  };
  App.actions['con-move'] = (el) => { App.ui.consoles.day += +el.dataset.dir; App.render(); };
  App.actions['con-today'] = () => { App.ui.consoles.day = P.schedulingDayOf(App.S, P.nowAbs()); App.render(); };
  App.changes['con-date'] = (el) => { if (el.value) { App.ui.consoles.day = P.parseDate(el.value); App.render(); } };
  App.changes['pin'] = (el) => {
    const date = P.fmtDate(App.ui.consoles.day);
    App.commit((s) => {
      s.pins = s.pins.filter((p) => !(p.employeeId === el.dataset.emp && p.date === date));
      if (el.value) s.pins.push({ id: P.uid('pin'), date, employeeId: el.dataset.emp, positionId: el.value });
    }, el.value ? 'Pinned for this shift' : 'Back to auto');
  };
})();
