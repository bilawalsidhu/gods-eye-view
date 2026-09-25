# Formatting and component boundaries

Run `npm run format` to format the files in `scripts/format-scope.json` plus
automatically discovered runtime JavaScript in `scripts/format-runtime.json`, and
`npm run format:check` to check that same list without writing. CI checks the
combined scope on Linux and Windows. Prettier is pinned in the development
dependencies; use the installed version so local and CI output agree. The shared
configuration specifies two spaces, single quotes, semicolons and LF endings.

Owned runtime modules are discovered automatically; add their tests and other
non-runtime files to the explicit list as they are adopted.
Keep mechanical formatting in its own commit after behavior is stable. Existing
source-text regression assertions still apply; investigate failures and preserve
their behavioral coverage when a move or line wrap changes a tested shape.
Files outside the runtime roots and explicit list retain their surrounding style
until deliberately adopted.
Generated output, local configuration, browser evidence and bundled datasets are
excluded. The formatter validates every entry before writing any file.

## Current component ownership

Package imports use `gods-eye-view`; `package.json` is the authoritative
export inventory. Use declared exports rather than reaching into internal files.

| Owner                  | Responsibility and lifetime                                                                             |
| ---------------------- | ------------------------------------------------------------------------------------------------------- |
| `src/app/`             | Construct supplied components, share scene/request services, cancel startup and dispose the application |
| `src/standalone/`      | Select the default catalog, local sources and setup controls                                            |
| `src/ui/`              | Navigation generations, restoration, visual state, panel snapshots and their subscriptions              |
| `src/data/`            | Lifecycle, context and feed state; legacy default-layer facades                                         |
| `src/layers/<family>/` | Source acquisition, records and Cesium resources with explicit controller/renderer owners               |
| `src/sources/`         | Portable protocols and source contracts; request state belongs to each factory instance                 |
| `src/services/`        | Supplied application operations; scene construction owns caches and cancellation                        |
| `src/voice/`           | Portable action schemas/session, common controls, action execution and separate protocol adapters       |
| `server/providers/`    | Node route factories, process-scoped provider caches and shutdown cleanup                               |
| `server/standalone/`   | Environment, local settings writes and server composition                                               |

See [application construction](APPLICATION.md) and the
[infrastructure contract](INFRASTRUCTURE-LAYERS.md) for construction interfaces.

## Import direction gates

`npm run check:boundaries` runs two complementary checks:

1. `scripts/check-import-directions.mjs` parses every runtime JS/MJS/CJS file in
   `src/` and `server/`, including files unused by the current bundle. Static,
   literal dynamic and re-export edges are checked; computed module imports and
   CommonJS `require` are rejected. Browser graphs cannot reach Node, server or
   test modules through helpers. Reusable modules cannot select standalone setup,
   and provider modules cannot import application/rendering modules.
2. `scripts/check-package-boundaries.mjs` builds every declared export without
   app Vite configuration or environment files. `scripts/package-boundaries.json`
   assigns each export exactly once and lists its owned modules and external
   dependencies. Unused imports still count. Node exports have only a `node`
   condition; browser groups cannot use build-only dependency exceptions.

Portable source graphs cannot reach application/rendering, Node, Cesium or
browser globals. This includes `sources/*`, dedicated `layers/*/source` exports,
flight/military/vessel record and ingestion exports, action schemas, the session
interface, lifecycle and feed state. The browser-global rule reserves platform
names such as `document` and `window` in these modules; it is an architectural
check, not a JavaScript sandbox. Common voice controls cannot depend on a
Realtime protocol implementation. Negative fixtures cover indirect helpers,
self-package imports, symlinks and unreachable files.

Source factories have dedicated exports for ALPR, bikeshare, CCTV, earthquakes,
FIRMS, installations, launches, radio, satellites and traffic. They preserve the
same factory implementations without loading layer rendering. ALPR/earthquake
record normalization and CCTV source endpoint policy have plain owners separate
from geometry/cards. Source exports do not start acquisition at import time.

Other layer `ingestion.js` files may still coordinate Cesium resources; the
portable contract applies to the explicitly reviewed graphs above. Their layer
controller remains the owner of rendering/cleanup until a focused extraction
moves it. Do not label all ingestion modules platform-independent by filename.

## Compatibility entries and owners

