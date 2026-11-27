# Application construction

`gods-eye-view/application` exports `createApplication`. Importing it does not
create a viewer, discover configuration, start requests, or attach browser
listeners. Construction is also inactive until the caller invokes `start()`.

The caller supplies four constructors, in this order:

| Constructor      | Receives                                       | Standalone implementation                     |
| ---------------- | ---------------------------------------------- | --------------------------------------------- |
| `createScene`    | `signal`, `defer`                              | Viewer, attribution and initial map           |
| `createControls` | `scene`, `signal`, `defer`                     | Style manager and camera presentation         |
| `createData`     | `scene`, `controls`, `signal`, `defer`         | Layer catalog, registration and restoration   |
| `createTools`    | `scene`, `controls`, `data`, `signal`, `defer` | Scenes, annotations, voice and page listeners |

Each constructor returns its component object, or a promise for that object.
Those objects are passed unchanged to later constructors. Configuration and
service instances belong in the caller's closures; the application does not
interpret provider names, environment variables, endpoints, or module paths.
There is no module discovery or automatic import mechanism.

```js
import { createApplication } from 'gods-eye-view/application';
import { createApplicationViewer } from 'gods-eye-view/application/viewer';

const app = createApplication({
  createScene({ defer }) {
    const viewer = createApplicationViewer({ container, creditContainer });
    defer(() => viewer.destroy());
    return { viewer };
  },
  createControls,
  createData,
  createTools,
});
const unsubscribe = app.subscribe(({ status, phase }) => {
  // Update the caller's startup presentation.
});
await app.start();
// When the application is no longer needed:
unsubscribe();
await app.destroy();
```

The example's containers and three remaining constructors are supplied by the
caller. The standalone scene also returns `trimStaleCommands()`, which drops
the draw commands the Cesium scene keeps after a turned-off layer stops drawing;
the application tools call it one frame after each layer disable. A scene
without it keeps those commands, and so the layer's memory, until they are
overwritten. The viewer helper preserves the standalone viewer's render settings;
it neither selects map sources nor reads keys. Supply a visible credit container
and retain all attribution required by the chosen sources. Cesium is external to
this export: the consuming build must provide the same instance used elsewhere
in its application.

## Lifecycle and ownership

Register `defer(cleanup)` immediately after acquiring each resource, before any
`await`. Cleanup registration remains open until that constructor settles. Each
callback may return a promise. Within a phase, callbacks run in reverse order.
Across phases, teardown runs **tools, controls, data, scene**: controls must cancel
restoration while their data manager and viewer are still alive.

`start()` returns the same promise on repeated calls. `destroy()` is terminal and
also returns the same promise on repeated calls. It aborts the shared signal
immediately, waits for an in-flight constructor to settle, and runs all registered
cleanup callbacks. Constructors must forward the signal to cancellable operations
and check it after awaits. If a provider cannot cancel construction, register
cleanup for its late result before returning. Destruction waits for that result;
it does not pretend a pending resource has already been released.

A constructor failure triggers the same cleanup before rejecting startup.
Cleanup failures do not stop the remaining callbacks; they are reported through
an `AggregateError`. Constructors own cleanup for resources created internally,
including anything allocated before their own construction throws.

`getState()` returns a frozen `{ status, phase }` snapshot. Status is `created`,
`starting`, `ready`, `destroying`, `destroyed`, or `failed`. `phase` identifies the
constructor during startup. `subscribe(listener)` immediately reports the current
snapshot and returns an unsubscribe function. Install observers before `start()`
to receive every startup phase. Observer failures cannot interrupt startup or
teardown. `getComponents()` returns a frozen, shallow snapshot of the currently
constructed component objects; the component instances themselves remain mutable.

`ready` means all constructors have returned. Background feed activity and the
standalone share-restoration result keep their existing separate contracts.

## Pointer input

