# PSAP Scheduler

A 24x7 scheduling tool built for emergency communications centers / PSAPs:
minimum console staffing, authorized vs. current strength, call-outs and
openings, real-time and predicted overtime, and shift bidding. It supports 8-, 10-
and 12-hour schedules, or a mix of them.

## Running it

No install or server needed. Open `index.html` in Chrome, Edge or Firefox.
It starts with **demo data** (a fictional 28-seat center) so you can explore.
Go to **Settings → Data → Start empty** when you're ready to enter your own center.

Data is saved in the browser's local storage on that computer. Use
**Settings → Export backup** regularly. (A shared, multi-user version needs a
server and database; see "Roadmap".)

Run the engine tests with `npm test` (Node 18+).

## What it does

| Page | Purpose |
|---|---|
| **Dashboard** | Who's on now vs. minimum, next-24-hour coverage strip, authorized/filled/vacant, open shifts, OT to date and projected vs. budget. Quick "record call-out" that goes straight to finding a backfill. |
| **Schedule** | 1/2/4-week grid of every employee's shifts, leave, pending requests and OT. Click any cell to record a sick call, time off, training (full or partial shift, multi-day) or an OT/extra shift. Shows uncovered hours per day. Printable. |
| **Coverage** | Hour-by-hour heatmap of staffed vs. minimum for each position. Red cells open the fill dialog. |
| **Openings** | Every hour below minimum, grouped into fillable slots with the cause (call-out, vacation, FMLA, training, or structural). The **fill dialog** ranks candidates by a voluntary list (holdover/early-in first, then fewest OT hours) or a mandatory/force list (least recently forced, then least senior). It enforces rest and max-continuous-hour rules, warns on 7-day fatigue hours, and shows the OT cost each person would add. Pending time-off requests show their **coverage impact before you approve**. |
| **Overtime** | Current period actual and predicted, FY to date, run-rate projection vs. budget, committed OT (built into the rotation plus already scheduled), and unfilled-opening exposure. Includes a cost-per-period chart, OT by reason, OT by employee (including forced counts), an assignment log and CSV export. |
| **Lines & Bid** | Lines = shift + rotation pattern + start date. Generate lines in teams, assign people, and run a **seniority shift bid** (pick, skip, reorder, auto-assign). The bid shows a live coverage preview and applies on an effective date, which is how you switch 8s → 12s (or any mix) while keeping history. |
| **Staff** | Employees, positions, authorized strength, trainee/CTO status (non-solo trainees don't count toward minimums), cross-training, and an estimate of what vacancies cost if backfilled with OT. |
| **Planner** | Relief factor and FTE needed per schedule type against your minimums. Shows built-in OT per pattern under your OT rule, including how much it changes with rotation/work-week alignment. |
| **Settings** | OT rules (period length, threshold, multiplier, "extra shifts always OT", leave counts toward OT), fatigue rules, hour-by-day minimum grid per position, special-day minimums (holidays, NYE, storms), shift templates, rotation patterns (including rotating ones like DuPont), and backup/import. |

## How the numbers work

- **Coverage** is computed per hour: scheduled lines − approved leave + OT fills,
  counting only active staff and solo-cleared trainees. Night shifts belong to the
  day they start.
- **OT** is computed per employee per OT period: hours worked (regular + extra +
  "worked" leave such as training) over the threshold × rate × multiplier.
  Optional rules: extra shifts always paid as OT, and paid leave counting toward
  the threshold.
- **Projection** = FY actual to date + (last-28-day daily OT rate × days left in the FY).
  **Committed** = OT already locked in by the rotation and scheduled fills.
  **Exposure** = open slots × average rate × multiplier.

## Code layout

```
index.html          app shell
css/styles.css      styles (dark default, light toggle, print)
js/core.js          scheduling/coverage/OT/bid engine — no DOM, unit tested
js/app.js           storage, routing, modals, helpers
js/views/*.js       one file per page
tests/core.test.js  engine tests (node --test)
```

## Roadmap / open questions

See the questions raised with the center before the next iteration: OT rule details,
multi-user hosting, CAD/payroll/telephony integrations, minimum-staffing source data,
and policy rules (force order, holiday pay, shift trades).
