# PSAP Scheduler

Scheduling for emergency communications centers: 24x7 console coverage,
authorized vs. current staffing, call-outs and openings, real-time and predicted
overtime, shift trades, OT sign-up, shift bids and vacation bids. It supports 8-, 10-
and 12-hour schedules or a mix, all built for non-exempt staff on a **7-day / 40-hour**
overtime rule.

## Two ways to run it

**1. Multi-user server (normal use).** Supervisors and employees each sign in.

Requirements: Node.js 22.13 or newer (Windows or Linux). Nothing else is needed:
no `npm install` and no database server. Data lives in one SQLite file.

```bash
npm start
```

On first start it creates the `admin` account and prints a temporary password
(or set `ADMIN_PASSWORD`). Open `http://<server>:8080`, sign in as admin, then
use **Staff** to add employees and create their logins.

To try it with a demo center and accounts for every demo employee (all use the
password `demo-password`):

```bash
npm run demo
```

The demo center has Law and Fire/EMS consoles plus a supervisor console, 17
Telecommunicators (9 days, 8 nights) and 5 Supervisors on the 0700/1900 rotation,
and 3 part-timers. Sign in as `rreed` (supervisor) or `aadams` (employee).

| Setting (environment variable) | Default | |
|---|---|---|
| `PORT` / `HOST` | `8080` / `0.0.0.0` | |
| `DATA_DIR` | `./data` | Holds `psap.db`. **Back this folder up nightly.** |
| `COOKIE_SECURE=1` | off | Set when served over HTTPS (it should be). |
| `ADMIN_PASSWORD` | random | Initial admin password. |
| `NOTIFY_WEBHOOK_URL` | none | Each notification is POSTed here as JSON (see below). |
| `SESSION_HOURS` | `168` | How long a sign-in lasts. |

**Windows Server:** see **[docs/WINDOWS.md](docs/WINDOWS.md)**. It has an install
script (Windows service + nightly backup), IIS HTTPS setup, updates and
troubleshooting. Settings can go in a `psap.config.json` file (see
`psap.config.example.json`) instead of environment variables.

**HTTPS:** put it behind the county's reverse proxy (IIS with URL Rewrite/ARR,
nginx, or an Azure/AWS load balancer) with a certificate, and set `COOKIE_SECURE=1`.

**Backups:** `npm run backup` (or `node server/backup.js <folder>`) makes a safe copy
while the server is running.

**2. Single computer.** Open `index.html` directly in a browser. Data stays in that
browser and there are no logins. Use **View as** in the top bar to preview what an
employee sees. This mode is good for trying things out or planning scenarios.

## Roles

| Role | Can |
|---|---|
| **Employee** | See their schedule and the center schedule; request time off; propose, accept or decline shift trades; sign up for posted OT; pick in shift and vacation bids on their turn; get notifications. They can't see coworkers' pay or why coworkers are off sick (sick, FMLA and injury show only as "Off"). |
| **Supervisor** | Everything on the schedule: record call-outs, approve requests and trades, fill or post openings, run bids, set console pins, manage employee logins, view the audit log. |
| **Admin** | All of the above, plus creating supervisor/admin accounts and importing/exporting all data. |

Every change is recorded in the audit log: who made it, when, and the record before
and after. That matters for grievances and payroll disputes.

## Features

- **Job classes and consoles.** A person's position is their *job class* (e.g.
  Telecommunicator, Supervisor). Job classes hold authorized full-time and part-time
  positions, vacancies, the daily leave limit, lines and bids. *Consoles* (e.g. Law,
  Fire/EMS) are only where people sit each hour. Each person has a job class, the
  consoles they're certified on, and optionally a preferred console that only breaks
  ties. Lines belong to a job class, so nobody is tied to a console by their line.
- **Console coverage.** Minimum staffing per hour and day for each console, with
  special-day overrides. Each hour, the people on duty are placed on consoles by
  certification, filling consoles in *fill priority* order. Openings are per console;
  anyone in any job class who is certified on that console can fill one.
  The **Consoles** page prints the assignment sheet; supervisors can pin a person to
  one console for a shift.
- **Part-time staff.** Marked part-time with a weekly hour cap (default 32). Extra
  shifts are straight time; eligible part-timers are offered open shifts first
  (setting) and are never forced; the fill list blocks going over the cap. The
  Overtime page shows hours they covered and the OT that saved.
