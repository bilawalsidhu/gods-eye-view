# ORYN Intelligence prototype

ORYN Intelligence is an enterprise geospatial-intelligence workspace built
around the God's Eye View engine. This checkout is an **experimental,
stand-alone prototype**: it does not touch any production ORYN deployment,
database, Railway project, credential or running service.

## Running it

```sh
npm ci
npm run dev            # http://localhost:5173
# or a production build
npm run build && npm run preview
```

Sign in with any display name. The sign-in is a **local demo session** (see
Boundaries below). Then pick a visualization mode from the command bar or open
the layer manager and enable public layers.

Browser QA for the shell (Puppeteer, headless):

```sh
npm run dev -- --port 5179 --strictPort   # in one terminal
npm run qa:oryn -- --url http://localhost:5179 --shots ./qa-shots
```

## How the engine and the shell fit together

| Layer | Where | Role |
| --- | --- | --- |
| Engine | `src/standalone`, `src/app`, `src/layers`, `src/ui/*` (existing) | Cesium viewer, layer lifecycle, providers, selection, cameras, voice, scenes director |
| Shell | `src/ui/oryn/*`, `src/ui/templates/oryn-shell.html`, `src/ui/styles/oryn.css` | Navigation rail, command bar, inspector, layer manager, timeline, pages, local workspace |
| Wiring | `src/main.js` | Installs the shell, then starts the engine once |

The engine renders inside `#oryn-stage` (see `index.html`). The stage uses
`contain: layout`, which makes it the containing block for every
`position: fixed` panel the engine already has, so the existing chrome (data
panel, context rail, command dock, cockpit, dialogs) keeps its offsets but
measures them from the workspace area rather than the viewport. The Cesium
viewer is never recreated; the shell observes `application.subscribe()` and
reads components with `application.getComponents()` after startup.

`src/ui/oryn/engine.js` is the only module that talks to the engine. It wraps:

- `LayerLifecycle.getAll()` / `setEnabled()` / `subscribeActivity()` for the
  layer manager, feed summary and Data Sources page;
- `layerSnapshot()` (existing) for feed state, mapped to the ORYN vocabulary
  OFF / LOADING / CURRENT / FALLBACK / STALE / PARTIAL / UNAVAILABLE;
- `window` selection events (`gev:entity-selected`,
  `gev:awareness-subject-selected`, and their cleared counterparts) plus
  `getSelectedEntityContext()` for the inspector;
- `getAnalystRecords()` on event layers for the event queue and timeline;
- `flyToLandmark` / `flyToGlobeView` and the shell's `getCameraState` /
  `applyCameraState` for focus, reset and saved scenes;
- `searchAndFlyTo` with the engine's own place search (coordinates, bundled
  places, then Photon / Nominatim / Google when configured).

## What works

- **Shell**: ORYN rail with 16 destinations, command bar (search, org context,
  feed health, UTC clock, mode selector, panel toggles), right inspector,
  bottom timeline, layer-manager drawer, full-page sheets and map drawers,
  responsive down to narrow windows.
- **Engine preserved**: all 32 registered layers, the native data panel,
  context rail, command dock, cockpit, display controls, provider settings,
  scene director and share links still run inside the stage. The engine's
  intel HUD and scope vignette are switched off at start (they remain
  available in the DISPLAY panel) unless a share link restores them.
- **Layer manager**: grouped by domain, searchable, toggles through the
  engine, shows provider, state, last retrieval, record count, key
  requirement and errors as the layer reports them.
- **Inspector**: identity, coordinates, source link, observation time,
  retrieval time, provider-reported values, feed limitations, analyst notes,
  focus / add-to-investigation actions. Measured, provider-reported,
  model-output, analyst and unverified statements use distinct markers.
- **Event queue**: records from enabled event layers (earthquakes, FIRMS
  fires, fire perimeters, cyclones, GNSS integrity, air quality), newest
  observation first, with CSV export; a row opens the inspector and flies the
  camera.
- **Saved scenes**: save, open, rename, duplicate, update, delete; a scene
  restores camera, enabled layers, mode, selection and panel state.
- **Investigations**: create, edit, status, evidence (with provenance),
  timeline, notes, attached scenes, JSON report and entity CSV export.
- **Notes**: per entity or location, stored locally, shown in the inspector
  and in the investigation they belong to.
