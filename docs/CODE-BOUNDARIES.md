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
Callers retain their request admission and transport policy. FIRMS CSV parsing
remains an owned dependency of the FIRMS Node provider. The boundary gate
checks each entry independently.

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
