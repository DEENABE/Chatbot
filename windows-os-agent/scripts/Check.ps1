$ErrorActionPreference = 'Stop'
$files = Get-ChildItem -LiteralPath $PSScriptRoot -Filter '*.ps1'
foreach ($file in $files) {
    $tokens = $null; $errors = $null
    $null = [System.Management.Automation.Language.Parser]::ParseFile($file.FullName, [ref]$tokens, [ref]$errors)
    if ($errors.Count) { $errors | Format-List; throw "Parse errors in $($file.Name)" }
}
Add-Type -Path (Join-Path $PSScriptRoot 'Native.cs')
Write-Output "Parsed $($files.Count) PowerShell scripts and compiled Native.cs successfully. No system settings were changed."
& (Join-Path $PSScriptRoot '..\test\verification.ps1')
