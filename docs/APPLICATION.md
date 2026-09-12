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
