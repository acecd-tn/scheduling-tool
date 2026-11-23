(function () {
  'use strict';
  const { P, esc, money, hrs } = App;

  App.views.dashboard = {
    render(S) {
      const today = P.todayNum();
      const now = P.nowAbs();
      const hourIdx = Math.floor((now - today * P.DAY) / 60);
      const cov = P.coverage(S, today, today + 1, { keepAssign: true });
      const staffing = P.staffingSummary(S);
      const op = P.openings(S, today, today + 6);
      const upcoming = op.slots.filter((s) => s.end > now);
      const fc = P.otForecast(S, today);
      const pending = S.exceptions.filter((e) => e.status === 'pending');
      const onDuty = cov.wi.intervals.filter((iv) => iv.start <= now && iv.end > now);

      const nowCards = S.positions.map((p) => {
        const st = cov.staffed[p.id][hourIdx], rq = cov.required[p.id][hourIdx];
        const cls = App.covClass(st, rq);
        return App.kpi(`${p.name} — on now`, `${App.fmtStaff(st)} <span class="muted small">/ ${rq} min</span>`,
          cls === 'short' ? `<span class="badge bad">SHORT ${Math.ceil(rq - st)}</span>` : cls === 'exact' ? '<span class="badge warn">At minimum</span>' : '<span class="badge ok">Covered</span>',
          cls === 'short' ? 'bad' : cls === 'exact' ? 'warn' : 'ok');
      }).join('');

      const budgetPct = fc.budget ? fc.projection / fc.budget : 0;
      const strips = S.positions.map((p) => {
        const cells = [], labels = [];
        for (let i = 0; i < 24; i++) {
          const idx = hourIdx + i, st = cov.staffed[p.id][idx], rq = cov.required[p.id][idx];
          cells.push(`<div class="${App.covClass(st, rq)}" title="${P.mil(now - (now % 60) + i * 60)}: ${App.fmtStaff(st)} of ${rq}">${App.fmtStaff(st)}/${rq}</div>`);
          labels.push(`<span>${P.mil(now - (now % 60) + i * 60).slice(0, 2)}</span>`);
        }
        return `<div class="field"><label>${esc(p.name)}</label><div class="strip">${cells.join('')}</div><div class="strip-labels">${labels.join('')}</div></div>`;
      }).join('');

      const where = (cov.assign && cov.assign[hourIdx]) || {};
      const seen = new Set();
      const dutyRows = S.positions.map((p) => {
        const list = onDuty.filter((iv) => (where[iv.employeeId] || iv.positionId) === p.id && !seen.has(iv.employeeId) && seen.add(iv.employeeId)).map((iv) => {
          const e = App.emp(iv.employeeId);
          const tag = iv.kind === 'ot' ? ' <span class="badge ok">OT</span>' : '';
          const tr = (e && !P.countable(e) ? ' <span class="badge warn" title="Not counted toward minimums">trainee</span>' : '') + (e ? ` <span class="small muted">${esc((P.empClass(S, e) || {}).name || '')}</span>` : '');
          return `<tr><td>${esc(P.empName(e))}${tag}${tr}</td><td class="nowrap">${P.mil(iv.start)}–${P.mil(iv.end)}</td></tr>`;
        }).join('');
        return `<tr class="group"><td colspan="2"><b>${esc(p.name)}</b></td></tr>${list || '<tr><td colspan="2" class="muted">Nobody on duty</td></tr>'}`;
      }).join('');

      return `
      <div class="page-head"><div><h1>Dashboard</h1><p>${esc(S.center.name)} · ${P.shortDate(today)} · OT period ${P.shortDate(fc.cur.start)}–${P.shortDate(fc.cur.end)}</p></div>
        <div class="toolbar"><button class="btn" data-action="quick-callout">+ Record call-out</button><button class="btn" data-action="go" data-to="openings">View openings</button></div></div>
      <div class="kpis">
        ${nowCards}
        ${App.kpi('Open shifts (7 days)', upcoming.length, `${hrs(upcoming.reduce((s, x) => s + x.hours, 0))} hrs uncovered`, upcoming.length ? 'bad' : 'ok')}
        ${App.kpi('Pending requests', pending.length, 'time-off awaiting decision', pending.length ? 'warn' : '')}
        ${App.kpi(`OT ${fc.fy.label} to date`, money(fc.ytd), `Budget ${money(fc.budget)}`)}
        ${App.kpi('Projected FY OT', money(fc.projection), `${App.pct(budgetPct)} of budget (run-rate)`, budgetPct > 1 ? 'bad' : budgetPct > 0.9 ? 'warn' : 'ok')}
      </div>
      <div class="grid g2">
        <div class="panel"><h2>Next 24 hours — staffed / minimum</h2>${strips}
          <div class="legend"><span><span class="badge bad">short</span></span><span><span class="badge warn">at minimum</span></span><span><span class="badge ok">above minimum</span></span></div></div>
        <div class="panel"><h2>Staffing levels</h2>
          <div class="table-wrap"><table><thead><tr><th>Job class</th><th class="num">Authorized</th><th class="num">Full-time</th><th class="num">Vacant</th><th class="num" title="Part-time filled / part-time authorized (separate from full-time)">Part-time</th><th class="num">Trainees</th><th class="num">Countable</th><th>Fill rate</th></tr></thead><tbody>
          ${staffing.map((r) => `<tr><td>${esc(r.position.name)}</td><td class="num">${r.authorized}</td><td class="num">${r.fullTime}</td>
            <td class="num">${r.vacancies ? `<span class="badge bad">${r.vacancies}</span>` : 0}</td>
            <td class="num" title="${r.partFTE.toFixed(1)} FTE">${r.authorizedPart ? `${r.partTime} / ${r.authorizedPart}${r.partVacancies ? ` <span class="badge warn">${r.partVacancies}</span>` : ''}` : (r.partTime || '—')}</td>
            <td class="num" title="solo-cleared / with CTO">${r.traineeSolo + r.traineeNot ? `${r.traineeSolo}/${r.traineeNot}` : '—'}</td>
            <td class="num" title="Active + solo-cleared trainees">${r.countable}</td>
            <td style="min-width:110px"><div class="meter ${r.pct < 0.85 ? 'bad' : r.pct < 0.95 ? 'warn' : 'ok'}"><span style="width:${Math.min(100, r.pct * 100)}%"></span></div><span class="small muted">${App.pct(r.pct)}</span></td></tr>`).join('')}
          </tbody></table></div>
          <p class="small muted">Trainees: solo-cleared / still with CTO. Only active staff and solo-cleared trainees count toward console minimums.</p>
        </div>
        <div class="panel"><h2>Open shifts — next 7 days <a class="btn sm" href="#/openings">All openings</a></h2>
          ${upcoming.length ? `<div class="table-wrap"><table><thead><tr><th>When</th><th>Console</th><th class="num">Hrs</th><th>Cause</th><th></th></tr></thead><tbody>
          ${upcoming.slice(0, 10).map((s) => `<tr><td class="nowrap">${App.slotTime(s)}</td><td>${esc(App.posName(s.positionId))}${s.level > 1 ? ` <span class="badge bad">#${s.level}</span>` : ''}</td><td class="num">${hrs(s.hours)}</td>
            <td class="small">${s.causes.length ? s.causes.map((c) => esc(`${P.empName(App.emp(c.employeeId))} (${App.excType(c.type).abbr})`)).join(', ') : '<span class="muted">Structural / vacancy</span>'}</td>
            <td><button class="btn sm primary" data-action="fill-slot" data-slot="${esc(s.id)}" data-from="${today}" data-to="${today + 6}">Fill</button></td></tr>`).join('')}
          </tbody></table></div>${upcoming.length > 10 ? `<p class="small muted">+ ${upcoming.length - 10} more</p>` : ''}` : '<div class="empty">All minimums covered for the next 7 days.</div>'}
        </div>
        <div class="panel"><h2>On duty now — by console <a class="btn sm" href="#/consoles">Console sheet</a></h2><div class="table-wrap"><table><tbody>${dutyRows}</tbody></table></div></div>
      </div>`;
    },
  };

  App.actions['quick-callout'] = () => {
    const today = P.todayNum();
    const now = P.nowAbs();
    const regs = P.regularShifts(S(), today - 1, today + 1).filter((r) => r.end > now - 60);
    const list = regs.map((r) => ({ id: `${r.employeeId}|${r.day}`, name: `${P.empName(App.emp(r.employeeId))} — ${P.shortDate(r.day)} ${P.mil(r.start)}–${P.mil(r.end)}` }));
    App.modal({
      title: 'Record call-out',
      body: `<div class="field"><label>Employee & shift</label><select name="pick">${App.opts(list, '')}</select></div>
        <div class="form-grid"><div class="field"><label>Type</label><select name="type">${App.opts(P.EXCEPTION_TYPES, 'sick', (t) => t.label)}</select></div>
        <div class="field"><label>Note</label><input name="note" placeholder="e.g. called at 0430"></div></div>`,
      footer: '<button class="btn" data-action="modal-close">Cancel</button><button class="btn primary" data-action="quick-callout-save">Save & find coverage</button>',
    });
  };
  function S() { return App.S; }
  App.actions['quick-callout-save'] = () => {
    const f = App.modalForm();
    if (!f.pick) return;
    const [employeeId, day] = f.pick.split('|');
    const d = +day;
    App.commit((s) => s.exceptions.push({ id: P.uid('ex'), employeeId, date: P.fmtDate(d), endDate: null, start: null, hours: null, type: f.type, status: 'approved', note: f.note, createdAt: new Date().toISOString() }), 'Call-out recorded');
    App.closeModal();
    const emp = App.emp(employeeId);
    const slots = P.openings(S(), d, d + 1).slots.filter((x) => x.end > P.nowAbs() && x.causes.some((c) => c.employeeId === employeeId));
    if (slots.length) App.openFill(slots[0]);
    else App.toast('Minimums still covered — no backfill needed');
  };
})();
