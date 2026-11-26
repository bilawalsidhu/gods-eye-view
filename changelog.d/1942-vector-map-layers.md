### Added

- Imagery layers of kind `vector` in the renderer contract: a MapLibre style's vector map at `styleUrl`, draped as any imagery layer, its labels drawn as text; `overlay` draws its lines and labels alone over other imagery. They need `vectorBase`.
- A map source whose imagery resolves to null shows the globe with no imagery layer; a source registered beyond `MAP_STACKS` and marked `presented: true` gets a Map Source chip; `publishMapLayer(id, row)` shows a select under Map Source in the Visual panel.

### Removed

- The vector base painter (`gods-eye-view/render/vectorBase`). The Cesium renderer no longer claims `vectorBase` and refuses a vector base.
