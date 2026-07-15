# Security Repair Guide

## Diagnose
- Windows Defender status:
  `Get-MpComputerStatus | Select-Object AMRunningMode, AntivirusEnabled, RealTimeProtectionEnabled, AntivirusSignatureLastUpdated`
- Recent threats:
  `Get-MpThreatDetection | Select-Object -First 10 ThreatID, InitialDetectionTime`
  `Get-MpThreat | Select-Object ThreatName, SeverityID`
- Firewall profiles:
  `Get-NetFirewallProfile | Select-Object Name, Enabled`

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

## Notes
- Never DISABLE protection as a "fix" — only enable/strengthen it.
- Defender changes and firewall changes require Administrator rights.
- If third-party antivirus is present, Defender may be intentionally passive.
