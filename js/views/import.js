/* Import an existing schedule (Lines & Bid → Import schedule). */
(function () {
  'use strict';
  const { P, esc, hrs } = App;
  const I = window.PSAPImport;

  const fresh = () => ({ text: '', year: '', grid: null, match: {}, codes: [], codeMap: {}, name: '', error: '' });
  App.ui.imp = fresh();

  const mappingValue = (m) => !m ? 'ignore' : m.kind === 'shift' ? 'tpl:' + m.templateId : m.kind === 'leave' ? 'leave:' + m.leaveType : m.kind === 'newShift' ? 'new' : m.kind;
  function mappingFrom(value, guess) {
    if (value === 'off' || value === 'ignore') return { kind: value };
    if (value === 'new') return guess && guess.kind === 'newShift' ? guess : { kind: 'ignore' };
    if (value.startsWith('tpl:')) return { kind: 'shift', templateId: value.slice(4) };
    if (value.startsWith('leave:')) return { kind: 'leave', leaveType: value.slice(6) };
    return { kind: 'ignore' };
  }

  App.importTab = function (st) {
    const u = App.ui.imp;
    const history = (st.scheduleImports || []).slice().sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    const step1 = `<div class="panel"><h2>1. Paste or upload your current schedule</h2>
      <p class="small muted" style="margin:0 0 8px">In your spreadsheet, select the whole grid (names down the side, dates across the top, a code in each cell) and copy it, then paste below. Or upload the sheet saved as CSV. Extra rows (titles, weekdays, totals) are fine.</p>
      <textarea id="imp-text" rows="8" style="width:100%;font-family:var(--mono, monospace);font-size:12px" placeholder="Name&#9;Badge&#9;Sun 12/27&#9;Mon 12/28&#9;…&#10;Adams, Ava&#9;1001&#9;D&#9;D&#9;OFF …" data-change="imp-text">${esc(u.text)}</textarea>
      <div class="toolbar" style="margin-top:8px">
        <label class="btn">Upload CSV<input type="file" accept=".csv,.txt,.tsv,text/csv,text/plain" data-change="imp-file" hidden></label>
        <label class="small muted" style="margin:0">Year of the first date (only if your dates have no year) <input id="imp-year" value="${esc(u.year)}" placeholder="auto" style="width:80px"></label>
        <button class="btn primary" data-action="imp-read">Read schedule</button>
        ${u.grid ? '<button class="btn" data-action="imp-reset">Start over</button>' : ''}
      </div>
      ${u.error ? `<div class="callout bad" style="margin-top:8px">${esc(u.error)}</div>` : ''}</div>`;

    let rest = '';
    if (u.grid) {
      const g = u.grid;
      const emps = st.employees.filter((e) => e.status !== 'inactive').sort((a, b) => P.empName(a).localeCompare(P.empName(b)));
      const matchedIds = Object.values(u.match).filter(Boolean);
      const dupIds = new Set(matchedIds.filter((id, i) => matchedIds.indexOf(id) !== i));
      const peopleRows = g.people.map((p, i) => {
        const id = u.match[i] || '';
        const n = Object.keys(p.cells).length;
        return `<tr class="${id ? '' : 'dim'}"><td>${esc(p.name || '—')}${p.badge ? ` <span class="small muted">#${esc(p.badge)}</span>` : ''}</td><td class="num">${n}</td>
          <td><select data-change="imp-match" data-i="${i}"><option value="">Skip this row</option>${App.opts(emps, id, (e) => `${P.empName(e)}${e.badge ? ' #' + e.badge : ''}`)}</select>
          ${id && dupIds.has(id) ? ' <span class="badge bad">matched twice</span>' : ''}${id && u.auto[i] && u.auto[i] === id ? ' <span class="badge ok">auto</span>' : ''}</td>
          <td class="small">${id ? esc((P.empClass(st, emps.find((e) => e.id === id)) || {}).name || '') : ''}</td></tr>`;
      }).join('');
      const tplOpts = st.shiftTemplates.map((t) => ({ v: 'tpl:' + t.id, l: `Shift: ${t.code} ${t.start.replace(':', '')} ${t.hours}h` }));
      const leaveOpts = P.EXCEPTION_TYPES.filter((t) => !t.system).map((t) => ({ v: 'leave:' + t.id, l: `Leave: ${t.label}` }));
      // Count codes only in rows matched to someone (totals and skipped rows don't count).
      const usedCount = {};
      g.people.forEach((p, i) => { if (u.match[i]) for (const v of Object.values(p.cells)) { const k = I.codeKey(v); usedCount[k] = (usedCount[k] || 0) + 1; } });
      const codeRows = u.codes.filter((c) => usedCount[c.key]).map((c) => {
        const cur = mappingValue(u.codeMap[c.key]);
        const opts = [{ v: 'off', l: 'Off' }, { v: 'ignore', l: 'Not sure — treat as off' }]
          .concat(c.mapping.kind === 'newShift' ? [{ v: 'new', l: `New shift ${P.mil(c.mapping.start)}–${P.mil(c.mapping.start + c.mapping.hours * 60)} (${c.mapping.hours}h)` }] : [])
          .concat(tplOpts, leaveOpts);
        const who = g.people.filter((p, i) => u.match[i] && Object.values(p.cells).some((v) => I.codeKey(v) === c.key)).slice(0, 3).map((p) => p.name).join(', ');
        const unsure = cur === 'ignore';
        return `<tr class="${unsure ? 'warn-row' : ''}"><td><code>${esc(c.code)}</code></td><td class="num">${usedCount[c.key]}</td>
          <td><select data-change="imp-code" data-k="${esc(c.key)}">${opts.map((o) => `<option value="${esc(o.v)}"${o.v === cur ? ' selected' : ''}>${esc(o.l)}</option>`).join('')}</select>${unsure ? ' <span class="badge warn">check</span>' : ''}</td>
          <td class="small muted">${esc(who)}</td></tr>`;
      }).join('');
      // What will happen.
      const built = I.buildImport(st, g, u.match, u.codeMap, { name: u.name });
      const s = built.stats;
      const after = g.to + 1;
      const noLineAfter = built.record.employeeIds.filter((id) => !st.lines.some((l) => l.employeeId === id && P.lineActiveOn(l, after)));
      const overlaps = (st.scheduleImports || []).filter((im) => P.parseDate(im.to) >= g.from && P.parseDate(im.from) <= g.to);
      rest = `<div class="panel"><h2>2. Match people <span class="small muted">${g.people.length} rows · ${P.shortDate(g.from)} ${P.fmtDate(g.from).slice(0, 4)} → ${P.shortDate(g.to)} ${P.fmtDate(g.to).slice(0, 4)} (${g.to - g.from + 1} days)</span></h2>
          <div class="table-wrap" style="max-height:420px"><table><thead><tr><th>In your schedule</th><th class="num">Days</th><th>Employee</th><th>Job class</th></tr></thead><tbody>${peopleRows}</tbody></table></div>
          <p class="small muted">Rows set to "Skip" (totals, notes, people not in the system) are left out. Add missing people on the Staff page, then press Read schedule again.</p></div>
        <div class="panel"><h2>3. What the codes mean</h2>
          <div class="table-wrap" style="max-height:420px"><table><thead><tr><th>Code</th><th class="num">Cells</th><th>Means</th><th>Used by</th></tr></thead><tbody>${codeRows}</tbody></table></div>
          <p class="small muted">Leave codes become approved leave on the person's usual shift, so leave hours and coverage come out right. Times like 0700-1900 match an existing shift or create a new one.</p></div>
        <div class="panel"><h2>4. Import</h2>
          <div class="form-grid"><div class="field"><label>Name</label><input id="imp-name" value="${esc(u.name || built.record.name)}"></div></div>
          <ul>
            <li><b>${s.people}</b> people, <b>${s.shifts}</b> shifts, <b>${s.leave}</b> leave days, ${s.off} days off${s.unknown ? `, <b>${s.unknown}</b> cells with codes marked "not sure" (treated as off)` : ''}.</li>
            <li>For these people from ${P.fmtDate(g.from)} to ${P.fmtDate(g.to)}, the imported schedule <b>replaces their lines</b>. Leave, call-outs and OT you enter afterwards work as usual.</li>
            <li>From ${P.fmtDate(after)}, their lines take over again.${noLineAfter.length ? ` <span class="badge warn">${noLineAfter.length} have no line then</span> — set up lines or a shift bid effective ${P.fmtDate(after)}.` : ''}</li>
            ${s.leaveWithoutShift ? `<li><span class="badge warn">${s.leaveWithoutShift}</span> leave days for people with no usual shift: recorded, but without leave hours.</li>` : ''}
            ${s.skippedPeople ? `<li>${s.skippedPeople} row(s) skipped.</li>` : ''}
            ${overlaps.length ? `<li><span class="badge info">Replaces</span> days from ${overlaps.map((im) => esc(im.name)).join(', ')} for the same people and dates.</li>` : ''}
          </ul>
          <button class="btn primary" data-action="imp-go" ${s.people ? '' : 'disabled'}>Import ${s.people} people</button></div>`;
    }

    const hist = history.length ? `<div class="panel"><h2>Imported schedules</h2><table><thead><tr><th>Name</th><th>Dates</th><th class="num">People</th><th class="num">Shifts</th><th class="num">Leave</th><th>Imported</th><th></th></tr></thead><tbody>
      ${history.map((im) => `<tr><td>${esc(im.name)}</td><td class="nowrap">${esc(im.from)} → ${esc(im.to)}</td><td class="num">${(im.employeeIds || []).length}</td>
        <td class="num">${(st.assignments || []).filter((a) => a.importId === im.id && !a.leave).length}</td><td class="num">${st.exceptions.filter((x) => x.importId === im.id).length}</td>
        <td class="small">${esc(new Date(im.createdAt).toLocaleString())}</td><td><button class="btn sm danger" data-action="imp-undo" data-id="${im.id}">Undo</button></td></tr>`).join('')}
      </tbody></table><p class="small muted">Undo removes that import's days and leave; those people's lines apply again for those dates.</p></div>` : '';

    return `<div class="grid">${step1}${rest}${hist}</div>`;
  };

  App.changes['imp-text'] = (el) => { App.ui.imp.text = el.value; };
  App.changes['imp-file'] = (el) => {
    const file = el.files && el.files[0];
    if (!file) return;
    file.text().then((t) => { App.ui.imp.text = t; App.actions['imp-read'](); }).catch((e) => App.toast('Could not read file: ' + e.message, true));
  };
  App.actions['imp-read'] = () => {
    const u = App.ui.imp;
    const ta = document.getElementById('imp-text');
    if (ta) u.text = ta.value;
    const y = document.getElementById('imp-year');
    u.year = y ? y.value.trim() : u.year;
    u.error = '';
    const rows = I.parseTable(u.text);
    if (!rows.length) { u.error = 'Nothing to read — paste the schedule grid first.'; u.grid = null; return App.render(); }
    const g = I.detectGrid(rows, { year: u.year || null });
    if (g.error) { u.error = g.error; u.grid = null; return App.render(); }
    if (!g.people.length) { u.error = 'Found the dates, but no rows with names and codes under them.'; u.grid = null; return App.render(); }
    const st = App.S;
    const m = I.matchPeople(st, g.people);
    u.grid = g;
    u.match = {}; u.auto = {};
    for (const [i, x] of Object.entries(m)) { u.match[i] = x.employeeId; u.auto[i] = x.employeeId; }
    u.codes = I.guessCodes(st, g);
    u.codeMap = {};
    for (const c of u.codes) u.codeMap[c.key] = c.mapping;
    u.name = '';
    App.render();
  };
  App.actions['imp-reset'] = () => { App.ui.imp = fresh(); App.render(); };
  App.changes['imp-match'] = (el) => { App.ui.imp.match[el.dataset.i] = el.value || null; App.render(); };
  App.changes['imp-code'] = (el) => {
    const u = App.ui.imp;
    const guess = (u.codes.find((c) => c.key === el.dataset.k) || {}).mapping;
    u.codeMap[el.dataset.k] = mappingFrom(el.value, guess);
    App.render();
  };
  App.actions['imp-go'] = () => {
    const u = App.ui.imp;
    const nameEl = document.getElementById('imp-name');
    u.name = nameEl ? nameEl.value : u.name;
    const st = App.S;
    const built = I.buildImport(st, u.grid, u.match, u.codeMap, { name: u.name });
    const dup = Object.values(u.match).filter(Boolean);
    if (new Set(dup).size !== dup.length) return App.toast('Someone is matched to two rows — fix the "matched twice" rows first', true);
    App.confirm(`Import "${esc(built.record.name)}": ${built.stats.people} people, ${built.stats.shifts} shifts and ${built.stats.leave} leave days from ${built.record.from} to ${built.record.to}? Their lines won't apply on those dates.`, () => {
      App.commit((s) => I.applyImport(s, built), `Imported ${built.stats.people} people`);
      App.ui.imp = fresh();
    }, 'Import');
  };
  App.actions['imp-undo'] = (el) => {
    const im = (App.S.scheduleImports || []).find((x) => x.id === el.dataset.id);
    App.confirm(`Undo "${esc(im ? im.name : '')}"? Its days and leave are removed and people's lines apply again for ${esc(im ? im.from + ' to ' + im.to : 'those dates')}.`, () => App.commit((s) => I.undoImport(s, el.dataset.id), 'Import undone'), 'Undo import');
  };
})();
