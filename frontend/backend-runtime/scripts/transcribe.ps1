param(
  [Parameter(Mandatory = $true)]
  [string]$AudioPath
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Speech

$culture = [System.Globalization.CultureInfo]::new('en-US')
$recognizer = New-Object System.Speech.Recognition.SpeechRecognitionEngine($culture)
try {
  $grammar = New-Object System.Speech.Recognition.DictationGrammar
  $grammar.Name = 'dictation'
  $recognizer.LoadGrammar($grammar)
  $recognizer.SetInputToWaveFile($AudioPath)

  $recognizer.InitialSilenceTimeout = [TimeSpan]::FromSeconds(5)
  $recognizer.BabbleTimeout = [TimeSpan]::FromSeconds(3)
  $recognizer.EndSilenceTimeout = [TimeSpan]::FromSeconds(1.5)
  $recognizer.EndSilenceTimeoutAmbiguous = [TimeSpan]::FromSeconds(2)

  $result = $recognizer.Recognize()

  if ($null -eq $result) {
    @{ text = ''; confidence = 0 } | ConvertTo-Json -Compress
  } else {
    @{ text = $result.Text; confidence = [math]::Round($result.Confidence, 3) } | ConvertTo-Json -Compress
  }
} finally {
  $recognizer.Dispose()
}
