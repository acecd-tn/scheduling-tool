<#
.SYNOPSIS
  Installs PSAP Scheduler as an always-on Windows service, with a nightly backup.

.DESCRIPTION
  Run from an elevated (Administrator) PowerShell prompt, from the app folder:

    powershell -ExecutionPolicy Bypass -File .\scripts\windows\install.ps1

  What it does:
    1. Checks Node.js (22.13 or newer).
    2. Creates the data, log and backup folders.
    3. Writes C:\PSAP\psap.config.json (if there isn't one already). It lives outside
       the app folder so updating the app never touches your settings.
    4. Registers the server to start at boot and restart if it stops:
         - as a Windows service using NSSM, if nssm.exe is found (recommended), or
         - as a Scheduled Task running at startup (built into Windows, nothing to download).
    5. Registers a nightly backup task.
    6. Optionally opens the Windows Firewall port.
    7. Starts it and checks that it answers.

  Re-running the script is safe: it updates the existing service/tasks.

.EXAMPLE
  .\install.ps1                                   # defaults: port 8080, data in C:\PSAP\data
.EXAMPLE
  .\install.ps1 -BehindIIS                         # listen on 127.0.0.1 only; IIS provides HTTPS
.EXAMPLE
  .\install.ps1 -DataDir D:\PSAP\data -BackupDir \\fileserver\backups\psap -OpenFirewall
#>
[CmdletBinding()]
param(
  [string]$AppDir = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path,
  [string]$ConfigFile = 'C:\PSAP\psap.config.json',
  [string]$DataDir = 'C:\PSAP\data',
  [string]$LogDir = 'C:\PSAP\logs',
  [string]$BackupDir = 'C:\PSAP\backups',
  [int]$Port = 8080,
  [int]$KeepBackups = 30,
  [string]$BackupTime = '02:15',
  [string]$ServiceName = 'PSAPScheduler',
  [string]$NssmPath = '',
  [switch]$UseScheduledTask,   # force the Scheduled Task method even if NSSM is available
  [switch]$BehindIIS,          # bind to 127.0.0.1 and use secure cookies (HTTPS at IIS)
  [switch]$OpenFirewall        # allow inbound TCP $Port (not needed with -BehindIIS)
)

$ErrorActionPreference = 'Stop'
function Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Ok($msg) { Write-Host "    $msg" -ForegroundColor Green }
function Warn($msg) { Write-Host "    $msg" -ForegroundColor Yellow }

# --- must be elevated -------------------------------------------------------
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'Run this from an elevated PowerShell (right-click > Run as administrator).'
}

# --- 1. Node.js ---------------------------------------------------------------
Step 'Checking Node.js'
$node = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
if (-not $node) { throw 'Node.js is not installed. Install the Node.js LTS (22 or newer) Windows Installer (.msi) from nodejs.org, then re-run.' }
$ver = (& $node -v).TrimStart('v')
$parts = $ver.Split('.') | ForEach-Object { [int]$_ }
if ($parts[0] -lt 22 -or ($parts[0] -eq 22 -and $parts[1] -lt 13)) { throw "Node.js $ver is too old. Install 22.13 or newer (LTS)." }
Ok "Node.js $ver at $node"
$serverJs = Join-Path $AppDir 'server\server.js'
$backupJs = Join-Path $AppDir 'server\backup.js'
if (-not (Test-Path $serverJs)) { throw "Can't find $serverJs. Run this script from inside the app folder, or pass -AppDir." }
Ok "App folder: $AppDir"

# --- 2. folders --------------------------------------------------------------
Step 'Creating folders'
foreach ($d in @($DataDir, $LogDir, $BackupDir)) {
  if ($d -notlike '\\*') { New-Item -ItemType Directory -Force -Path $d | Out-Null }
  Ok $d
}

# --- 3. config ----------------------------------------------------------------
Step 'Configuration'
$cfgFile = $ConfigFile
New-Item -ItemType Directory -Force -Path (Split-Path $cfgFile) | Out-Null
if (Test-Path $cfgFile) {
  Warn "Keeping existing $cfgFile (edit it by hand to change settings)."
} else {
  $cfg = [ordered]@{
    port         = $Port
    host         = $(if ($BehindIIS) { '127.0.0.1' } else { '0.0.0.0' })
    dataDir      = $DataDir
    cookieSecure = [bool]$BehindIIS
    sessionHours = 168
    notifyWebhookUrl = ''
  }
  # UTF-8 without BOM so Node reads it cleanly on Windows PowerShell 5.1
  [IO.File]::WriteAllText($cfgFile, ($cfg | ConvertTo-Json), (New-Object Text.UTF8Encoding($false)))
  Ok "Wrote $cfgFile"
}
if (-not $BehindIIS) { Warn 'Without -BehindIIS the app is plain HTTP. Put HTTPS in front of it before staff use it (see docs\WINDOWS.md).' }

