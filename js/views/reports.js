/* Reports: the pages a scheduler doesn't need every day. */
(function () {
  'use strict';
  const { esc } = App;
  const PAGES = [
    ['coverage', 'Coverage', 'Staffed vs. minimum for every hour of the next weeks, by console. Click a red cell to fill it.'],
    ['consoles', 'Consoles', 'Who sits where each hour of a scheduling day; pin someone to a console for their shift.'],
    ['overtime', 'Overtime', 'This week actual vs. predicted, fiscal year to date, projection against budget, by reason and by person.'],
    ['planner', 'Planner', 'How many people each kind of schedule needs for your minimums (FTE and relief factor).'],
  ];
  App.views.reports = {
    render() {
      return `<div class="page-head"><div><h1>Reports</h1><p>Details behind the day-to-day pages.</p></div></div>
        <div class="grid g2">${PAGES.map(([id, name, text]) => `<a class="panel report-card" href="#/${id}"><h2>${esc(name)}</h2><p class="small muted" style="margin:0">${esc(text)}</p></a>`).join('')}</div>`;
    },
  };
})();
