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

where git >nul 2>nul
if errorlevel 1 goto :no_git
git rev-parse --is-inside-work-tree >nul 2>nul
if errorlevel 1 goto :no_repository

for /f "delims=" %%B in ('git branch --show-current 2^>nul') do set "GEV_BRANCH=%%B"
if /i not "%GEV_BRANCH%"=="main" goto :not_main

for /f "delims=" %%A in ('git status --porcelain') do set "GEV_DIRTY=1"
if defined GEV_DIRTY goto :dirty_worktree

echo Checking upstream main for updates...
git fetch origin main
if errorlevel 1 goto :fetch_failed
git merge-base --is-ancestor HEAD origin/main
if errorlevel 1 goto :not_fast_forward

git diff --quiet HEAD origin/main -- package.json package-lock.json
if errorlevel 1 set "GEV_DEPS_CHANGED=1"

git merge --ff-only origin/main
if errorlevel 1 goto :update_failed

if defined GEV_DEPS_CHANGED (
  echo Dependencies changed. Installing the updated locked dependencies...
  call npm ci
  if errorlevel 1 (
    echo Dependency installation failed. Check the messages above and try again.
    pause
    exit /b 1
  )
)
goto :start

:no_git
echo Git was not found; starting without checking for updates.
goto :start

:no_repository
echo This folder is not a Git checkout; starting without checking for updates.
goto :start

:not_main
echo Automatic updates only run on the main branch. Current branch: %GEV_BRANCH%
echo Starting this branch without changing it.
goto :start

:dirty_worktree
echo The working tree has local changes. Automatic updates were skipped to protect them.
echo Commit or stash your changes, then start again to update main.
goto :start

:fetch_failed
echo Could not check upstream main. Check your network and Git remote, then try again.
pause
exit /b 1

:not_fast_forward
echo Local main has commits not present in upstream main; refusing to rewrite local history.
echo Reconcile the branch manually before starting the launcher again.
pause
exit /b 1

:update_failed
echo Could not fast-forward to upstream main. Resolve the Git error above before retrying.
pause
exit /b 1

:start
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
