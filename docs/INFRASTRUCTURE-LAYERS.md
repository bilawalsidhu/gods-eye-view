# Reusing infrastructure layers

`gods-eye-view/infrastructure` exports `createInfrastructureLayers(services)`.
It returns fresh datacenter and dam layers in that order, with the existing IDs,
appearance, label budgets and bundled public datasets. Importing the module or
calling the factory does not load data, create a viewer, or start the application.
The asset URLs resolve relative to the module; Vite rewrites them for production
base paths. This browser source export expects a Vite-compatible asset build.

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
| `clearSelectedEntityContextForLayer` | `(layerId)`; clear selection only if owned by this layer |
| `removeEntityContextsForLayer` | `(layerId)`; remove records owned by the layer on destruction or failed setup |
| `governorRequestRender` | `(reason)`; request a frame through the existing render scheduler |

Each returned layer supports `init(viewer)`, `enable(viewer)`, `disable(viewer)`,
`update(viewer)`, `destroy(viewer)`, `getStats()`, `getLodDiagnostics()` and
`getAnalystRecords()`.
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
a `marker-symbol` draws the plain pin. Polygons with heights are drawn at them,
outlined; points with heights stand their pin on the stem's tip. Edges follow
rhumb lines.

`gods-eye-view/infrastructure/geojson` exports the lower-level
`createLocalGeoJsonLayer(options, services)` and existing infrastructure overlay
helpers. `gods-eye-view/infrastructure/lod` exports the existing LOD policy helpers.
Consumers use the package exports, which do not import standalone application
globals.

Dataset files and source/license notices remain under `src/data/local_data/`.
Their input counts are 4,351 datacenter features and 704 dam features. A multipart
geometry draws as several parts, each with its own stem; part and stem counts are
different measurements from feature counts. This change does not refresh or relicense the datasets.
