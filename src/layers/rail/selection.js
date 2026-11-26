import {
  RAIL_SELECTED_OVERLAY_SOURCE_ID,
  RAIL_SELECTED_OVERLAY_SOURCE_OPTIONS,
  SELECTED_CARD_REFRESH_MS,
  buildRailSelectionCopy,
  createRailSelectedOverlayEntry,
} from './policy.js';
import { getRegisteredRailFeed } from '../../data/railFeeds.js';
import { inputFor } from '../../input/dispatcher.js';
import { isUnderOtherCard } from '../../data/pickRegistry.js';
import { onFollowChanged } from '../../data/followed.js';
import {
  claimSelection,
  releaseSelection,
  yieldSelectionToOthers,
} from '../../data/clickSelect.js';
import { t } from '../../i18n/index.js';

/**
 * Click-to-select one train, a card that stays on it, and one camera
 * flight that centres it (focus.js); the camera does not follow it. Escape,
 * a click on anything else, or another layer's selection deselects it.
 * @param {object} context
 * @returns {object}
 */
export function createSelection({ state, services, parts }) {
  const { governorRequestRender } = services.render;
  /** Offs for the listeners that let the selection go to another layer. */
  let yieldOffs = [];

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
   * selection to another feed's copy of the same train.
   * @param {string} key
   */
  function selectTrain(key) {
    if (!state._trains.has(key)) return;
    const hadSelection = state._selectedKey !== null;
    const previous = state._trains.get(state._selectedKey);
    if (state._selectedKey !== null && state._selectedKey !== key)
      releaseSelection('rail', state._selectedKey);
    state._selectedKey = key;
    // The one selection: any other layer's selected thing lets go.
    claimSelection('rail', key);
    const entry = state._trains.get(key);
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
   * Select the train the user picked and centre it once (focus.js), even
   * the selected train again. The camera does not follow it.
   * @param {string} key
   */
  function selectAndFocusTrain(key) {
    if (!state._trains.has(key)) return;
    // A selection by the user, even of the selected train (cockpitSubject.js).
    state._selectedAtMs = Date.now();
    selectTrain(key);
    parts.focus.focus(state._trains.get(key));
  }

  /** Deselect, leaving the camera where it is. */
  function clearSelection() {
    const hadSelection = state._selectedKey !== null;
    if (hadSelection) releaseSelection('rail', state._selectedKey);
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

  /**
   * The train a click's hit names: one of this layer's icons, or a train's
   * 3D model (its pick meta is the train's key); null for anything else.
   */
  function trainKeyOf(hit) {
    if (!hit) return null;
    if (hit.set && hit.set === state._icons?.id)
      return state._trains.has(hit.id) ? hit.id : null;
    const meta = hit.meta;
    return typeof meta === 'string' && state._trains.has(meta) ? meta : null;
  }

  function installClickHandler(viewer) {
    if (state._clickSubscription) return;
    // The dispatcher maps a sensor-style click back into the pick buffer
    // and skips it while a tool holds the pointer.
    state._clickSubscription = inputFor(viewer).onClick((event) => {
      if (!state._enabled) return;
      // A held train keeps the selection until its view lets it go.
      if (state._cockpitSubjectKey) return;
      // Another layer's card or label painted on top takes the click: the item
      // under it does not act, and the click is not empty space either.
      if (isUnderOtherCard(event)) return;
      const key = trainKeyOf(event.drawHit);
      if (key) selectAndFocusTrain(key);
      else if (state._selectedKey) clearSelection();
    });
    globalThis.document?.addEventListener?.('keydown', onKeyDown);
    // Another layer's selection, or anything the camera starts following,
    // takes the scene from the train, unless a first-person view holds it.
    const yields = () =>
      state._selectedKey !== null && !state._cockpitSubjectKey;
    yieldOffs = [
      yieldSelectionToOthers('rail', yields, () => clearSelection()),
      onFollowChanged(viewer, (followed) => {
        if (followed && yields()) clearSelection();
      }),
    ];
  }

  function removeClickHandler() {
    state._clickSubscription?.();
    state._clickSubscription = null;
    globalThis.document?.removeEventListener?.('keydown', onKeyDown);
    for (const off of yieldOffs) off();
    yieldOffs = [];
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
