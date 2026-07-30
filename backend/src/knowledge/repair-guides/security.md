# Security Repair Guide

## Diagnose
- Windows Defender status:
  `Get-MpComputerStatus | Select-Object AMRunningMode, AntivirusEnabled, RealTimeProtectionEnabled, AntivirusSignatureLastUpdated`
- Recent threats:
  `Get-MpThreatDetection | Select-Object -First 10 ThreatID, InitialDetectionTime`
  `Get-MpThreat | Select-Object ThreatName, SeverityID`
- Firewall profiles:
  `Get-NetFirewallProfile | Select-Object Name, Enabled`
- Is a third-party antivirus registered (Defender may be passive by design):
  `Get-CimInstance -Namespace root/SecurityCenter2 -ClassName AntiVirusProduct | Select-Object displayName`
- Suspicious startup entries (classic persistence):
  `Get-CimInstance Win32_StartupCommand | Select-Object Name, Command, Location`
- Processes running from user-writable paths (masquerading malware):
  `Get-Process | Where-Object Path -like '*\Users\Public\*' | Select-Object Name, Id, Path`
- Failed logon attempts (needs admin — Security log is protected):
  `Get-WinEvent -FilterHashtable @{LogName='Security'; Id=4625} -MaxEvents 10 | Select-Object TimeCreated`
- Current Defender exclusions and PUA setting:
  `Get-MpPreference | Select-Object ExclusionPath, PUAProtection`
- Firewall rules for a specific program:
  `Get-NetFirewallApplicationFilter -Program '<path>' -ErrorAction SilentlyContinue`

## Common fixes
- Real-time protection disabled (needs admin):
  `Set-MpPreference -DisableRealtimeMonitoring $false`
- Update signatures then quick scan:
  `Update-MpSignature`
  `Start-MpScan -ScanType QuickScan`
- Firewall turned off (needs admin):
  `Set-NetFirewallProfile -Profile Domain,Public,Private -Enabled True`
- Remove detected threats after a scan (needs admin):
  `Start-MpScan -ScanType QuickScan; Remove-MpThreat`
- An app is blocked by the firewall — add a targeted allow rule (needs admin):
  `New-NetFirewallRule -DisplayName 'Allow <App>' -Direction Inbound -Program '<path>' -Action Allow`
- Defender slowing a specific build/dev folder — exclude it instead of
  disabling protection (needs admin):
  `Add-MpPreference -ExclusionPath '<folder>'`
- Verify the fix before finishing:
  `Get-MpComputerStatus | Select-Object RealTimeProtectionEnabled`
  `Get-MpThreatDetection | Measure-Object | Select-Object Count`

## Subdomain playbooks

The prompt may name a narrower area, e.g. "security (certificates)". Use the
matching playbook; fall back to the general sections above when none fits.

### certificates — expiry and trust failures
- Certificates expiring soon in the machine store:
  `Get-ChildItem Cert:\LocalMachine\My | Where-Object NotAfter -lt (Get-Date).AddDays(30) | Select-Object Subject, NotAfter, Thumbprint`
- Already-expired certificates:
  `Get-ChildItem Cert:\LocalMachine\My | Where-Object NotAfter -lt (Get-Date) | Select-Object Subject, NotAfter`
- Verify a certificate chain:
  `Test-Certificate -Cert (Get-Item Cert:\LocalMachine\My\<thumbprint>) -ErrorAction SilentlyContinue`
- Trusted roots (spot unexpected entries):
  `Get-ChildItem Cert:\LocalMachine\Root | Select-Object -First 10 Subject, NotAfter`
- Report expiry and chain problems; renewing or installing a certificate is a
  manual, admin-owned step — never delete certificates automatically.

### security-incident — triage after a suspected compromise
- Processes running from user-writable locations:
  `Get-Process | Where-Object Path -like '*\Users\*' | Select-Object Name, Id, Path`
- Persistence via Run keys:
  `Get-ItemProperty 'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Run', 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Run' -ErrorAction SilentlyContinue`
- Recently created scheduled tasks:
  `Get-ScheduledTask | Where-Object { $_.Date -gt (Get-Date).AddDays(-7) } | Select-Object TaskName, TaskPath, Date`
- Unexpected local admins:
  `Get-LocalGroupMember -Group Administrators | Select-Object Name, PrincipalSource`
- Outbound connections and their owners:
  `Get-NetTCPConnection -State Established | Select-Object RemoteAddress, RemotePort, OwningProcess | Sort-Object RemoteAddress -Unique`
- Collect evidence first and report it. Do not delete files, kill processes, or
  remove accounts automatically — recommend a Defender Offline scan and, for a
  confirmed compromise, isolating the machine from the network.

## Notes
- Never DISABLE protection as a "fix" — only enable/strengthen it. If the user
  asks to turn off Defender or the firewall, explain the risk and offer a
  targeted exclusion or an app-specific allow rule instead.
- Defender changes and firewall changes require Administrator rights.
- If third-party antivirus is present, Defender may be intentionally passive.
- A process named like a system binary (svchost, services, lsass) running from
  outside `System32` is highly suspicious. Malware often resists termination —
  if `Stop-Process` returns Access Denied, recommend a Microsoft Defender
  Offline scan rather than retrying.
- Prefer per-app firewall allow rules over disabling the firewall for a profile.
- SmartScreen/PUA blocks are often reputation-based, not proof of malware. Say
  so plainly, and only suggest "Run anyway" for sources the user truly trusts.
- Repeated 4625 events seconds apart suggest automated password guessing:
  recommend a strong password, account lockout, and removing RDP from the
  internet (VPN instead).
- Reading the Security event log needs elevation; if it fails, say so and give
  the elevated command rather than guessing at the cause.
