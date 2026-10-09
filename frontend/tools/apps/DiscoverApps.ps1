param([string]$Query = '')
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$rows = [System.Collections.Generic.List[object]]::new()
$errors = [System.Collections.Generic.List[string]]::new()
function Add-App($name,$target,$source,$version='',$publisher='',$aumid='',$package='',$location='') {
  if (!$name) { return }
  if($target -and $target -match '-launcher\.exe$'){try{$direct=$target -replace '-launcher\.exe$','.exe';if((Test-Path -LiteralPath $direct) -and [Diagnostics.FileVersionInfo]::GetVersionInfo($direct).ProductName -eq [Diagnostics.FileVersionInfo]::GetVersionInfo($target).ProductName){$target=$direct}}catch{}}
  if($target -and $target -match '\.exe$'){try{$metadata=[Diagnostics.FileVersionInfo]::GetVersionInfo($target)}catch{$metadata=$null}}else{$metadata=$null}
  $rows.Add([pscustomobject]@{name=$name; fileDescription=$metadata.FileDescription; productName=$metadata.ProductName; executablePath=$target; source=$source; version=$version; publisher=$publisher; appUserModelId=$aumid; packageFamilyName=$package; installLocation=$location})
}
try {
  $shell = New-Object -ComObject WScript.Shell
  foreach ($root in @("$env:APPDATA\Microsoft\Windows\Start Menu\Programs", "$env:PROGRAMDATA\Microsoft\Windows\Start Menu\Programs")) {
    if (!(Test-Path -LiteralPath $root)) { continue }
    Get-ChildItem -LiteralPath $root -Filter *.lnk -Recurse -File -ErrorAction SilentlyContinue | ForEach-Object {
      try { $s=$shell.CreateShortcut($_.FullName);
        $console=$null
        if([IO.Path]::GetExtension($s.TargetPath) -ieq '.msc'){$console=$s.TargetPath}
        elseif([IO.Path]::GetFileName($s.TargetPath) -ieq 'mmc.exe' -and $s.Arguments -match '^\s*"?([^"\r\n]+\.msc)"?\s*$'){$console=[Environment]::ExpandEnvironmentVariables($Matches[1])}
        if($console -and [IO.Path]::GetDirectoryName($console).TrimEnd('\') -ieq "$env:WINDIR\System32" -and (Test-Path -LiteralPath $console)){
          Add-App $_.BaseName $console 'windows_management';continue
        }
        Add-App $_.BaseName $s.TargetPath 'start_menu'; if($rows.Count){$rows[$rows.Count-1]|Add-Member -NotePropertyName shortcutPath -NotePropertyValue $_.FullName;if($s.Arguments){$rows[$rows.Count-1]|Add-Member -NotePropertyName requiresArguments -NotePropertyValue $true}} } catch { }
    }
  }
} catch { $errors.Add('start_menu') }
# A targeted lookup with a verified exact shortcut need not wait for unrelated
# MSIX, association and install-root scans. All records are still discovered on
# this machine and independently validated by the Node registry before launch.
if($Query){
  $exact=@($rows | Where-Object {$_.source -eq 'start_menu' -and $_.name.Trim() -ieq $Query.Trim() -and !$_.requiresArguments -and [IO.Path]::GetExtension($_.executablePath) -ieq '.exe' -and (Test-Path -LiteralPath $_.executablePath -PathType Leaf)})
  if($exact.Count){[pscustomobject]@{apps=@($exact);errors=@($errors.ToArray()|Select-Object -Unique)}|ConvertTo-Json -Depth 5 -Compress;exit}
}
foreach ($root in @('HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths','HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\App Paths','HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths')) {
  try { if (Test-Path $root) { Get-ChildItem $root | ForEach-Object { try { $p=$_.GetValue(''); if ($p) { $p=$p.Trim('"'); $info=[Diagnostics.FileVersionInfo]::GetVersionInfo($p); Add-App $(if($info.FileDescription){$info.FileDescription}else{$_.PSChildName}) $p 'app_paths' $info.ProductVersion $info.CompanyName } }catch{$errors.Add('app_paths_entry')} } } } catch { $errors.Add('app_paths') }
}
foreach ($root in @('HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall','HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall','HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall')) {
  try { if (Test-Path $root) { Get-ItemProperty "$root\*" | ForEach-Object {
    if ($_.DisplayName) {
      $p = [string]$_.DisplayIcon -replace ',\s*-?\d+$',''; $p=$p.Trim('"')
      # DisplayIcon is only a candidate; JS validates existence, extension and safety.
      Add-App $_.DisplayName $p 'uninstall' $_.DisplayVersion $_.Publisher '' '' $_.InstallLocation
    }
  } } } catch { $errors.Add('uninstall') }
}
# MMC consoles installed in System32, in addition to Start Menu shortcuts. Titles come from a small code-owned
# map of well-known consoles; a console without a known title is only reachable through its shortcut above.
try {
  $mscTitles=@{devmgmt='Device Manager';diskmgmt='Disk Management';services='Services';eventvwr='Event Viewer';compmgmt='Computer Management';taskschd='Task Scheduler';gpedit='Local Group Policy Editor';lusrmgr='Local Users and Groups';perfmon='Performance Monitor';certmgr='Certificates';secpol='Local Security Policy';wf='Windows Defender Firewall with Advanced Security'}
  $knownConsoles=@{};foreach($row in $rows){if($row.source -eq 'windows_management'){$knownConsoles[$row.executablePath.ToLowerInvariant()]=$true}}
  foreach($file in @(Get-ChildItem -LiteralPath "$env:SystemRoot\System32" -Filter '*.msc' -File -ErrorAction SilentlyContinue)) {
    $title=$mscTitles[$file.BaseName.ToLowerInvariant()]
    if($title -and !$knownConsoles.ContainsKey($file.FullName.ToLowerInvariant())){Add-App $title $file.FullName 'windows_management'}
  }
} catch { $errors.Add('msc') }
# Control Panel applets: canonical names and localized titles come from the registry, never from a product list.
try {
  Add-Type -Namespace ChanakyaNative -Name Shlwapi -MemberDefinition '[DllImport("shlwapi.dll", CharSet=CharSet.Unicode)] public static extern int SHLoadIndirectString(string pszSource, System.Text.StringBuilder pszOutBuf, int cchOutBuf, IntPtr ppvReserved);' -ErrorAction Stop
  function Resolve-IndirectString($value) {
    if(!$value){return $null}
    if($value -notmatch '^@'){return $value}
    $buffer=[System.Text.StringBuilder]::new(512)
    if([ChanakyaNative.Shlwapi]::SHLoadIndirectString($value,$buffer,$buffer.Capacity,[IntPtr]::Zero) -eq 0 -and $buffer.Length){return $buffer.ToString()}
    return $null
  }
  foreach($key in @(Get-ChildItem -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Explorer\ControlPanel\NameSpace' -ErrorAction Stop)) {
    try {
      $clsid=$key.PSChildName
      if($clsid -notmatch '^\{[0-9A-Fa-f-]{36}\}$'){continue}
      $class=Get-Item -LiteralPath "Registry::HKEY_CLASSES_ROOT\CLSID\$clsid" -ErrorAction SilentlyContinue
      if(!$class){continue}
      $canonical=[string]$class.GetValue('System.ApplicationName')
      if($canonical -notmatch '^Microsoft\.[A-Za-z]+$'){continue}
      $display=Resolve-IndirectString ([string]$class.GetValue('LocalizedString'))
      if(!$display){$display=Resolve-IndirectString ([string]$class.GetValue(''))}
      if(!$display){continue}
      $rows.Add([pscustomobject]@{name=$display; canonicalName=$canonical; source='control_panel'})
    } catch { $errors.Add('control_panel_entry') }
  }
} catch { $errors.Add('control_panel') }
$knownFolders=@{'6D809377-6AF0-444B-8957-A3773F02200E'=$env:ProgramW6432;'7C5A40EF-A0FB-4BFC-874A-C0F2E0B9FA8E'=${env:ProgramFiles(x86)};'1AC14E77-02E7-4E5D-B744-2EB1AE5198B7'="$env:WINDIR\System32";'F38BF404-1D43-42F2-9305-67DE0B28FC23'=$env:WINDIR;'D65231B0-B2F1-4857-A4CE-A8E7C6EA7D27'="$env:LOCALAPPDATA\Programs"}
try {
  Get-StartApps | ForEach-Object {
    if ($_.AppID -match '^[A-Za-z0-9._-]+![A-Za-z0-9._-]+$') {
      Add-App $_.Name '' 'msix' '' '' $_.AppID ($_.AppID.Split('!')[0])
    } else {
      # Desktop entries carry a known-folder path ({GUID}\relative\app.exe) or an absolute path.
      $target=$null;$id=[string]$_.AppID
      if($id -match '^\{([0-9A-Fa-f-]{36})\}\\(.+)$' -and $knownFolders.ContainsKey($Matches[1].ToUpperInvariant())){$target=Join-Path $knownFolders[$Matches[1].ToUpperInvariant()] $Matches[2]}
      elseif($id -match '^[A-Za-z]:\\'){$target=$id}
      if($target -and [IO.Path]::GetExtension($target) -ieq '.exe' -and (Test-Path -LiteralPath $target)){Add-App $_.Name $target 'shell_apps'}
    }
  }
} catch { $errors.Add('msix') }
# Running GUI applications also cover portable applications absent from installers.
try {
  Get-Process | Where-Object {$_.MainWindowHandle -ne 0} | ForEach-Object {
    try {$p=$_.Path;$info=[Diagnostics.FileVersionInfo]::GetVersionInfo($p);Add-App $(if($info.ProductName){$info.ProductName}else{$_.ProcessName}) $p 'running' $info.ProductVersion $info.CompanyName} catch {}
  }
} catch {$errors.Add('running')}
# Scan executable metadata, not a list of known product names. No script wrappers.
$seenPaths=@{};$pathBudget=3000
foreach($directory in @($env:PATH -split ';'|Select-Object -Unique)) {
  if(!$directory -or !(Test-Path -LiteralPath $directory -PathType Container)){continue}
  if($directory.TrimEnd('\').StartsWith($env:WINDIR,[StringComparison]::OrdinalIgnoreCase)){continue}
  try {
    foreach($file in @(Get-ChildItem -LiteralPath $directory -Filter '*.exe' -File -ErrorAction Stop)) {
      try {
      if($pathBudget-- -le 0){$errors.Add('path_budget');break}
      if($seenPaths.ContainsKey($file.FullName)){continue};$seenPaths[$file.FullName]=$true
      # Admit GUI executables only. Console helpers often share their parent app's product name.
      $stream=$null;$reader=$null
      try {
        $stream=[IO.File]::OpenRead($file.FullName);$reader=[IO.BinaryReader]::new($stream)
        if($reader.ReadUInt16() -ne 0x5A4D){continue}
        $stream.Position=0x3c;$pe=$reader.ReadInt32()
        if($pe -lt 0 -or $pe+94 -ge $stream.Length){continue}
        $stream.Position=$pe;if($reader.ReadUInt32() -ne 0x4550){continue}
        $stream.Position=$pe+24+68;if($reader.ReadUInt16() -ne 2){continue}
      }finally{if($reader){$reader.Dispose()}elseif($stream){$stream.Dispose()}}
      $info=$file.VersionInfo
      Add-App $(if($info.ProductName){$info.ProductName}else{$file.BaseName}) $file.FullName 'path' $info.ProductVersion $info.CompanyName
      }catch{$errors.Add('path_entry')}
    }
  }catch{$errors.Add('path')}
  if($pathBudget -le 0){break}
}
# Shell AppsFolder COM enumeration (ExtendedProperty is ~30ms per item) is only a fallback for when Get-StartApps failed.
if($errors.Contains('msix')) {
  try {
    $shellApps=(New-Object -ComObject Shell.Application).NameSpace('shell:AppsFolder')
    foreach($item in $shellApps.Items()) {
      $aumid=$item.ExtendedProperty('System.AppUserModel.ID')
      if($aumid -match '^[A-Za-z0-9._-]+![A-Za-z0-9._-]+$'){Add-App $item.Name '' 'shell_apps' '' '' $aumid ($aumid.Split('!')[0]);continue}
      $target=$item.ExtendedProperty('System.Link.TargetParsingPath')
      if($target -and [IO.Path]::GetExtension($target) -ieq '.exe'){Add-App $item.Name $target 'shell_apps'}
    }
  }catch{$errors.Add('shell_apps')}
}
# Generic GUI PE discovery. Never recurse through links, WindowsApps, or personal documents.
function Is-GuiExecutable($file) {
 $stream=$null;$reader=$null
 try {$stream=[IO.File]::OpenRead($file);$reader=[IO.BinaryReader]::new($stream)
  if($reader.ReadUInt16() -ne 0x5A4D){return $false}
  $stream.Position=0x3c;$pe=$reader.ReadInt32()
  if($pe -lt 0 -or $pe+94 -ge $stream.Length){return $false}
  $stream.Position=$pe;if($reader.ReadUInt32() -ne 0x4550){return $false}
  $stream.Position=$pe+24+68;return $reader.ReadUInt16() -eq 2
 }catch{return $false}finally{if($reader){$reader.Dispose()}elseif($stream){$stream.Dispose()}}
}
# Query arguments are data, never evaluated as PowerShell. On a miss, re-read inexpensive
# registration sources above, then prioritize matching installation folders instead of
# traversing every product's deep subtree. Names come only from this machine.
function Matches-Query([string]$value) {
 if(!$Query){return $true}
 $compact=$value.ToLowerInvariant() -replace '[^\p{L}\p{N}]',''
 $needle=$Query.ToLowerInvariant() -replace '[^\p{L}\p{N}]',''
 if($compact.Contains($needle)){return $true}
 $wanted=@($Query.ToLowerInvariant() -split '[^\p{L}\p{N}]+' | Where-Object {$_.Length -ge 3})
 foreach($token in @($value.ToLowerInvariant() -split '[^\p{L}\p{N}]+')) {
  foreach($word in $wanted) {
   if($token -eq $word){return $true}
   $limit=if($word.Length -ge 8){2}else{1}
   if($token.Length -lt 3 -or [Math]::Abs($word.Length-$token.Length) -gt $limit){continue}
   # Bounded Levenshtein matching helps a miss caused by a typo select its directory.
   $previous=0..$token.Length
   for($i=1;$i -le $word.Length;$i++) {
    $current=New-Object int[] ($token.Length+1);$current[0]=$i
    for($j=1;$j -le $token.Length;$j++) {
     $cost=if($word[$i-1] -eq $token[$j-1]){0}else{1}
     $current[$j]=[Math]::Min([Math]::Min($current[$j-1]+1,$previous[$j]+1),$previous[$j-1]+$cost)
    }
    $previous=$current
   }
   if($previous[$token.Length] -le $limit){return $true}
  }
 }
 return $false
}
$scanClock=[Diagnostics.Stopwatch]::StartNew();$fileBudget=40000
$known=@{};foreach($row in $rows){if($row.executablePath){$known[$row.executablePath]=$true}}
$registeredRoots=@($rows|Where-Object {$_.installLocation -match '^[A-Za-z]:\\' -and $_.installLocation -notmatch '(?i)\\(temp|tmp|package cache)\\' -and (!$Query -or (Matches-Query $_.name))}|ForEach-Object {$_.installLocation})
$installRoots=$registeredRoots+@($env:ProgramFiles,${env:ProgramFiles(x86)},"$env:LOCALAPPDATA\Programs")
$installRoots=@($installRoots|Where-Object {$_}|Select-Object -Unique)
foreach($root in $installRoots){
 $queue=[Collections.Generic.Queue[object]]::new();$queue.Enqueue(@{path=$root;depth=0;selected=(!$Query -or $registeredRoots -contains $root)})
 while($queue.Count -and $fileBudget -gt 0 -and $scanClock.ElapsedMilliseconds -lt 12000){
  $node=$queue.Dequeue()
  # Raw .NET enumeration: the PowerShell FileSystem provider costs several times more per directory.
  try{$entries=[IO.DirectoryInfo]::new($node.path).GetFileSystemInfos()}catch{$errors.Add('install_root_entry');continue}
  foreach($entry in $entries){
   if($fileBudget-- -le 0 -or $scanClock.ElapsedMilliseconds -gt 12000){break}
   if($entry.Attributes -band [IO.FileAttributes]::ReparsePoint){continue}
   if($entry.Attributes -band [IO.FileAttributes]::Directory){
    $selected=$node.selected -or (Matches-Query $entry.Name)
    if($node.depth -lt 5 -and (!$Query -or $selected -or $node.depth -lt 2) -and $entry.Name -notmatch '^(WindowsApps|node_modules|resources|locales|plugins|packages|cache|installer|redist|cef|runtime|runtimes)$'){$queue.Enqueue(@{path=$entry.FullName;depth=$node.depth+1;selected=$selected})};continue
   }
   $baseName=[IO.Path]::GetFileNameWithoutExtension($entry.Name)
   if($entry.Extension -ine '.exe' -or $known.ContainsKey($entry.FullName) -or $baseName -match '(?i)unins|setup|install|updat|crash|helper|service|broker|handler|reporter|elevat|repair'){continue}
   if($Query -and !$node.selected -and !(Matches-Query $baseName)){continue}
   if(!(Is-GuiExecutable $entry.FullName)){continue}
   try{$info=[Diagnostics.FileVersionInfo]::GetVersionInfo($entry.FullName);$name=if($info.FileDescription){$info.FileDescription}elseif($info.ProductName){$info.ProductName}else{$baseName}
    Add-App $name $entry.FullName 'install_roots' $info.ProductVersion $info.CompanyName
    $known[$entry.FullName]=$true
   }catch{$errors.Add('install_executable_entry')}
  }
 }
}
if($fileBudget -le 0 -or $scanClock.ElapsedMilliseconds -ge 12000){$errors.Add('install_scan_budget')}
if($Query){$errors.Add('targeted_install_scope')}

# Registered application associations are metadata only; never run registry command strings.
$associationBudget=200
$associationClock=[Diagnostics.Stopwatch]::StartNew()
$rowsByPath=@{}
foreach($row in $rows){if($row.executablePath){if(!$rowsByPath.ContainsKey($row.executablePath)){$rowsByPath[$row.executablePath]=[Collections.Generic.List[object]]::new()};$rowsByPath[$row.executablePath].Add($row)}}
foreach($hive in @('HKEY_CURRENT_USER','HKEY_LOCAL_MACHINE')) {
 try {
  $registered=Get-Item -LiteralPath "Registry::$hive\Software\RegisteredApplications" -ErrorAction SilentlyContinue
  if(!$registered){continue}
  foreach($appName in $registered.GetValueNames()) {
   if($associationBudget -le 0 -or $associationClock.ElapsedMilliseconds -gt 2500){break}
   $capabilities="Registry::$hive\"+[string]$registered.GetValue($appName)
   foreach($kind in @('FileAssociations','URLAssociations')) {
    $key=Get-Item -LiteralPath "$capabilities\$kind" -ErrorAction SilentlyContinue
    if(!$key){continue}
    foreach($name in $key.GetValueNames()) {
     if($associationBudget-- -le 0 -or $associationClock.ElapsedMilliseconds -gt 2500){break}
     $progId=[string]$key.GetValue($name)
     if($progId -notmatch '^[A-Za-z0-9._-]+$'){continue}
     $commandKey=Get-Item -LiteralPath "Registry::HKEY_CLASSES_ROOT\$progId\shell\open\command" -ErrorAction SilentlyContinue
     if(!$commandKey){continue}
     $command=[string]$commandKey.GetValue('')
     if($command -notmatch '^"([^"\r\n]+\.exe)"(?:\s|$)'){continue}
     $exe=$Matches[1]
     foreach($row in @($rowsByPath[$exe])) {
      if(!$row){continue}
      $field=if($kind -eq 'FileAssociations'){'supportedExtensions'}else{'supportedProtocols'}
      $existing=@($row.$field)+@($name)
      $row|Add-Member -Force -NotePropertyName $field -NotePropertyValue @($existing|Where-Object {$_}|Select-Object -Unique)
     }
    }
   }
  }
 }catch{$errors.Add('registered_associations')}
}
[pscustomobject]@{apps=@($rows.ToArray()); errors=@($errors.ToArray()|Select-Object -Unique)} | ConvertTo-Json -Depth 5 -Compress
