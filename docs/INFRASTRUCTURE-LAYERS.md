# Reusing infrastructure layers

`gods-eye-view/infrastructure` exports `createInfrastructureLayers(services)`.
It returns fresh datacenter and dam layers in that order, with the existing IDs,
appearance, label budgets and bundled public datasets, then the three USGS
water layers (rivers and streams, lakes and reservoirs, springs). The water
layers bundle no data: they fetch `/api/usgs-water/` from the host's origin,
the route this repository's server provides, and they fail to load on a host
without it. Importing the module or calling the factory does not load data,
create a viewer, or start the application. The asset URLs resolve relative to
the module; Vite rewrites them for production base paths. This browser source
export expects a Vite-compatible asset build.

Pass the application's existing functions:

```js
import { createInfrastructureLayers } from 'gods-eye-view/infrastructure';

const layers = createInfrastructureLayers({
  overlayHost: { setEntries, setVisible, clearSource },
  registerEntityContext,
  selectEntityContext,
  clearSelectedEntityContextForLayer,
  removeEntityContextsForLayer,
  governorRequestRender,
  // optional: i18n: { t, formatNumber, formatDate, isolate, onLocaleChange },
});

// Register these layers with the existing data-layer manager and viewer.
```

| Function | Arguments / responsibility |
| --- | --- |
| `overlayHost.setEntries` | `(sourceId, entries, options)`; publish the existing infrastructure overlay records and paint budget |
| `overlayHost.setVisible` | `(sourceId, visible)`; toggle a source |
| `overlayHost.clearSource` | `(sourceId)`; remove that source's overlay entries |
| `registerEntityContext` | `(entity, metadata)`; register selectable feature metadata, including the owning layer and data source |
| `selectEntityContext` | `(entity)`; select that registered feature |
| `clearSelectedEntityContextForLayer` | `(layerId, { evicted })`; clear selection only if owned by this layer; `evicted` when its feature left the data |
| `removeEntityContextsForLayer` | `(layerId, { retainIds })`; remove records owned by the layer on destruction or failed setup, or those a new feature set no longer has |
| `getSelectedEntityContext` | optional; `()` the selected record, so `replaceFeatures` keeps a selection the new set still has |
| `governorRequestRender` | `(reason)`; request a frame through the existing render scheduler |
| `i18n` (optional) | `{ t, formatNumber, formatDate, isolate, onLocaleChange }`; the application's translator, formatters and language-change subscription (`onLocaleChange(listener)` returns the function that stops it), used to word the USGS water cards in the active language and to word the cards of an enabled layer again when the language changes, from the gauges already loaded. The package bundles no translator or catalogs; without `i18n` those cards are English with en-US numbers and times, and without `onLocaleChange` they are not worded again |

Each returned layer supports `init(viewer)`, `enable(viewer)`, `disable(viewer)`,
`update(viewer)`, `destroy(viewer)`, `getStats()`, `getLodDiagnostics()`,
`getAnalystRecords()` and `refreshCards()` (word the loaded cards again with
no request; nothing while the layer is disabled).
Use the same viewer for the instance's entire lifetime. Each viewer/context/overlay
host permits one live instance per layer ID; destroy an old instance before
replacing it. Separate applications may use identical IDs with separate hosts.
Callbacks must be ready before enable and remain usable through destruction.

Disable retains the loaded dataset for reuse and clears selection and listeners.
Concurrent enables share one load. Destroy is permanent, aborts pending fetches,
discards late results, and clears the owned draw sets, context records, overlays,
input handler and listeners. The layer never creates an application context store,
overlay host, viewer, or render scheduler. The consumer must resolve one compatible
Cesium installation shared with its viewer; it must not bundle separate copies.

The layers draw, size their stems and fly the camera through the renderer's
ports. A viewer the application has bound a renderer to needs nothing more; a
Cesium viewer with no renderer bound loads
`gods-eye-view/render/cesium/unbound` once first; until then the layer reports
an error naming it, as it does for a dataset it cannot load.
A selected feature is the context record its draw item carries as `meta`; the
layer no longer sets the viewer's `selectedEntity`.
Features keep their own simplestyle `fill`, `fill-opacity`, `stroke`,
`stroke-opacity`, `stroke-width`, `marker-color` and `marker-size`, given as
hex, `rgb()` or `hsl()` colours or by the CSS colour names the default renderer
knows (it has no `rebeccapurple`, and spells `lavenderblush` `lavendar_blush`);
a `marker-symbol` is stamped on the pin as the default renderer stamped it: a
one-character string as bold upper-case text, any other value as the Maki icon
of that id from the renderer's assets, the plain pin when the icon cannot be
loaded. The assets are found as the renderer finds them from a page script: the
`CESIUM_BASE_URL` global, else the folder `Cesium.js` is loaded from; a
page bundling Cesium as modules sets `CESIUM_BASE_URL` for icon pins. Polygons with heights are drawn at them, outlined; points with
heights stand their pin on the stem's tip. Edges follow rhumb lines.

`gods-eye-view/infrastructure/geojson` exports the lower-level
`createLocalGeoJsonLayer(options, services)` and existing infrastructure overlay
helpers. Its options also take `loadFeatures({ signal })`, a loader resolving to
GeoJSON features in place of `url`, and `featureColor(properties)`, a CSS colour
per feature for its fill, stem, dot, pin and label accent. The layer it returns
also has `dropCachedFeatures()`, so the next `enable` loads again, and
`replaceFeatures(viewer, features)`, which draws a new feature set in place of
the current one: the current one stays drawn until the new one is built, and
stays if that fails (the call then rejects). A layer made with it may also pass
`cardDetails(properties)`, returning the detail lines of a feature's card (or
nothing, for a title alone); the USGS water layers use it for their gauge
readings. `gods-eye-view/infrastructure/lod` exports the existing LOD policy helpers.
Consumers use the package exports, which do not import standalone application
globals.

Dataset files and source/license notices remain under `src/data/local_data/`.
Their input counts are 4,352 datacenter features and 706 dam features. A multipart
geometry draws as several parts, each with its own stem; part and stem counts are
different measurements from feature counts.
