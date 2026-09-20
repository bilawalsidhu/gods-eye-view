# Operations Console

Structural chrome layered over the globe: a command bar with live camera
telemetry, a module rail, an intelligence dossier, and a command palette.

It is **additive**. The console constructs no scene state, registers no layer
and owns no camera. Every action it offers is delegated to the control that
already owns that behaviour, so a console command and the equivalent click
settle in exactly the same application state. Standing it down removes one
class from `<body>` and leaves the original floating-panel interface untouched.

## Surfaces

| Surface | Element | What it shows |
| --- | --- | --- |
| Command bar | `#gev-console-topbar` | Brand, link/feed/analyst status, LAT · LON · ELEV · HDG · TILT · MGRS, frame rate, UTC clock, palette + dossier + exit |
| Telemetry strip | `#gev-console-statusbar` | Active feed chips with live counts, the last console action, the resolved place |
| Module rail | `#gev-console-rail` | Eight application panels, opened through their own disclosure controls |
| Dossier | `#gev-console-dossier` | `ANALYST` · `FEEDS` (layer roster with toggles, health and age) · `LOG` |
| Command palette | `#gev-console-palette` | <kbd>⌘K</kbd> / <kbd>Ctrl K</kbd> — places, feeds, presets, modules, console actions |

The bottom band belongs to the application. The Cesium attribution, the command
dock, the mic pill and the toast all live there, and the credit must stay
visible under the Google/Cesium terms, so no console surface is anchored to it
(`src/tooling/consoleMarkup.test.mjs` pins that, and
`src/creditAttribution.test.mjs` models the application's own chrome).

## How it attaches

`src/main.js` calls `mountOperationsConsole()` before bootstrap. The console
polls for `window.__godsEyeView` — the handle `src/app/tools.js` publishes once
the scene is up — and reads from it:

- `viewer.camera.positionCartographic` and `camera.heading/pitch` → readouts
- `viewer.scene.postRender` → frame rate, the same event the existing readout counts
- `dataManager.getAll()` / `setEnabled()` / `subscribe()` → the feed roster and its toggles
- `styleManager.setStyle()` → visual presets

Panels are toggled by clicking their own `[data-dock-toggle-target]` or
`[data-collapse-target]` control, so disclosure, focus handling, pinning and
rail layout all run exactly as they do for a direct click. A `MutationObserver`
follows panel state, so the rail stays correct when a panel is opened by a
keyboard shortcut, the dock, or a restored share link.

Every accessor is defensive: the handle is absent before bootstrap and after
teardown, the viewer can be destroyed mid-frame, and a runtime-built panel may
not exist yet. A missing piece degrades that readout, never the page.

## Stand-down

`EXIT` in the command bar, or the palette's *Stand down the console* command,
removes `body.gev-console` and shows the `OPEN CONSOLE` chip. The choice is
remembered in `localStorage` under `godsEyeView.console.enabled`; blocked
storage is not an error. The console also stands aside automatically for
clean view (`body.ui-clean-view`) and the first-person cockpit
(`body.cockpit-mode`), which both claim the whole frame.

## Scene analyst

`ANALYST` in the dossier posts to `/api/openai/analyst`, brokered by the same
provider that issues the realtime voice token
(`server/providers/openai/analyst.js`). The browser sends a question plus a
snapshot of what the console can see — camera pose, place label, visual preset,
enabled layers with record counts and feed health — and gets plain text back.

- The credential stays server-side. `GET` reports only whether one is
  configured, so the panel can show `ANALYST OFFLINE` without spending a
  request; with no key it says which variable to set.
- Every request is bounded before it reaches OpenAI: 32 KB body, 800-character
  question, six replayed turns, 6 KB of serialized context, capped output.
- The opt-in `GEV_RATELIMIT_OPENAI_PER_MIN` throttle that covers the voice
  token and the HUD summary covers this endpoint too.
- Model: `OPENAI_ANALYST_MODEL`, default `gpt-5-mini`. A non-reasoning override
  drops the `reasoning` parameter that would otherwise be rejected.

## Files

```
src/console/index.js        composition root, lifecycle, telemetry loops
src/console/bridge.js       read-only window onto the running application
src/console/commands.js     command registry and ranking (pure)
src/console/palette.js      palette controller (ARIA combobox)
src/console/analyst.js      analyst panel client
src/console/format.js       readout formatting (pure, total)
src/ui/templates/console.html   markup, registered in build/application-html.js
src/ui/styles/console.css       styles, imported last from style.css
server/providers/openai/analyst.js  the analyst endpoint
```
