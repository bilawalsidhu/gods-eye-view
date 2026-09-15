# Formatting and component boundaries

Run `npm run format` to format the files in `scripts/format-scope.json` and
`npm run format:check` to check that same list without writing. CI checks the
entire adopted list on Linux and Windows. Prettier is pinned in the development
dependencies; use the installed version so local and CI output agree. The shared
configuration specifies two spaces, single quotes, semicolons and LF endings.

Add new reusable modules and their tests to the list as they are extracted.
Keep mechanical formatting in its own commit after behavior is stable. Existing
source-text regression assertions still apply; investigate failures and preserve
their behavioral coverage when a move or line wrap changes a tested shape.
Files outside the list retain their surrounding style until deliberately adopted.
Generated output, local configuration, browser evidence and bundled datasets are
excluded. The formatter validates every entry before writing any file.

## Current component ownership

| Surface                                | Owns                                                                   | Receives from its caller                            |
| -------------------------------------- | ---------------------------------------------------------------------- | --------------------------------------------------- |
| `gods-eye-view/infrastructure`         | Datacenter/dam definitions and fresh layer construction                | Context, overlay and render operations              |
| `gods-eye-view/infrastructure/geojson` | Data loading, Cesium entities, selection handling and resource cleanup | A viewer and those same operations                  |
| `gods-eye-view/infrastructure/lod`     | Pure visibility budgets and selection policy                           | Position/visibility records and camera measurements |
| `src/data/localGeojson.js`             | Standalone compatibility wiring                                        | The application's existing shared services          |
| `src/main.js` and `src/standalone/`    | Standalone browser startup                                             | Local configuration                                 |

The application and infrastructure exports are browser source modules. Use their documented
exports instead of importing standalone startup or reaching into internal files.
The application owns the viewer, context store, overlay host and render scheduler;
layers use the supplied callbacks. See [the infrastructure contract](INFRASTRUCTURE-LAYERS.md).

`npm run check:boundaries` builds every declared package export, with app Vite
configuration disabled. `scripts/package-boundaries.json` lists each export's
component, owned modules and external runtime dependencies. A new export must be
classified. Imports outside the declared modules fail, including unused and
literal dynamic imports. Cesium stays external so the consuming application
supplies the same compatible instance as its viewer. Existing consumer tests
also check import-time inactivity and asset URLs under a non-root base.

These checks cover the declared exports, not every import in the application.
They check build-time imports, not arbitrary runtime-generated module URLs.
Keep runtime module discovery out of these exports. When extracting another
component, add its ownership and consumer tests together. Node services must use
separate entry points and their own checks when they become reusable; importing
them into a browser component is not supported.

`gods-eye-view/application` owns construction order, startup state, cancellation
and disposal of caller-supplied components. Its only owned module is
`src/app/application.js`. `gods-eye-view/application/viewer` separately owns the
standard Cesium viewer configuration in `src/app/viewer.js`; Cesium stays external.
Neither export imports standalone UI, layers, tools or configuration. See
[application construction](APPLICATION.md) for the contracts and current limits.

UI panels and individual source adapters remain future extractions. They should
become smaller modules with explicit lifecycle owners as their callers migrate.

## Build and standalone server configuration

`gods-eye-view/build/vite` is a separate Node-only export. `build/vite.js`
creates standard Cesium/Vite browser settings from explicit inputs. It imports
only the declared `vite-plugin-cesium` build dependency, discovers no environment,
and constructs no provider middleware. Call it from a Vite configuration:

```js
import { createBrowserViteConfig } from 'gods-eye-view/build/vite';

export default createBrowserViteConfig({
  plugins: [],
  googleApiKey: undefined,
  cesiumToken: undefined,
});
```

Consumers supply compatible Vite and vite-plugin-cesium development dependencies.
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
