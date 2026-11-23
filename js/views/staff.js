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
        .sort((a, b) => String(a.positionId).localeCompare(b.positionId) || P.parseDate(a.seniorityDate || a.hireDate || '2000-01-01') - P.parseDate(b.seniorityDate || b.hireDate || '2000-01-01'));
      const lineOf = (e) => st.lines.find((l) => l.employeeId === e.id && P.lineActiveOn(l, today));
      const vacancyCost = sum.reduce((s, r) => s + r.vacancies * 2080 * P.avgRate(st, r.position.id) * (+st.center.otMultiplier || 1.5), 0);
      return `<div class="page-head"><div><h1>Staff & authorized strength</h1><p>Authorized positions vs. who you actually have. Schedules and minimum checks use current staff only.</p></div>
        <div class="toolbar"><label class="check"><input type="checkbox" ${ui.staff.showInactive ? 'checked' : ''} data-change="staff-inactive"> Show separated</label>
        <button class="btn primary" data-action="emp-edit">+ Employee</button></div></div>
      <div class="grid g2" style="margin-bottom:14px">
        <div class="panel"><h2>Positions</h2><table><thead><tr><th>Discipline</th><th class="num" title="Full-time positions">Authorized</th><th class="num">Full-time</th><th class="num">Vacant</th><th class="num" title="Part-time staff (full-time equivalent at their weekly caps)">Part-time</th><th class="num">Countable</th><th title="When short, lower numbers are staffed first">Fill priority</th><th title="Most people in this discipline on planned leave (vacation/comp/holiday) per day">Max off / day</th><th>Console seat</th><th></th></tr></thead><tbody>
          ${sum.map((r) => `<tr><td><input value="${esc(r.position.name)}" data-change="pos-field" data-id="${r.position.id}" data-f="name"></td>
            <td><input type="number" min="0" value="${r.authorized}" data-change="pos-field" data-id="${r.position.id}" data-f="authorized" style="width:80px"></td>
            <td class="num">${r.fullTime}</td><td class="num">${r.vacancies ? `<span class="badge bad">${r.vacancies}</span>` : 0}</td>
            <td class="num">${r.partTime ? `${r.partTime} <span class="small muted">(${r.partFTE.toFixed(1)} FTE)</span>` : '—'}</td><td class="num">${r.countable}</td>
            <td><input type="number" min="1" value="${esc(r.position.priority ?? '')}" data-change="pos-field" data-id="${r.position.id}" data-f="priority" style="width:70px"></td>
            <td><input type="number" min="0" value="${esc((st.center.maxOffPerDay || {})[r.position.id] ?? '')}" data-change="max-off" data-id="${r.position.id}" style="width:70px" placeholder="none"></td>
            <td><input type="checkbox" ${r.position.isConsole ? 'checked' : ''} data-change="pos-field" data-id="${r.position.id}" data-f="isConsole"></td>
            <td><button class="btn sm danger" data-action="pos-del" data-id="${r.position.id}">✕</button></td></tr>`).join('')}
        </tbody></table><button class="btn sm" data-action="pos-add" style="margin-top:8px">+ Position</button></div>
        <div class="panel"><h2>What the vacancies cost</h2>
          <p>${sum.map((r) => `${esc(r.position.name)}: <b>${r.vacancies}</b> vacant`).join(' · ')}</p>
          <p class="small muted">Authorized counts are full-time positions. Part-timers are listed separately and don't fill a vacancy, but they work open shifts at straight time.</p>
          <p>If every vacant position's ~2,080 hrs/yr were backfilled with overtime: <b>${money(vacancyCost)}/yr</b> (at average rate × ${st.center.otMultiplier}).</p>
          <p class="small muted">A new hire at base rate costs roughly ${money(sum.reduce((s, r) => s + r.vacancies * 2080 * Math.min(...st.employees.filter((e) => e.positionId === r.position.id && +e.hourlyRate).map((e) => +e.hourlyRate).concat([P.avgRate(st, r.position.id) || 0])), 0))}/yr in wages for the same hours (before benefits and training time).</p></div>
      </div>
      <div class="panel"><div class="table-wrap"><table><thead><tr><th>Badge</th><th>Name</th><th>Position</th><th>Status</th><th>Seniority</th><th class="num">Rate</th><th>Current line</th><th>Also certified</th>${App.mode === 'server' ? '<th>Login</th>' : ''}<th></th></tr></thead><tbody>
        ${emps.map((e) => { const l = lineOf(e); return `<tr class="${e.status === 'inactive' ? 'dim' : ''}"><td>${esc(e.badge)}</td><td>${esc(P.empName(e))}</td><td>${esc(App.posName(e.positionId))}</td>
          <td>${statusBadge(e)}${P.isPartTime(e) ? ` <span class="badge info" title="Part-time, straight time, capped at ${P.partTimeCap(st, e)} h/week">PT ${P.partTimeCap(st, e)}h</span>` : ''}</td><td>${esc(e.seniorityDate || e.hireDate || '')}</td><td class="num">${money(+e.hourlyRate, 2)}</td>
          <td>${l ? esc(l.name) : '<span class="badge warn">none</span>'}</td><td class="small">${(e.qualifications || []).map((q) => esc(App.posName(q))).join(', ')}</td>
          ${App.mode === 'server' ? `<td class="small">${loginCell(e)}</td>` : ''}
          <td><button class="btn sm" data-action="emp-edit" data-id="${e.id}">Edit</button></td></tr>`; }).join('') || '<tr><td colspan="9" class="empty">No employees yet.</td></tr>'}
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

  App.changes['max-off'] = (el) => App.commit((s) => {
    s.center.maxOffPerDay = Object.assign({}, s.center.maxOffPerDay);
    if (el.value === '') delete s.center.maxOffPerDay[el.dataset.id]; else s.center.maxOffPerDay[el.dataset.id] = Math.max(0, +el.value);
  }, 'Leave limit saved');
  App.changes['staff-inactive'] = (el) => { App.ui.staff.showInactive = el.checked; App.render(); };
  App.changes['pos-field'] = (el) => App.commit((s) => {
    const p = s.positions.find((x) => x.id === el.dataset.id);
    p[el.dataset.f] = el.type === 'checkbox' ? el.checked : el.type === 'number' ? +el.value : el.value;
  });
  App.actions['pos-add'] = () => App.commit((s) => {
    const id = P.uid('pos');
    s.positions.push({ id, name: 'New position', authorized: 0, isConsole: false });
    s.minimums[id] = Array.from({ length: 7 }, () => new Array(24).fill(0));
  }, 'Position added');
  App.actions['pos-del'] = (el) => {
    const used = S().employees.some((e) => e.positionId === el.dataset.id);
    if (used) return App.toast('Move employees off this position first', true);
    App.confirm('Delete this position and its minimum staffing grid?', () => App.commit((s) => { s.positions = s.positions.filter((p) => p.id !== el.dataset.id); delete s.minimums[el.dataset.id]; }, 'Position deleted'), 'Delete');
  };

  App.actions['emp-edit'] = (el) => {
    const st = S();
    const e = el.dataset.id ? App.emp(el.dataset.id) : { id: '', firstName: '', lastName: '', badge: '', positionId: st.positions[0].id, status: 'active', hireDate: P.fmtDate(P.todayNum()), seniorityDate: P.fmtDate(P.todayNum()), hourlyRate: 20, soloCleared: true, qualifications: [], phone: '', notes: '' };
    App.modal({
      title: e.id ? `Edit ${P.empName(e)}` : 'New employee',
      body: `<div class="form-grid">
        <div class="field"><label>First name</label><input name="firstName" value="${esc(e.firstName)}" required></div>
        <div class="field"><label>Last name</label><input name="lastName" value="${esc(e.lastName)}" required></div>
        <div class="field"><label>Badge / employee #</label><input name="badge" value="${esc(e.badge)}"></div>
        <div class="field"><label>Position</label><select name="positionId">${App.opts(st.positions, e.positionId)}</select></div>
        <div class="field"><label>Status</label><select name="status">${App.opts(P.STATUSES, e.status, (s) => s.label)}</select></div>
        <div class="field"><label>Employment</label><select name="employmentType"><option value="full">Full-time</option><option value="part" ${P.isPartTime(e) ? 'selected' : ''}>Part-time (no OT, capped hours)</option></select></div>
        <div class="field"><label>Part-time weekly cap (h)</label><input type="number" step="0.5" min="1" max="40" name="maxWeeklyHours" value="${esc(e.maxWeeklyHours ?? '')}" placeholder="${esc(st.center.partTimeDefaultCap)}"></div>
        <div class="field"><label class="check" style="margin-top:22px"><input type="checkbox" name="soloCleared" ${e.soloCleared ? 'checked' : ''}> Solo-cleared (counts toward minimums)</label></div>
        <div class="field"><label>Hire date</label><input type="date" name="hireDate" value="${esc(e.hireDate)}"></div>
        <div class="field"><label>Seniority date (bid order)</label><input type="date" name="seniorityDate" value="${esc(e.seniorityDate)}"></div>
        <div class="field"><label>Hourly rate ($)</label><input type="number" step="0.01" name="hourlyRate" value="${esc(e.hourlyRate)}"></div>
        <div class="field"><label>Mobile phone</label><input name="phone" value="${esc(e.phone)}"></div>
        <div class="field"><label>Email</label><input type="email" name="email" value="${esc(e.email || '')}"></div>
        <div class="field"><label class="check" style="margin-top:22px"><input type="checkbox" name="textOptIn" ${e.textOptIn ? 'checked' : ''}> OK to text open shifts</label></div>
      </div>
      <div class="field"><label>Also certified on (cross-training — they can be placed on these consoles)</label><div class="pill-list">${st.positions.map((p) => `<label class="check"><input type="checkbox" data-multi="1" name="qualifications" value="${p.id}" ${(e.qualifications || []).includes(p.id) ? 'checked' : ''}> ${esc(p.name)}</label>`).join('')}</div></div>
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
    f.qualifications = (f.qualifications || []).filter((q) => q !== f.positionId);
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
