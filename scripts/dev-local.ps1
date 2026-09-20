# Windows launcher for the local Ollama voice + HUD path (AI_PROVIDER=ollama).
# Usage:  powershell -ExecutionPolicy Bypass -File scripts\dev-local.ps1 [-NoBrowser]
# Also the target of the "GodsEyeView Local" logon Scheduled Task.
param([switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
New-Item -ItemType Directory -Force -Path (Join-Path $root '.gev-logs') | Out-Null
try { Start-Transcript -Path (Join-Path $root '.gev-logs\dev-local.log') -Append | Out-Null } catch {}

# Read .env for defaults without overriding an already-set environment.
$envFile = Join-Path $root '.env'
if (Test-Path $envFile) {
  foreach ($line in Get-Content $envFile) {
    if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$') {
      $name = $Matches[1]; $value = $Matches[2].Trim().Trim('"')
      if (-not (Test-Path "Env:$name")) { Set-Item -Path "Env:$name" -Value $value }
    }
  }
}

$env:AI_PROVIDER = 'ollama'
if (-not $env:PYTHON) { $env:PYTHON = Join-Path $root '.venv-local\Scripts\python.exe' }
if (-not (Test-Path $env:PYTHON)) {
  throw "Python venv missing at $env:PYTHON. Create it with: python -m venv .venv-local; .venv-local\Scripts\pip install faster-whisper piper-tts numpy nvidia-cublas-cu12"
}
if (-not $env:TTS_VOICE) { $env:TTS_VOICE = 'en_US-lessac-medium' }
if (-not $env:PIPER_MODEL) { $env:PIPER_MODEL = Join-Path $root ".local\voices\$($env:TTS_VOICE).onnx" }
if (-not (Test-Path $env:PIPER_MODEL)) {
  Write-Warning "Piper voice not found at $env:PIPER_MODEL. Download with: $env:PYTHON -m piper.download_voices --download-dir .local\voices $env:TTS_VOICE"
}
# Persist NVIDIA's PTX JIT cache so a Blackwell GPU pays kernel compilation once.
if (-not $env:CUDA_CACHE_MAXSIZE) { $env:CUDA_CACHE_MAXSIZE = '4294967296' }

# Wait for the Ollama tray app (it races this script at logon) before falling
# back to a foreground server. Two servers fighting over 11434 is worse than a
# slow start.
$ollamaUrl = if ($env:OLLAMA_BASE_URL) { $env:OLLAMA_BASE_URL.TrimEnd('/') } else { 'http://localhost:11434' }
# curl.exe ships with Windows and ignores proxy auto-detection, which makes
# Windows PowerShell's Invoke-RestMethod time out against localhost.
function Test-Http($url) { & curl.exe -s -m 2 -o NUL -w '%{http_code}' $url 2>$null }
$ollamaUp = $false
for ($i = 0; $i -lt 60; $i++) {
  if ((Test-Http "$ollamaUrl/api/version") -eq '200') { $ollamaUp = $true; break }
  Start-Sleep -Seconds 1
}
if (-not $ollamaUp) {
  Write-Host 'Ollama not answering; starting ollama serve in the background.'
  Start-Process ollama -ArgumentList 'serve' -WindowStyle Hidden
  Start-Sleep -Seconds 3
}

if (-not $NoBrowser) {
  $port = if ($env:PORT) { $env:PORT } else { '4173' }
  Start-Job -ScriptBlock {
    param($url)
    for ($i = 0; $i -lt 60; $i++) {
      $code = & curl.exe -s -m 2 -o NUL -w '%{http_code}' "$url/api/voice/config" 2>$null
      if ($code -eq '200') { Start-Process $url; break }
      Start-Sleep -Seconds 1
    }
  } -ArgumentList "http://localhost:$port" | Out-Null
}

npm run dev
