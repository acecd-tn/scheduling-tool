# Installing PSAP Scheduler on Windows Server

This guide is for the county IT staff who will host PSAP Scheduler. It covers a single
Windows Server running the app as an always-on service, HTTPS through IIS, nightly
backups, updates and troubleshooting.

> The PowerShell scripts in `scripts\windows\` are written for **Windows PowerShell
> 5.1** (built into Windows Server) and PowerShell 7. The first test on Windows Server
> found a 5.1 bug in `install.ps1`, now fixed (see
> [Troubleshooting](#troubleshooting)). The fixed version hasn't been re-run on Windows
> yet, so try it on a test server first. Every step the scripts automate is also listed
> here so it can be done by hand.

## What you need

| | |
|---|---|
| Server | Windows Server 2019, 2022 or 2025 (2016 works). A VM is fine. |
| CPU / RAM / disk | 2 vCPU, 4 GB RAM and 10 GB free covers a center of 100+ staff with years of history. The database is typically under 50 MB. |
| Node.js | **22.13 or newer** (any current LTS: 22.x or 24.x), x64 Windows Installer (.msi) from nodejs.org. It is the only software the app itself needs. |
| HTTPS | A certificate for the name staff will use (e.g. `schedule.county.local`) from your internal CA or a public CA, and a DNS record pointing to the server. |
| IIS (recommended) | The Web Server role plus two free Microsoft add-ons: **URL Rewrite** and **Application Request Routing (ARR)**. IIS provides HTTPS and forwards requests to the app. |
| NSSM (recommended) | `nssm.exe` from nssm.cc runs the app as a real Windows service. Without it, the install script uses a startup Scheduled Task instead (built into Windows). |

Ports: staff reach IIS on **443**. The app listens on **8080** on localhost only, so
nothing else needs to be opened.

```
 Staff browsers / phones ──HTTPS 443──▶ IIS (certificate, URL Rewrite + ARR)
                                         │  http://127.0.0.1:8080
                                         ▼
                                   node.exe server\server.js   (Windows service)
                                         │
                                   C:\PSAP\data\psap.db         (SQLite, one file)
