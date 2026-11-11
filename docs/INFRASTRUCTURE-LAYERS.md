# Reusing infrastructure layers

`gods-eye-view/infrastructure` exports `createInfrastructureLayers(services)`.
It returns fresh datacenter and dam layers in that order, with the existing IDs,
appearance, label budgets and bundled public datasets. Importing the module or
calling the factory does not load data, create an engine, or start the application.
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

// Attach each layer to the current engine, then enable it when requested.
for (const layer of layers) layer.init(null, { engine });
await layers[0].enable();

// On a scene switch, keep the parsed data and replace only its display.
for (const layer of layers) layer.detachRenderer();
for (const layer of layers) await layer.attachRenderer(null, { engine: nextEngine });
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

Each returned session layer supports `init(null, { engine })`,
`attachRenderer(null, { engine, signal })`, `detachRenderer()`, `enable()`,
`disable()`, `update()`, `destroy()`, `getStats()`, `getLodDiagnostics()` and
`getAnalystRecords(limit)`. The first argument is retained for lifecycle
compatibility; drawing uses the engine passed in the options. Attach once per
scene, detach before attaching another engine, and destroy when the session ends.
Separate applications may use identical IDs with separate context/overlay hosts.
Callbacks must remain usable through destruction.

`src/layers/infrastructure/index.js` owns the parsed dataset, shared in-flight
load, enabled intention and selection across scene switches. Enable loads on
first use. Disable hides the drawing and clears selection but retains parsed
data. Detach destroys scene resources and retains the dataset and selected ID;
reattach redraws enabled data and restores selection when no other selection
owns the context. The attachment signal cancels that scene's wait, not the
session's fetch. Destroy aborts the fetch, discards late results and releases
both data and drawing.

`src/layers/infrastructure/render/display.js` draws the same records on every
engine: point movers for tips and pins, lines for stems, ground polygons for
footprints and ground corridors for paths. It owns the LOD walk, surface-height
refresh, picks, context handles and overlay publications. Destruction releases
its primitives and frame, camera and input subscriptions. The layer never
creates an overlay host, engine or render scheduler and does not import Cesium.

`gods-eye-view/infrastructure/geojson` exports the overlay publication,
selection, label and error helpers in `src/data/localGeojsonCore.js`; it no
longer exports `createLocalGeoJsonLayer`. `gods-eye-view/infrastructure/lod`
exports the LOD policy helpers. The package exports do not import standalone
application globals.

Dataset files and source/license notices remain under `src/data/local_data/`.
Their input counts are 4,352 datacenter features and 704 dam features. The session
splits multipart geometries using Cesium's stable repeated-id suffixes on every
engine. Feature, mover and stem counts are different measurements. These files
and licenses are independent of the renderer implementation.