| Retained entry                                      | Owner and current reason                                                                                           |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `src/ui.js`                                         | UI facade; direct callers retain standalone StyleManager defaults. Normal assembly uses `src/ui/composition.js`    |
| `src/data/manager.js`                               | Lifecycle/panel compatibility and existing tests; normal assembly constructs lifecycle and presentation separately |
| `src/data/<layer>.js`                               | Legacy default instances; new assembly calls layer factories with supplied sources                                 |
| `src/data/localGeojson.js`                          | Infrastructure compatibility factories; catalog imports services from `src/app/localGeojsonServices.js` directly   |
| `src/app/sourceSlot.js`                             | Re-export for direct callers/tests; portable slot ownership is `src/sources/sourceSlot.js`                         |
| `src/app/sources.js`, `src/services/application.js` | Existing default/override API; current application construction supplies its own instances                         |
| `server/providers/local.js`                         | Existing Node composition barrel and provider helper re-exports                                                    |

The two exact standalone-import exceptions are `src/ui.js` to
`src/standalone/catalog.js` and `server/providers/local.js` to
`server/standalone/key-setup.js`. They do not authorize new compatibility
back-edges. Voice actions use plain `src/data/feedState.js`, not the manager
facade. Settings filesystem hardening belongs in
`server/standalone/key-setup-hardening.mjs`; its settings policy is unchanged.
Test modules and the Node-only allocation benchmark are outside browser runtime.

## Build and standalone server configuration

`gods-eye-view/build/vite` is a separate Node-only export. `build/vite.js`
creates standard Cesium/Vite browser settings from explicit inputs. It imports
`build/cesium.js` and the declared `rollup-plugin-external-globals` build
dependency, discovers no environment, and constructs no provider middleware.
Call it from a Vite configuration:

```js
import { createBrowserViteConfig } from 'gods-eye-view/build/vite';

export default createBrowserViteConfig({
  plugins: [],
  googleApiKey: undefined,
  cesiumToken: undefined,
});
```

`build/cesium.js` owns the Cesium wiring: it defines `CESIUM_BASE_URL`, serves the
unminified build from `node_modules` in development, keeps `cesium` out of the
production bundle in favour of the prebuilt global, and copies the runtime asset
directories into the output. Consumers supply compatible Vite and
`rollup-plugin-external-globals` development dependencies.
The package's `node` export condition has no browser fallback. The boundary gate
builds this group for Node, with the declared build dependency external; its
owned module list is checked just like browser groups. Browser groups cannot
use build-only dependency exceptions.

`server/standalone/vite.config.js` loads the root environment and passes selected
browser keys, host/port and the ordered local provider plugins to this helper.
`server/providers/local.js` composes provider factories and re-exports existing
helpers for compatibility. Provider Settings lives in `server/standalone/key-setup.js`
and writes to the same root `.env` or Pinokio store as before. `vite.config.js`
preserves the default configuration and named provider exports for tools/tests.

## Aircraft and vessel providers

`server/providers/live.js` exports the existing Node middleware factories and
request helpers. `aircraft/` owns OpenSky state/fallback, military positions,
enrichment and track endpoints in separate files. `vessels/ais-live.js` owns
websocket setup and route responses; `vessels/ais-store.js` owns record ingestion,
static metadata and recent-track storage. Neither area imports globe rendering.
`common/http.js` owns capped reads/coalescing; `common/query.js` owns query values.

These plugins retain their existing process-scoped caches and server lifetime.
Importing the entry does not start acquisition. The AIS plugin disposes its
socket/watchdog on server close and re-reads configuration after restart.
The portable `gods-eye-view/sources/adsb-lol` export normalizes existing aircraft
records without importing Node middleware or a renderer. Browser layer/controller
separation is outside this server extraction.

## Place-search and routing providers

`gods-eye-view/server/providers/places` exports the Google nearby-place and
text-search plugin, OSRM route registration, and their shared Node helpers.
The existing Overpass plugin still mounts `/api/route` in its original order.
Google credentials are resolved on each request; the default uses the existing
server-key precedence, and callers may supply `resolveApiKey`.

`gods-eye-view/sources/places` exports portable response projections for Google
place results and OSRM route results/profile aliases. These functions own no
credentials, requests, caches, environment loading, or rendering. Callers retain
input validation and upstream-response acceptance. The boundary check builds
this entry independently and rejects Node imports.

The browser's direct geocoding, annotation rendering and full Overpass query
service remain in their existing modules.

## Satellite and launch providers

`gods-eye-view/server/providers/space` is a Node-only entry for the CelesTrak
and Launch Library 2 middleware. Separate files under `server/providers/space/`
own each feed's acquisition, memory/disk cache and error handling. The existing
local composition mounts them in the same order. Importing the entry performs
no acquisition; factory calls create independent cache state.

