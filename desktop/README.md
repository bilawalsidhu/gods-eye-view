# God's Eye View for Windows

A standalone desktop build of God's Eye View. It is an Electron shell around the
same local server `npm run dev` runs, so every provider and the in-app key setup
(POWER UP) work exactly as in the repository.
Nothing is a thin link to a hosted site: the app source, its production
dependencies and a pinned Node runtime ship inside the installer.

## Install

Download `Gods Eye View-Setup-<version>-x64.exe` from the GitHub release (or the
`gods-eye-view-windows-x64` workflow artifact) and run it. It installs per user,
needs no administrator rights and creates Start menu and desktop shortcuts. A
portable `.zip` is published next to it. Check downloads against `SHA256SUMS.txt`.

The first launch prepares Cesium for the dev server and can take a minute; later
launches are fast because the cache lives in your user profile.

## Where things live

| What | Where |
| --- | --- |
| Provider keys (`.env`) | `%APPDATA%\God's Eye View\config` |
| Dependency cache | `%APPDATA%\God's Eye View\cache` |
| Logs | `%APPDATA%\God's Eye View\logs` |

`File > Open Configuration Folder` and `File > Open Logs Folder` open these.
Uninstalling keeps them; delete the folder to remove your keys.

## Security model

* The server binds to `127.0.0.1` only and is never reachable from the network.
* The window runs with `contextIsolation`, `sandbox` and no Node integration, and
  has no preload script.
* Navigation is locked to the local origin; external links open in your browser,
  and only `http(s)` links are ever handed to the operating system.
* Only microphone capture (voice control) and fullscreen are granted; camera,
  geolocation and every other permission are refused.
* The page keeps the application's own Content-Security-Policy.

## Building (CI only)

The `Desktop` workflow builds on a Windows runner; nothing needs installing on a
developer machine. Run it from the Actions tab, or push a tag `desktop-v0.2.1` to
build and publish a release.

The steps, all under `desktop/`: `npm run icons` renders the icons from
`public/logo.svg`, `npm run stage` assembles `.stage/payload` (source plus
`win32-x64` production dependencies) and `.stage/runtime` (Node, checksum
verified), and `electron-builder` packs the NSIS installer and zip.
`scripts/after-pack.cjs` writes the icon and version resources into the
executable.

## Configuration

`GEV_STATE_DIR` (set by the shell) moves the writable `.env` store out of the
source tree; unset, the repository behaves as before. Provider keys are entered
in the app, so no environment setup is needed.
