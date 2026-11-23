# PSAP Scheduler

Scheduling for emergency communications centers: 24x7 console coverage by discipline,
authorized vs. current staffing, call-outs and openings, real-time and predicted
overtime, shift trades, OT sign-up, shift bids and vacation bids. It supports 8-, 10-
and 12-hour schedules or a mix, all built for non-exempt staff on a **7-day / 40-hour**
overtime rule.

## Two ways to run it

**1. Multi-user server (normal use).** Supervisors and employees each sign in.

Requirements: Node.js 22.5 or newer (Windows or Linux). Nothing else is needed:
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

| Setting (environment variable) | Default | |
|---|---|---|
| `PORT` / `HOST` | `8080` / `0.0.0.0` | |
| `DATA_DIR` | `./data` | Holds `psap.db`. **Back this folder up nightly.** |
| `COOKIE_SECURE=1` | off | Set when served over HTTPS (it should be). |
| `ADMIN_PASSWORD` | random | Initial admin password. |
| `NOTIFY_WEBHOOK_URL` | none | Each notification is POSTed here as JSON (see below). |
| `SESSION_HOURS` | `168` | How long a sign-in lasts. |

**HTTPS:** put it behind the county's reverse proxy (IIS with URL Rewrite/ARR,
nginx, or an Azure/AWS load balancer) with a certificate, and set `COOKIE_SECURE=1`.
It needs to stay running, e.g. as a Windows service (NSSM) or a systemd unit.

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

- **Coverage by discipline.** Minimum staffing per hour and day for each discipline
  (call-taker, law, fire/EMS, supervisor), with special-day overrides. With
  *console assignment* on, cross-trained people are placed on whatever console needs
  them each hour. When short, disciplines are filled in *fill priority* order.
  The **Consoles** page prints the assignment sheet; supervisors can pin a person to
  one console for a shift.
- **Staffing levels.** Authorized vs. filled vs. vacant per discipline, trainee/CTO
  status (trainees not yet solo-cleared don't count), and the OT cost of vacancies.
- **Openings.** Every hour below minimum, its cause (call-out, vacation, FMLA,
  training, structural) and its OT cost. Fill it directly from a ranked list:
  - Voluntary order: holdover/early-in first, then fewest OT hours.
  - Force order: least recently forced, then least senior.
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
- **Rotations.** The built-in patterns are all exactly 40 h every week: 5×8, 4×10,
  2×12 + 2×8 (days or nights), and 3×12 + 4. Any custom line that would build in OT
  is flagged.
- **Shift bid.** Generate lines, bid in seniority order (employees pick on their own
  turn and are notified when it arrives), preview coverage, then apply on an
  effective date.
- **Vacation bid.** Rounds in seniority order with a daily limit per discipline. Each
  pick is approved immediately; a calendar shows full days.
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
js/app.js               data layer (server or local), sign-in, routing, modals
js/views/*.js           one file per page
server/server.js        HTTP server, auth, SQLite storage, audit, live updates
tests/                  engine, workflow and server API tests: npm test
```
