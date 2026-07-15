# wakeword.ps1
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

try {
    Add-Type -AssemblyName System.Speech
} catch {
    Write-Output '{"event":"error","message":"System.Speech assembly not available. Wake word disabled."}'
    Exit 1
}

# Create engine
$culture = [System.Globalization.CultureInfo]::new('en-US')
try {
    $recognizer = New-Object System.Speech.Recognition.SpeechRecognitionEngine($culture)
} catch {
    # Fallback to default engine if en-US culture is missing
    try {
        $recognizer = New-Object System.Speech.Recognition.SpeechRecognitionEngine
    } catch {
        Write-Output '{"event":"error","message":"Could not initialize SpeechRecognitionEngine."}'
        Exit 1
    }
}

try {
    # Set default input device (microphone)
    $recognizer.SetInputToDefaultAudioDevice()
} catch {
    Write-Output '{"event":"error","message":"No default microphone device found."}'
    $recognizer.Dispose()
    Exit 1
}

# Set up target words
$choices = New-Object System.Speech.Recognition.Choices
$choices.Add([string[]]@("Hey Nova", "Nova", "Chanakya"))

$gb = New-Object System.Speech.Recognition.GrammarBuilder($choices)
$grammar = New-Object System.Speech.Recognition.Grammar($gb)
$grammar.Name = "wakeword"

$recognizer.LoadGrammar($grammar)

# Register event handler
$action = {
    param($sender, $eventArgs)
    if ($eventArgs.Result.Confidence -gt 0.35) {
        $data = @{
            event = "wakeword"
            text = $eventArgs.Result.Text
            confidence = [math]::Round($eventArgs.Result.Confidence, 3)
        }
        Write-Output ($data | ConvertTo-Json -Compress)
    }
}

$event = Register-ObjectEvent -InputObject $recognizer -EventName SpeechRecognized -Action $action

# Start recognition
$recognizer.RecognizeAsync([System.Speech.Recognition.RecognizeMode]::Multiple)
Write-Output '{"event":"started"}'

# Keep script running until terminated
try {
    while ($true) {
        Start-Sleep -Seconds 1
    }
} finally {
    # Clean up
    Unregister-Event -SourceIdentifier $event.Name -ErrorAction SilentlyContinue
    $recognizer.Dispose()
}
