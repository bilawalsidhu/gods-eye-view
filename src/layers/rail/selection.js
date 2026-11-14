import * as Cesium from 'cesium';
import {
  RAIL_SELECTED_OVERLAY_SOURCE_ID,
  RAIL_SELECTED_OVERLAY_SOURCE_OPTIONS,
  SELECTED_CARD_REFRESH_MS,
  buildRailSelectionCopy,
  createRailSelectedOverlayEntry,
} from './policy.js';
import { getRegisteredRailFeed } from '../../data/railFeeds.js';
import { isPointerFree } from '../../data/inputOwnership.js';
import { t } from '../../i18n/index.js';

/**
 * Click-to-select one train, a card that follows it, and the camera handed
 * to it (follow.js). Escape or a click on anything else deselects it.
 * @param {object} context
 * @returns {object}
 */
export function createSelection({ state, services, parts }) {
  const { governorRequestRender } = services.render;

  /**
   * The card's anchor: the marker's current position, read on every paint,
   * whether the train is drawn as its marker or as its 3D model.
   */
  function anchorFor(entry) {
    return () => {
      const drawn =
        entry.marker?.show !== false || entry.modelOwnsVisual === true;
      const p = drawn ? entry.marker?.position : null;
      return p && Number.isFinite(p.x) && Number.isFinite(p.y) ? p : null;
    };
  }

  function refreshSelectedCard(force) {
    const entry = state._trains.get(state._selectedKey);
    if (!entry) return;
    // A train a first-person view rides shows no card.
    if (entry.key === state._cockpitSubjectKey) {
      state._selectedCardText = null;
      state._overlayHost.setEntries(
        RAIL_SELECTED_OVERLAY_SOURCE_ID,
        [],
        RAIL_SELECTED_OVERLAY_SOURCE_OPTIONS,
      );
      return;
    }
    const now = Date.now();
    if (!force && now - state._selectedCardAt < SELECTED_CARD_REFRESH_MS)
      return;
    state._selectedCardAt = now;
    const feed = getRegisteredRailFeed(entry.feedId);
    if (!feed) return;
    const copy = buildRailSelectionCopy(
      feed,
      entry.record,
      now,
      entry.fetchedAt,
      entry,
      t,
      state._trip,
    );
    const text = JSON.stringify(copy);
    if (!force && text === state._selectedCardText) return;
    state._selectedCardText = text;
    const card = createRailSelectedOverlayEntry(
      entry.key,
      anchorFor(entry),
      copy,
      entry.category,
    );
    state._overlayHost.setEntries(
      RAIL_SELECTED_OVERLAY_SOURCE_ID,
      card ? [card] : [],
      RAIL_SELECTED_OVERLAY_SOURCE_OPTIONS,
    );
  }

  /**
   * Select a train without touching the camera. Called by a click (through
   * selectAndFocusTrain) and by the duplicate filter, which moves the
   * selection to another feed's copy of the same train; a follow on the old
   * copy then glides to the new one.
   * @param {string} key
   */
  function selectTrain(key) {
    if (!state._trains.has(key)) return;
    const hadSelection = state._selectedKey !== null;
    const previous = state._trains.get(state._selectedKey);
    state._selectedKey = key;
    const entry = state._trains.get(key);
    if (previous && previous !== entry) parts.follow.handover(entry);
    // The first selection dims every other train; a change of selection only
    // swaps the two trains involved.
    if (!hadSelection) parts.rendering.paintAll();
    else {
      if (previous) parts.rendering.paint(previous);
      parts.rendering.paint(entry);
    }
    // Line and stops first, so the card is built with this trip's stops.
    parts.routes.onSelectionChanged();
    refreshSelectedCard(true);
    // Its feed is polled for it at any distance from now on.
    parts.viewport.requestProximityCheck();
    governorRequestRender('rail-select');
  }

  /**
   * Select the train the user picked and give it the camera (follow.js): a
   * moving train is followed, any other flown to once. Picking the train
   * already followed keeps the follow as it is.
   * @param {string} key
   */
  function selectAndFocusTrain(key) {
    if (!state._trains.has(key)) return;
    // A selection by the user, even of the selected train (cockpitSubject.js).
    state._selectedAtMs = Date.now();
    const following = parts.follow.isFollowing(key);
    // Another train's follow lets go first, so this is never taken for a
    // move between two copies of one train.
    if (!following) parts.follow.release();
    selectTrain(key);
    if (!following) parts.follow.focus(state._trains.get(key));
  }

  /**
   * Deselect, letting go of the camera where it is.
   * @param {{untrack?: boolean}} [options] `untrack: false` when another
   *   camera owner took over and its tracked entity must stay.
   */
  function clearSelection({ untrack = true } = {}) {
    const hadSelection = state._selectedKey !== null;
    parts.follow.release({ untrack });
    state._selectedKey = null;
    state._selectedAtMs = null;
    state._selectedCardText = null;
    if (hadSelection) {
      parts.rendering.paintAll();
      parts.routes.onSelectionChanged();
      // A feed held for the train goes back to the viewport's rules.
      parts.viewport.requestProximityCheck();
    }
    state._overlayHost.setEntries(
      RAIL_SELECTED_OVERLAY_SOURCE_ID,
      [],
      RAIL_SELECTED_OVERLAY_SOURCE_OPTIONS,
    );
    governorRequestRender('rail-deselect');
  }

  function onKeyDown(event) {
    // While a first-person view rides the train, Escape is the view's.
    if (state._cockpitSubjectKey) return;
    if (event.key === 'Escape' && state._selectedKey) clearSelection();
  }

  function installClickHandler(viewer) {
    if (state._clickHandler) return;
    state._clickHandler = new Cesium.ScreenSpaceEventHandler(
      viewer.scene.canvas,
    );
    state._clickHandler.setInputAction((click) => {
      if (!state._enabled || !isPointerFree()) return;
      // A held train keeps the selection until its view lets it go.
      if (state._cockpitSubjectKey) return;
      const picked = viewer.scene.pick(click.position);
      const id = typeof picked?.id === 'string' ? picked.id : null;
      if (id && state._trains.has(id)) selectAndFocusTrain(id);
      else if (state._selectedKey) clearSelection();
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
    globalThis.document?.addEventListener?.('keydown', onKeyDown);
    parts.follow.install(viewer);
  }

  function removeClickHandler() {
    state._clickHandler?.destroy();
    state._clickHandler = null;
    globalThis.document?.removeEventListener?.('keydown', onKeyDown);
    parts.follow.uninstall();
  }

  return {
    refreshSelectedCard,
    selectTrain,
    selectAndFocusTrain,
    clearSelection,
    onKeyDown,
    installClickHandler,
    removeClickHandler,
  };
}
