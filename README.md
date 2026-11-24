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

The demo center runs a 2-week 12-hour template (Day 1–6, Night 1–6 and a Mid-shift,
Monday–Sunday weeks) on Law and Fire/EMS consoles, with 4 supervisors and 3
part-timers. Sign in as `nnash` (supervisor) or `aadams` (employee).

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

- **Schedule slots.** A schedule slot is one person's repeating schedule: their shift,
  rotation and start date. Vacant slots are unfilled positions; in a shift bid, people
  pick slots in seniority order. (In the code and data these are still called `lines`.)
- **Job classes and consoles.** A person's position is their *job class* (e.g.
  Telecommunicator, Supervisor). Job classes hold authorized full-time and part-time
  positions, vacancies, the daily leave limit, schedule slots and bids. *Consoles* (e.g. Law,
  Fire/EMS) are only where people sit each hour. Each person has a job class, the
  consoles they're certified on, and optionally a preferred console that only breaks
  ties. Schedule slots belong to a job class, so nobody is tied to a console by their
  schedule slot.
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
- **Your schedule template (default).** Schedules & Bids → Upload schedule template.
  Upload the spreadsheet you already schedule from (.xlsx, CSV or pasted rows): a block
  per shift titled like *Days (0700 - 1900)*, one row per slot and week (*Day 1 · Week 1
  · Mon … Sun*) with *Work*, *RDO* or a time like *1100-1500*; a slot with its own hours
  can say so in its name (*Mid-Shift (1100-2300)*). Each slot becomes a schedule slot
  that repeats (e.g. every 2 weeks). The preview shows each slot's weekly hours and days
  in a row, the overtime built into the template, and you pick who holds each slot.
  Overtime weeks can be set to match the template (e.g. Monday–Sunday). Weeks over 40
  hours are shown as *scheduled* overtime, not as a mistake.
- **The 7-week rotation (optional).** Settings → Advanced → Schedules are built from.
  Three 12-hour shifts plus one 4-hour shift a week (exactly 40 hours); days off move
  one day later each week over 7 weeks. The 4-hour shift starts with the regular shift
  or falls during peak call volume (per job class or schedule slot). Other 40-hour
  patterns (5×8, 4×10, 2×12 + 2×8) are there too; any custom schedule slot that would
  build in OT is flagged.
- **Preferred staffing.** Settings → Schedule rules → Preferred staffing: how many people
  you'd like on above the minimum, per job class, days and hours (e.g. Telecommunicators
  4 from 1100 to 1900 every day, with a minimum of 3). Being below preferred isn't a
  gap. Fix coverage lists those hours separately ("Sun days: 1 under preferred
  1100–1900 for 4 weeks") and fills them only with day-off moves that open no real gap,
  and with spare part-time hours after real gaps and overtime cuts are covered. It never
  uses overtime for them, and training time never drops a shift below preferred.
- **Days in a row.** Nobody should work more than 4 days in a row (a 4-hour shift
  counts as a day). Slots that do are flagged on Schedules & Bids and in the template
  preview, with a suggested fix: two slots on the same shift trade a work day and a day
  off in the same week, so every day keeps the same people on duty and every slot keeps
  its weekly hours. Day-off moves never go past the limit; a 5th day only when a
  supervisor marks a move as an emergency (flagged on the schedule). Extra shifts that
  would break the limit are flagged in the fill list.
- **Shift bid.** Per job class: generate the class's schedule slots, bid in seniority order (employees pick on their own
  turn and are notified when it arrives), preview coverage across all consoles the
  class staffs, then apply on an effective date.
- **Import an existing schedule.** Schedules & Bids → Import schedule. Paste the grid from
  your spreadsheet (names down the side, dates across the top, a code per cell) or
  upload a CSV. Names are matched to employees; codes are guessed (OFF, times like
  0700-1900, VAC/SL/TRN and other leave codes) and you confirm the rest. For the
  imported people and dates, the imported days replace their schedule slots; leave codes
  become approved leave on their usual shift. Schedule slots take over after the last
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
- **Fix coverage** (Dashboard → Fix coverage). The tool does the legwork; the scheduler
  reviews and approves. One short page answers three questions for the next few weeks:
  1. *Which shifts are short*, in plain words ("Fri nights are 1 short for 3 weeks").
  2. *Who can cover without overtime*: day-off moves first ("Have Smith work Fri
     instead of Tue?": same shift, same work week so still 40 hours, rest rules, the
     notice period and the days-in-a-row limit), then part-timers under their cap.
     **Cut scheduled overtime:** in a long week (e.g. the 48-hour week of a 2-week
     template) a part-timer works part of one shift at straight time and the full-timer
     stays at 40 hours ("Have Jones (part-time) work Tue 1100–1900 for Smith? Smith works
     0700–1100 and stays at 40 hours. Saves about $200."). When coverage allows, it also
     offers 4-hour shifts for training, never at the cost of overtime.
  3. *What it costs if nobody can*, with advice at Critical staffing and a pointer to
     the slots or template when the same gap repeats every cycle.
  Each suggestion is Approve or Skip; approving notifies the employee. Changes inside
  the notice period, or a 5th day in a row (emergency), are opt-in.
- **Rebalance schedule slots** (7-week rotation only; also inside a shift bid). Keeps everyone
  on their shift and picks which week of the rotation each person starts on, so every
  hour of the job class's consoles is at minimum, extra hours stay within the relief
  margin and 4-hour days are spread across the week. Shows who changes (days off before
  → after); approving changes only those schedule slots and notifies those people. Or start a
  shift bid with the suggested schedule slots.
- **Vacation bid.** Rounds in seniority order, up to 5 scheduled workdays per pick
  (or calendar days), and a daily limit per job class (default 1). Each pick is
  approved immediately; a calendar shows full days. The same per-job-class limit
  (Staff → Max off / day) flags ordinary time-off requests that would exceed it.
- **Planner.** FTE needed and relief factor per schedule type against your minimums.
- **Reports.** Coverage, Consoles, Overtime and Planner are under Reports, so the menu
  holds only the pages a scheduler uses every day.

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
js/xlsx.js              reads .xlsx files in the browser (no dependencies)
js/template.js          schedule templates: read, preview, days-in-a-row trades, create slots
js/balancer.js          rotation schedule-slot suggestions, day-off moves, Fix coverage plan
js/app.js               data layer (server or local), sign-in, routing, modals
js/views/*.js           one file per page
server/server.js        HTTP server, auth, SQLite storage, audit, live updates
server/backup.js        online backup with retention
scripts/windows/        install/uninstall scripts and IIS web.config
docs/WINDOWS.md         Windows Server installation guide
tests/                  engine, workflow and server API tests: npm test
```
