import { inputFor } from '../../input/dispatcher.js';
import { clickCard, isUnderOtherCard } from '../../data/pickRegistry.js';
import { LAYER_ID } from './policy.js';

export function createSelection({
  state: layerState,
  services,
  parts,
  source,
}) {
  const { clearSelectedEntityContextForLayer } = services.context;

  let removeContextListeners = null;

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
      // Another layer's card or label painted on top takes the click: the item
      // under it does not act, and the click is not empty space either. A
      // site's own label box is this layer's.
      if (isUnderOtherCard(event, [LAYER_ID])) return;
      // The site whose label box is painted on top at the click takes it,
      // whatever is drawn under it: from far out the click lands on the label,
      // not the 7 px dot. Else a site's dot, outline or fill, or a named
      // marker: each draw item names its installation in its `meta`.
      const card = clickCard(event);
      const hit = event.drawHit;
      const id =
        (card?.sourceId === LAYER_ID ? card.entryId : null) ??
        (hit?.set === parts.namedMarkers?.setId ||
        parts.rendering.ownsSet(hit?.set)
          ? hit.meta?.installationId
          : null) ??
        null;
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
  }
  return {
    selectRecord,
    installInteraction,
    destroy() {
      removeContextListeners?.();
      removeContextListeners = null;
    },
  };
}
