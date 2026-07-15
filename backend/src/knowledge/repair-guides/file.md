# File / Folder Repair Guide

## Diagnose
- Confirm a path exists and its attributes:
  `Get-Item -LiteralPath '<path>' | Select-Object FullName, Attributes, Length, LastWriteTime`
- List a folder:
  `Get-ChildItem -LiteralPath '<path>' -Force | Select-Object Name, Length, Attributes`
- Check permissions (ACL):
  `Get-Acl -LiteralPath '<path>' | Select-Object Owner, AccessToString`
- Disk health / filesystem errors (needs admin):
  `Get-Volume '<DriveLetter>' | Select-Object DriveLetter, HealthStatus, FileSystem`

## Common fixes
- Hidden/system attribute making a file "disappear":
  `Set-ItemProperty -LiteralPath '<path>' -Name Attributes -Value 'Normal'`
- Access denied — take ownership (needs admin, be cautious):
  `takeown /f "<path>" /r /d y` then `icacls "<path>" /grant "$env:USERNAME:F" /t`
- Recover from Recycle Bin — list items:
  `(New-Object -ComObject Shell.Application).NameSpace(10).Items() | Select-Object Name, Path`
- Corrupted system files (needs admin):
  `sfc /scannow` and `DISM /Online /Cleanup-Image /RestoreHealth`

## Notes
- Always use -LiteralPath and quote paths (spaces are common).
- Deleting/overwriting user files is destructive — recommend, do not auto-run.
- Taking ownership and ACL changes require Administrator rights.
