/*
 * Fix coverage: one guided list for the scheduler.
 *   1. Which shifts are short (next few weeks, grouped in plain words)
 *   2. Who can cover without overtime: day-off moves, then part-timers (and 4-hour
 *      shifts that can go to training)
 *   3. What it costs if nobody can
 * Every suggestion is Approve / Skip. Approving notifies the employee.
 */
(function () {
  'use strict';
  const { P, esc, money, hrs } = App;
  const B = window.PSAPBalance;
  const S = () => App.S;

  const SKIP_KEY = 'psap.fixSkip';
  const loadSkips = () => { try { return new Set(JSON.parse(localStorage.getItem(SKIP_KEY) || '[]')); } catch (e) { return new Set(); } };
  const saveSkips = (set) => { try { localStorage.setItem(SKIP_KEY, JSON.stringify([...set].slice(-500))); } catch (e) { /* private window */ } };

  App.ui.fix = { weeks: null, shortNotice: false, emergency: false, skips: loadSkips(), plan: null };

  const DOWS = P.DOW;
  const one = { days: 'day', nights: 'night', evenings: 'evening' };
  const dateList = (days) => days.map((d) => P.shortDate(d).replace(/^\w+ /, '')).join(', ');
  const name = (id) => { const e = App.emp(id); return e ? `${e.firstName} ${e.lastName}` : '—'; };
  const shiftWord = (tplId) => { const t = App.tpl(tplId); return t ? B.blockName(P.parseTime(t.start)) : 'shift'; };
  const tplTime = (tplId) => { const t = App.tpl(tplId); return t ? `${t.start.replace(':', '')}–${P.mil(P.parseTime(t.start) + t.hours * 60)}` : ''; };

  /** How short, in the shift's own terms: "1 short all shift" or "2 short 1100–1500, 1 short 1500–1900". */
  function shortText(g) {
    if (g.full) return `${g.short} short all shift`;
    return g.segments.map((x) => `${x.short} short ${x.from}–${x.to}`).join(', ');
  }
  /** "Fri nights (1900–0700) are 1 short all shift for 2 weeks (11/27, 12/4)" */
  function gapSentence(g) {
    const shift = `(${g.blockText.replace('-', '–')})`;
    if (g.days.length > 1) return `<b>${DOWS[g.dow]} ${g.name}</b> <span class="muted">${shift}</span>: <b>${shortText(g)}</b> for ${g.days.length} weeks <span class="muted">(${dateList(g.days)})</span>`;
    return `<b>${DOWS[g.dow]} ${one[g.name] || g.name}, ${dateList(g.days)}</b> <span class="muted">${shift}</span>: <b>${shortText(g)}</b>`;
  }

  function compute(st) {
    const u = App.ui.fix;
    const weeks = u.weeks || +st.center.fixHorizonWeeks || 4;
    const today = P.todayNum();
    u.plan = B.planCoverage(st, today, { weeks, allowShortNotice: u.shortNotice, allowEmergency: u.emergency, skip: u.skips, training: st.center.offerTraining !== false });
    return u.plan;
  }

  App.views.fix = {
    render(st) {
      const u = App.ui.fix;
      const plan = compute(st);
      const weeks = plan.weeks;
      const crit = plan.classes.filter((x) => x.level.level === 'critical' && P.classMembers(st, x.jobClass).length);
      const short = plan.classes.filter((x) => x.level.level === 'short' && P.classMembers(st, x.jobClass).length);
      const skipped = u.skips.size;

      const gapsHtml = plan.gaps.length
        ? `<ul class="fix-list">${plan.gaps.map((g) => `<li>${gapSentence(g)} <span class="small muted">${esc(g.consoles.map((p) => App.posName(p)).join(', '))}</span></li>`).join('')}</ul>`
        : '<div class="empty">Every shift is at minimum for the next ' + weeks + ' weeks.</div>';

      const item = (kind, i, text, sub, extra = '') => `<div class="fix-item">
          <div class="fix-text">${text}${sub ? `<div class="small muted">${sub}</div>` : ''}</div>
          <div class="fix-btns">${extra}<button class="btn sm primary" data-action="fix-approve" data-kind="${kind}" data-i="${i}">Approve</button><button class="btn sm" data-action="fix-skip" data-kind="${kind}" data-i="${i}">Skip</button></div>
        </div>`;

      const moves = plan.moves.map((m, i) => {
        const first = m.items[0];
        const dates = m.items.map((x) => `${P.shortDate(P.parseDate(x.workDate)).replace(/^\w+ /, '')}`).join(', ');
        const text = `${DOWS[m.workDow]} ${shiftWord(m.templateId)} short${m.items.length > 1 ? ` for ${m.items.length} weeks` : ''} (${dates}). <b>Have ${esc(name(m.employeeId))} work ${DOWS[m.workDow]} instead of ${DOWS[m.offDow]}?</b>`;
        const sub = `${DOWS[m.offDow]} becomes a day off; same ${tplTime(first.templateId)} shift, same 40 hours that week. Closes ${hrs(m.hours)} h of gaps.`;
        const flag = m.emergency ? '<span class="badge bad" title="This makes 5 days in a row. Allowed only as an emergency; it is flagged on the schedule.">5 in a row · emergency</span> ' : '';
        return item('move', i, flag + text, sub);
      }).join('');

      const pts = plan.ptOffers.map((o, i) => {
        const dates = o.items.map((x) => P.shortDate(P.parseDate(x.fill.date)).replace(/^\w+ /, '')).join(', ');
        const end = P.mil(P.parseTime(o.start) + o.hours * 60);
        const text = `<b>Offer ${esc(name(o.employeeId))} (part-time) ${DOWS[o.dow]} ${o.start.replace(':', '')}–${end} on ${esc(App.posName(o.positionId))}</b>${o.items.length > 1 ? ` for ${o.items.length} weeks` : ''} <span class="muted">(${dates})</span>`;
        return item('pt', i, text, `Straight time, about ${money(o.cost)} · stays under their weekly cap`);
      }).join('');

      const train = plan.training.map((t, i) => {
        const text = `<b>Use ${esc(name(t.employeeId))}'s 4-hour shift ${P.shortDate(P.parseDate(t.date))} ${t.start.replace(':', '')}–${P.mil(P.parseTime(t.start) + t.hours * 60)} for training</b>`;
        const sub = t.cover ? `${esc(name(t.cover.employeeId))} (part-time) covers the seat at straight time; still at minimum, no overtime.` : 'There are enough people on that shift: still at minimum without them, no overtime.';
        return item('training', i, text, sub);
      }).join('');

      const left = plan.remaining.map((g) => `<li>${gapSentence(g)} <span class="small muted">about ${money(g.cost)}</span>${g.everyWeek ? ' <span class="badge warn" title="The same gap every week: the lines themselves don\'t cover it.">every week</span>' : ''}</li>`).join('');
      const everyWeek = plan.remaining.some((g) => g.everyWeek);

      const levelLine = plan.classes.filter((x) => P.classMembers(st, x.jobClass).length).map((x) => `<span class="badge">${esc(x.jobClass.name)}</span> ${App.levelBadge(x.level)}`).join(' &nbsp; ');

      return `<div class="page-head"><div><h1>Fix coverage</h1><p>Next ${weeks} weeks from ${P.shortDate(plan.from)} · ${levelLine}</p></div>
          <div class="toolbar"><label class="small muted" style="margin:0">Look ahead <select data-change="fix-weeks">${[2, 4, 6, 8].map((w) => `<option value="${w}" ${w === weeks ? 'selected' : ''}>${w} weeks</option>`).join('')}</select></label>
          ${skipped ? `<button class="btn" data-action="fix-unskip" title="Show suggestions you skipped again">Show skipped (${skipped})</button>` : ''}</div></div>
        <div class="kpis">
          ${App.kpi('Short shifts', plan.gaps.length, `${hrs(plan.gapHours)} h below minimum`, plan.gaps.length ? 'bad' : 'ok')}
          ${App.kpi('Covered without OT', `${hrs(Math.max(0, plan.gapHours - plan.hours))} h`, 'if you approve the suggestions below', plan.gapHours > plan.hours ? 'ok' : '')}
          ${App.kpi('Still needs overtime', `${hrs(plan.hours)} h`, `about ${money(plan.cost)}`, plan.hours ? 'warn' : 'ok')}
        </div>

        <div class="panel"><h2>1. Which shifts are short</h2>${gapsHtml}</div>

        <div class="panel"><h2>2. Who can cover without overtime ${plan.moves.length + plan.ptOffers.length > 1 ? '<button class="btn sm" data-action="fix-approve-all">Approve all</button>' : ''}</h2>
          <h3>Move days off <span class="small muted">same shift, same work week, rest rules, ${plan.noticeDays}-day notice, max ${+st.center.maxConsecutiveDays || '—'} days in a row</span></h3>
          ${moves || '<p class="small muted">No day-off moves help.</p>'}
          ${plan.skippedForNotice ? `<p class="small muted">${plan.skippedForNotice} more possible move(s) fall inside the ${plan.noticeDays}-day notice period. <label class="check" style="display:inline-flex"><input type="checkbox" data-change="fix-short" ${u.shortNotice ? 'checked' : ''}> Include them (needs the employee's agreement)</label></p>` : ''}
          <h3>Part-timers <span class="small muted">straight time, under their cap, never forced</span></h3>
          ${pts || '<p class="small muted">No part-timer can take what\'s left (none needed, or none under their cap).</p>'}
          ${train ? `<details class="section"><summary><b>Training time available (${plan.training.length})</b> <span class="small muted">4-hour shifts that can go to training without dropping below minimum or paying overtime</span></summary>${train}</details>` : ''}
        </div>

        <div class="panel"><h2>3. If nobody can: overtime</h2>
          ${plan.remaining.length ? `<p><b>${hrs(plan.hours)} h</b> still need overtime over the next ${weeks} weeks — about <b>${money(plan.cost)}</b>. <a class="btn sm" href="#/openings">Fill from Openings</a></p>
            <ul class="fix-list">${left}</ul>
            ${everyWeek ? `<div class="callout warn">Some gaps repeat every week, so the lines themselves don't cover them. <button class="btn sm primary" data-action="fix-lines">Rebalance lines</button> keeps everyone on their shift and only changes which week of the rotation they start on.</div>` : ''}`
          : '<p><span class="badge ok">None</span> Once the suggestions above are approved, every shift is covered without overtime.</p>'}
          ${crit.length ? `<div class="callout bad">${crit.map((x) => `<b>${esc(x.jobClass.name)}</b> is at <b>Critical</b> staffing: work to minimums only and spread gaps across days. Consider holding vacation (daily limit now ${P.maxOffFor(st, x.jobClass) ?? 'none'}${P.maxOffFor(st, x.jobClass) ? `; Settings → Staffing levels` : ''}).`).join('<br>')}</div>` : ''}
          ${short.length ? `<p class="small muted">${short.map((x) => esc(x.jobClass.name)).join(', ')}: Short staffing — part-timers before overtime, no relief margin.</p>` : ''}
          ${plan.blockedByRun || u.emergency ? `<p class="small muted">${plan.blockedByRun ? `${plan.blockedByRun} possible move(s) were left out because they make more than ${+st.center.maxConsecutiveDays} days in a row. ` : ''}<label class="check" style="display:inline-flex"><input type="checkbox" data-change="fix-emergency" ${u.emergency ? 'checked' : ''}> Emergency: allow a ${(+st.center.maxConsecutiveDays || 4) + 1}th day in a row (flagged on the schedule)</label></p>` : ''}
        </div>`;
    },
  };

  const groupOf = (kind, i) => {
    const p = App.ui.fix.plan;
    return kind === 'move' ? p.moves[i] : kind === 'pt' ? p.ptOffers[i] : p.training[i];
  };
  const nowIso = () => new Date().toISOString();

  function applyGroup(s, kind, g) {
    const ctx = { now: nowIso() };
    if (kind === 'move') {
      for (const m of g.items) {
        s.shiftMoves.push({ id: P.uid('mv'), employeeId: m.employeeId, offDate: m.offDate, workDate: m.workDate, templateId: m.templateId, status: 'approved', emergency: !!m.emergency, approvedAt: ctx.now, approvedBy: App.me ? App.me.id : null });
      }
      const pairs = g.items.map((m) => `work ${P.shortDate(P.parseDate(m.workDate))} instead of ${P.shortDate(P.parseDate(m.offDate))}`).join('; ');
      App.A.notify(s, g.employeeId, 'Your days off changed', `Approved schedule change: ${pairs} (${tplTime(g.templateId)}). Same shift and hours those weeks.${g.emergency ? ' This makes 5 days in a row (emergency).' : ''}`, ctx, 'me');
    } else if (kind === 'pt') {
      for (const o of g.items) {
        const { id: _x, ...fill } = o.fill;
        s.fills.push(Object.assign({ id: P.uid('ot'), note: 'Fix coverage: part-time before overtime', createdAt: ctx.now }, fill, { type: 'voluntary', status: 'scheduled' }));
      }
      App.A.notify(s, g.employeeId, 'Extra shift scheduled', `${g.items.map((o) => `${P.shortDate(P.parseDate(o.fill.date))} ${o.fill.start.replace(':', '')} (${o.fill.hours}h)`).join(', ')} on ${App.posName(g.positionId)}, straight time.`, ctx, 'me');
    } else if (kind === 'training') {
      const exc = Object.assign({}, g.exception, { id: P.uid('ex'), createdAt: ctx.now });
      s.exceptions.push(exc);
      if (g.cover) {
        const { id: _y, ...fill } = g.cover.fill;
        s.fills.push(Object.assign({ id: P.uid('ot'), note: 'Covers a 4-hour shift used for training', createdAt: ctx.now }, fill, { exceptionId: exc.id, status: 'scheduled' }));
        App.A.notify(s, g.cover.employeeId, 'Extra shift scheduled', `${P.shortDate(P.parseDate(fill.date))} ${fill.start.replace(':', '')} (${fill.hours}h), straight time, covering a seat during training.`, ctx, 'me');
      }
      App.A.notify(s, g.employeeId, 'Training scheduled', `Your 4-hour shift ${P.shortDate(P.parseDate(g.date))} ${g.start.replace(':', '')} is training time.`, ctx, 'me');
    }
  }

  App.actions['fix-approve'] = (el) => {
    const kind = el.dataset.kind, g = groupOf(kind, +el.dataset.i);
    if (!g) return;
    App.commit((s) => applyGroup(s, kind, g), kind === 'move' ? 'Approved; employee notified' : kind === 'pt' ? 'Part-timer scheduled and notified' : 'Training scheduled; employee notified');
  };
  App.actions['fix-approve-all'] = () => {
    const p = App.ui.fix.plan;
    const n = p.moves.length + p.ptOffers.length;
    App.confirm(`Approve all ${n} suggestions (day-off moves and part-time shifts)? Each employee is notified.`, () => {
      App.commit((s) => { for (const g of p.moves) applyGroup(s, 'move', g); for (const g of p.ptOffers) applyGroup(s, 'pt', g); }, `${n} approved; employees notified`);
    }, 'Approve all');
  };
  App.actions['fix-skip'] = (el) => {
    const g = groupOf(el.dataset.kind, +el.dataset.i);
    if (!g) return;
    for (const k of g.skipKeys || []) App.ui.fix.skips.add(k);
    saveSkips(App.ui.fix.skips);
    App.render();
  };
  App.actions['fix-unskip'] = () => { App.ui.fix.skips.clear(); saveSkips(App.ui.fix.skips); App.render(); };
  App.actions['fix-lines'] = () => App.openSuggest({});
  App.changes['fix-weeks'] = (el) => { App.ui.fix.weeks = +el.value; App.render(); };
  App.changes['fix-short'] = (el) => { App.ui.fix.shortNotice = el.checked; App.render(); };
  App.changes['fix-emergency'] = (el) => { App.ui.fix.emergency = el.checked; App.render(); };
})();
