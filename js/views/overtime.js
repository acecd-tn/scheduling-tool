(function () {
  'use strict';
  const { P, esc, money, hrs } = App;

  App.ui.ot = { log: 'upcoming' };

  App.views.overtime = {
    render(st, ui) {
      const today = P.todayNum();
      const fc = P.otForecast(st, today);
      const budgetPct = fc.budget ? fc.projection / fc.budget : 0;
      const elapsed = (today - fc.fy.start + 1) / (fc.fy.end - fc.fy.start + 1);
      const c = st.center;

      // Chart: last 12 periods actual + next 4 predicted.
      const all = fc.full.periods;
      const act = {}; for (const p of fc.actual.periods) act[p.start] = p.cost;
      const ci = all.findIndex((p) => p.start === fc.cur.start);
      const lo = Math.max(0, ci - 12), hi = Math.min(all.length, ci + 5);
      const win = all.slice(lo, hi);
      // Unfilled-gap exposure per future period.
      const gapByP = {};
      const gaps = P.openings(st, today, Math.min(fc.fy.end, today + 70)).slots.filter((s) => s.end > P.nowAbs());
      for (const g of gaps) { const p = P.periodOf(st, Math.floor(g.start / P.DAY)); gapByP[p.start] = (gapByP[p.start] || 0) + P.slotCost(st, g); }
      const bars = win.map((p) => ({ p, a: act[p.start] || 0, k: Math.max(0, p.cost - (act[p.start] || 0)), g: gapByP[p.start] || 0 }));
      const maxV = Math.max(1, ...bars.map((b) => b.a + b.k + b.g));
      const W = 760, H = 220, pad = 34, bw = (W - pad - 10) / Math.max(1, bars.length);
      const y = (v) => H - 24 - (v / maxV) * (H - 40);
      const svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="OT cost by period">
        ${[0, 0.5, 1].map((t) => `<line x1="${pad}" x2="${W - 6}" y1="${y(maxV * t)}" y2="${y(maxV * t)}" stroke="currentColor" opacity=".12"/><text x="${pad - 4}" y="${y(maxV * t) + 4}" text-anchor="end">${money(maxV * t / 1000)}k</text>`).join('')}
        ${bars.map((b, i) => {
          const x = pad + i * bw + 3, w = bw - 6;
          let h = '', top = H - 24;
          const seg = (v, color, op, label) => { if (v <= 0) return; const hh = (v / maxV) * (H - 40); top -= hh; h += `<rect x="${x}" y="${top}" width="${w}" height="${hh}" fill="${color}" opacity="${op}" rx="2"><title>${P.shortDate(b.p.start)} — ${label}: ${money(v)}</title></rect>`; };
          seg(b.a, 'var(--accent)', 1, 'actual');
          seg(b.k, 'var(--accent)', 0.4, 'scheduled / built-in');
          seg(b.g, 'var(--warn)', 0.75, 'unfilled openings if filled with OT');
          const cur = b.p.start === fc.cur.start;
          return h + `<text x="${x + w / 2}" y="${H - 8}" text-anchor="middle" ${cur ? 'font-weight="700"' : ''}>${P.fmtDate(b.p.start).slice(5).replace('-', '/')}</text>`;
        }).join('')}
      </svg>`;

      const reasons = Object.entries(fc.actual.totals.byReason).sort((a, b) => b[1].cost - a[1].cost);
      const fullReasons = fc.full.totals.byReason;
      const emps = st.employees.filter((e) => e.status !== 'inactive');
      const fyFills = st.fills.filter((f) => f.status !== 'cancelled' && P.parseDate(f.date) >= fc.fy.start && P.parseDate(f.date) <= fc.fy.end);
      const fillsBy = P.groupBy(fyFills, 'employeeId');
      const empRows = emps.map((e) => {
        const a = fc.actual.totals.byEmp[e.id] || { hours: 0, cost: 0 };
        const fl = fillsBy[e.id] || [];
        return { e, a, fills: fl.length, extraHrs: fl.reduce((s, f) => s + +f.hours, 0), forced: fl.filter((f) => f.type === 'mandatory').length };
      }).sort((x, y2) => y2.a.cost - x.a.cost);
      const maxEmp = Math.max(1, ...empRows.map((r) => r.a.cost));

      const logList = st.fills.filter((f) => f.status !== 'cancelled')
        .filter((f) => ui.ot.log === 'upcoming' ? P.parseDate(f.date) >= today : P.parseDate(f.date) < today)
        .sort((a, b) => ui.ot.log === 'upcoming' ? a.date.localeCompare(b.date) : b.date.localeCompare(a.date)).slice(0, 60);

      return `<div class="page-head"><div><h1>Overtime</h1><p>${fc.fy.label} (${P.fmtDate(fc.fy.start)} → ${P.fmtDate(fc.fy.end)}) · rule: OT after ${c.otThresholdHours} h per ${c.otPeriodDays}-day period at ${c.otMultiplier}×${c.extraShiftsAlwaysOT ? ', extra shifts always OT' : ''}</p></div>
        <div class="toolbar"><button class="btn" data-action="ot-export">Export CSV</button></div></div>
      <div class="kpis">
        ${App.kpi('Current period — actual', money(fc.curActual), `${P.shortDate(fc.cur.start)}–${P.shortDate(fc.cur.end)}`)}
        ${App.kpi('Current period — predicted', money(fc.curTotal), 'incl. scheduled OT through period end')}
        ${App.kpi('FY to date (actual)', money(fc.ytd), `${hrs(fc.ytdHours)} OT hrs · ${App.pct(fc.budget ? fc.ytd / fc.budget : 0)} of budget, ${App.pct(elapsed)} of year elapsed`, fc.budget && fc.ytd / fc.budget > elapsed + 0.05 ? 'warn' : '')}
        ${App.kpi('FY projection (run-rate)', money(fc.projection), `${money(fc.daily)}/day last 28 days · ${App.pct(budgetPct)} of ${money(fc.budget)}`, budgetPct > 1 ? 'bad' : budgetPct > 0.9 ? 'warn' : 'ok')}
        ${App.kpi('Committed rest of FY', money(fc.known), 'built-in schedule OT + already-scheduled fills')}
        ${App.kpi(`Unfilled exposure (${fc.horizonDays} d)`, money(fc.gapCost), `${fc.gapCount} openings · ${hrs(fc.gapHours)} h`, fc.gapCost ? 'warn' : '')}
      </div>
      <div class="grid g2">
        <div class="panel chart"><h2>OT cost per ${c.otPeriodDays}-day period</h2>${svg}
          <div class="legend"><span><span class="badge" style="background:var(--accent);color:#fff">actual</span></span><span><span class="badge info">scheduled / built-in</span></span><span><span class="badge warn">unfilled openings (if OT)</span></span></div></div>
        <div class="panel"><h2>Why we pay OT (FY)</h2>
          <div class="table-wrap"><table><thead><tr><th>Reason</th><th class="num">Hours to date</th><th class="num">Cost to date</th><th class="num">Full-year committed</th></tr></thead><tbody>
          ${reasons.map(([k, v]) => `<tr><td>${esc(App.reasonLabel(k))}</td><td class="num">${hrs(v.hours)}</td><td class="num">${money(v.cost)}</td><td class="num">${money((fullReasons[k] || {}).cost || 0)}</td></tr>`).join('') || '<tr><td colspan="4" class="empty">No OT yet this FY.</td></tr>'}
          </tbody></table></div>
          ${fullReasons['built-in'] ? `<p class="small muted">"Built-in" is OT generated by the rotation itself (e.g. a Pitman week of 48 h against a ${c.otThresholdHours} h / ${c.otPeriodDays}-day threshold). Compare patterns in the Planner.</p>` : ''}
        </div>
        <div class="panel"><h2>By employee (FY to date)</h2><div class="table-wrap" style="max-height:420px"><table><thead><tr><th>Employee</th><th class="num">OT hrs</th><th class="num">OT cost</th><th class="num">Extra shifts</th><th class="num">Extra hrs</th><th class="num">Forced</th><th></th></tr></thead><tbody>
          ${empRows.map((r) => `<tr><td>${esc(P.empName(r.e))}</td><td class="num">${hrs(r.a.hours)}</td><td class="num">${money(r.a.cost)}</td><td class="num">${r.fills}</td><td class="num">${hrs(r.extraHrs)}</td><td class="num">${r.forced}</td>
            <td style="width:90px"><div class="meter"><span style="width:${r.a.cost / maxEmp * 100}%"></span></div></td></tr>`).join('')}
        </tbody></table></div></div>
        <div class="panel"><h2>OT assignments <span class="seg"><button class="${ui.ot.log === 'upcoming' ? 'on' : ''}" data-action="ot-log" data-v="upcoming">Upcoming</button><button class="${ui.ot.log === 'past' ? 'on' : ''}" data-action="ot-log" data-v="past">Past</button></span></h2>
          <div class="table-wrap" style="max-height:420px"><table><thead><tr><th>Date</th><th>Time</th><th>Employee</th><th>Type</th><th>Reason</th><th></th></tr></thead><tbody>
          ${logList.map((f) => `<tr><td class="nowrap">${P.shortDate(P.parseDate(f.date))}</td><td class="nowrap">${f.start.replace(':', '')} · ${f.hours}h</td><td>${esc(P.empName(App.emp(f.employeeId)))}</td>
            <td>${f.type === 'mandatory' ? '<span class="badge bad">forced</span>' : esc(App.fillType(f.type))}</td><td class="small">${esc(App.reasonLabel(f.reason))}</td>
            <td><button class="btn sm danger" data-action="fill-del" data-id="${f.id}" title="Remove">✕</button></td></tr>`).join('') || '<tr><td colspan="6" class="empty">None.</td></tr>'}
          </tbody></table></div></div>
      </div>`;
    },
  };
  App.actions['ot-log'] = (el) => { App.ui.ot.log = el.dataset.v; App.render(); };
  App.actions['ot-export'] = () => {
    const st = App.S;
    const rows = [['date', 'start', 'hours', 'employee', 'badge', 'position', 'type', 'reason', 'hourly_rate']];
    for (const f of st.fills) {
      if (f.status === 'cancelled') continue;
      const e = App.emp(f.employeeId) || {};
      rows.push([f.date, f.start, f.hours, P.empName(e), e.badge || '', App.posName(f.positionId), f.type, f.reason, e.hourlyRate || '']);
    }
    App.download('overtime-assignments.csv', rows.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n'), 'text/csv');
  };
})();
