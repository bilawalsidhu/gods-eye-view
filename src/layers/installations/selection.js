import { inputFor } from '../../input/dispatcher.js';
import { LAYER_ID } from './policy.js';

export function createSelection({
  state: layerState,
  services,
  parts,
  source,
}) {
  const { clearSelectedEntityContextForLayer } = services.context;

  let removeContextListeners = null;
  let removeDoubleClick = null;

  function syncContextSelection(event) {
    if (!layerState.enabled) return;
    // Tracking layers publish this event before replacing the shared context.
    const selected =
      event?.type === 'gev:awareness-subject-selected'
        ? event.detail
        : services.context.getSelectedEntityContext();
    const next =
      selected?.layerId === LAYER_ID && layerState.recordById.has(selected.id)
        ? selected.id
        : null;
    if (next === layerState.selectedId) return;
    layerState.selectedId = next;
    parts.rendering.renderRecords();
  }

  function selectRecord(id) {
    const record = layerState.recordById.get(id);
    if (!record || !layerState.sets) return false;
    layerState.selectedId = id;
    parts.rendering.renderRecords({ claimSelection: true });
    // renderRecords drops selectedId when the record produced no marker.
    return layerState.selectedId === id;
  }

  function installInteraction(viewer) {
    if (layerState.clickSubscription) return;
    const events = [
      'gev:entity-selected',
      'gev:entity-selection-cleared',
      'gev:awareness-subject-selected',
    ];
    for (const event of events)
      globalThis.window?.addEventListener?.(event, syncContextSelection);
    removeContextListeners = () => {
      for (const event of events)
        globalThis.window?.removeEventListener?.(event, syncContextSelection);
    };
    const input = inputFor(viewer);
    layerState.clickSubscription = input.onClick((event) => {
      if (!layerState.enabled) return;
      // A site's dot, outline or fill, or a named marker: each draw item
      // names its installation in its `meta`.
      const hit = event.drawHit;
      const id =
        hit?.set === parts.namedMarkers?.setId ||
        parts.rendering.ownsSet(hit?.set)
          ? hit.meta?.installationId
          : null;
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
    });
    // Follow a site on a double-click, as the renderer's own double-click
    // followed the site's entity.
    removeDoubleClick =
      input.onPointer?.('dblclick', (event) => {
        // The renderer's own double-click follow, off while a tool holds it
        // or on a renderer without one.
        if (input.stockEnabled?.('dblclickFollow') !== true) return;
        parts.rendering.followAt(event.position);
      }) ?? null;
  }
  return {
    selectRecord,
    installInteraction,
    destroy() {
      removeContextListeners?.();
      removeContextListeners = null;
      removeDoubleClick?.();
      removeDoubleClick = null;
    },
  };
}
