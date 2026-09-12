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
`update(viewer)`, `destroy(viewer)`, `getStats()` and `getLodDiagnostics()`.
Use the same viewer for the instance's entire lifetime. Each viewer/context/overlay
host permits one live instance per layer ID; destroy an old instance before
replacing it. Separate applications may use identical IDs with separate hosts.
Callbacks must be ready before enable and remain usable through destruction.

Disable retains the loaded dataset for reuse and clears selection and listeners.
Concurrent enables share one load. Destroy is permanent, aborts pending fetches,
discards late results, and clears the owned data source, context records, overlays,
input handler and listeners. The layer never creates an application context store,
overlay host, viewer, or render scheduler. The consumer must resolve one compatible
Cesium installation shared with its viewer; it must not bundle separate copies.

`gods-eye-view/infrastructure/geojson` exports the lower-level
`createLocalGeoJsonLayer(options, services)` and existing infrastructure overlay
helpers. `gods-eye-view/infrastructure/lod` exports the existing LOD policy helpers.
The standalone app's `src/data/localGeojson.js` keeps its original single-argument
factory and supplies its existing functions. Other consumers should use the package
exports, which do not import standalone application globals.

Dataset files and source/license notices remain under `src/data/local_data/`.
Their input counts are 4,351 datacenter features and 704 dam features. Cesium may
expand multipart geometries into multiple entities; entity and stem counts are
different measurements. This change does not refresh or relicense the datasets.