# --- 4. run at boot -------------------------------------------------------------
$nodeArgs = "--no-warnings=ExperimentalWarning `"$serverJs`" --config `"$cfgFile`""
if (-not $NssmPath) { $NssmPath = (Get-Command nssm.exe -ErrorAction SilentlyContinue).Source }
if ($NssmPath -and -not $UseScheduledTask) {
  Step "Installing Windows service '$ServiceName' with NSSM"
  $existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
  if ($existing) { & $NssmPath stop $ServiceName confirm | Out-Null } else { & $NssmPath install $ServiceName $node | Out-Null }
  & $NssmPath set $ServiceName Application $node | Out-Null
  & $NssmPath set $ServiceName AppParameters $nodeArgs | Out-Null
  & $NssmPath set $ServiceName AppDirectory $AppDir | Out-Null
  & $NssmPath set $ServiceName DisplayName 'PSAP Scheduler' | Out-Null
  & $NssmPath set $ServiceName Description 'PSAP Scheduler web server' | Out-Null
  & $NssmPath set $ServiceName Start SERVICE_AUTO_START | Out-Null
  & $NssmPath set $ServiceName AppStdout (Join-Path $LogDir 'server.log') | Out-Null
  & $NssmPath set $ServiceName AppStderr (Join-Path $LogDir 'server.log') | Out-Null
  & $NssmPath set $ServiceName AppRotateFiles 1 | Out-Null
  & $NssmPath set $ServiceName AppRotateOnline 1 | Out-Null
  & $NssmPath set $ServiceName AppRotateBytes 10485760 | Out-Null
  & $NssmPath set $ServiceName AppExit Default Restart | Out-Null
  & $NssmPath set $ServiceName AppRestartDelay 5000 | Out-Null
  & $NssmPath set $ServiceName AppStopMethodConsole 5000 | Out-Null
  & $NssmPath start $ServiceName | Out-Null
  Ok "Service installed. Manage it in services.msc or with: nssm restart $ServiceName"
} else {
  Step "Registering startup task '$ServiceName' (Task Scheduler)"
  $wrapper = Join-Path $AppDir 'scripts\windows\run-server.cmd'
  $cmd = "@echo off`r`ncd /d `"$AppDir`"`r`n`"$node`" $nodeArgs >> `"$(Join-Path $LogDir 'server.log')`" 2>&1`r`n"
  [IO.File]::WriteAllText($wrapper, $cmd, (New-Object Text.ASCIIEncoding))
  $action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument "/c `"$wrapper`"" -WorkingDirectory $AppDir
  $trigger = New-ScheduledTaskTrigger -AtStartup
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
    -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
  $taskPrincipal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
  if (Get-ScheduledTask -TaskName $ServiceName -ErrorAction SilentlyContinue) {
    Stop-ScheduledTask -TaskName $ServiceName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $ServiceName -Confirm:$false
  }
  Register-ScheduledTask -TaskName $ServiceName -Action $action -Trigger $trigger -Settings $settings -Principal $taskPrincipal `
    -Description 'PSAP Scheduler web server (starts at boot)' | Out-Null
  Start-ScheduledTask -TaskName $ServiceName
  Ok 'Startup task registered and started. Manage it in Task Scheduler (taskschd.msc).'
  Warn 'For a true Windows service with log rotation, install NSSM (nssm.cc) and re-run this script.'
}

# --- 5. nightly backup --------------------------------------------------------
Step "Nightly backup at $BackupTime to $BackupDir (keep $KeepBackups)"
$bkName = "$ServiceName Backup"
$bkLog = Join-Path $LogDir 'backup.log'
$bkWrapper = Join-Path $AppDir 'scripts\windows\run-backup.cmd'
$bkCmd = "@echo off`r`ncd /d `"$AppDir`"`r`necho %DATE% %TIME% >> `"$bkLog`"`r`n`"$node`" --no-warnings=ExperimentalWarning `"$backupJs`" `"$BackupDir`" --config `"$cfgFile`" --keep $KeepBackups >> `"$bkLog`" 2>&1`r`nexit /b %ERRORLEVEL%`r`n"
[IO.File]::WriteAllText($bkWrapper, $bkCmd, (New-Object Text.ASCIIEncoding))
$bkAction = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument "/c `"$bkWrapper`"" -WorkingDirectory $AppDir
$bkTrigger = New-ScheduledTaskTrigger -Daily -At $BackupTime
$bkSettings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 1)
$bkPrincipal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
if (Get-ScheduledTask -TaskName $bkName -ErrorAction SilentlyContinue) { Unregister-ScheduledTask -TaskName $bkName -Confirm:$false }
Register-ScheduledTask -TaskName $bkName -Action $bkAction -Trigger $bkTrigger -Settings $bkSettings -Principal $bkPrincipal `
  -Description 'Nightly online backup of the PSAP Scheduler database' | Out-Null
Ok "Registered task '$bkName'. Log: $bkLog"
if ($BackupDir -like '\\*') { Warn 'Backups go to a network share: SYSTEM authenticates as the server computer account (DOMAIN\SERVER$). Give that account write access to the share.' }

# --- 6. firewall --------------------------------------------------------------
if ($OpenFirewall -and -not $BehindIIS) {
  Step "Opening Windows Firewall TCP $Port"
  $ruleName = "PSAP Scheduler ($Port)"
  if (-not (Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Protocol TCP -LocalPort $Port -Action Allow -Profile Domain,Private | Out-Null
  }
  Ok "Rule '$ruleName' (Domain and Private networks only)"
}

# --- 7. check -----------------------------------------------------------------
Step 'Checking that the server answers'
$ok = $false
for ($i = 0; $i -lt 20 -and -not $ok; $i++) {
  Start-Sleep -Seconds 1
  try { Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$Port/api/me" -TimeoutSec 3 | Out-Null; $ok = $true }
  catch { if ($_.Exception.Response -and [int]$_.Exception.Response.StatusCode -eq 401) { $ok = $true } }
}
if ($ok) {
  Ok "Running: http://localhost:$Port"
  Write-Host ''
  Write-Host '  FIRST SIGN-IN: the admin password is printed once, in the log:' -ForegroundColor White
  Write-Host "    $(Join-Path $LogDir 'server.log')" -ForegroundColor White
  Write-Host '  Look for "Admin account created". Sign in as admin, change the password, then delete that line from the log.' -ForegroundColor White
} else {
  Warn "No answer on port $Port yet. Check $(Join-Path $LogDir 'server.log')"
  exit 1
}
