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
them into a browser component is not supported. No provider service is exported yet.

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
`server/providers/local.js` still owns provider process state, routes and
credential-store paths. Provider Settings writes to the same root `.env` or
Pinokio store as before. `vite.config.js` preserves the default configuration and
existing named provider exports for tools/tests. The provider module remains
large; later extractions should split complete provider families and their tests.

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
