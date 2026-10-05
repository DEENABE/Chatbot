# Pure verifier tests: synthetic state only. Does not execute any mutation or inspect user settings.
. (Join-Path $PSScriptRoot '..\scripts\Common.ps1')
. (Join-Path $PSScriptRoot '..\scripts\Mutations.ps1')
$checks = 0
function Assert-Verified([string]$Operation, [hashtable]$Parameters, $State, $Expected, $Effect = $null) {
    $actual = Verify-Operation $Operation $Parameters $State $Effect
    if ($null -eq $Expected) { if ($null -ne $actual) { throw "$Operation should be unverified" } }
    elseif ($actual -ne $Expected) { throw "$Operation returned '$actual', expected '$Expected'" }
    $script:checks++
}
Assert-Verified 'audio.volume' @{ percent=40; muted=$false } @{ percent=40.1; muted=$false } $true
Assert-Verified 'audio.volume' @{ percent=40 } @{ percent=60; muted=$false } $false
Assert-Verified 'audio.volume' @{ percent=0 } @{ percent=$null; muted=$null } $false
Assert-Verified 'theme.set' @{ mode='dark' } @{ appsLight=0; systemLight=0 } $true
Assert-Verified 'theme.set' @{ mode='light' } @{ appsLight=1; systemLight=0 } $false
Assert-Verified 'privacy.set' @{ enabled=$false } @{ userConsent='Deny' } $true
Assert-Verified 'taskbar.set' @{ autoHide=$true } @{ autoHide=$true } $true
Assert-Verified 'registry.set' @{ value=1 } @{ value=0 } $false
Assert-Verified 'power.plan' @{ guid='scheme-guid' } @{ activeGuid='scheme-guid' } $true
$power = @{ monitor="Minimum: 0x00000000`nMaximum: 0xffffffff`nIncrement: 0x00000001`nAC: 0x00000258`nDC: 0x0000012c" }
Assert-Verified 'power.timeout' @{ setting='monitor'; source='ac'; minutes=10 } $power $true
Assert-Verified 'power.timeout' @{ setting='monitor'; source='dc'; minutes=5 } $power $true
Assert-Verified 'power.timeout' @{ setting='monitor'; source='ac'; minutes=5 } $power $false
Assert-Verified 'power.hibernate' @{ enabled=$true } @{ hibernationEnabled=1 } $true
Assert-Verified 'network.adapter' @{ enabled=$true } @{ adapter=@{ AdminStatus='Up' } } $true
Assert-Verified 'network.dns' @{ reset=$true; servers=@() } @{ dns=@() } $null
Assert-Verified 'network.dns' @{ reset=$false; servers=@('1.1.1.1') } @{ dns=@(@{ServerAddresses=@('1.1.1.1')}) } $true
Assert-Verified 'wifi.connect' @{} @{} $null
Assert-Verified 'radio.set' @{ kind='Bluetooth'; enabled=$false } @(@{kind='Bluetooth';state='Off'}) $true
Assert-Verified 'display.topology' @{ topology='extend' } @{ topology=4 } $true
Assert-Verified 'brightness.set' @{ instance='monitor'; percent=50 } @(@{InstanceName='monitor';CurrentBrightness=50}) $true
Assert-Verified 'firewall.set' @{ profiles=@('Public'); enabled=$false } @(@{Name='Public';Enabled=0},@{Name='Private';Enabled=1}) $true
Assert-Verified 'service.set' @{ action='configure'; startupType='Manual' } @{ StartType='Manual' } $true
Assert-Verified 'storage.cleanup' @{} @{} $false @{ skipped=@('locked');deleted=@() }
Assert-Verified 'updates.scan' @{} @{} $true @{ resultCode=2 }
Assert-Verified 'policy.set' @{ value=1 } @{ configured='DWORD:1'; effective=1 } $true
if ((Get-CanonicalState @{ b=@(1,2); a=@{ value=3 } }) -cne (Get-CanonicalState ([pscustomobject]@{a=[pscustomobject]@{value=3};b=@(1,2)}))) { throw 'Equivalent worker states did not canonicalize equally' }
if ((Get-CanonicalState @{ value=3 }) -ceq (Get-CanonicalState @{ value=4 })) { throw 'Changed worker states matched' }
$checks += 2
Write-Output "Passed $checks synthetic Windows verification checks; no settings changed."