`gods-eye-view/sources/space` owns only fixed upstream URL construction: the
CelesTrak group/TLE query and Launch Library's recent 30-day detailed feed.
Callers supply the group or end date and own validation, credentials, transport,
response limits and cache policy. The boundary gate checks this portable entry
separately from the Node providers. Satellite rendering and launch replay remain
in their existing browser modules.

## Terrain, traffic, fires and bike-share providers

`gods-eye-view/server/providers/terrain`, `/traffic`, `/firms` and `/gbfs`
are separate Node-only entries. Each owns its existing middleware and
process-scoped cache or request handling. Standalone composition mounts them in
the original order; their imports do not start acquisition.

`gods-eye-view/sources/terrain` exports existing point-key, retry and cache
reconstruction mechanics with injectable acquisition dependencies.
`gods-eye-view/sources/traffic` exports tile math and budget calculations.
`gods-eye-view/sources/gbfs` exports host/path acceptance and cache-header rules.
These entries import no Node middleware, application configuration or rendering.
Callers retain their request admission and transport policy.

`gods-eye-view/sources/firms-csv` exports the existing CSV parser, header
recognition, acquisition-time conversion and trailing-day filter independently
of the Node middleware. It imports no Node, DOM, rendering or network code.
The Node provider continues using the same implementation; contract fixtures
cover malformed rows, acquisition times, empty feeds and the inclusive time
window. The boundary gate checks each entry independently.

Browser terrain sampling, traffic matching/drawing, fire overlays and bike-share
layer lifecycle remain in their current modules. This extraction changes no
source defaults, credentials, quotas, data interpretation or visual behavior.

## Local search, regional context, voice and setup

Node-only exports `server/providers/overpass`, `server/providers/military-installations`,
`server/providers/regional` and `server/providers/openai` own request handling
without importing the standalone configuration or browser rendering. Overpass
separates query admission, geometry simplification, cache and transport; military
search shares the bounded transport. Regional place/news/weather acquisition is
separate from briefing and weather-effect response caches. Voice handlers share
existing rate limits and request reading; schemas and instructions are separate.

`server/standalone/key-setup` is explicitly standalone Node functionality.
Its factory and the local voice factory accept `sourceRoot` for application-owned
configuration/log files; defaults resolve the repository root. Local voice also
accepts an optional `annotationGuidance` paragraph. Neither factory starts
acquisition on import. Setup retains its pre-environment-load provenance capture
and development-only registration. Package checks enumerate every owned module
and reject browser imports of these Node entries.

## Browser place search

`gods-eye-view/search` exports an explicit geocoding service and Google/Photon
adapters. The entry owns normalization, bounded caches, deadlines and fallback
sequencing. It imports no application state, environment configuration, rendering
or Node server code. Google transport is supplied by its caller.

`src/standalone/placeSearch.js` constructs the configured Google request and
keyless Photon fallback. The application passes this service to location
controls, annotation resolution and voice/radio actions. Those consumers retain
framing, landmark recovery, footprint matching and playback decisions. Existing
reverse geocoding and nearby/text-search routes remain separate.

## Panel controls

`gods-eye-view/ui/panels` owns collapse-button binding, nearest-panel Escape
handling, hover delays and delayed content-focus handoff. It accepts existing
DOM elements and callbacks; importing it creates no browser state. `destroy()`
removes owned listeners and cancels pending work without changing saved state
or moving focus. Call it before removing or replacing the controls.

`src/ui.js` retains panel layout, persistence, share restoration and application
reactions to state changes. Map Source selection and Location draft cleanup are
provided through callbacks. The component imports no globe, data, application
or server modules. Package checks and scoped formatting cover this entry.

## Surface keyboard handling

`gods-eye-view/ui/surfaces` exports `createSurfaceKeyboard` from
`src/ui/surfaceKeyboard.js`. It receives a root DOM node, an optional document,
an `isActive` predicate, an `onEscape` action and an optional return-focus fallback.
Construction is inert. `activate()` remembers the opener and installs one capture
listener; repeated activation is harmless. `deactivate({ restoreFocus: true })`
removes that listener and restores the opener when connected, otherwise invoking
the supplied fallback. Omit return focus when yielding to another surface.
`destroy()` permanently releases ownership without moving focus.

The welcome launcher and Provider Settings retain content, visibility, initial
focus, animation and screen-specific policy. Tab boundaries are read from the
current visible/enabled controls for each key; ordinary movement within those
boundaries remains native. The component honors already-handled keys and has no
app, server, storage or network dependencies. Its package boundary is checked
independently from the standalone screens that consume it.

## Panel rail layout

