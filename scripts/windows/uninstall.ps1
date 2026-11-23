<#
.SYNOPSIS
  Removes the PSAP Scheduler service / startup task, backup task and firewall rule.
  Data, backups and logs are NOT deleted.

    powershell -ExecutionPolicy Bypass -File .\scripts\windows\uninstall.ps1
#>
[CmdletBinding()]
param(
  [string]$ServiceName = 'PSAPScheduler',
  [int]$Port = 8080,
  [string]$NssmPath = ''
)
$ErrorActionPreference = 'Continue'

if (-not $NssmPath) { $NssmPath = (Get-Command nssm.exe -ErrorAction SilentlyContinue).Source }
if (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue) {
  if ($NssmPath) { & $NssmPath stop $ServiceName confirm | Out-Null; & $NssmPath remove $ServiceName confirm | Out-Null }
  else { Stop-Service -Name $ServiceName -Force; sc.exe delete $ServiceName | Out-Null }
  Write-Host "Removed service $ServiceName"
}
foreach ($t in @($ServiceName, "$ServiceName Backup")) {
  if (Get-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue) {
    Stop-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $t -Confirm:$false
    Write-Host "Removed task '$t'"
  }
}
# A startup-task install runs node.exe from cmd.exe; stop that process too.
Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object { $_.CommandLine -like '*server\server.js*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force; Write-Host "Stopped node process $($_.ProcessId)" }
$rule = "PSAP Scheduler ($Port)"
if (Get-NetFirewallRule -DisplayName $rule -ErrorAction SilentlyContinue) { Remove-NetFirewallRule -DisplayName $rule; Write-Host "Removed firewall rule '$rule'" }
Write-Host 'Done. Data, backups and logs were left in place.'