```

## Folder layout used below

```
C:\PSAP\app\              the application (replace this folder to update)
C:\PSAP\psap.config.json  settings (kept separately so updates don't touch it)
C:\PSAP\data\             database: psap.db (+ psap.db-wal, psap.db-shm while running)
C:\PSAP\logs\             server.log, backup.log
C:\PSAP\backups\          nightly backups (or a network share)
```

## Step 1: Install Node.js

1. Download the **Windows Installer (.msi), x64, LTS** from https://nodejs.org. If the
   server has no internet access, download it on another PC and copy it over.
2. Run it with the defaults. The optional "Tools for native modules" (Chocolatey)
   step is **not** needed; leave it unchecked.
3. Open a **new** PowerShell window and check the version:
   ```powershell
   node -v
   ```
   It must show `v22.13.0` or higher.

## Step 2: Copy the app to the server

Put the contents of the repository in `C:\PSAP\app`. Either:

- **ZIP:** on GitHub, open the branch, then **Code → Download ZIP**. Extract it to
  `C:\PSAP\app` so that `C:\PSAP\app\server\server.js` exists. Windows marks files
  from a downloaded ZIP as "from the internet", which blocks the scripts. Unblock them:
  ```powershell
  Get-ChildItem C:\PSAP\app -Recurse | Unblock-File
  ```
- **git:** `git clone <repository URL> C:\PSAP\app`

There is no `npm install` step. The app has no third-party packages.

## Step 3 (optional): Try it with demo data

```powershell
cd C:\PSAP\app
npm run demo
```

Open http://localhost:8080 on the server. Every demo employee has an account (first
initial + last name, e.g. `pprice`; supervisors such as `pingram`) and the password
`demo-password`. Press **Ctrl+C** to stop, then delete `C:\PSAP\app\data-demo`.

## Step 4: Install the service

Optionally install NSSM first: download it from https://nssm.cc and copy
`win64\nssm.exe` to `C:\Windows\System32` (or pass `-NssmPath`).

Then, in an **elevated** PowerShell (Run as administrator):

```powershell
cd C:\PSAP\app
powershell -ExecutionPolicy Bypass -File .\scripts\windows\install.ps1 -BehindIIS
```

`-AppDir` is optional: it defaults to the app folder the script sits in
(`C:\PSAP\app` here). Use `-BehindIIS` when you'll set up HTTPS in IIS (Step 5). The app then listens only
on 127.0.0.1 and marks its sign-in cookie HTTPS-only.

The script:

1. Checks Node.js.
2. Creates `C:\PSAP\data`, `logs` and `backups`.
3. Writes `C:\PSAP\psap.config.json`.
4. Registers the server to start at boot and restart if it ever stops.
5. Registers a nightly backup at 02:15.
6. Starts the server and checks that it answers.

Useful options:

| Option | Default | |
|---|---|---|
| `-AppDir` | the script's app folder | Only needed if you run the script from somewhere else. |
| `-DataDir` | `C:\PSAP\data` | Put the database on a different drive, e.g. `D:\PSAP\data`. |
| `-BackupDir` | `C:\PSAP\backups` | Can be a UNC share: `\\fileserver\backups\psap`. |
| `-KeepBackups` | `30` | How many nightly copies to keep. |
| `-BackupTime` | `02:15` | |
| `-Port` | `8080` | |
| `-UseScheduledTask` | | Use a startup task even if NSSM is installed. |
| `-OpenFirewall` | | Only when **not** using IIS: opens the port on Domain/Private networks. |

To remove it later, run `.\scripts\windows\uninstall.ps1`. Data, backups and logs are
kept.

<details><summary>Doing it by hand instead of the script (NSSM)</summary>

```powershell
nssm install PSAPScheduler "C:\Program Files\nodejs\node.exe"
nssm set PSAPScheduler AppParameters "--no-warnings=ExperimentalWarning C:\PSAP\app\server\server.js --config C:\PSAP\psap.config.json"
nssm set PSAPScheduler AppDirectory C:\PSAP\app
nssm set PSAPScheduler AppStdout C:\PSAP\logs\server.log
nssm set PSAPScheduler AppStderr C:\PSAP\logs\server.log
nssm set PSAPScheduler AppRotateFiles 1
nssm set PSAPScheduler AppRotateBytes 10485760
nssm set PSAPScheduler Start SERVICE_AUTO_START
nssm start PSAPScheduler
```
</details>

### Settings: `C:\PSAP\psap.config.json`

```json
{
  "port": 8080,
  "host": "127.0.0.1",
  "dataDir": "C:\\PSAP\\data",
  "cookieSecure": true,
  "sessionHours": 168,
  "notifyWebhookUrl": ""
}
```

| Key | Meaning |
|---|---|
| `host` | `127.0.0.1` behind IIS (recommended). `0.0.0.0` makes the app answer other machines directly, over plain HTTP. |
| `cookieSecure` | `true` when staff use HTTPS. **Must be `false` if you browse over plain http**, or sign-in won't stick. |
| `sessionHours` | How long a sign-in lasts (default 7 days). |
| `notifyWebhookUrl` | Optional. Each notification is POSTed as JSON to this URL, e.g. a Power Automate "When an HTTP request is received" flow that sends email, text or Teams messages. See the README for the payload. |
| `adminPassword` | Optional, first start only: sets the initial admin password instead of a random one. Remove it afterwards. |

Restart the service after editing it (`nssm restart PSAPScheduler`, or Services).

## Step 5: HTTPS with IIS

1. **Install IIS and the add-ons.** Server Manager → Add Roles → *Web Server (IIS)*.
   Then install **URL Rewrite** and **Application Request Routing 3.0** (from
   iis.net / the Microsoft download center).
2. **Turn on the proxy.** In IIS Manager select the *server* node → *Application
   Request Routing Cache* → *Server Proxy Settings* → check **Enable proxy**. Set
   **Response buffer threshold** to `0` so live updates stream immediately.
   From an elevated prompt:
   ```bat
   %windir%\system32\inetsrv\appcmd.exe set config -section:system.webServer/proxy /enabled:"True" /responseBufferLimit:"0" /commit:apphost
   ```
   Check it took effect (the output should include `enabled="true"`). If this step is
   skipped, browsing to the site gives **HTTP 404.4**:
   ```bat
   %windir%\system32\inetsrv\appcmd.exe list config -section:system.webServer/proxy
   ```
3. **Create the site.** IIS Manager → Sites → *Add Website*:
   - Name `PSAP Scheduler`, physical path `C:\PSAP\iis` (an empty folder).
   - Binding **https**, port 443, host name `schedule.county.local`, and your
     certificate. Optionally add an http/80 binding; the config redirects it to HTTPS.
4. **Add the proxy rules.** Copy `C:\PSAP\app\scripts\windows\web.config` into
   `C:\PSAP\iis\`. If you changed the app's port, edit `127.0.0.1:8080` in it.
5. Browse to `https://schedule.county.local`. You should see the sign-in page.

**Not using IIS?** Any reverse proxy or load balancer that terminates HTTPS works
(F5, NetScaler, Azure Application Gateway, nginx). Forward everything to the app's
port. Don't buffer responses for `/api/events`, which is a long-lived Server-Sent
Events stream. Allow request bodies up to 50 MB.

**Access from phones.** Staff can use the app on their phones on the county network or
VPN. Publishing it to the internet is a security decision for IT. If you do it, put it
behind your WAF or reverse proxy. The app has account lockout, hashed passwords and
HTTPS-only cookies, but no multi-factor sign-in yet; that would come with Microsoft 365
(Entra ID) sign-in.

## Step 6: First sign-in

1. The admin password is created on first start and written **once** to
   `C:\PSAP\logs\server.log` (look for `Admin account created`).
2. Sign in as `admin`. You'll be asked to choose a new password (10+ characters).
3. Delete that line from the log.
4. In the app:
   1. **Settings:** center name, OT rule (7 days / 40 h), budget.
   2. **Staff:** disciplines, authorized counts, employees.
   3. **Settings:** minimum staffing grid.
   4. **Lines & Bid:** lines.
   5. **Staff → Create login** for each person. Each one gets a temporary password
      they must change at first sign-in.
   6. Give supervisors the *supervisor* role (only an admin can).

## Backups and restore

The nightly task runs `server\backup.js`. It takes a consistent snapshot while the app
is running (SQLite `VACUUM INTO`), checks the copy's integrity, and deletes copies
beyond the retention count. Results go to `C:\PSAP\logs\backup.log`, and a failed
backup makes the task fail in Task Scheduler, so it can alert.

- **Back up the backups.** Include `C:\PSAP\backups` (or the share) in your normal
  server backup or off-site rotation. VM snapshots alone aren't enough.
- **Manual backup:**
  `node C:\PSAP\app\server\backup.js D:\somewhere --config C:\PSAP\psap.config.json`
- Admins can also download a JSON export from **Settings → Data** in the app.
- **Don't** copy `psap.db` directly while the service is running. Use `backup.js`.

**Restore:**

1. Stop the service.
2. Rename `C:\PSAP\data\psap.db` (and delete `psap.db-wal` and `psap.db-shm` if
   present).
3. Copy the chosen `psap-YYYY-MM-DD-....db` backup to `C:\PSAP\data\psap.db`.
4. Start the service.

## Updating the app

1. Run a backup (or check that last night's succeeded).
2. Stop the service: `nssm stop PSAPScheduler` (or Services; for a Scheduled Task
   install, End the task in Task Scheduler).
3. Replace the contents of `C:\PSAP\app` with the new version. Settings and data live
   outside it.
4. If you used a ZIP: `Get-ChildItem C:\PSAP\app -Recurse | Unblock-File`
5. Start the service and sign in to check.

If the update changed `scripts\windows\install.ps1`, re-run it after step 3. It is
safe to re-run: it updates the existing service and backup task.

Keep **Node.js** patched as well: install the newest 22.x/24.x LTS .msi over the old
one during a maintenance window, then restart the service. Windows Updates as usual.

## Monitoring

- **Service up:** `Get-Service PSAPScheduler`. Or have your monitoring tool request
  `http://127.0.0.1:8080/api/me`; an answer of **401** means the app is up.
- **Log:** `C:\PSAP\logs\server.log` (rotated at 10 MB with NSSM).
- **Backups:** Task Scheduler → *PSAPScheduler Backup* → History / Last Run Result
  (0x0 = success), and `backup.log`.
- **Who did what:** in the app, **Settings → Audit log** (supervisors and admins).

## Security checklist

- [ ] HTTPS only; the app bound to `127.0.0.1` (`-BehindIIS`); port 8080 not open in the firewall.
- [ ] `cookieSecure: true`.
- [ ] NTFS permissions on `C:\PSAP\data`, `C:\PSAP\backups` and `C:\PSAP\psap.config.json`: SYSTEM and Administrators only. The database holds the schedule, leave records and password hashes.
- [ ] Admin password changed; the first-start line removed from `server.log`.
- [ ] Backups copied off the server and a restore tested once.
- [ ] Node.js and Windows kept patched.
- [ ] Departing employees: set them to *Separated* and disable their login (Staff page).

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Join-Path : Cannot bind argument to parameter 'Path' because it is an empty string` (install.ps1 line 33) | You have the first version of `install.ps1`, which doesn't work on Windows PowerShell 5.1. Get the current `scripts\windows\install.ps1`, or work around it by passing the app folder yourself: `powershell -ExecutionPolicy Bypass -File .\scripts\windows\install.ps1 -AppDir C:\PSAP\app -BehindIIS` |
| `node` is not recognized | Open a new PowerShell after installing Node.js. If the service can't find it, reinstall Node.js "for all users" or pass the full path (`-NssmPath`/script uses `Get-Command node`). |
| Script says it "cannot be loaded … not digitally signed" | Unblock the files (Step 2) and run with `powershell -ExecutionPolicy Bypass -File …`. |
| `Port 8080 is already in use` in the log | Another program (or a second copy of the app) uses it. Stop it, or change `port` in the config **and** in the IIS `web.config`. |
| Sign-in succeeds but you're immediately back at the sign-in page | You're on plain `http://` with `cookieSecure: true`. Use the HTTPS address, or set it to `false` for testing. |
| Other people's changes take a while to appear | IIS is buffering the live-update stream. Set the ARR response buffer threshold to 0 (Step 5.2) and keep compression off in `web.config`. |
| IIS shows **404.4** ("does not have a handler associated with it") | The rewrite rule is working but IIS isn't allowed to forward requests: ARR isn't installed or its proxy is off. Check the server node in IIS Manager has *Application Request Routing Cache* (install ARR 3.0 if not), then run the `appcmd` command in Step 5.2 and confirm with `appcmd.exe list config -section:system.webServer/proxy` (look for `enabled="true"`). No restart needed. |
| IIS shows 404.0 or 403.14 | `web.config` isn't in the site's physical folder (`C:\PSAP\iis`). |
| IIS shows 500.19 | URL Rewrite isn't installed, so IIS can't read `web.config`. Install URL Rewrite. |
| IIS shows 502.3 / 502.2 | The app isn't running or the port in `web.config` is wrong. Check the service and `server.log`. |
| "ExperimentalWarning: SQLite" in the log | Harmless. It's Node's built-in database module; the service command hides it. |
| Backups to a share fail | The task runs as SYSTEM, which reaches network shares as the server's computer account (`DOMAIN\SERVERNAME$`). Grant that account write access to the share. |