- **Staffing levels.** Authorized vs. filled vs. vacant per job class for full-time
  positions, with part-time positions as a separate count (PT authorized, filled,
  FTE), trainee/CTO
  status (trainees not yet solo-cleared don't count), and the OT cost of vacancies.
- **Openings.** Every hour below minimum, its cause (call-out, vacation, FMLA,
  training, structural) and its OT cost. Fill it directly from a ranked list:
  - Voluntary order: holdover/early-in first, then fewest OT hours.
  - Force order: longest since any OT was worked, then least senior (or "longest since
    last forced"; set in Settings).
  - The list enforces rest and max-hour rules.
  - Or **post it**: eligible staff are notified and sign up. It goes to the first
    eligible volunteer, or a supervisor awards it in OT-list order.
- **Time off.** Employees request leave; supervisors see the coverage and OT impact
  before approving.
- **Shift trades.** Employee proposes (with an optional payback shift), the coworker
  accepts, a supervisor approves. The partner must be certified and free with proper
  rest. Trades are straight time (FLSA 7(p)(3)): the covering employee's hours are
  excluded from OT, and the original employee is credited.
- **Overtime.** OT after 40 h in the work week by default (configurable). Shows the
  current week actual vs. predicted, fiscal year to date, a projection against the
  budget, unfilled-opening exposure, OT by reason and by employee, and CSV export.
- **The rotation (default).** Three 12-hour shifts plus one 4-hour shift a week:
  exactly 40 hours in every work week, never more. People keep their shift (days stay
  days, nights stay nights); only days off move: one day later each week, through every
  combination (weekends included) over 7 weeks. The default base week never puts anyone
  on more than 3 days in a row. The 4-hour shift starts with the regular shift (day
  0700-1100, night 1900-2300) or falls during peak call volume; pick per job class in
  Settings (the peak hours are suggested from your minimums) or per line. Other 40-hour
  patterns (5×8, 4×10, 2×12 + 2×8) are under Settings → Advanced; any custom line that
  would build in OT is flagged.
- **Days in a row.** Nobody is scheduled more than 4 days in a row (the 4-hour shift
  counts as a day). A 5th only when a supervisor marks a day-off move as an emergency;
  it is flagged on the schedule. Extra shifts that would break the limit are flagged
  in the fill list.
- **Shift bid.** Per job class: generate the class's lines, bid in seniority order (employees pick on their own
  turn and are notified when it arrives), preview coverage across all consoles the
  class staffs, then apply on an effective date.
- **Import an existing schedule.** Lines & Bid → Import schedule. Paste the grid from
  your spreadsheet (names down the side, dates across the top, a code per cell) or
  upload a CSV. Names are matched to employees; codes are guessed (OFF, times like
  0700-1900, VAC/SL/TRN and other leave codes) and you confirm the rest. For the
  imported people and dates, the imported days replace their lines; leave codes
  become approved leave on their usual shift. Lines take over after the last
  imported date. Single days can be changed from the Schedule page; a whole import
  can be undone.
- **Scheduling day.** Consoles, Coverage and the Dashboard run from the scheduling
  day start (default: the earliest regular shift, e.g. 0700) to the same time next
  day, grouped by shift (e.g. 0700-1900, 1900-0700). Pins hold a person on a console
  for their shift on that scheduling day.
- **Staffing levels.** Effective staffing per job class = full-time filled, minus people
  on extended leave (FMLA, military, injury, LOA) and trainees not yet solo, plus
  part-time FTE (setting), as a % of authorized: Normal (≥90%), Short (75–89%),
  Critical (<75%), thresholds editable. Shown on the Dashboard and Staff page with a
  6-month outlook from solo dates and leave return dates; a notice appears when a
  level changes. Each level has its own relief margin and daily vacation limit.
- **Fix coverage** (Dashboard → Fix coverage). The tool runs the rotation; the scheduler
  reviews and approves. One short page answers three questions for the next few weeks:
  1. *Which shifts are short*, in plain words ("Fri nights are 1 short for 3 weeks").
  2. *Who can cover without overtime*: day-off moves first ("Have Smith work Fri
     instead of Tue?": same shift, same work week so still 40 hours, rest rules, the
     notice period and the days-in-a-row limit), then part-timers under their cap. When
     coverage allows, it also offers 4-hour shifts for training (a part-timer may cover
     the seat), never at the cost of overtime.
  3. *What it costs if nobody can*, with advice at Critical staffing and a pointer to
     rebalance the lines when the same gap repeats every week.
  Each suggestion is Approve or Skip; approving notifies the employee. Changes inside
  the notice period, or a 5th day in a row (emergency), are opt-in.
- **Rebalance lines** (Lines & Bid, Fix coverage, or inside a shift bid). Keeps everyone
  on their shift and picks which week of the rotation each person starts on, so every
  hour of the job class's consoles is at minimum, extra hours stay within the relief
  margin and 4-hour days are spread across the week. Shows who changes (days off before
  → after); approving changes only those lines and notifies those people. Or start a
  shift bid with the suggested lines.
- **Vacation bid.** Rounds in seniority order, up to 5 scheduled workdays per pick
  (or calendar days), and a daily limit per job class (default 1). Each pick is
  approved immediately; a calendar shows full days. The same per-job-class limit
  (Staff → Max off / day) flags ordinary time-off requests that would exceed it.
- **Planner.** FTE needed and relief factor per schedule type against your minimums.

## Notifications

Employees and supervisors see notifications in the app (🔔). For email or text,
set `NOTIFY_WEBHOOK_URL` and the server POSTs each notification as:

```json
{ "title": "Overtime available", "body": "...", "at": "...", "center": "...",
  "to": [{ "employeeId": "...", "name": "...", "email": "...", "phone": "...", "textOptIn": true }] }
```

Point it at Power Automate, Zapier or a small relay to send email, SMS or Teams
messages. Without it, notifications are written to the server log.

## Sign-in options

The app has built-in accounts now (scrypt-hashed passwords, HttpOnly session cookies,
lockout after repeated failures, and forced change of temporary passwords). The
login layer is isolated in `server/server.js`, so county Microsoft 365 (Entra ID)
single sign-on can be added later without changing the rest of the app.

## Code layout

```
index.html, css/        web app
js/core.js              scheduling / coverage / OT / bid engine (no DOM; unit tested)
js/actions.js           workflow rules (requests, trades, postings, bids); run by the server
js/importer.js          reads and imports an existing schedule grid
js/balancer.js          rotation line suggestions, day-off moves, Fix coverage plan
js/app.js               data layer (server or local), sign-in, routing, modals
js/views/*.js           one file per page
server/server.js        HTTP server, auth, SQLite storage, audit, live updates
server/backup.js        online backup with retention
scripts/windows/        install/uninstall scripts and IIS web.config
docs/WINDOWS.md         Windows Server installation guide
tests/                  engine, workflow and server API tests: npm test
```
