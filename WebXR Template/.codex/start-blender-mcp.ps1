$codexHome = $env:CODEX_HOME
if ([string]::IsNullOrWhiteSpace($codexHome)) {
    $codexHome = Join-Path $env:USERPROFILE '.codex'
}

$python = Join-Path $codexHome 'mcp\blender\venv\Scripts\python.exe'
$source = Join-Path $codexHome 'mcp\blender\source\mcp'
if (-not (Test-Path -LiteralPath $python) -or -not (Test-Path -LiteralPath $source)) {
    Write-Error "Blender MCP is not installed under $codexHome\mcp\blender. Install the Blender MCP runtime, then reopen this project."
    exit 1
}

$env:BLENDER_HOST = '127.0.0.1'
$env:BLENDER_PORT = '9876'
$env:PYTHONPATH = $source
& $python -m blmcp
exit $LASTEXITCODE