`gods-eye-view/ui/layout` exports synchronous `layoutLeftPanelRail` and
`layoutRightPanelRail` passes, `measurePanelNaturalHeight`, and the existing pure
corridor/allocation helpers. Separate modules own left placement, right placement,
DOM height measurement and rail geometry. They import no application, renderer,
server, storage or network modules; package checks build this entry independently.

Callers supply rail/obstacle DOM nodes, the viewport, HUD state, the preferred
panel, disclosure/retry callbacks and the left measurement cache. Right layout
reads the caller's Display scroll value at measurement time and restores it
within the resulting scroll range. The left pass notifies its caller after
alignment so the right pass can follow. Neither pass installs listeners, timers
or observers; construction/import does no work. Scheduling, preference writes,
share restoration and movement of controls between containers remain caller-owned.
Existing helper imports from `cockpitMath.js` and `rightRailPolicy.js` remain
compatible through re-exports.

### Adding a right-rail readout panel

Add the shell in `src/ui/templates/context.html` inside `#right-context-rail`:
a `.panel-collapsible` with a stable `id` and matching `data-panel-id`, the
existing `.panel-header`, collapse button and a dedicated body. Register it
with the existing panel chrome/layout owners; do not allocate rail space in
the body renderer. Set `hidden` while empty so the allocator ignores it, and
expand through the existing collapse button only on first appearance per page
session, and only when the chrome marked the restored state as a default
(`data-collapsed-preference`), never over a stored or shared choice. Preserve
the user's later collapse choice, including body remounts. Mark the body
`data-rail-scroller` when it scrolls: the rail's measuring pass lifts its
`max-height` and puts the scroll offset back afterwards. Panel bodies only
scroll on an open-card change, with one write, never on a refresh.

Compose `createRailCards({ container, document, onParams, onOpen })` and
`createRailTimeline({ container, document, onCommit, onPreview, onStep,
onLatest, onPlay })`. Cards reconcile `{ id, title, badge, open, compact,
compactStatus, blocks }` in place. Their full-width native button headers expose
`aria-expanded` and `aria-controls`; articles expose `data-open`. The feature
adapter owns accordion state. Generic cards do not select data or enable layers.

`blocks` is an ordered array of loose, optional `{ id, type, ... }` descriptors,
rendered by `railCardBlocks.js`. There are no per-section disclosures:

- `summary`: `text`, a single summary line.
- `list`: `list: { ariaLabel, items }`, reconciled by `syncRowList` in `rowList.js`.
- `lines`: keyed `lines: [{ id, text, muted? }]` for details and status.
- `settings`: `settings: [{ id, label, chips }]`; each labelled row has a 56 px
  label column and a wrapping `syncChipGroup` from `chipGroup.js`.
- `legend`: `legend: { colors, labels, units?, zeroIndex?, categorical? }` for a
  ramp/scale (including a physical freezing anchor) or separate keyed swatches.
- `actions`: keyed `actions: [{ id, label, params?, href?, onClick?, disabled?,
hint? }]` in a footer, using buttons or safe new-tab links.
- `result`: `label`, keyed `lines`, and optional `clear: { params | onClick }`;
  its accessible × button sits beside the title.

Every block and control has a stable id. Lists, settings, actions and results
can appear in any requested order, including a scene panel's rectangle action,
results list, then selected-scene details. Chip/list/action `params` dispatch
through `onParams(cardId, params)`; the feature adapter supplies
`setLayerParams(id, params, { origin: 'user' })`. Current descriptors and disabled
state are read at dispatch. Identical updates do not move nodes or write DOM;
focused controls survive feed refreshes.

Weather descriptors retain top-level `chips`, `list` and `legend` for non-DOM
consumers. They expose `summary.settings`, `summary.actions` and optional
`summary.result`; wind also retains its raw captured `summary.reading`.
`readout: true` layer rows render only the toggle and source/meta line; their
subscriptions still refresh the cards. Cards own configuration and readings.

Weather orders cyclones, wind, then a bordered Observed history group containing
the timeline and active radar, satellite and lightning cards. The group heading
and scope name its active products. The timeline stays visible whenever any
observed product is enabled; fewer than two ticks disables transport. Pass
`heading: false` to the timeline when the containing group owns the heading.
Exactly one active card is open. Header clicks and newly enabled ids choose it
(the last new entry wins a batch); refreshes and clock ticks retain it. First
appearance uses cyclones with storms, otherwise the first card. Disabling the
open layer falls back to the first remaining card. A WeakMap per document keeps
explicit choices through body remounts without adding share state. Card opening,
storm selection and layer enabling remain independent.

