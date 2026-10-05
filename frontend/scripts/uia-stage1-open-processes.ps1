# Test selection only: process metadata for an already-open discovered app.
# No UI inspection, activation, or launch occurs here.
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$items=@(Get-Process | ForEach-Object {try{if($_.MainWindowHandle -ne 0 -and $_.Path){@{processId=$_.Id;windowHandle=$_.MainWindowHandle.ToInt64().ToString();executablePath=$_.Path}}}catch{}})
ConvertTo-Json -InputObject $items -Compress