`gods-eye-view/input` exports `inputFor(viewer)`, the scene's one input
dispatcher. Every layer and tool takes its pointer input from it, and so can
the caller: one pointer handler per viewer, and a click picked once and
handed to every subscriber.

```js
import { inputFor } from 'gods-eye-view/input';

const input = inputFor(viewer);
const off = input.onClick((event) => {
  if (event.ownerId === 'flights') showFlight(event.id);
});
// Later:
off();
```

`onClick` runs while no tool holds the pointer (the draw tool, the imagery
box), so a vertex placed on an aircraft is not also a click on it. Its event
reads lazily; a subscriber that reads nothing costs no pick:

| Member               | What it is                                                                |
| -------------------- | ------------------------------------------------------------------------- |
| `screenPosition`     | Where the user clicked, in CSS pixels; for DOM and overlay hit-tests      |
| `position`           | Where that lands in the pick buffer (corrected under sensor styles)       |
| `gesture`            | `{ travelPx, durationMs }` of the press, to tell a click from a drag      |
| `topHit`             | The renderer's `Hit` on top at `position`, or `null` for the map itself   |
| `drawHit`            | `topHit` when it is an item of a draw set, else `null`                    |
| `hit`                | `topHit`, or on a coarse pointer the contact under a surface pick         |
| `id`, `ownerId`      | The hit's pick id and the layer that registered it, or `null`             |
| `meta`               | The hit's own metadata, when it carries any                               |
| `surface`            | Whether the hit is the map itself                                         |
| `drill(limit)`       | The draw-set `Hit`s under the click, shared by every subscriber           |
| `windowHit(w, h)`    | `{ id, drawHit, surface }` of a pick over a `w`×`h` window                |
| `ground()`           | The world position under the click, or `null` over the sky                |
| `native`             | The renderer adapter's own `{ pick, pickWindow(w, h), drill(limit) }`     |
| `pick`, `pickWindow` | `native.pick` and `native.pickWindow`, for code bound to the engine picks |

A hit is the renderer contract's `Hit` (`src/render/contract/query.d.ts`).
Something drawn outside the renderer's draw port is a `Hit` with `set: ''`,
named by the adapter. Positions are plain `{ x, y }` objects. The dispatcher
takes its pointer events from the renderer's input port and its picks from
its query port, so a viewer with no renderer bound needs the Cesium adapter's
factories loaded (`gods-eye-view/render/cesium/unbound`), or `inputFor` throws.

