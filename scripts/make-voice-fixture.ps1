# Generates scripts/fixtures/voice/local-fly-to-paris.wav with Windows speech
# synthesis: 16 kHz mono 16-bit, 0.6 s of lead-in silence, "Fly to Paris.",
# 0.8 s tail. Re-run only when the fixture must change; update README SHA-256.
Add-Type -AssemblyName System.Speech
$out = Join-Path $PSScriptRoot 'fixtures\voice\local-fly-to-paris.wav'
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
$s.SetOutputToWaveFile($out, $fmt)
$b = New-Object System.Speech.Synthesis.PromptBuilder
$b.AppendBreak([TimeSpan]::FromMilliseconds(600))
$b.AppendText('Fly to Paris.')
$b.AppendBreak([TimeSpan]::FromMilliseconds(800))
$s.Speak($b)
$s.Dispose()
$hash = (Get-FileHash $out -Algorithm SHA256).Hash.ToLower()
"$out`nSHA-256: $hash`nbytes: $((Get-Item $out).Length)"
