import * as Cesium from 'cesium';
import { isPointerFree } from '../../data/inputOwnership.js';
import { LAYER_ID } from './policy.js';

export function createSelection({
  state: layerState,
  services,
  parts,
  source,
}) {
  const { clearSelectedEntityContextForLayer } = services.context;

  function selectRecord(id) {
    const record = layerState.recordById.get(id);
    if (!record || !layerState.dataSource) return false;
    layerState.selectedId = id;
    parts.rendering.renderRecords({ claimSelection: true });
    // renderRecords drops selectedId when the record produced no entity.
    return layerState.selectedId === id;
  }

  function installInteraction(viewer) {
    if (layerState.clickHandler) return;
    layerState.clickHandler = new Cesium.ScreenSpaceEventHandler(
      viewer.scene.canvas,
    );
    layerState.clickHandler.setInputAction((click) => {
      // A tool owns the pointer (src/data/inputOwnership.js): yield the click.
      if (!isPointerFree()) return;
      if (!layerState.enabled) return;
      const picked = viewer.scene.pick(click.position);
      const id =
        picked?.id?.installationId ||
        (typeof picked?.id?.id === 'string' ? picked.id.id : null);
      if (id && layerState.recordById.has(id) && id !== layerState.selectedId) {
        selectRecord(id);
      } else if (layerState.selectedId) {
        // Clicking the selected site again, empty map, or another contact
        // releases this layer's selection. Clear only our shared context so a
        // sibling click handler's newly selected aircraft/site stays intact.
        layerState.selectedId = null;
        clearSelectedEntityContextForLayer(LAYER_ID);
        parts.rendering.renderRecords();
      }
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  }
  return { selectRecord, installInteraction };
}
