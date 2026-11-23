(function () {
  'use strict';
  const { P, esc } = App;

  App.ui.cov = { start: null };

  App.views.coverage = {
    render(st, ui) {
      const today = P.todayNum();
      const u = ui.cov;
      if (u.start == null) u.start = today - P.dow(today);
      const from = u.start, to = from + 6;
      const op = P.openings(st, from, to);
      const cov = op.cov;
      const nowIdx = Math.floor((P.nowAbs() - cov.base) / 60);
      const days = [0, 1, 2, 3, 4, 5, 6].map((i) => from + i);
      const tables = st.positions.map((p) => {
        let shortHrs = 0;
        const rows = [];
        for (let h = 0; h < 24; h++) {
          rows.push(`<tr><td class="h">${P.pad(h)}00</td>${days.map((d, di) => {
            const i = di * 24 + h;
            const s = cov.staffed[p.id][i], r = cov.required[p.id][i];
            const cls = App.covClass(s, r);
            if (cls === 'short') shortHrs += Math.ceil(r - s - 1e-6);
            return `<td class="c ${cls} ${i === nowIdx ? 'now' : ''}" ${cls === 'short' ? `data-action="cov-fill" data-pos="${p.id}" data-idx="${i}"` : ''} title="${P.shortDate(d)} ${P.pad(h)}00 — ${App.fmtStaff(s)} staffed, minimum ${r}">${App.fmtStaff(s)}/${r}</td>`;
          }).join('')}</tr>`);
        }
        return `<div class="panel"><h2>${esc(p.name)} <span class="badge ${shortHrs ? 'bad' : 'ok'}">${shortHrs} short person-hours</span></h2>
          <div class="table-wrap"><table class="heat"><thead><tr><th></th>${days.map((d) => `<th>${P.shortDate(d)}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div></div>`;
      }).join('');
      return `<div class="page-head"><div><h1>Coverage</h1><p>Staffed / minimum each hour, after leave and with OT. Click a red cell to fill it.</p></div>
        <div class="toolbar"><button class="btn" data-action="cov-move" data-dir="-7">◀</button><button class="btn" data-action="cov-today">This week</button><button class="btn" data-action="cov-move" data-dir="7">▶</button>
        <input type="date" value="${P.fmtDate(from)}" data-change="cov-date"></div></div>
        <div class="legend" style="margin-bottom:10px"><span class="badge bad">below minimum</span><span class="badge warn">at minimum</span><span class="badge ok">above minimum</span><span>Outlined = current hour</span></div>
        <div class="grid g2">${tables}</div>`;
    },
  };

  App.actions['cov-move'] = (el) => { App.ui.cov.start += +el.dataset.dir; App.render(); };
  App.actions['cov-today'] = () => { const t = P.todayNum(); App.ui.cov.start = t - P.dow(t); App.render(); };
  App.changes['cov-date'] = (el) => { if (el.value) { const d = P.parseDate(el.value); App.ui.cov.start = d - P.dow(d); App.render(); } };
  App.actions['cov-fill'] = (el) => {
    const from = App.ui.cov.start;
    const op = P.openings(App.S, from, from + 6);
    const t = op.cov.base + (+el.dataset.idx) * 60;
    const slot = op.slots.find((s) => s.positionId === el.dataset.pos && s.level === 1 && s.start <= t && s.end > t);
    if (slot) App.openFill(slot);
  };
})();
