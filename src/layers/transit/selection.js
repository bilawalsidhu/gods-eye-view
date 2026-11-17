import {
  SELECTED_CARD_REFRESH_MS,
  TRANSIT_SELECTED_OVERLAY_SOURCE_ID,
  TRANSIT_SELECTED_OVERLAY_SOURCE_OPTIONS,
  buildTransitSelectionCopy,
  createTransitSelectedOverlayEntry,
} from './policy.js';
import { getRegisteredTransitFeed } from '../../data/transitFeeds.js';
import { inputFor } from '../../input/dispatcher.js';
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
   * anchor to: a hidden or removed marker draws no card, unless the vehicle's
   * 3D model is drawing it in the marker's place.
   * @param {object} entry
   * @returns {() => {x: number, y: number, z: number}|null} ECEF
   */
  function anchorFor(entry) {
    return () => {
      const marker = entry.marker;
      const drawn = marker?.show !== false || entry.modelOwnsVisual === true;
      const p = drawn ? marker?.position : null;
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
    // A vehicle a first-person view rides shows no card.
    if (entry.key === state._cockpitSubjectKey) {
      state._selectedCardText = null;
      state._overlayHost.clearSource(TRANSIT_SELECTED_OVERLAY_SOURCE_ID);
      return;
    }
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
    state._selectedAtMs = null;
    state._selectedCardText = null;
    state._detectRevision += 1;
    // Cleared first: the styling path reads the selection from state.
    if (entry) parts.rendering.paintSelected(entry, false);
    state._overlayHost.clearSource(TRANSIT_SELECTED_OVERLAY_SOURCE_ID);
  }

  /**
   * Select a vehicle. `byUser` marks a selection the user made (a click, or
   * focusVehicle), even of the selected vehicle again: its time is the
   * snapshot's `selectedAtMs` (cockpitSubject.js). A first-person view's hold
   * selects without it.
   */
  function selectVehicle(key, { byUser = false } = {}) {
    clearSelection();
    const entry = state._vehicles.get(key);
    if (!entry?.marker) return;
    state._selectedKey = key;
    if (byUser) state._selectedAtMs = Date.now();
    state._detectRevision += 1;
    parts.rendering.paintSelected(entry, true);
    parts.trails.select(entry);
    refreshSelectedCard(true);
    governorRequestRender('transit-select');
  }

  function onKeyDown(event) {
    // While a first-person view rides the vehicle, Escape is the view's.
    if (state._cockpitSubjectKey) return;
    if (event.key === 'Escape' && state._selectedKey) clearSelection();
  }

  function installClickHandler(viewer) {
    if (state._clickSubscription) return;
    // The dispatcher maps a sensor-style click back into the pick buffer
    // (src/input/sensorPick.js) and skips it while a tool holds the pointer.
    state._clickSubscription = inputFor(viewer).onClick((event) => {
      // A held vehicle keeps the selection until its view lets it go.
      if (state._cockpitSubjectKey) return;
      const position = event.position;
      // A marker is an item of one of this layer's two sets, by its key.
      const hit = event.drawHit;
      const set = parts.rendering.setNameOf(hit?.set);
      const key = set && state._vehicles.has(hit.id) ? hit.id : null;
      state._lastPickForTest = {
        id: key,
        set: hit?.set ?? null,
        x: position.x,
        y: position.y,
        collection:
          set === 'moving' ? 'animated' : set === 'still' ? 'stationary' : null,
      };
      if (key) {
        selectVehicle(key, { byUser: true });
        return;
      }
      if (state._selectedKey) clearSelection();
    });
    document.addEventListener('keydown', onKeyDown);
  }

  function removeClickHandler() {
    state._clickSubscription?.();
    state._clickSubscription = null;
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
