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
consumer. The viewer helper preserves the standalone viewer's render settings;
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
the controls. An incompatible protocol needs a separate controller adapter;
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
observed-history clock those layers share for the catalog's lifetime.
A `weather` source may also supply decoded frames: an optional
`getFrameImage({ product, time, size, bbox, signal })` returns a whole-extent or
detail image and an optional `getFrameTile({ product, time, z, x, y, size,
signal })` returns one tile or null for a transparent tile, each as an
`ImageBitmap`, `ImageData`, canvas or `VideoFrame` of exactly the requested
size, which the layer draws once and closes. Without them the layers read the
image and tile routes (`WeatherFrameFeed` in `src/layers/weather/source.js`).

`application/services` accepts boundary, terrain, regional-context, weather and
summary services; its weather service supplies cockpit local conditions, not the
Weather layers. `application/requests` supplies the existing HTTP protocols
with configurable endpoints and a scoped transport. Changing an endpoint works
only for a compatible protocol; another protocol supplies a service adapter.
Cancellation discards late response bodies, and replacing a source invalidates
its pending results. Source disposal does not silently reinstate a default.

`ui/composition` supplies the default engines to the shell. Applications can
supply a HUD implementation or request policy through control services. The
shared chrome owns the welcome/loading transition; standalone composition adds
Provider Settings. A page places each Vue view in `src/ui/views` with a host,
`<div class="gev-view" data-gev-view="NAME"></div>`, and writes its own loading
screen (`#loading-screen` with a `.loader-status` line) as static markup so it
paints before any script runs. `createApplication()` renders the views before
anything reads the page; `omitViews` names views the application leaves out,
such as `provider-settings`, and their hosts are removed. Leaving out
`layer-panels` also leaves out the scene sharing dialogs it draws, and leaving
out `scene-chrome` the before/after imagery dividers (the imagery still splits,
with no line or handle to move it), the status chips, the toast, the ORBIT
indicator, the FPS readout, the Scene actions panel, the data-pack attribution
cards, the wind inspection marker, the Space Missions replay vehicle, the
full-globe celestial ring, the screen-space map annotations, the visible
map target list and the Global Context compass;
leaving out `command-dock` the voice control and its pointer reticle;
leaving out `context` the Bhote Koshi reconstruction panel; and leaving out
`intel-hud` the Intel HUD overlay (`#intel-hud`), whose readouts the HUD
implementation publishes to the `gev-hud` store. An unknown
view name is an error. An application that offers its own language choice
starts and switches the language with the `./i18n` entry (`startPageLocale`,
`followPageLocale`, `switchLocale`; see [I18N.md](./I18N.md)) and passes
`localePicker: false` to `createApplicationControls` instead of editing the
markup. Node tests that import application modules register the component
loader with `node --import=<core package>/build/register-vue`.

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
last good words.

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
