(function () {
  'use strict';
  const { P, esc, money, hrs } = App;

  App.ui.planner = {
    leave: null,
    rows: [
      { tpl: 't_d8', pat: 'p_52' },
      { tpl: 't_p10', pat: 'p_410' },
      { tpl: 't_d12', pat: 'p_12d8' },
      { tpl: 't_d12', pat: 'p_3x12' },
    ],
  };

  function builtInOT(st, tplId, patId) { return P.patternBuiltInOT(st, tplId, patId); }

  App.views.planner = {
    render(st, ui) {
      const u = ui.planner;
      const actual = P.actualLeavePerEmployee(st);
      if (u.leave == null) u.leave = Math.round(actual.perEmployee > 40 ? actual.perEmployee : 200);
      const sum = P.staffingSummary(st);
      const tplOk = (id) => st.shiftTemplates.some((t) => t.id === id);
      const patOk = (id) => st.patterns.some((p) => p.id === id);
      u.rows = u.rows.filter((r) => tplOk(r.tpl) && patOk(r.pat));
      const mult = +st.center.otMultiplier || 1.5;
      const rows = u.rows.map((r, i) => {
        const pat = st.patterns.find((p) => p.id === r.pat);
        const tpl = st.shiftTemplates.find((t) => t.id === r.tpl);
        const weekly = P.patternWeeklyHours(st, pat, r.tpl);
        const annual = weekly * 52.143;
        const net = Math.max(1, annual - u.leave);
        const ot = builtInOT(st, r.tpl, r.pat);
        const perPos = sum.map((s) => {
          const req = s.requiredWeeklyHours * 52.143;
          const fte = req / net;
          const gap = fte - s.countableFTE;
          const rate = s.avgRate;
          return { s, fte, gap, gapCost: Math.max(0, gap) * net * rate * mult, builtCost: ot.min * Math.min(s.countable - s.partTime, Math.ceil(fte)) * rate * mult };
        });
        return { i, r, pat, tpl, weekly, annual, net, relief: 8760 / net, ot, perPos };
      });
      return `<div class="page-head"><div><h1>Staffing planner</h1><p>How many people each schedule type needs to meet your minimums, and what it costs — for comparing 8, 10 and 12-hour models before a bid.</p></div></div>
      <div class="panel" style="margin-bottom:14px"><div class="form-grid">
        <div class="field"><label>Avg leave hours / employee / year</label><input type="number" min="0" value="${u.leave}" data-change="plan-leave"></div>
        <div class="field"><label>From your data (last 365 days)</label><div>${hrs(actual.perEmployee)} h <span class="small muted">(${Object.entries(actual.byType).map(([k, v]) => `${App.excType(k).abbr} ${hrs(v / actual.headcount)}`).join(', ') || 'no leave recorded'})</span> <button class="btn sm" data-action="plan-use-actual">Use</button></div></div>
        <div class="field"><label>Required coverage</label><div>${sum.map((s) => `${esc(s.position.name)}: ${hrs(s.requiredWeeklyHours)} person-h/wk <span class="small muted">(${s.positionIds.map((pid) => esc(App.posName(pid))).join(' + ')})</span>`).join('<br>')}</div></div>
      </div><p class="small muted">Leave should include vacation, sick, holiday, training, FMLA, military and other time off the console. Typical PSAPs run 180–280 h. Required coverage comes from the minimum grid in Settings.</p></div>
      <div class="panel"><div class="table-wrap"><table><thead><tr><th>Shift</th><th>Pattern</th><th class="num">Avg h/wk</th><th class="num">Net avail h/yr</th><th class="num">Relief factor</th><th class="num">Built-in OT h/yr/FTE</th>
        ${sum.map((s) => `<th class="num">${esc(s.position.name)} FTE needed</th><th class="num" title="Full-time plus part-time FTE">vs ${s.countableFTE.toFixed(1)} on staff</th>`).join('')}<th class="num">Est. OT/yr to cover gap + built-in</th><th></th></tr></thead><tbody>
        ${rows.map((x) => `<tr>
          <td><select style="min-width:170px" data-change="plan-row" data-i="${x.i}" data-f="tpl">${App.opts(st.shiftTemplates, x.r.tpl, (t) => `${t.code} ${t.start.replace(':', '')} ${t.hours}h`)}</select></td>
          <td><select style="min-width:200px" data-change="plan-row" data-i="${x.i}" data-f="pat">${App.opts(st.patterns, x.r.pat)}</select></td>
          <td class="num">${hrs(x.weekly)}</td><td class="num">${Math.round(x.net).toLocaleString()}</td><td class="num">${x.relief.toFixed(2)}</td><td class="num">${Math.abs(x.ot.max - x.ot.min) < 0.5 ? hrs(x.ot.min) : `${hrs(x.ot.min)}–${hrs(x.ot.max)}<div class="small muted">best if rotation starts ${x.ot.bestDow}</div>`}</td>
          ${x.perPos.map((p) => `<td class="num"><b>${p.fte.toFixed(1)}</b></td><td class="num">${p.gap > 0.05 ? `<span class="badge bad">short ${p.gap.toFixed(1)}</span>` : `<span class="badge ok">+${(-p.gap).toFixed(1)}</span>`}</td>`).join('')}
          <td class="num">${money(x.perPos.reduce((s, p) => s + p.gapCost + p.builtCost, 0))}</td>
          <td><button class="btn sm danger" data-action="plan-del" data-i="${x.i}">✕</button></td></tr>`).join('')}
      </tbody></table></div>
      <button class="btn sm" data-action="plan-add" style="margin-top:8px">+ Scenario</button>
      <div class="section small muted">
        <p><b>Relief factor</b> = hours in a year (8,760) ÷ net available hours per employee: how many people it takes to staff one seat 24/7.</p>
        <p><b>FTE needed</b> = minimum person-hours per year ÷ net available hours per employee. It assumes coverage can be perfectly distributed, so treat it as a floor — use the bid tool's coverage preview to check actual line placement.</p>
        <p><b>Built-in OT</b> applies your current OT rule (${st.center.otThresholdHours} h per ${st.center.otPeriodDays} days) to the pattern. Any pattern over 40 h in a work week builds in overtime for non-exempt staff. If it is over 40 h in only some weeks, which day the rotation starts matters (range shown = best–worst alignment; the cost column uses the best).</p>
      </div></div>`;
    },
  };
  App.changes['plan-leave'] = (el) => { App.ui.planner.leave = Math.max(0, +el.value || 0); App.render(); };
  App.actions['plan-use-actual'] = () => { App.ui.planner.leave = Math.round(P.actualLeavePerEmployee(App.S).perEmployee); App.render(); };
  App.changes['plan-row'] = (el) => { App.ui.planner.rows[+el.dataset.i][el.dataset.f] = el.value; App.render(); };
  App.actions['plan-add'] = () => { const st = App.S; App.ui.planner.rows.push({ tpl: st.shiftTemplates[0].id, pat: st.patterns[0].id }); App.render(); };
  App.actions['plan-del'] = (el) => { App.ui.planner.rows.splice(+el.dataset.i, 1); App.render(); };
})();