`onPointer(type, fn, { lease })` subscribes to `down`, `move`, `up`, `click`
or `dblclick`; with a lease it runs only while that lease is current. A tool
takes its lease with `claimPointer(ownerId, { onLost })` from the same export
(and gives it back with `releasePointer(lease)`), which also keeps every
ambient subscriber off its clicks; `isPointerFree()` and `pointerOwner()`
report who holds it. The newest claim takes over, as on the renderer's input
port: the tool holding the pointer has its `onLost` called once and turns
itself off, and its late release frees nothing. `suspendCamera(reason)` and `suppressStockClicks()` return their
own release: camera input and the viewer's stock select and double-click-track
come back when the last hold is released, so two holders cannot undo each
other. The renderer's input port owns the camera controller's `enableInputs`: a direct
write (Cesium's camera flights make one when they start and end) is kept, but
reads true only while no hold is out. A caller-supplied `createScene` that creates its own viewer registers
`defer(() => inputFor(viewer).destroy())` right after it; the standalone scene
does this and returns the dispatcher as `scene.input`.

## Height queries

`gods-eye-view/queries/heights` exports `heightsOf(viewer)`, the one place
height queries go. Layers, tools and the camera ask it instead of asking the
renderer's query port (`sampleHeight`, `sampleHeightNow`, `clampToSurface`)
or the scene themselves, so how the renderer answers heights can change
without touching them. Pass the viewer the renderer is bound to, not its
scene. A viewer with no renderer bound is answered by the Cesium adapter's
fallback once the caller has loaded `gods-eye-view/render/cesium/unbound`;
until then, every query answers `null`.

```js
import { heightsOf } from 'gods-eye-view/queries/heights';

const heights = heightsOf(viewer);
const ground = heights.now({ lon, lat }, { exclude: [ownSetId] });
if (ground !== null) place(ground);
```

| Member                        | What it answers                                                           |
| ----------------------------- | ------------------------------------------------------------------------- |
| `now(point, opts)`            | Height in metres from what is loaded, or `null`                           |
| `clampNow(position, opts)`    | The ECEF `{ x, y, z }` moved onto the drawn surface, or `null`            |
| `batch(points, opts)`         | A promise of heights once the most detailed tiles stream; `null` per miss |
| `clampBatch(positions, opts)` | A promise of clamped `{ x, y, z }` copies; `null` per miss                |
| `supported()`                 | `{ surface, clamp }`: whether the drawn surface can be queried at all     |

A point is `{ lon, lat }` in degrees or `{ longitude, latitude }` in radians.
`against: 'surface'` (the default) reads what is drawn, 3D tiles and globe;
`against: 'terrain'` reads the loaded terrain alone; `against: 'tiles'` the
tiles without the globe. Both `surface` and `tiles` include draw sets drawn
with `includeInHeightQueries`; `clampNow` and `clampBatch` always clamp to
the surface. `exclude` lists draw set ids to see through, of those drawn with
`includeInHeightQueries`; every other draw set is seen through already. Every
miss is `null`, and every caller treats it as one; `batch` and `clampBatch`
reject when the query itself fails. Without depth-texture support the Cesium
renderer answers no `surface` or `tiles` height; `now` still answers
`terrain` from the loaded tiles, while `batch` misses terrain too.

## Cesium internals

The app reaches private Cesium fields only through
`src/render/cesium/internals.js`, one named helper per field (the main and
offscreen pick views, a billboard's collection, a cluster's point collection,
the widget's render-loop latch, the WebGL context and whether a camera flight
is under way). `internals.test.mjs` fails when the installed Cesium stops
declaring one of them, and when a private field is reached anywhere else.
Imagery that rations its tile requests states the policy as a hook with
`withTileRequestHook(provider, { requestImage, credit })` from
`src/render/cesium/tileRequests.js`, which leaves the provider untouched.

## Standalone wiring

`src/main.js` reads the existing browser configuration and starts
`src/standalone/application.js`. That module selects the four implementations
in its directory. Scene setup, controls, layer registration, tools and loading
chrome have separate owners. The existing `window.__godsEyeView` debugging shape
is preserved while the app is running.

The standalone controls and layer modules still contain page-scoped state.
Only one standalone application may be constructed per page. Shutdown releases
its runtime resources and debugging handles; reload the page to start again.
It is not an embeddable, removable HTML shell or a multiple-viewer implementation.
Consumers of the small application export supply their own component ownership;
the lifecycle controller itself has no shared instance state.

Later component extractions can replace a constructor's internals without
changing the startup contract or moving standalone imports into the package.
Run the unit suite, package boundary gate, build, tracking and first-run browser
checks when changing this wiring.

## Geospatial services

`src/search` owns forward/reverse geocoding, place search and route provider
interfaces. `createStandaloneApplication({ geospatial })` accepts `endpoints`
and `providers`. Default forward search tries decimal coordinates and bundled
place names (`presets`) first, without a network request, then Google when a key
is configured, Photon, and the local `/api/geocode` Nominatim route. The
defaults also keep Google place context and the local OSRM route proxy.
Location, annotations, HUD labels and voice use the composed service.
Provider-specific credentials belong in the selected transport; server secrets
never belong in browser configuration.

For a compatible protocol, configure `geocode`, `photon`, `nominatim`, `reverse`,
`textSearch`, `nearby` or `route` endpoints. These are developer-selected
configuration, not URLs accepted from page queries or model arguments. A different protocol supplies
an adapter function instead. The exported `createDefaultPlaceSearch` constructor
supports the same options for direct composition:

```js
const services = createDefaultPlaceSearch({
  resolveApiKey,
  signal,
  endpoints: { photon: 'https://search.example/api/', route: '/api/routes' },
  providers: {
    route: routeProvider,
    routeProfiles: ['foot', 'car'],
  },
});
```

Forward `providers.geocode` is the existing ordered geocoder array. Other
operations are independent functions: `reverseGeocode(latitude, longitude,
{ signal })`, `textSearch(query, point, { signal })`, `nearby(point, { signal })`
and `route(coordinates, profile, { signal })`. Points use `latitude`, `longitude`
and `radiusM`; route coordinates use `[longitude, latitude]` in WGS84. Routes
return `{ geometry, distanceM, durationS }` with metres and seconds. Unavailable
routes return null, retaining the explicitly labelled direct-line fallback.
Place search returns normalized place arrays; reverse lookup returns address,
locality, region, country and label fields used by scene context. Unsupported
operations are reported in `capabilities`; adapters can provide attribution and
supported route profiles. A provider's lifetime and caller cancellation both
invalidate late response bodies.

Node middleware is configured separately. `googlePlacesContextProxy` accepts
`endpoints: { nearby, textSearch }`, `resolveApiKey` and `fetchImpl`.
`overpassProxy({ routing: { endpoints: { foot, car, bike }, fetchImpl } })`
selects compatible OSRM base URLs while preserving coordinate/span limits.
`regionalBriefProxy({ placeProvider })` accepts the regional lookup function;
`createRegionalPlaceProvider({ endpoint, requestJson })` supplies the existing
serialized Nominatim implementation. Configuration is per instance, including
routing and regional caches. Request parameters cannot override these endpoints.

### Voice connections and controls

Voice controls accept an action runner and a controller factory through
`createVoiceCommands` (`./voice/commands`). The default Realtime controller owns
microphone tracks, playback, push-to-talk, tool cancellation and radio handoff.
Its backend supplies `requestToken({ tier, authMode, signal })` and
`negotiate({ offerSdp, credential, signal })`. The Realtime-compatible adapter
(`./voice/realtime-backend`) accepts separate token and connection transports
and endpoints. Only the short-lived client secret reaches the SDP endpoint.
Stopping or ending the application lifetime aborts connection requests and
rejects delayed responses; a new start requests a fresh secret. Secret expiry
limits connection creation and does not describe the connected session lifetime.

`createStandaloneApplication({ voice })` passes these construction options to
the controls. An app can supply `voice.openStories({ isCurrent })` for what the
`open_stories` action does, spoken or typed; it answers true when it opened,
`'already-open'`, or false. Without it the action opens the Stories page.
An incompatible protocol needs a separate controller adapter;
changing an endpoint alone does not translate protocol messages. No alternate
model is bundled by this extraction. The Node Realtime provider accepts
`realtime: { endpoint, models: { standard, mini }, resolveApiKey, fetchImpl }`;
existing environment variables remain the default configuration. Model choices
come from server configuration. Keep secret keys in the server adapter.
Tool schemas, model defaults and cost estimates are unchanged. Unknown model
IDs retain the existing conservative estimate until their rates are registered.

### Composing the existing application components

`application/scene`, `application/controls`, `application/data` and
`application/tools` expose the existing globe, controls, catalog and tools as
separate constructors. Pass these to `createApplication`; use its `signal` and
`defer` for ownership. The compatibility catalog is still page-scoped: construct
one application per page. Controls, actions and renderers use the same layer
instances. Configure sources with `application/sources` before registration or
state restoration, and release them after the consumers stop. The catalog
constructor (`application/layers`) also requires `wind`, `weather` and
`cyclones` sources with `getSnapshot` for the Weather layers, and owns the
observed-history clock those layers share for the catalog's lifetime. That
clock, the catalog's `weatherClock`, follows the world clock (`gods-eye-view/time`)
and has no time controls of its own: move time with the world clock's `seek`,
`play`, `pause` and `goLive` (`weatherClock.world` is the one it follows).

A layer gives the world clock's timeline the time it can show with
`worldClock.register({ id, coverage })` (`gods-eye-view/time`), which returns
the unregister; call `worldClock.coverageChanged()` when that time changes.
`coverage()` returns null while the layer has none, or
`{ start, end, marks? }` in epoch ms. `marks` are the moments worth going to,
drawn as ticks the timeline's arrow keys step to and a tap on or within 6 px of
snaps to. Each mark is a number, or `{ time, label?, id?, kind? }`: `label` is
short text (cut to 60 characters, ending in `…`) shown when the pointer is on
the tick and told with the time while the handle is on the mark, `id` the layer's own key for the event and `kind`
what sort of event it is (`'launch'`, `'earthquake'`). The two forms may be
mixed; a mark without a finite time, and a `label`, `id` or `kind` that is not
a non-empty string, are ignored. `worldClock.coverage()` returns the union of
the registered layers, `{ start, end, marks, markDetails }`, or null: `marks`
is every mark's time once, in order, as numbers, and `markDetails` the marks in
time order, each a frozen `{ time, label?, id?, kind? }` holding only the
fields given, with marks given alike by several layers once and a bare time
left out where a mark with more to say shares it.
A `weather` source may also supply decoded frames: an optional
`getFrameImage({ product, time, size, bbox, signal })` returns a whole-extent or
detail image and an optional `getFrameTile({ product, time, z, x, y, size,
signal })` returns one tile or null for a transparent tile, each as an
`ImageBitmap`, `ImageData`, canvas or `VideoFrame` of exactly the requested
size, which the layer draws once and closes. Without them the layers read the
image and tile routes (`WeatherFrameFeed` in `src/layers/weather/source.js`).
It may also name its source with an optional `sourceName(kind)`, `kind` being
`'radar'`, `'lightning'` or `'satellite'`: the layer's row shows that name until
a manifest names its own, and NOAA nowCOAST when the source names none. The
name is read once, when the layer is built, and held to the same rule as a
manifest's `display.source`. The map credit still comes from each manifest's
`display.credit`, so a source that is not nowCOAST sets that too.

`createApplicationScene({ requestServices })` supplies local conditions to the
Cockpit and to the Context Inspector when no card is selected. Its
`weather.getConditions(latitude, longitude, { signal })` resolves to an object
with a normalized `weather` observation and optional `retrievedAt` and `status`
fields. Return `null` for a missing reading and honor the request's abort signal.
The Inspector requests `exactPoint: true` for the local clock. When an
adapter reuses another point's weather, return that point in
`coordinates: { latitude, longitude }` so the Inspector can keep UTC.
An observation without coordinates is assumed to describe the requested point.
The Inspector credits Open-Meteo when the observation carries
`weather.source: 'open-meteo'`, as the bundled provider does.
A selected card gets its weather from `requestServices.regional.getBrief`.
The Weather layers use the separate frame and snapshot sources above.
`createApplicationControls` accepts an Inspector override in
`services.fetchSpotWeather` with the same contract.

`application/services` accepts boundary, terrain, regional-context, weather,
summary and layer count services. The standalone Inspector uses the page-scoped
weather service. The `ui/composition` StyleManager uses `services.fetchSpotWeather`
or `requestServices.weather.getConditions` when supplied. If a host supplies only
`services.fetchRegionalBrief`, that adapter also serves Inspector weather.
Otherwise the composed shell uses the page-scoped point-weather service.
The bare `ui/shell` takes the host's `services.fetchSpotWeather` and falls
back to a supplied `services.fetchRegionalBrief`.
`application/requests` supplies the existing HTTP protocols with
configurable endpoints and a scoped transport. Changing an endpoint works only
for a compatible protocol; another protocol supplies a service adapter.
Cancellation discards late response bodies, and replacing a source invalidates
its pending results. Source disposal does not silently reinstate a default.
Inspector worldwide counts use the page-scoped
`configureApplicationServices({ layerCounts })` adapter. To use another host
with the same count protocol, build that adapter with
`createApplicationRequestServices({ endpoints: { layerCounts: url } }).layerCounts`
and configure it before mounting the app.

`ui/composition` supplies the default engines to the shell. Applications can
supply a HUD implementation or request policy through control services. The
shared chrome owns the welcome/loading transition; standalone composition adds
Provider Settings. A page places each Vue view in `src/ui/views` with a host,
`<div class="gev-view" data-gev-view="NAME"></div>`, and writes its own loading
screen (`#loading-screen` with a `.loader-status` line) as static markup so it
paints before any script runs. `createApplication()` renders the views before
anything reads the page; `omitViews` names views the application leaves out,
such as `provider-settings`, and their hosts are removed. Leaving out
`layer-panels` also leaves out the scene sharing dialogs it draws. If the host
supplies its own Data Layers markup, Context opens it without applying the
stock Suggestions filter. Omitting `scene-chrome` removes the before/after
imagery dividers (the imagery still splits, with no line or handle to move
it), the status chips, the toast, the ORBIT indicator, the FPS readout, the
Scene actions panel, the data-pack attribution cards, the wind inspection
marker, the Space Missions replay vehicle, the full-globe celestial ring,
the screen-space map annotations, the visible map target list and the Global
Context compass. Omitting `command-dock` removes the voice control and its
pointer reticle. Omitting `context` removes the right-side Context rail and
the Space Missions and Bhote Koshi reconstruction panels. Omitting `intel-hud`
removes the Intel HUD overlay (`#intel-hud`), whose readouts the HUD
implementation publishes to the `gev-hud` store. An unknown view name is an
error. An application that offers its own language choice starts and switches
the language with the `./i18n` entry (`await startPageLocale(document)`
before `createApplication`, which renders the views; `followPageLocale`,
`switchLocale`; see [I18N.md](./I18N.md)) and passes `localePicker: false` to
`createApplicationControls` instead of editing the markup. Node tests that
import application modules register the component loader with
`node --import=<core package>/build/register-vue`.

### Cockpit subjects

Core's Cockpit rides a tracked aircraft, the tracked satellite and the
selected AIS vessel. An application adds kinds of its own with
`services.cockpitSubjects` on `createApplicationControls`: a list of
providers, checked once when the controls are built
(`src/cockpitSubjectProviders.js`). A malformed provider, or one with a member
that throws when read (a getter), is left out with a warning and the rest are
kept. A provider's subject takes entry when it was selected after every
built-in subject present (a tracked aircraft or satellite, a selected vessel),
whose own fixed order is unchanged, and needs the provider's `layerId` on; the
provider then holds its subject, hands the camera a frame and the generic HUD
a view model on every update, and releases it on exit. Provider methods are
synchronous and are called on the provider, so a class instance's methods keep
their `this`; one that throws or returns a promise is treated as having
failed. What a method returns may carry getters: one that throws when read
makes a candidate none, a frame malformed (the view ends) and a HUD view keep
the last; a worded member (labels, entry face, look) that throws keeps its
last good words. An entry face's `icon` is a Material Symbols name whose glyph
the application's page must load (GEV's own `index.html` loads a subset, its
`icon_names`); a glyph the page does not load renders as its name.

