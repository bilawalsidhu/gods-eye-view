import * as Cesium from 'cesium';
import {
  SELECTED_CARD_REFRESH_MS,
  TRANSIT_SELECTED_OVERLAY_SOURCE_ID,
  TRANSIT_SELECTED_OVERLAY_SOURCE_OPTIONS,
  buildTransitSelectionCopy,
  createTransitSelectedOverlayEntry,
} from './policy.js';
import { getRegisteredTransitFeed } from '../../data/transitFeeds.js';
import { parseTransitNetworkPickId } from './network.js';
import { isPointerFree } from '../../data/inputOwnership.js';

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

  /**
   * Card for a clicked route line, anchored where the click met the ground.
   * @param {boolean} force
   */
  function refreshRouteCard(force) {
    const selected = state._selectedRoute;
    if (!selected) return;
    const now = Date.now();
    if (!force && now - state._selectedCardAt < SELECTED_CARD_REFRESH_MS)
      return;
    state._selectedCardAt = now;
    const copy = parts.network.networkCardCopy(
      { kind: selected.kind, feedId: selected.feedId, id: selected.id },
      now,
    );
    if (!copy) {
      clearSelection();
      return;
    }
    const text = `${selected.kind}\u0000${selected.feedId}\u0000${selected.id}\u0000${copy.title}\u0000${copy.details.join('\u0000')}`;
    if (!force && text === state._selectedCardText) return;
    const card = createTransitSelectedOverlayEntry(
      `${selected.kind}:${selected.feedId}/${selected.id}`,
      selected.position,
      copy,
      'unknown',
    );
    if (!card) return;
    card.accent = copy.accent;
    state._selectedCardText = text;
    state._overlayHost.setEntries(
      TRANSIT_SELECTED_OVERLAY_SOURCE_ID,
      [card],
      TRANSIT_SELECTED_OVERLAY_SOURCE_OPTIONS,
    );
    state._cardPublications = (state._cardPublications || 0) + 1;
  }

  function refreshSelectedCard(force) {
    if (state._selectedRoute) {
      refreshRouteCard(force);
      return;
    }
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
    );
    // Route name and alerts, for feeds that publish them. "Route Red" becomes
    // "Red Line"; a bus keeps its number and gains its destination line; and
    // whatever is in force on the route is said where the reader is looking.
    const extras = parts.network.vehicleCardExtras(
      entry.feedId,
      entry.record.routeId,
      now,
    );
    if (extras.routeName && entry.record.routeId) {
      copy.title = copy.title.replace(
        `Route ${entry.record.routeId}`,
        extras.routeName,
      );
    }
    if (extras.description) copy.details.splice(1, 0, extras.description);
    if (extras.lines.length) copy.details.push(...extras.lines);
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
    state._selectedRoute = null;
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
    governorRequestRender('transit-select');
  }

  /**
   * Select a route line clicked at `position` (a Cartesian3 on the ground).
   * @param {string} pickId Route pick id.
   * @param {object} position
   */
  function selectRoute(pickId, position) {
    const parsed = parseTransitNetworkPickId(pickId);
    if (!parsed) return;
    // A stop card stands on its stop; a route card where the click landed.
    const anchor =
      parsed.kind === 'stop'
        ? parts.network.stopPosition(parsed.feedId, parsed.id)
        : position;
    if (!anchor) return;
    clearSelection();
    state._selectedRoute = {
      ...parsed,
      ...(parsed.kind === 'route'
        ? { routeId: parsed.id }
        : { stopId: parsed.id }),
      position: anchor,
    };
    state._detectRevision += 1;
    refreshSelectedCard(true);
    governorRequestRender('transit-select-route');
  }

  /**
   * Where a click met the rendered surface: the depth buffer when the scene
   * can read it (photoreal tiles, terrain), else the globe, else the ellipsoid.
   */
  function groundPositionAt(viewer, windowPosition) {
    const scene = viewer.scene;
    try {
      if (scene.pickPositionSupported) {
        const p = scene.pickPosition(windowPosition);
        if (p && Number.isFinite(p.x)) return p;
      }
    } catch {
      /* fall through */
    }
    const ray = viewer.camera.getPickRay(windowPosition);
    const onGlobe = ray ? scene.globe?.pick(ray, scene) : null;
    if (onGlobe) return onGlobe;
    return viewer.camera.pickEllipsoid(windowPosition) || null;
  }

  function onKeyDown(event) {
    if (event.key === 'Escape' && (state._selectedKey || state._selectedRoute))
      clearSelection();
  }

  function installClickHandler(viewer) {
    if (state._clickHandler) return;
    state._clickHandler = new Cesium.ScreenSpaceEventHandler(
      viewer.scene.canvas,
    );
    state._clickHandler.setInputAction((click) => {
      // Ambient selection never competes for a pointer a tool has claimed:
      // placing a draw vertex on top of a bus must not also select the bus.
      if (!isPointerFree()) return;
      const scene = viewer.scene;
      // Pick buffers precede post-processing. Map a sensor pixel back through
      // the active shader's barrel distortion and quantization before picking.
      const position = Cesium.Cartesian2.clone(click.position);
      const style = state._stylePreset;
      const stage = scene.postProcessStages?.getStageByName?.(
        `godsEyeView_${style}`,
      );
      if (stage?.enabled && (style === 'thermal' || style === 'surveillance')) {
        const intensity = stage.uniforms.intensity;
        const canvas = scene.canvas,
          w = canvas.clientWidth,
          h = canvas.clientHeight;
        let u = position.x / w,
          v = 1 - position.y / h;
        if (style === 'surveillance') {
          const x = u * 2 - 1,
            y = v * 2 - 1,
            r2 = x * x + y * y;
          const d = 1 + r2 * intensity * 0.25 + r2 * r2 * intensity * 0.075;
          u = (x * d + 1) / 2;
          v = (y * d + 1) / 2;
        }
        const grid = 1 + (stage.uniforms.pixelation - 1) * intensity;
        u +=
          ((Math.floor((u * canvas.width) / grid) * grid) / canvas.width - u) *
          intensity;
        v +=
          ((Math.floor((v * canvas.height) / grid) * grid) / canvas.height -
            v) *
          intensity;
        position.x = u * w;
        position.y = (1 - v) * h;
      }
      const picked = scene.pick(position);
      state._lastPickForTest = {
        id: typeof picked?.id === 'string' ? picked.id : null,
        primitiveId:
          typeof picked?.primitive?.id === 'string'
            ? picked.primitive.id
            : null,
        x: position.x,
        y: position.y,
        collection:
          picked?.primitive?._billboardCollection === state._animatedMarkers
            ? 'animated'
            : picked?.primitive?._billboardCollection === state._markers
              ? 'stationary'
              : null,
      };
      if (picked) {
        const primitiveId = picked.primitive?.id;
        if (
          typeof primitiveId === 'string' &&
          state._vehicles.has(primitiveId)
        ) {
          selectVehicle(primitiveId);
          return;
        }
        if (typeof picked.id === 'string' && state._vehicles.has(picked.id)) {
          selectVehicle(picked.id);
          return;
        }
        if (parts.network.isNetworkPick(picked.id)) {
          selectRoute(picked.id, groundPositionAt(viewer, position));
          return;
        }
      }
      if (state._selectedKey || state._selectedRoute) clearSelection();
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
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
    selectRoute,
    onKeyDown,
    installClickHandler,
    removeClickHandler,
  };
}
