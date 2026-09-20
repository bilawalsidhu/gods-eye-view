# Time travel

Rewind and scrub the last 15 minutes of live flights, military flights and
ships. Recording starts at application start; nothing is fetched or persisted.

## What it is

- `src/history/positionHistory.js` — `createPositionHistory()` subscribes to
  the data manager's `data-updated` activity and snapshots
  `module.getAnalystRecords()` for each enabled watched layer (`flights`,
  `military`, `ais-live-vessels`). Fixes are stored per entity in typed-array
  ring buffers (36 bytes per fix, at most 256 fixes per entity).
- `src/history/timeTravel.js` — `createTimeTravel()` owns the
  `live | rewind` state machine, the animation loop and the overlay: one
  `PointPrimitiveCollection` point per entity (flights amber, military red,
  vessels cyan, 6 px, drawn over terrain) plus a 60-second trail polyline for
  the entities nearest the camera (250 at most).
- `src/ui/timeTravelControl.js` + `src/ui/styles/time-travel.css` — the dock
  button (`⏪ 10 MIN`) and the scrubber strip that appears above the command
  dock while rewound: offset (`LIVE −07:32`), wall clock, range slider over
  the recorded window, play/pause, ×1/×4/×16 and LIVE.
- Wired in `src/ui/applicationShell.js` (`_initTimeTravel()`), torn down in
  `dispose()`.

## Programmatic API

`window.__gevTimeTravel` is the stable seam for the voice assistant and the
console:

| Call                         | Effect                                                                                                                                   |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `rewind(offsetMs = -600000)` | Enter rewind at `now + offsetMs` (clamped to the recorded window) replaying forward at ×1. Returns `false` when nothing is recorded yet. |
| `seekTo(timestampMs)`        | Jump to an absolute time (clamped). Enters rewind from live.                                                                             |
| `setRate(rate)`              | `0` pauses; `1`, `4`, `16` replay forward. Returns the effective rate.                                                                   |
| `resumeLive()`               | Leave rewind, restore live visuals.                                                                                                      |
| `state()`                    | `{ mode, displayTimeMs, offsetMs, rate, oldestT, newestT }`                                                                              |
| `range()`                    | `{ oldestT, newestT, count }` of the recorded history                                                                                    |

Keyboard: `[` rewinds ten minutes (again while rewound steps back another
ten), `]` returns to live.

## How live visuals are hidden

The live layers cannot render backwards — their snapshot renderers reconcile
forward-only state — so rewind never touches their data. Instead each of the
three layer modules exposes `setPresentationSuppressed(boolean)`:

- flights / military: hides the billboard and model collections, the tracked
  aircraft model and trail; `enable()` and cockpit-mode changes honour the
  flag; `getAnalystRecords()` keeps answering while suppressed so recording
  continues during a rewind.
- vessels: `rendering.setVisible(false)` (billboards + label overlay);
  `enable()` honours the flag.

Suppression is re-asserted once a second while rewound (a layer enabled
mid-rewind stays hidden) and lifted on resume, destroy, or when a forward
replay reaches the newest recorded fix (auto-resume). Entering rewind releases
any follow camera, since its target is hidden.

## Limits

- 15 minutes of retention, in memory only; a reload starts empty.
- Positions only: latitude, longitude, height, heading and speed per fix — no
  callsign changes, routes, squawks or AIS destinations are replayed.
- One fix per poll (~30 s for aircraft); faster feeds are thinned to one fix
  per 4 s per entity, and unmoved contacts refresh once a minute.
- Memory is capped at 32 MB across all layers; when exceeded, the entities
  that reported least recently are dropped first.
- Entities with no fix within ±90 s of the display time are not drawn.
- Picking, cards and detection do not apply to the rewind overlay.
