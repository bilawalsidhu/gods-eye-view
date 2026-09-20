# Incident replay bundles

An incident bundle is one self-contained HTML file that freezes what the
console showed around a moment in time, so it can be mailed, archived or
opened months later without the app, the network or the live feeds. It is
part of the local voice assistant (`AI_PROVIDER=ollama`, see LOCAL-VOICE.md)
and reuses the same in-memory position history as time travel
(TIME-TRAVEL.md), so it covers at most the last 15 minutes.

## What is in a bundle

- **Header**: title, incident time (UTC), camera centre, radius, window and
  the camera altitude / heading / pitch at export time.
- **Screenshot**: the viewport as a JPEG data URL (the same capture
  `ask_about_view` uses).
- **Track map**: a canvas with an equirectangular projection around the
  centre, a dashed radius circle, a scale bar and a north arrow. Every track
  that passed inside the radius during the window is drawn as a polyline,
  coloured from blue (oldest) to red (newest), with a labelled end marker and
  heading tick.
- **Replay**: a play / pause button, ×1 / ×10 / ×60 speed and a scrub slider.
  Positions between fixes are interpolated (longitude wrap-aware), faded full
  tracks stay visible behind the live portion.
- **Tracks** table: label, layer, id, fix count, seen interval, closest
  approach in km.
- **Fix timeline**: every fix (time, layer, label, lat, lon, altitude,
  heading, speed), rendered from the embedded data; past 600 rows it is
  evenly sampled and says so.
- **Transcript**: the recent spoken exchange inside a doubled window.
- **Alerts**: standing watches at export time, or the alert that triggered the
  capture.
- **Notes**: free text, when provided.

The file makes no network requests: no external scripts, styles, fonts or
images. Track data is embedded as JSON in a `<script type="application/json">`
element and rendered by a small inline script. Budgets keep the file under
~400 KB before the screenshot: at most 150 tracks and 5 000 fixes (tracks are
ordered by closest approach and dense tracks are thinned evenly, always
keeping their first and last fix). A 20-track, 60-fix sample is about 60 KB;
the screenshot typically adds 150–300 KB.

## Voice tools

| Tool              | Arguments                                                          | Result                                                            |
| ----------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------- |
| `export_incident` | `title?` string, `minutes?` 0.5–15 (default 5), `radiusKm?` 1–500 (default 50) | `{ ok, file, tracks, bytes, downloaded, screenshot, title, error? }` |
| `list_incidents`  | none                                                               | `{ ok, count, incidents: [{ file, bytes, savedAt }] }`            |

Say "save this incident", "export this as runway incursion" or "make a report
of what just happened". The centre is the current camera position; the window
is `now ± minutes`. The bundle is always posted to the server, and the browser
is also offered a download through a Blob link. Sandboxed or headless tabs may
silently refuse the download (`downloaded: false`); the server copy is the
record.

`src/voice/incidents.js` also exports `captureIncident(alert, context)` for
the alert engine: it titles the bundle after the alert's description and
label and embeds the alert. It is not wired to `watch_add` alerts yet.

## Server route

`POST /api/voice/incidents` with JSON `{ title, at, slug?, html }` saves the
document under `.gev-logs/incidents/<YYYYMMDD-HHMMSS>-<slug>.html` and
answers `201 { ok, file, bytes, removed, kept }`. Bodies over 8 MB are refused
with 413 before they are read in full; `html` must be a complete document
(starts with `<!doctype html`) or the request is a 400. After every save only
the newest 50 files are kept.

`GET /api/voice/incidents` lists the saved bundles newest first:
`{ ok, dir, count, incidents: [{ file, bytes, savedAt }] }`.

`GET /api/voice/incidents/<file>` serves one bundle as `text/html` with a
strict inline-only Content-Security-Policy; file names must match the pattern
above, so traversal and arbitrary reads are not possible.

The route is installed through `server/providers/ollama/routes/index.js`
(`FEATURE_ROUTES`) and the tool pack through `src/voice/tools/index.js`
(`LOCAL_TOOL_PACKS`). Bundle construction lives in
`src/voice/incidentBundle.js` and is pure, so it is unit-tested against
`createPositionHistory` directly (`src/voice/incidentBundle.test.mjs`); the
route is tested against a temporary directory
(`src/voice/incidentsRoute.test.mjs`).

## Limits

- History depth is the position history retention (15 minutes) and only the
  layers it records (`flights`, `military`, `ais-live-vessels`).
- Tracks whose only fixes are outside the window or the radius are omitted;
  an empty bundle is still saved (the assistant says so).
- The screenshot is whatever the WebGL canvas held at export time; a
  throttled background tab may yield a stale frame or none.
