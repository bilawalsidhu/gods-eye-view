@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 24.14.x or 26.x is required. Install it from https://nodejs.org/
  pause
  exit /b 1
)

node -e "const [major, minor] = process.versions.node.split('.').map(Number); process.exit(major === 24 && minor >= 14 || major === 26 ? 0 : 1)"
if errorlevel 1 (
  echo This app requires Node.js 24.14 or later in the 24.x line, or Node.js 26.x.
  echo Your installed version is:
  node --version
  pause
  exit /b 1
)

if not exist "node_modules\vite\package.json" (
  echo Installing God's Eye View dependencies. This may take a few minutes...
  call npm ci
  if errorlevel 1 (
    echo Dependency installation failed. Check the messages above and try again.
    pause
    exit /b 1
  )
)

echo Starting God's Eye View. Keep this window open while you use the app.
call npm run dev -- --open
if errorlevel 1 (
  echo God's Eye View stopped with an error.
  pause
)