- **Modes**: Globe Overview, Live Operations, Transportation, Environment,
  Municipal Operations, Agriculture, Investigation, Custom. Managed modes
  enable real layers and report what could not be enabled.
- **Cameras**: typed camera model, provider interface, registry that
  aggregates the engine's public CCTV poses (metadata only), a DEMO provider
  and an unconfigured organization provider. Grid and focus views. A media
  element is only created for a verified stream of a supported kind.
- **Analytics foundation**: typed model definitions, inference-provider
  interface, findings schema. The only provider is explicitly
  `not-configured`; no detections are ever generated.
- **Audit trail**: local record of session, scene, investigation, note,
  export and mode actions.
- **Timeline**: observation windows per enabled event feed over the last
  24 h, drawn from the records the engine holds; playback only for the
  engine's weather clock (radar / satellite / lightning frames), which is the
  one feed with real history.

## Boundaries (read before demoing)

- **Authentication is a local demo session.** There is no identity provider,
  no password check, no server session and no organization isolation. The
  sign-in card and the rail say so. Nothing from the production ORYN
  authentication was copied.
- **Persistence is browser localStorage** under the `oryn:` prefix: scenes,
  investigations, notes, audit entries and the session's display fields.
  Records are validated on read and write; no credentials are stored.
- **Public feeds are periodic snapshots**, not continuous surveillance.
  Coverage depends on providers and receivers. Retrieval time (when ORYN
  fetched) and observation time (per record, when the provider supplies it)
  are shown separately.
- **No camera stream is shown as live** unless a provider supplied a verified
  media URL. Demo camera records are labeled DEMO and have no stream.
- **No model runs.** The analytics registry lists what a future inference
  backend would provide and renders its not-configured state.
- **Alerts are not derived automatically** from public events and no threat
  levels or confidence scores are assigned.
- **PDF export is not implemented** (it would need a new dependency). JSON and
  CSV exports are real downloads.
- **Routing is in-memory** (persisted page id only) so the engine's share-link
  hash is left untouched.

## Reference design

The ORYN website repository named in the brief
(`github.com/monishallada/ORYN-WEBSITE`) returned 404 for anonymous and
credentialed HTTPS access from this machine and no GitHub CLI was installed,
so its code, assets, colors, typography and route names **could not be
inspected**. The shell therefore uses an independent, restrained enterprise
dark theme defined as tokens at the top of `src/ui/styles/oryn.css`, and the
navigation labels from the brief. Replace the token block and the brand mark
in `src/ui/templates/oryn-shell.html` to adopt the real identity.

## Disabled or blocked integrations

| Capability | State | Needs |
| --- | --- | --- |
| Live AIS vessels | unavailable | `AISSTREAM_API_KEY` in `.env` (engine provider settings) |
| NASA FIRMS fires | key required | `FIRMS_MAP_KEY` in `.env` |
| Photorealistic 3D / Cesium World Terrain | keyless fallback | Cesium ion token or Google Maps key |
| Organization camera registry | not configured | authorized registry endpoint + server-side credentials |
| Authorized streams (RTSP/HLS/WebRTC) | not configured | provider implementing `createCameraProvider` with verified stream URLs; HLS playback via the engine's hls.js pipeline |
| Computer vision / change detection / vegetation indices | not configured | inference service implementing `createInferenceProvider` |
| Field boundaries, municipal asset inventories | not configured | organization GeoJSON import (engine Geo Import tool) or data source |
| Alert rules | not available | organization backend to evaluate rules continuously |

## Licenses and attribution

God's Eye View is MIT licensed (see `LICENSE`); its copyright notice is
preserved. Data sources keep their own terms and attribution requirements
(`DATA_SOURCES.md`); the Cesium / Google attribution element stays visible
inside the workspace. The ORYN shell adds no third-party packages; the
Material Symbols subset and Google Fonts already used by the engine are
unchanged, and shell icons are inline SVG. The bundled Bhote Koshi scene data
is non-commercial (see `DATA_SOURCES.md`) and must not ship in a commercial
ORYN product without clearance.

## Next steps

1. Replace the demo session with a real identity provider and move scenes,
   investigations and notes to an organization backend with audit logging.
2. Add an authorized camera provider with server-side credentials and wire
   HLS playback through the engine's existing hls.js pipeline.
3. Connect a multispectral imagery source for agriculture (field boundaries,
   NDVI/NDMI time series) and an inference service for the change-detection
   model, keeping every model output labeled as such.