Optional card/badge/slider class names provide feature styling. Card titles use
`.data-name` typography; meta/time/badges use `.data-toggle-meta` typography;
setting/result labels use `.panel-title`; chips retain `.data-toggle-chip`.
Reserve one status line, even without a legend. Use app tokens. Wind's footer
reads the map center into a result after the action. The captured location stays
fixed until another read; model changes resample that location, units reformat
it, and × clears both reading and map marker.

The timeline shows endpoint times and receives ticks, index, mode, playing,
readout and disabled state. Its preview callback receives the tick and index and
may return readout text; commits receive the same values after a 150 ms coalesced
drag or final change. Feature adapters own data mapping and service subscriptions;
generic modules own DOM/listeners/timers and release them in `destroy()`.

Keep persistence with panel chrome: collapse uses
`godsEyeView.v6.panelCollapsed.<panelId>`, position uses
`godsEyeView.v8.panelPos.<panelId>`, and share state uses the registered panel id.
Do not rename existing
ids or reset persistence versions when adding a body. The WEATHER adapter is
`src/ui/weatherPanel.js`; its observed-history selection remains transient.

## Visual input

`gods-eye-view/ui/input` exports `bindApplicationShortcuts` and
`createStyleParameters`. The shortcut binder owns one bubbling keydown listener
and receives the document, editing target and explicit action callbacks.
Parameter controls own only the supplied container's generated rows/listeners;
uniform metadata and read/write/change operations come from the caller.
Clearing permits reuse; destruction is final. Neither module imports the app,
renderer, persistence or services. The facade retains panel visibility, share
restore claims and render scheduling. Both controls are destroyed before the
facade's asynchronous teardown can yield.

## Display controls

`ui/display` owns Display button, selector and slider subscriptions. It receives
DOM elements and explicit actions, imports no application or effect singleton,
and releases every listener on destruction. Settings and rendering remain with
the caller.

## Visual effects

`ui/effects` exports the effects controller and existing preset definitions.
It owns shader stages and their clock, with explicit render ownership callbacks.
Construction installs no stages or frame callbacks. Stop animation before
releasing UI consumers, then destroy to remove owned stages and restore the
borrowed bloom state. `ui/effects/bloom` exposes the pure intensity/version helpers
without loading the renderer. UI presentation and product-action coordination
remain in their callers.

## Map Source controls

`ui/maps` owns source-chip presentation, selection feedback and its subscription
lifetime. It receives the existing controller and explicit state/action callbacks;
it imports no renderer or application. Source construction and availability policy
remain with the map controller. Rebuilding controls removes their previous chip
listeners, and destruction suppresses late completions without owning or destroying
the supplied controller.

## Layer panel

`ui/layers` exports the Layers panel and clear-control binding. Callers supply
snapshots, row descriptors, subscriptions and actions; the component imports no
layer implementation or application bootstrap. Layer transactions remain with
the caller. Hidden-page refresh scheduling remains an explicit callback.

`ui/layers/feedback` exposes the existing pure loading/notice reducers separately
from DOM controls. Scheduling and presentation stay with their callers.

## Location controls

`ui/location` exports Location controls, the cancellable lookup controller and
the existing location-status formatter. Callers supply city data, search and
navigation operations. The component owns DOM listeners and pending expansion;
it imports no geocoder, camera engine, layer or application bootstrap. Existing
camera authority and search providers remain supplied by the application.

### Radio controls

`ui/radio` owns Radio input, disclosures, tuner state and presentation. It
receives the existing Radio port and explicit layer/layout actions, without
importing the renderer or station providers. Pure tuner calculations retain
compatibility exports from the data layer. Disposal revokes DOM listeners and
subscriptions before ending the active tuning interaction.

### Camera panel controls

`ui/cctv` composes camera controls, frame loading, calibration editing and status
presentation. It receives DOM elements, the existing camera port and explicit
application actions; it imports no provider, layer or camera engine. Selection,
placement, navigation and storage policy remain outside the component family.

### Context coordination

`ui/context` owns mode controls, transactions, session restoration and manager
subscriptions. Composition supplies the manager, installations search and
explicit visual/panel actions. `ui/context/policy` exposes the existing pure
mode and restoration rules. No source transport or renderer is imported by
these components; initial state and action results retain their existing shape.

## Cockpit controls

`ui/cockpit` supplies the Cockpit controller and Display portal. Camera updates,
instruments, Context readouts, briefings, signals, layout and input have separate
modules. Composition supplies the existing aircraft/awareness operations, terrain
cache and sampling operations, continuous-render owner and regional briefing
service. Pure math, utility layout and vision helpers have explicit exports.
Disposal releases subscriptions and pending work; portal moves preserve the
original Display groups, independent scroll positions and current focus owner.