```js
import { getLocale, onLocaleChange } from 'gods-eye-view/i18n';
import { pointAtS } from 'gods-eye-view/layers/rail/paths';

const words = {
  en: { view: 'Ride view', exit: 'Exit ride view', exitText: 'EXIT RIDE' },
  de: {
    view: 'Fahrtansicht',
    exit: 'Fahrtansicht verlassen',
    exitText: 'VERLASSEN',
  },
};

/** Ride the Rail layer's selected train; `rail` is its layer instance. */
const ride = {
  kind: 'example-ride',
  layerId: 'rail',
  entryFace: { icon: 'train', label: 'RIDE' },
  // A function is read again when the page's language changes.
  labels: () => words[getLocale()] ?? words.en,
  candidate() {
    const train = rail.getSelectedTrain();
    return (
      train && {
        id: train.key,
        name: train.label,
        selectedAt: train.selectedAtMs,
      }
    );
  },
  // Only a train bound to its line can be ridden: read() needs its path.
  isEntryAllowed: () => Boolean(rail.getSelectedTrain()?.path),
  hold: (id) => rail.setCockpitSubject(id),
  read(nowMs, ctx) {
    const train = rail.getCockpitSubject();
    if (!train?.path) return null; // ends the view
    const point = pointAtS(train.path.line, train.path.s);
    return {
      id: train.key,
      latitude: point.lat,
      longitude: point.lon,
      heightM: train.position.railHeightM, // null stands it on the shared floor
      name: train.label,
      headingDeg:
        train.path.direction < 0 ? point.bearingDeg + 180 : point.bearingDeg,
      speedMps: train.motion.reportedSpeedMps ?? train.motion.derivedSpeedMps,
      // The layer already moves the train smoothly: sit on it.
      anchor: 'exact',
      eye: { upM: 3.5 },
    };
  },
  hud: (frame) => ({ title: frame.name }),
  release(id, { restore }) {
    rail.setCockpitSubject(null);
    if (restore) rail.focusTrain(id);
  },
};

createApplicationControls({ /* ... */ services: { cockpitSubjects: [ride] } });
```

