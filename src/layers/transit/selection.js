import {
  SELECTED_CARD_REFRESH_MS,
  TRANSIT_SELECTED_OVERLAY_SOURCE_ID,
  TRANSIT_SELECTED_OVERLAY_SOURCE_OPTIONS,
  buildTransitSelectionCopy,
  createTransitSelectedOverlayEntry,
} from './policy.js';
import { getRegisteredTransitFeed } from '../../data/transitFeeds.js';
import { isPointerFree } from '../../data/inputOwnership.js';
import { t } from '../../i18n/index.js';

/**
 * Click-to-select one vehicle and a card that follows it.
 * @param {object} context
 * @returns {object}
 */
export function createSelection({ state, services, parts }) {
  const { governorRequestRender } = services.render;

  /**
   * The card's anchor: the selected marker's CURRENT position, read by the
   * overlay host on every paint. A getter, not a clone — the host accepts one
   * (the tracked-aircraft readout uses the same), so the anchor moves with the
   * sprite at frame rate, through poll arrivals, settling, a late floor and a
   * reset alike, with no per-frame work here. Null when there is nothing to
   * anchor to: a hidden or removed marker draws no card.
   * @param {object} entry
   * @returns {() => Cesium.Cartesian3|null}
   */
  function anchorFor(entry) {
    return () => {
      const marker = entry.marker;
      const p = marker?.show !== false ? marker?.position : null;
      return p &&
        Number.isFinite(p.x) &&
        Number.isFinite(p.y) &&
        Number.isFinite(p.z)
        ? p
        : null;
    };
  }

  function refreshSelectedCard(force) {
    const entry = state._selectedKey
      ? state._vehicles.get(state._selectedKey)
      : null;
    if (!entry) return;
    const now = Date.now();
    if (!force && now - state._selectedCardAt < SELECTED_CARD_REFRESH_MS)
      return;
    state._selectedCardAt = now;
    const feed =
      state._activeFeeds.get(entry.feedId) ||
      getRegisteredTransitFeed(entry.feedId);
    if (!feed) return;
    const copy = buildTransitSelectionCopy(
      feed,
      entry.record,
      entry.mode,
      now,
      entry.fetchedAt,
      entry,
      t,
    );
    // The TEXT is what the throttle is for, and it is republished only when
    // it has changed: the anchor is live through its getter, so re-sending
    // an identical card would only make the host re-solve its layout.
    const text = `${entry.key}\u0000${copy.title}\u0000${copy.details.join('\u0000')}`;
    if (!force && text === state._selectedCardText) return;
    const card = createTransitSelectedOverlayEntry(
      entry.key,
      anchorFor(entry),
      copy,
      entry.mode,
    );
    if (card) {
      state._selectedCardText = text;
      state._overlayHost.setEntries(
        TRANSIT_SELECTED_OVERLAY_SOURCE_ID,
        [card],
        TRANSIT_SELECTED_OVERLAY_SOURCE_OPTIONS,
      );
      state._cardPublications = (state._cardPublications || 0) + 1;
    }
  }

  function clearSelection() {
    const entry = state._selectedKey
      ? state._vehicles.get(state._selectedKey)
      : null;
    parts.trails.clear();
    state._selectedKey = null;
    state._selectedCardText = null;
    state._detectRevision += 1;
    // Cleared first: the styling path reads the selection from state.
    if (entry) parts.rendering.paintSelected(entry, false);
    state._overlayHost.clearSource(TRANSIT_SELECTED_OVERLAY_SOURCE_ID);
  }

  function selectVehicle(key) {
    clearSelection();
    const entry = state._vehicles.get(key);
    if (!entry?.marker) return;
    state._selectedKey = key;
    state._detectRevision += 1;
    parts.rendering.paintSelected(entry, true);
    parts.trails.select(entry);
    refreshSelectedCard(true);
    governorRequestRender('transit-select', parts.renderer?.engine);
  }

  function onKeyDown(event) {
    if (event.key === 'Escape' && state._selectedKey) clearSelection();
  }

  function installClickHandler() {
    if (state._clickHandler) return;
    state._clickHandler = parts.renderer.bindClick((picked) => {
      state._lastPickForTest = picked;
      const key = state._vehicles.has(picked.primitiveId)
        ? picked.primitiveId
        : picked.id;
      if (typeof key === 'string' && state._vehicles.has(key)) {
        selectVehicle(key);
        return;
      }
      if (state._selectedKey) clearSelection();
    }, isPointerFree);
    document.addEventListener('keydown', onKeyDown);
  }

  function removeClickHandler() {
    if (state._clickHandler) {
      state._clickHandler.destroy();
      state._clickHandler = null;
    }
    document.removeEventListener('keydown', onKeyDown);
  }

  return {
    refreshSelectedCard,
    clearSelection,
    selectVehicle,
    onKeyDown,
    installClickHandler,
    removeClickHandler,
  };
}