## Scene controls

`ui/scenes` owns Scene prompts, panel input, project/shot rows, playback button and runtime
presentation. It receives project reads and explicit actions, with no imports of
the director, source modules, camera engine or storage. Replacement and disposal
release listeners; pending action feedback is limited to its current owner.

## UI assembly and styles

`ui/shell` assembles controls from supplied existing layer, navigation, terrain,
rendering, HUD and share operations. `src/standalone/ui.js` provides the running
application's instances; `src/ui.js` remains the compatibility entry. The shell
imports no standalone bootstrap or concrete live layer implementation.
Panel layout, position/drag, notices, recording and deferred UI work have separate
owners with synchronous cleanup. Existing scene, share and HUD engines retain
their entry points. `ui/styles` loads the ordered stylesheet entry; component
files retain the original cascade, including responsive and dock refinements.

## UI state and Scene actions

`StyleManager.subscribeShareState(listener)` supplies the current shareable
visual preferences and subsequent settings changes. The built-in share manager
consumes the same updates. `subscribeLocationSearch(listener)` follows the
current lookup owner across control replacement. `LocationSearch.subscribe`
provides the corresponding per-owner contract. Changes identify `started`,
`found`, `missing`, `failed`, `settled`, and the shell's `reset`; request IDs
belong to their lookup owner. Only current requests publish accepted results.

`gods-eye-view/scenes` exports `SceneDirector`. Its `subscribe(listener)` supplies
small playback snapshots plus editing outcomes. Scene controls consume these
updates to render the affected presentation; progress does not copy the project
or rebuild shot rows. Project import/export outcomes include the project;
shot editing outcomes include the affected shot and its index before deletion.
Camera, layer sequencing, storage and run-file download retain their existing
owners. Cesium remains an external dependency supplied by the application.

Each listener receives `{ state, change, revision, initial }` and subscriptions
return an unsubscribe function. Initial state is emitted by default; pass
`{ emitCurrent: false }` to receive only changes. Snapshots and outcomes are
immutable plain data. Reentrant publications retain delivery order; removing a
listener or destroying its owner prevents further queued delivery. These APIs
perform no network requests and discover no additional modules.

## Maps

`maps/controller` coordinates scene changes and lifetimes. `maps/imagery`,
`maps/terrain` and `maps/3d` supply constructors; `maps/defaults` selects the
standard sources and their setup/fallback policy. The standalone facade wires
these to the application's render governor.

A registry supplies `sources`, `defaultId`, `unknownId` and optional `recoveryId`.
Each source has a user-facing `descriptor`, availability/reason, and either an
`imagery({ signal })` factory or a supplied `tileset`/`createTileset({ signal })`.
Imagery sources can share a terrain definition with a stable `id` and
`create({ signal })` returning `{ provider }` or `{ terrain }`. Cache IDs must
identify the same source for the lifetime of that registry. Sources may supply
trusted credit markup and construction/tile-error fallback policy. Provider
configuration stays in factories; descriptor values are the presentation API.

Factories should honor cancellation where their SDK supports it. The controller
also checks scene ownership after asynchronous work, so late results cannot
replace a newer selection. Supplied tilesets are caller-owned; factory-created
tilesets and provider caches are controller-owned. Construct a fresh controller
for a new viewer or configuration lifetime.

The application-components group assembles the existing page-scoped catalog and
its engines. Its explicit module graph includes the smaller layer/UI groups;
those independent groups retain their narrower gates. Source adapters and
request services enter through construction, without replacing global fetch.
The Node build group also owns the allowlisted static HTML template assembler.

## Application catalog

`gods-eye-view/application/catalog` captures caller-supplied layer instances and
matching registration metadata. `application/data` registers that catalog, attaches
coordinators after registration and seals it before controls start restoration.
`application/controls` binds its layer services from the same catalog. The existing
control surface and v2 sharing codec retain their established layer IDs; changing
that schema requires a corresponding codec change.

`standalone/catalog` selects the existing page-scoped default instances and metadata.
Reusable data setup imports no standalone layer defaults. The current compatibility
source setters remain available while callers migrate to instance construction.

### Layer construction

`application/layers` constructs the current catalog from explicit source objects
and an application AbortSignal. Small `src/app/layers` modules wire existing scene
services into each family factory. Standalone provider selection lives in
`src/standalone/layerSources.js`. The construction export has its own checked
dependency graph, excluding standalone setup and compatibility layer instances.

