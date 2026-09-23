# Module Map — Boundary Roadmap (R4)

Round 2, committed 2026-09-23 (Batch S). Round 1 (cycle 2) split `src/ui.js`
10,500 → 6,680 and extracted the shared flight-tracking pipeline
(`src/data/flightsTracking.js`). This map ranks the NEXT seams by evidence,
states the split strategy for each, and records one deliberate
don't-split decision.

## Method

Rank by **size × churn**, confirm cohesion by shared closure (do the
candidate pieces import each other, or only the outside world?), then weight
**extraction leverage**: a seam is worth cutting when the extracted piece has
a distinct change cadence or test surface. Numbers: `wc -l` at HEAD;
churn = commits touching the file since 2026-06-01 (~4 months).

| Module | Lines | Churn | Size × churn | State |
|---|---|---|---|---|
| `src/ui.js` | 6,680 | 24 | 160,320 | split once (cycle 2); panels remain the biggest block |
| `src/data/flights.js` | 4,801 | 19 | 91,219 | tracking half already extracted; residual is feed ingest + entities |
| `src/data/cctv.js` | 4,958 | 12 | 59,496 | largest single data layer; no extraction yet |
| `src/voice/gevRealtime.js` | 3,021 | 10 | 30,210 | session + UI + pure helpers in one file |
| `src/voice/gevActions.js` | 4,342 | 9 | 39,078 | tool implementations; already per-tool structured |
| `src/data/radio.js` | 3,479 | 9 | 31,311 | stable cadence |
| `src/data/rocketLaunches.js` | 4,180 | 9 | 37,620 | stable cadence |

## Ranked seams (next three)

### 1. `src/data/cctv.js` (4,958 lines, 145 functions, 12 commits)

The largest data layer: source discovery (`cctvSources.js` is already
extracted — the worker-safe parity module), per-city fetchers, entity
rendering, the click/focus gesture, and the LOD policy (also extracted as
`cctvLod.js`/`cctvFocusPolicy.js`). What remains in-file is the fetch→entity
lifecycle per provider.

**Split strategy** — per-provider fetch→normalize modules under
`src/data/cctv/` (austin, caltrans, tfl, + shared `normalize.js`), leaving the
orchestrator (layer registration, entity pool, reconcile loop) in `cctv.js`.
Verbatim moves only; `functions/api/cctv` parity modules stay untouched (they
never imported the layer). Risk: low — each provider module is already a
closure with a narrow surface; the shared entity pool stays behind.

### 2. `src/ui.js` (6,680 lines, 24 commits — highest churn)

Already split once; the remaining block is dominated by the panel subsystem
(layer tray, HUD panel, settings, share links) plus the runtime event wiring.
Highest churn of any module — every UI change pays the full-file re-read.

**Split strategy** — extract the panel subsystem to `src/ui/panels.js` (or a
small family: `layerTray.js`, `hudPanel.js`), keeping `ui.js` as the
StyleManager orchestrator + event wiring. Constraint: the style system
modules (`src/ui/*`) import from `ui.js` today via passed references — keep
that direction (extracted panels receive `styleManager` as an argument), or
the dependency inverts and the split fails. Risk: medium — `ui.js` is the
app's densest state hub; extract only after the panel block's external
references are enumerable from the module map of a single reading.

### 3. `src/voice/gevRealtime.js` (3,021 lines, 10 commits)

Three distinguishable layers share one file: (a) pure decision helpers —
already exported and unit-tested (`shouldPauseRadioForVoice`,
`computeDownscale`, `estimateDataUrlBytes`, `isPushToTalkKey`,
`selectVoiceVisualizerSignal`, `resolveVoiceControlHint`…), (b) the WebRTC
session state machine (`initGevVoiceCommands`, ~2,000 lines), (c) the error/
debug-log store + storage helpers.

**Split strategy** — (a) moves to `src/voice/realtimePolicy.js` and (c) to
`src/voice/realtimeErrorLog.js`; both are verbatim moves with existing test
files re-pointing at the new module. The session machine stays as the
orchestrator. Risk: low — (a) and (c) have zero WebRTC coupling; their tests
already exist and pin behavior.

## Deliberate don't-split: `src/data/flightsTracking.js`

1,433 lines, but it is the shared-pipeline chokepoint both live layers
instantiate (`createFlightTrackingPipeline(config)`); splitting it would
separate shared behavior from both consumers with zero cadence benefit (its
churn rides on flights/military work anyway). Instead, Batch S pinned the
seam with a config-schema contract test (`src/data/flightsTracking.test.mjs`):
24 documented keys = 24 runtime-consumed keys (get-trap) = keys both call
sites provide, optional seams exactly `{trailFloorFix, requestTypeEnrichment}`,
no orphan/dead config. The boundary is now enforced, not merely documented.

`src/data/flights.js` (4,801 × 19) looks like the top candidate by size ×
churn, but its tracking half already moved to `flightsTracking.js`; the
residual is feed ingest + Cesium entity plumbing — the Tier-2 browser-coupled
part (ADR 0008) where extraction has the least leverage and the highest
regression risk. Revisit only if the ingest paths diverge per-feed.

## Rules for any split

1. Verbatim moves — no behavior edits in the same commit.
2. Every existing test file re-points and stays green; new module gets the
   moved tests, not copies.
3. Dev/prod parity untouched: nothing under `functions/api/**` or
   `src/config/apiEndpoints.js` changes for a UI/layer split.
4. The split commit is separate from any feature commit, so review and
   revert are one-file operations.