The `./i18n` entry gives `getLocale()` and `onLocaleChange()`:
Core translates only its own strings, so a provider words its labels, entry
face and HUD for the page's language (labels may be functions, as above; the
HUD is read again on a change). `gods-eye-view/layers/rail/paths` is the
Rail layer's pure path module (`createRailPath`, `pointAtS`, `projectOnPath`)
for a provider placing a train along its line. The frame, HUD view and
candidate fields are documented in `src/cockpitSubjectProviders.js`; the Rail
and Transit read APIs in `src/layers/rail/cockpitSubject.js` and
`src/layers/transit/cockpitSubject.js`. A snapshot read again while nothing in
it changed is the one read before, so `read` may take one on every update; a
train's `path.line` is a frozen copy of its line, for `pointAtS` and
`projectOnPath`. The `layers/rail/paths` export and the
Rail and Transit read APIs (`getSelectedTrain`, `getSelectedVehicle`,
`getCockpitSubject` and the snapshots they return, `path.line` among them)
are experimental and may change without notice.

A candidate's `selectedAt` is a token that changes each time the user selects
the subject, even the same one again, so entry counts it as selected then; a
new `id` under the same token is the same selection (a train's selection
moving to another feed's copy of it). The Rail and Transit snapshots give one,
`selectedAtMs`: when the user last selected the train or vehicle by a click or
`focusTrain`/`focusVehicle`. It is null after a deselection and for one
selected only by a hold, since a hold is not the user's selection.

A frame with `heightM: null` stands on the shared floor, or where it last
stood while that floor is cold. If no height has been known since entry, the
view waits, showing ACQUIRING SURFACE, for at most five seconds
(`COCKPIT_GROUND_WAIT_TIMEOUT_MS`), then ends and releases the subject.

`hold(id)` returns `true` once it holds the subject, or `false` to refuse
entry; any other answer, `undefined` included, refuses entry too, with one
warning. A refused hold, and one that throws or returns a promise, is followed
by `release(id, { restore: false })`, again once a returned promise settles,
so `release` must be harmless for a subject it does not hold and when called
more than once.

Leaving the view does not track again an aircraft that was tracked before
entry, as with the bridge and orbital views: when the user leaves by the exit
control, the map goes back to the ridden subject through
`release(id, { restore: true })`.
