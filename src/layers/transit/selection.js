import * as Cesium from 'cesium';
import { TRANSIT_FEED_REGISTRY } from '../../data/transitFeeds.js';
import {
  OUTLINE_COLOR,
  POINT_PIXEL_SIZE,
  SELECTED_CARD_REFRESH_MS,
  SELECTED_OUTLINE_COLOR,
  SELECTED_PIXEL_SIZE,
  TRANSIT_SELECTED_OVERLAY_SOURCE_ID,
  TRANSIT_SELECTED_OVERLAY_SOURCE_OPTIONS,
} from './policy.js';
import {
  buildTransitSelectionCopy,
  createTransitSelectedOverlayEntry,
} from './model.js';

/**
 * Click-to-inspect. This is an AMBIENT selection handler: it picks a vehicle
 * because the user clicked one, so it yields whenever a tool holds the
 * pointer (a draw session, Directions placing an endpoint) and never claims
 * the pointer itself.
 */
export function createSelection({ state: layerState, services, parts }) {
  function feedFor(entry) {
    return (
      layerState._activeFeeds.get(entry.feedId) ||
      TRANSIT_FEED_REGISTRY.find((feed) => feed.id === entry.feedId) ||
      null
    );
  }

  /**
   * Re-anchor the selected vehicle's card. Throttled while it glides; forced
   * after a poll so fresh speed/heading/age show at once.
   * @param {boolean} force
   * @param {string} [onlyFeedId] Skip when the selection belongs to another feed.
   */
  function refreshSelectedCard(force, onlyFeedId) {
    const entry = layerState._selectedKey
      ? layerState._vehicles.get(layerState._selectedKey)
      : null;
    if (!entry) return;
    if (onlyFeedId && entry.feedId !== onlyFeedId) return;
    const now = layerState._now();
    if (!force && now - layerState._selectedCardAt < SELECTED_CARD_REFRESH_MS)
      return;
    layerState._selectedCardAt = now;
    const feed = feedFor(entry);
    if (!feed) return;
    const copy = buildTransitSelectionCopy(feed, entry.record, entry.mode, now);
    const card = createTransitSelectedOverlayEntry(
      entry.key,
      Cesium.Cartesian3.clone(entry.point.position),
      copy,
      entry.mode,
    );
    if (card)
      layerState._overlayHost.setEntries(
        TRANSIT_SELECTED_OVERLAY_SOURCE_ID,
        [card],
        TRANSIT_SELECTED_OVERLAY_SOURCE_OPTIONS,
      );
  }

  function clearSelection() {
    const entry = layerState._selectedKey
      ? layerState._vehicles.get(layerState._selectedKey)
      : null;
    if (entry?.point) {
      entry.point.pixelSize = POINT_PIXEL_SIZE;
      entry.point.outlineColor = OUTLINE_COLOR;
      entry.point.outlineWidth = 1;
    }
    layerState._selectedKey = null;
    layerState._overlayHost.clearSource(TRANSIT_SELECTED_OVERLAY_SOURCE_ID);
  }

  function selectVehicle(key) {
    clearSelection();
    const entry = layerState._vehicles.get(key);
    if (!entry?.point) return false;
    layerState._selectedKey = key;
    entry.point.pixelSize = SELECTED_PIXEL_SIZE;
    entry.point.outlineColor = SELECTED_OUTLINE_COLOR;
    entry.point.outlineWidth = 2;
    refreshSelectedCard(true);
    services.render.governorRequestRender('transit-select');
    return true;
  }

  /** The vehicle key a pick names, or null. */
  function keyFromPick(picked) {
    for (const candidate of [picked?.primitive?.id, picked?.id]) {
      if (typeof candidate === 'string' && layerState._vehicles.has(candidate))
        return candidate;
    }
    return null;
  }

  /**
   * One click over the globe. Returns what happened so a test can drive it
   * without a canvas: 'yielded' (a tool holds the pointer), 'selected',
   * 'cleared' or 'ignored'.
   * @param {object|null} picked `scene.pick` result.
   * @returns {'yielded'|'selected'|'cleared'|'ignored'}
   */
  function handleClick(picked) {
    if (!layerState._enabled) return 'ignored';
    if (!services.input.isPointerFree()) return 'yielded';
    const key = keyFromPick(picked);
    if (key !== null) {
      selectVehicle(key);
      return 'selected';
    }
    if (layerState._selectedKey) {
      clearSelection();
      return 'cleared';
    }
    return 'ignored';
  }

  function onKeyDown(event) {
    if (event.key === 'Escape' && layerState._selectedKey) clearSelection();
  }

  function installClickHandler(viewer) {
    if (layerState._clickHandler || !viewer?.scene?.canvas) return;
    layerState._clickHandler = new Cesium.ScreenSpaceEventHandler(
      viewer.scene.canvas,
    );
    layerState._clickHandler.setInputAction((click) => {
      let picked = null;
      try {
        picked = viewer.scene.pick(click.position);
      } catch {
        picked = null;
      }
      handleClick(picked);
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
    globalThis.document?.addEventListener('keydown', onKeyDown);
  }

  function removeClickHandler() {
    if (layerState._clickHandler) {
      layerState._clickHandler.destroy();
      layerState._clickHandler = null;
    }
    globalThis.document?.removeEventListener('keydown', onKeyDown);
  }

  return {
    refreshSelectedCard,
    clearSelection,
    selectVehicle,
    handleClick,
    onKeyDown,
    installClickHandler,
    removeClickHandler,
  };
}
