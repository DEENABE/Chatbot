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
- Zero-byte check (file "corrupt" because its contents were lost):
  `Get-Item -LiteralPath '<path>' | Select-Object Length`
- Which process holds a file locked ("open in another program"):
  `Get-Process | Where-Object { $_.Modules.FileName -like '*<filename>*' } | Select-Object Name, Id`
- Hidden items making a folder look empty:
  `Get-ChildItem -LiteralPath '<path>' -Force | Measure-Object | Select-Object Count`
- Who am I (before blaming permissions):
  `whoami`
- Mapped network drive state:
  `Get-SmbMapping | Select-Object LocalPath, RemotePath, Status`
- Long-path support (errors over 260 characters):
  `Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem' -Name LongPathsEnabled`
- Folder size before cleaning:
  `Get-ChildItem -LiteralPath '<path>' -Recurse -ErrorAction SilentlyContinue | Measure-Object Length -Sum`

## Common fixes
- Hidden/system attribute making a file "disappear":
  `Set-ItemProperty -LiteralPath '<path>' -Name Attributes -Value 'Normal'`
- Access denied — take ownership (needs admin, be cautious):
  `takeown /f "<path>" /r /d y` then `icacls "<path>" /grant "$env:USERNAME:F" /t`
- File locked by an app — identify the process, then close it (ask first):
  `Stop-Process -Id <pid>`
- Enable long paths (needs admin, reboot to take full effect):
  `Set-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem' -Name LongPathsEnabled -Value 1`
- Corrupt Recycle Bin metadata (Windows rebuilds it automatically):
  `Remove-Item 'C:\$Recycle.Bin' -Recurse -Force -ErrorAction SilentlyContinue`
- Recover from Recycle Bin — list items:
  `(New-Object -ComObject Shell.Application).NameSpace(10).Items() | Select-Object Name, Path`
- Corrupted system files (needs admin):
  `sfc /scannow` and `DISM /Online /Cleanup-Image /RestoreHealth`

## Notes
- Always use -LiteralPath and quote paths (spaces are common).
- Deleting/overwriting user files is destructive — recommend, do not auto-run.
- Taking ownership and ACL changes require Administrator rights. If `takeown`
  returns "Access is denied", stop and tell the user to relaunch as
  Administrator with the exact command.
- A 0-byte file has no contents left to repair — point the user at File
  History, OneDrive version history, or the Recycle Bin instead of running
  repair commands.
- `sfc /scannow` repairs Windows system files; it will never fix a single
  corrupt user document. For Office files recommend Word's "Open and Repair".
- Access denied on a network share is a server-side permission issue — nothing
  on the client can grant access; tell the user to contact the file-server admin.
- Never recursively delete drive roots or `C:\Windows`. Target the specific
  folder that actually holds the junk.
