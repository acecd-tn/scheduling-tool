(function () {
  'use strict';
  const { P, esc, money } = App;
  const S = () => App.S;

  App.ui.staff = { showInactive: false };

  App.views.staff = {
    render(st, ui) {
      const today = P.todayNum();
      const sum = P.staffingSummary(st);
      const emps = st.employees.filter((e) => ui.staff.showInactive || e.status !== 'inactive')
        .sort((a, b) => String((P.empClass(st, a) || {}).name).localeCompare((P.empClass(st, b) || {}).name) || P.parseDate(a.seniorityDate || a.hireDate || '2000-01-01') - P.parseDate(b.seniorityDate || b.hireDate || '2000-01-01'));
      const lineOf = (e) => st.lines.find((l) => l.employeeId === e.id && P.lineActiveOn(l, today));
      const mult = +st.center.otMultiplier || 1.5;
      const vacancyCost = sum.reduce((t, r) => t + r.vacancies * 2080 * r.avgRate * mult, 0);
      const hireCost = sum.reduce((t, r) => t + r.vacancies * 2080 * (r.minRate || r.avgRate), 0);
      const classes = P.jobClasses(st);
      const classSel = (pid) => {
        const cur = P.jobClassOf(st, pid);
        return `<select data-change="pos-class" data-id="${pid}">${classes.map((c) => `<option value="${esc(c.id)}"${cur && cur.id === c.id ? ' selected' : ''}>${esc(c.name)}</option>`).join('')}<option value="__new">+ New job class…</option></select>`;
      };
      return `<div class="page-head"><div><h1>Staff & authorized strength</h1><p>Each person has a job class (their position, e.g. Telecommunicator) and the consoles they're certified on. Consoles are only where people sit each hour, assigned by certification and fill priority.</p></div>
        <div class="toolbar"><label class="check"><input type="checkbox" ${ui.staff.showInactive ? 'checked' : ''} data-change="staff-inactive"> Show separated</label>
        <button class="btn primary" data-action="emp-edit">+ Employee</button></div></div>
      <div class="grid" style="margin-bottom:14px">
        <div class="panel"><h2>Job classes</h2>
          <p class="small muted" style="margin:0">A job class is a budgeted position (e.g. Telecommunicator). Authorized counts, vacancies, part-time positions, the daily leave limit, lines and bids are all by job class.</p>
          <div class="table-wrap"><table class="positions"><thead><tr><th>Job class</th><th title="Consoles this job class staffs (for planning and bid previews)">Consoles staffed</th><th class="num" title="Full-time positions">Authorized</th><th class="num">Full-time</th><th class="num">Vacant</th><th class="num" title="Part-time positions (separate from full-time)">PT authorized</th><th class="num" title="Part-time staff (FTE at their weekly caps)">PT filled</th><th class="num" title="Active and solo-cleared staff">Countable</th><th title="Most people in this job class on planned leave (vacation/comp/holiday) per day">Max off / day</th><th></th></tr></thead><tbody>
          ${sum.map((r) => `<tr><td><input value="${esc(r.jobClass.name)}" data-change="jc-field" data-id="${esc(r.jobClass.id)}" data-f="name"></td>
            <td class="small">${r.positionIds.map((pid) => `<span class="badge">${esc(App.posName(pid))}</span>`).join(' ') || '<span class="muted">none</span>'}</td>
            <td><input type="number" min="0" value="${r.authorized}" data-change="jc-field" data-id="${esc(r.jobClass.id)}" data-f="authorized"></td>
            <td class="num">${r.fullTime}</td><td class="num">${r.vacancies ? `<span class="badge bad">${r.vacancies}</span>` : 0}</td>
            <td><input type="number" min="0" value="${r.authorizedPart || ''}" placeholder="0" data-change="jc-field" data-id="${esc(r.jobClass.id)}" data-f="authorizedPartTime"></td>
            <td class="num">${r.partTime}${r.partTime ? ` <span class="small muted">(${r.partFTE.toFixed(1)} FTE)</span>` : ''}${r.partVacancies ? ` <span class="badge warn" title="Part-time vacancies">${r.partVacancies} open</span>` : ''}</td>
            <td class="num">${r.countable}</td>
            <td><input type="number" min="0" value="${esc(r.jobClass.maxOffPerDay ?? '')}" placeholder="none" data-change="jc-field" data-id="${esc(r.jobClass.id)}" data-f="maxOffPerDay"></td>
            <td>${r.current ? '' : `<button class="btn sm danger" data-action="jc-del" data-id="${esc(r.jobClass.id)}" title="Delete job class">✕</button>`}</td></tr>`).join('')}
          </tbody></table></div><button class="btn sm" data-action="jc-add" style="margin-top:8px">+ Job class</button></div>
        <div class="panel"><h2>Consoles</h2>
          <p class="small muted" style="margin:0">Minimum staffing is set per console (Settings). When short, consoles with a lower fill priority number are staffed first.</p>
          <div class="table-wrap"><table class="positions"><thead><tr><th>Console</th><th title="Which job class's planning and bid preview this console counts toward">Staffed by</th><th class="num" title="People certified to sit this console">Certified</th><th class="num" title="People whose preferred console this is (only breaks ties)">Preferred by</th><th title="When short, lower numbers are staffed first">Fill priority</th><th>Console seat</th><th></th></tr></thead><tbody>
          ${st.positions.map((p) => `<tr><td><input value="${esc(p.name)}" data-change="pos-field" data-id="${p.id}" data-f="name"></td>
            <td>${classSel(p.id)}</td>
            <td class="num">${st.employees.filter((e) => e.status !== 'inactive' && P.qualifiedFor(e, p.id)).length}</td>
            <td class="num">${st.employees.filter((e) => e.status !== 'inactive' && e.positionId === p.id).length}</td>
            <td><input type="number" min="1" value="${esc(p.priority ?? '')}" data-change="pos-field" data-id="${p.id}" data-f="priority"></td>
            <td><input type="checkbox" ${p.isConsole ? 'checked' : ''} data-change="pos-field" data-id="${p.id}" data-f="isConsole"></td>
            <td><button class="btn sm danger" data-action="pos-del" data-id="${p.id}">✕</button></td></tr>`).join('')}
          </tbody></table></div><button class="btn sm" data-action="pos-add" style="margin-top:8px">+ Console</button></div>
        <div class="panel"><h2>What the vacancies cost</h2>
          <p>${sum.map((r) => `${esc(r.jobClass.name)}: <b>${r.vacancies}</b> vacant`).join(' · ')}</p>
          <p class="small muted">Authorized counts full-time positions only. Part-time positions are a separate count (PT authorized); part-timers don't fill a full-time vacancy, but they work open shifts at straight time.</p>
          ${sum.some((r) => r.authorizedPart) ? `<p>Part-time: ${sum.filter((r) => r.authorizedPart).map((r) => `${esc(r.jobClass.name)} ${r.partTime} of ${r.authorizedPart}`).join(' · ')}</p>` : ''}
          <p>If every vacant position's ~2,080 hrs/yr were backfilled with overtime: <b>${money(vacancyCost)}/yr</b> (at average rate × ${mult}).</p>
          <p class="small muted">A new hire at base rate costs roughly ${money(hireCost)}/yr in wages for the same hours (before benefits and training time).</p></div>
      </div>
      <div class="panel"><div class="table-wrap"><table><thead><tr><th>Badge</th><th>Name</th><th>Job class</th><th>Status</th><th>Seniority</th><th class="num">Rate</th><th>Current line</th><th>Certified consoles</th>${App.mode === 'server' ? '<th>Login</th>' : ''}<th></th></tr></thead><tbody>
        ${emps.map((e) => { const l = lineOf(e); return `<tr class="${e.status === 'inactive' ? 'dim' : ''}"><td>${esc(e.badge)}</td><td>${esc(P.empName(e))}</td><td>${P.empClass(st, e) ? esc(P.empClass(st, e).name) : '<span class="badge bad">none</span>'}</td>
          <td>${statusBadge(e)}${P.isPartTime(e) ? ` <span class="badge info" title="Part-time, straight time, capped at ${P.partTimeCap(st, e)} h/week">PT ${P.partTimeCap(st, e)}h</span>` : ''}</td><td>${esc(e.seniorityDate || e.hireDate || '')}</td><td class="num">${money(+e.hourlyRate, 2)}</td>
          <td>${l ? esc(l.name) : '<span class="badge warn">none</span>'}</td><td class="small">${P.certifications(e).map((q) => `${esc(App.posName(q))}${q === e.positionId ? ' <span class="muted" title="Preferred console">★</span>' : ''}`).join(', ') || '<span class="badge warn">none</span>'}</td>
          ${App.mode === 'server' ? `<td class="small">${loginCell(e)}</td>` : ''}
          <td><button class="btn sm" data-action="emp-edit" data-id="${e.id}">Edit</button></td></tr>`; }).join('') || '<tr><td colspan="10" class="empty">No employees yet.</td></tr>'}
      </tbody></table></div></div>`;
    },
  };

  function statusBadge(e) {
    if (e.status === 'active') return '<span class="badge ok">Active</span>';
    if (e.status === 'trainee') return `<span class="badge ${e.soloCleared ? 'info' : 'warn'}">Trainee${e.soloCleared ? ' · solo' : ' · CTO'}</span>`;
    if (e.status === 'leave') return '<span class="badge bad">Extended leave</span>';
    return '<span class="badge">Separated</span>';
  }

  // ---------------------------------------------------- login accounts
  App.users = null;
  function loadUsers() {
    App.api('GET', '/api/users').then((r) => { App.users = r.users; App.render(); }).catch(() => { App.users = []; });
  }
  function loginCell(e) {
    if (App.users === null) { loadUsers(); return '…'; }
    const u = App.users.find((x) => x.employeeId === e.id);
    if (!u) return `<button class="btn sm" data-action="user-create" data-emp="${e.id}">Create login</button>`;
    return `${esc(u.username)} <span class="badge ${u.disabled ? 'bad' : u.role === 'employee' ? '' : 'info'}">${u.disabled ? 'disabled' : esc(u.role)}</span>
      <button class="btn sm ghost" data-action="user-reset" data-id="${u.id}" title="Reset password">↻</button>
      <button class="btn sm ghost" data-action="user-toggle" data-id="${u.id}" data-dis="${u.disabled ? 0 : 1}" title="${u.disabled ? 'Enable' : 'Disable'}">${u.disabled ? '✓' : '⦸'}</button>`;
  }
  function showTemp(r, what) {
    App.modal({ title: what, body: `<p>Username: <b>${esc(r.user.username)}</b></p><p>Temporary password: <code style="font-size:1.2em">${esc(r.tempPassword)}</code></p><p class="small muted">Give this to the employee privately. They must choose a new password when they first sign in. It won't be shown again.</p>`, footer: '<button class="btn primary" data-action="modal-close">Done</button>' });
    loadUsers();
  }
  App.actions['user-create'] = (el) => {
    const e = App.emp(el.dataset.emp);
    const suggested = (e.firstName[0] + e.lastName).toLowerCase().replace(/[^a-z0-9]/g, '');
    App.modal({
      title: `Create login — ${P.empName(e)}`,
      body: `<div class="form-grid"><div class="field"><label>Username</label><input name="username" value="${esc(suggested)}"></div>
        <div class="field"><label>Role</label><select name="role"><option value="employee">Employee</option>${App.isAdmin() ? '<option value="supervisor"' + (e.positionId === 'pos_sup' ? ' selected' : '') + '>Supervisor</option><option value="admin">Admin</option>' : ''}</select></div></div>
        <p class="small muted">A temporary password is generated. Supervisors can manage schedules and approve requests; admins can also manage supervisor accounts and import data.</p>`,
      footer: `<button class="btn" data-action="modal-close">Cancel</button><button class="btn primary" data-action="user-create-go" data-emp="${e.id}">Create</button>`,
    });
  };
  App.actions['user-create-go'] = (el) => {
    const f = App.modalForm();
    App.api('POST', '/api/users', { username: f.username, role: f.role, employeeId: el.dataset.emp }).then((r) => showTemp(r, 'Login created')).catch((e) => App.toast(e.message, true));
  };
  App.actions['user-reset'] = (el) => App.confirm('Reset this password? The person will be signed out everywhere.', () =>
    App.api('POST', '/api/users/' + el.dataset.id, { resetPassword: true }).then((r) => showTemp(r, 'Password reset')).catch((e) => App.toast(e.message, true)), 'Reset');
  App.actions['user-toggle'] = (el) => App.api('POST', '/api/users/' + el.dataset.id, { disabled: el.dataset.dis === '1' }).then(() => { App.toast(el.dataset.dis === '1' ? 'Login disabled' : 'Login enabled'); loadUsers(); }).catch((e) => App.toast(e.message, true));

  /** Turn an implicit class (a console without a job class) into a saved one. */
  function ensureClass(s2, id) {
    let jc = s2.jobClasses.find((c) => c.id === id);
    if (jc) return jc;
    const implicit = P.jobClasses(s2).find((c) => c.id === id);
    if (!implicit) return null;
    jc = { id: implicit.positionIds.length === 1 ? 'jc_' + implicit.positionIds[0] : P.uid('jc'), name: implicit.name, positionIds: implicit.positionIds.slice(), authorized: implicit.authorized, authorizedPartTime: implicit.authorizedPartTime, maxOffPerDay: implicit.maxOffPerDay };
    if (s2.jobClasses.some((c) => c.id === jc.id)) jc.id = P.uid('jc');
    s2.jobClasses.push(jc);
    return jc;
  }
  App.changes['jc-field'] = (el) => App.commit((s2) => {
    const jc = ensureClass(s2, el.dataset.id);
    if (!jc) return;
    const f = el.dataset.f;
    if (f === 'name') jc.name = el.value || jc.name;
    else if (f === 'maxOffPerDay') jc.maxOffPerDay = el.value === '' ? null : Math.max(0, +el.value);
    else jc[f] = Math.max(0, +el.value || 0);
  }, 'Job class saved');
  App.actions['jc-add'] = () => App.commit((s2) => s2.jobClasses.push({ id: P.uid('jc'), name: 'New job class', positionIds: [], authorized: 0, authorizedPartTime: 0, maxOffPerDay: null }), 'Job class added. Assign consoles to it below.');
  App.actions['jc-del'] = (el) => {
    const st = S();
    const jc = P.jobClassById(st, el.dataset.id);
    const n = P.classMembers(st, jc, true).length;
    if (n) return App.toast(`Move its ${n} employee(s) to another job class first`, true);
    App.commit((s2) => { s2.jobClasses = s2.jobClasses.filter((c) => c.id !== el.dataset.id); }, 'Job class deleted');
  };
  App.changes['pos-class'] = (el) => App.commit((s2) => {
    const pid = el.dataset.id;
    let target = el.value === '__new' ? null : ensureClass(s2, el.value);
    // Make every current class explicit so the move can't change the others.
    for (const c of P.jobClasses(s2)) ensureClass(s2, c.id);
    if (!target) {
      const p = s2.positions.find((x) => x.id === pid);
      target = { id: P.uid('jc'), name: p ? p.name : 'New job class', positionIds: [], authorized: 0, authorizedPartTime: 0, maxOffPerDay: null };
      s2.jobClasses.push(target);
    } else target = s2.jobClasses.find((c) => c.id === target.id);
    for (const c of s2.jobClasses) c.positionIds = (c.positionIds || []).filter((x) => x !== pid);
    target.positionIds.push(pid);
  }, 'Console moved');
  App.changes['staff-inactive'] = (el) => { App.ui.staff.showInactive = el.checked; App.render(); };
  App.changes['pos-field'] = (el) => App.commit((s) => {
    const p = s.positions.find((x) => x.id === el.dataset.id);
    p[el.dataset.f] = el.type === 'checkbox' ? el.checked : el.type === 'number' ? +el.value : el.value;
  });
  App.actions['pos-add'] = () => App.commit((s) => {
    const id = P.uid('pos');
    s.positions.push({ id, name: 'New console', isConsole: true });
    s.minimums[id] = Array.from({ length: 7 }, () => new Array(24).fill(0));
  }, 'Console added');
  App.actions['pos-del'] = (el) => {
    const n = S().employees.filter((e) => P.qualifiedFor(e, el.dataset.id)).length;
    App.confirm(`Delete this console and its minimum staffing grid?${n ? ` It will be removed from ${n} employee(s)' certifications.` : ''}`, () => App.commit((s) => {
      for (const e of s.employees) {
        if (e.positionId === el.dataset.id) e.positionId = null;
        e.qualifications = (e.qualifications || []).filter((q) => q !== el.dataset.id);
      }
      for (const l of s.lines) if (l.positionId === el.dataset.id) l.positionId = null;
      s.positions = s.positions.filter((p) => p.id !== el.dataset.id);
      delete s.minimums[el.dataset.id];
      for (const c of s.jobClasses) c.positionIds = (c.positionIds || []).filter((x) => x !== el.dataset.id);
    }, 'Console deleted'), 'Delete');
  };

  App.actions['emp-edit'] = (el) => {
    const st = S();
    const e = el.dataset.id ? App.emp(el.dataset.id) : { id: '', firstName: '', lastName: '', badge: '', jobClassId: (P.jobClasses(st)[0] || {}).id || null, positionId: null, status: 'active', hireDate: P.fmtDate(P.todayNum()), seniorityDate: P.fmtDate(P.todayNum()), hourlyRate: 20, soloCleared: true, qualifications: [], phone: '', notes: '' };
    App.modal({
      title: e.id ? `Edit ${P.empName(e)}` : 'New employee',
      body: `<div class="form-grid">
        <div class="field"><label>First name</label><input name="firstName" value="${esc(e.firstName)}" required></div>
        <div class="field"><label>Last name</label><input name="lastName" value="${esc(e.lastName)}" required></div>
        <div class="field"><label>Badge / employee #</label><input name="badge" value="${esc(e.badge)}"></div>
        <div class="field"><label>Job class</label><select name="jobClassId">${App.opts(P.jobClasses(st), (P.empClass(st, e) || {}).id || '')}</select></div>
        <div class="field"><label>Preferred console (optional)</label><select name="positionId"><option value="">None</option>${App.opts(st.positions, e.positionId || '')}</select></div>
        <div class="field"><label>Status</label><select name="status">${App.opts(P.STATUSES, e.status, (s) => s.label)}</select></div>
        <div class="field"><label>Employment</label><select name="employmentType"><option value="full">Full-time</option><option value="part" ${P.isPartTime(e) ? 'selected' : ''}>Part-time</option></select></div>
        <div class="field"><label>Part-time weekly cap (h)</label><input type="number" step="0.5" min="1" max="40" name="maxWeeklyHours" value="${esc(e.maxWeeklyHours ?? '')}" placeholder="${esc(st.center.partTimeDefaultCap)}"></div>
        <div class="field"><label class="check" style="margin-top:22px"><input type="checkbox" name="soloCleared" ${e.soloCleared ? 'checked' : ''}> Solo-cleared (counts toward minimums)</label></div>
        <div class="field"><label>Hire date</label><input type="date" name="hireDate" value="${esc(e.hireDate)}"></div>
        <div class="field"><label>Seniority date (bid order)</label><input type="date" name="seniorityDate" value="${esc(e.seniorityDate)}"></div>
        <div class="field"><label>Hourly rate ($)</label><input type="number" step="0.01" name="hourlyRate" value="${esc(e.hourlyRate)}"></div>
        <div class="field"><label>Mobile phone</label><input name="phone" value="${esc(e.phone)}"></div>
        <div class="field"><label>Email</label><input type="email" name="email" value="${esc(e.email || '')}"></div>
        <div class="field"><label class="check" style="margin-top:22px"><input type="checkbox" name="textOptIn" ${e.textOptIn ? 'checked' : ''}> OK to text open shifts</label></div>
      </div>
      <p class="small muted" style="margin:0 0 10px">Part-time: extra shifts at straight time, capped weekly hours (blank cap = center default of ${esc(st.center.partTimeDefaultCap)} h), never forced.</p>
      <div class="field"><label>Certified on (the consoles they can work; the preferred console is always included)</label><div class="pill-list">${st.positions.map((p) => `<label class="check"><input type="checkbox" data-multi="1" name="qualifications" value="${p.id}" ${P.qualifiedFor(e, p.id) ? 'checked' : ''}> ${esc(p.name)}</label>`).join('')}</div></div>
      <div class="field"><label>Notes</label><textarea name="notes" rows="2" style="width:100%">${esc(e.notes)}</textarea></div>`,
      footer: `${e.id ? `<button class="btn danger" data-action="emp-del" data-id="${e.id}" style="margin-right:auto">Delete</button>` : ''}<button class="btn" data-action="modal-close">Cancel</button><button class="btn primary" data-action="emp-save" data-id="${e.id}">Save</button>`,
    });
  };
  App.actions['emp-save'] = (el) => {
    const f = App.modalForm();
    if (!f.firstName || !f.lastName) return App.toast('Name is required', true);
    f.hourlyRate = +f.hourlyRate || 0;
    if (f.employmentType !== 'part') { f.employmentType = 'full'; f.maxWeeklyHours = null; }
    else f.maxWeeklyHours = f.maxWeeklyHours === '' ? null : Math.min(40, Math.max(1, +f.maxWeeklyHours));
    if (!f.jobClassId) return App.toast('Choose a job class', true);
    f.positionId = f.positionId || null;
    f.qualifications = [...new Set([f.positionId, ...(f.qualifications || [])].filter(Boolean))];
    if (!f.qualifications.length) return App.toast('Tick at least one console they are certified on', true);
    App.commit((s) => {
      if (el.dataset.id) Object.assign(s.employees.find((x) => x.id === el.dataset.id), f);
      else s.employees.push(Object.assign({ id: P.uid('emp') }, f));
    }, 'Employee saved');
    App.closeModal();
  };
  App.actions['emp-del'] = (el) => App.confirm('Delete this employee permanently? Their leave and OT history will also be removed. (To keep history, set status to "Separated" instead.)', () => App.commit((s) => {
    const id = el.dataset.id;
    s.employees = s.employees.filter((e) => e.id !== id);
    s.exceptions = s.exceptions.filter((x) => x.employeeId !== id);
    s.fills = s.fills.filter((x) => x.employeeId !== id);
    for (const l of s.lines) if (l.employeeId === id) l.employeeId = null;
  }, 'Employee deleted'), 'Delete');
})();
