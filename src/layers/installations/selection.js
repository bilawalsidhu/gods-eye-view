import { inputFor } from '../../input/dispatcher.js';
import {
  clickCard,
  isUnderOtherCard,
  registerClickClaim,
  unregisterClickClaim,
} from '../../data/pickRegistry.js';
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

  /** Whether a draw hit is one of this layer's: a dot, outline, fill or named marker. */
  function ownsHit(hit) {
    return Boolean(
      hit &&
      (hit.set === parts.namedMarkers?.setId ||
        parts.rendering.ownsSet(hit.set)),
    );
  }

  /**
   * A site's label box as the card on top of a click, for every layer's
   * clickCard (the pick registry's click claim). Only where nothing another
   * layer draws is under the click: an aircraft or vessel drawn under a
   * base's label keeps its own click, while a label over the map, or over
   * this layer's own dots and fills, takes it. Runs only where no card or
   * label that takes clicks is painted on top.
   * @param {object} event The shared dispatcher click.
   * @returns {{sourceId: string, entryId: string}|null}
   */
  function labelClickCard(event) {
    if (!layerState.enabled || !event) return null;
    if (event.topHit && !ownsHit(event.drawHit)) return null;
    const id =
      parts.namedMarkers?.labelAt?.(event.screenPosition ?? event.position) ??
      null;
    return id && layerState.recordById.has(id)
      ? { sourceId: LAYER_ID, entryId: id }
      : null;
  }

  function installInteraction(viewer) {
    if (layerState.clickSubscription) return;
    registerClickClaim(LAYER_ID, labelClickCard);
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
      // The site whose label box is at the click takes it where nothing
      // another layer draws is under it (labelClickCard): from far out the
      // click lands on the label, not the 7 px dot. Else a site's dot,
      // outline or fill, or a named marker: each draw item names its
      // installation in its `meta`.
      const card = clickCard(event);
      const hit = event.drawHit;
      const id =
        (card?.sourceId === LAYER_ID ? card.entryId : null) ??
        (ownsHit(hit) ? hit.meta?.installationId : null) ??
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
      unregisterClickClaim(LAYER_ID);
    },
  };
}