Both aircraft layers share the catalog's classification registry; launches use
its satellites and Contacts uses its aircraft, vessels and installations. Data
registration, controls and voice actions read those same instances. Destruction
remains the manager's responsibility; classification also observes application
abort when startup has not reached registration. Scene engines remain page-owned,
so this change does not introduce multiple simultaneous viewers.

Direct `src/data` compatibility entries retain their old defaults and testing
exports. Browser regression probes use the registered instance's testing surface
to avoid accidentally inspecting an unused compatibility instance. Existing source
setters apply only to compatibility instances; the normal application supplies
its sources at construction.

### Application operations

`application/operations` accepts request-service instances and an application
lifetime. It constructs terrain resolution, coarse floor/mesh caches and an
annotation resolver without selecting upstream providers. Its checked graph is
separate from standalone setup. Scene construction returns these operations; the
catalog and controls use the same surface owner. Layers still own their individual
ground-snap caches and model resources.

Terrain cancellation rejects late replies before caching, clears floor queues and
removes the map-stack listener. Annotation lookup caches are instance-owned and
cleared on cancellation. Geometry selection and floor policies are unchanged.
HUD and weather controllers accept their respective service; regional lookup and
location framing use the supplied operations. Voice shares the same boundary and
floor services, with analyst memory scoped to the runner. Direct compatibility
entrypoints retain default services; normal assembly does not configure their
source slots.

## Layer lifecycle and presentation

`data/lifecycle` owns registrations, visibility intent, refresh transactions,
parameters and teardown. Its package group contains one module and no external
imports. Adding a panel, renderer or application dependency fails the boundary
build, including unused imports.

`app/layerPresentation` mounts the toggle panel and turns lifecycle activity into
render requests and detection invalidation. It owns hidden-panel refresh and
listener cleanup. Application data assembly constructs both owners explicitly;
`data/manager` is the compatibility facade for direct callers. The ordinary
state subscriptions retain their existing event contract.

## UI state owners

- `ui/navigation` owns navigation generations, pending search presentation and
  tracking handoff. It reads Cockpit admission and uses supplied tracking operations.
- `ui/share-restoration` owns the initial restore transaction, layer coordinator,
  status notices and gesture/timer cleanup.
- `ui/visual-settings` owns style preferences, detection overrides, display inputs
  and IR cleanup. Its engine services and panel operations are explicit.
- `ui/panel-chrome` owns disclosure, docking, collapse preferences and temporary
  Cockpit panel snapshots, composing the existing positioning/layout controllers.

These package groups contain their own dependencies and exclude application
assembly. `applicationShell` retains composition and compatibility methods;
those methods delegate to the state owner. Source-based regression checks inspect
that implementation owner, and browser acceptance exercises the assembled UI.

## Civil-flight records and acquisition

`layers/flights/records` owns metadata, sticky observations, geoid values and
missing-poll admission. `layers/flights/ingestion` owns the source and request
lifetime, backoff and freshness state. Both are portable package groups with no
Cesium, viewer, billboard, model or application imports.

The layer composes these with `snapshotRenderer`, which applies record changes
to Cesium history and primitives and coordinates existing follow operations.
Occlusion points live with rendering state. Eviction still releases tracking
before deleting records; incomplete snapshots retain recent contacts for the
existing bounded interval. The renderer retains its existing per-frame scratch
objects; reconciliation occurs on source refresh, not on each frame.

`layers/military/records` and `layers/military/ingestion` have the same portable
ownership boundary. Military observations retain their aviation-foot readout,
source-time fallback and model-owned ground policy. The renderer supplies that
ownership fact and handles stale-ground lifting, Cesium history and primitives;
record reconciliation does not import the engine or application.

`layers/vessels/records` owns plain AIS metadata, stable MMSI identity and bounded
retention. `layers/vessels/ingestion` owns source requests and feed state through
explicit operations. Both exports exclude Cesium, DOM and application assembly.
The snapshot renderer applies record changes; rendering owns a weak map of
geometry and billboard resources used by cards, picking and trails.

`gods-eye-view/sources/reference` constructs fresh earthquake and bundled cable
source instances independently of standalone setup. Individual sources remain
available through `layers/earthquakes/source` and `layers/submarine-cables/source`.
The latter retains the bundled dataset’s attribution and licensing requirements.

## Geocoding and feature-query providers

`createDefaultPlaceSearch` accepts an explicit Nominatim selection:

```js
const places = createDefaultPlaceSearch({
  geocoding: {
    provider: 'nominatim',
    searchEndpoint: '/places/search',
    reverseEndpoint: '/places/reverse',
  },
  fetchImpl,
  signal,
});
```

The endpoints must return Nominatim JSONv2. They are supplied by application
composition; no instance is selected automatically and this does not install
those routes. For a remote instance, configure its full URLs and transport
requirements. The caller owns request scheduling, identifying headers and any
instance-specific usage policy. The existing public fallback retains its shared
queue, pacing and cache. `endpoints.nominatim` still names the legacy
Google-shaped `/api/geocode` fallback; it is not a raw Nominatim endpoint.

Coordinates and supplied presets remain offline. Explicit Nominatim selection
replaces the network forward-geocoder chain; it does not silently fall back to
another instance. Reverse geocoding is available only when a reverse endpoint
is configured. Other operations (Places text/nearby search and routing) retain
their independent providers. For custom compositions, `createNominatimProvider`
from `./search/nominatim` can be passed to `createPlaceSearch` and
`createGeospatialServices`; it exposes no route or nearby-search capability.
An empty search array is a definitive miss. HTTP failures, malformed results
and oversized responses remain retryable. Attribution identifies OpenStreetMap /
Nominatim.

Overpass currently supplies traffic road geometry, ALPR camera records, military
installation footprints, and annotation geometry (administrative boundaries,
neighborhoods, streets, building/grounds outlines and monument candidates).
Nominatim forward/reverse lookup does not replace those queries. Layer source
interfaces select traffic, camera and installation ingestion separately;
annotation and camera-framing consumers use the feature operations documented
below. The Overpass adapter translates those operations and normalizes records;
an alternate backend implements that source interface. Rendering and geometry
selection remain consumers of those results.

`./sources/nominatim` exports the lower-level JSONv2 client and normalizers for
server adapters without importing search composition.

`./sources/http-body` exports bounded text/JSON readers using web primitives;
`./sources/overpass` exports the quoted-string/comment lexer. The lexer alone is
not a query validator: spatial bounds, timeouts and other policy remain in the
server sanitizer. Existing server imports keep their compatibility exports.

Runtime formatting discovers tracked and new non-ignored `.js`, `.mjs` and `.cjs`
files under the configured owned roots. Tests retain explicit adoption. Git and
Prettier exclusions keep local/generated data out; resolved paths are validated
before any writes. New runtime modules do not need another scope-list entry.

## Map-feature sources

Application request services expose `features`. Callers may supply another source
with the same operations; the default is `createOverpassFeatureSource` from
`sources/map-features`. Legacy boundary-query configuration remains supported.
Search and annotation code request candidates and rank them without constructing
query-language strings or decoding backend tags and relation members.

| Operation                                                             | Result used by the caller                               |
| --------------------------------------------------------------------- | ------------------------------------------------------- |
| `getAdministrativeAreas(point, options)`                              | Named administrative candidates and geometry references |
| `getAreaGeometry(id, options)`                                        | Geometry for one selected administrative reference      |
| `getNeighborhoodAreas(point, options)`                                | Neighborhood polygon candidates                         |
| `getStreetAreas(point, options)` / `getStreetLines(point, options)`   | Named areas and road lines for street annotations       |
| `getFootprints(point, options)` / `getEnclosingAreas(point, options)` | Building and surrounding-ground candidates              |
| `getMonuments(point, options)`                                        | Named point candidates                                  |
| `getFocusFootprints(point, options)`                                  | Building/landmark candidates for camera framing         |

Points use `{lat, lon}`. Options carry `signal`. A successful array, including an
empty array, is definitive; `null` means a transient failure;
`{rateLimited: true, retryAfterMs}` retains a provider's retry delay. Candidates
carry `id`, `names` (`primary`, `english`, `official`, `alternate`, `short`),
`coordinates` (objects with `lat` and `lon`), `building` and optional `heightM`,
`center` and `point`. Administrative candidates use `category: 'administrative'`
and a numeric `level`. Provenance may retain compatibility metadata, but ranking
does not use backend tags. The Overpass implementation retains its existing
operation-specific query radii and deadlines.

Traffic's source response decodes to `{roads}`. Each road supplies longitude/latitude
`coordinates`, a road-class `type` and `oneway` (`-1`, `0` or `1`). Scene construction
still owns thinning, terrain sampling and Cartesian waypoints. Installation
sources supply `{records, droppedCount, status, saturated}`; viewport filtering,
exact-bound retry and rendering stay in the layer. Legacy cache saturation is
decoded in the source. Source and geometry modules remain independent of Cesium,
DOM and platform middleware.
