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
and `providers`; the defaults preserve Google/Photon search, Google place context
and the local OSRM route proxy. Location, annotations, HUD labels and voice use
the composed service. Provider-specific credentials belong in the selected
transport; server secrets never belong in browser configuration.

For a compatible protocol, configure `geocode`, `photon`, `reverse`, `textSearch`,
`nearby` or `route` endpoints. These are developer-selected configuration, not
URLs accepted from page queries or model arguments. A different protocol supplies
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
Its backend supplies `requestToken({ tier, signal })` and
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
