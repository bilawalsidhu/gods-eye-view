import {
  createFrameSlot,
  CCTV_OVERLAY_SOURCE_ID,
  declutterCctvCards,
  planFrameCachePrune,
  createCctvThumbnailOverlayEntry,
  CCTV_FRAME_CANVAS_W,
  CCTV_FRAME_CANVAS_H,
  applyFrameResult,
} from '../../data/cctvCards.js';
import * as Cesium from 'cesium';
import { horizonOccluder } from '../../data/iconOrientation.js';
import { selectCctvLod, applyEvictionGrace } from '../../data/cctvLod.js';
import {
  CCTV_OVERLAY_SOURCE_OPTIONS,
  CARD_VIEW_MARGIN,
  CCTV_AMBIENT_CARD_DRAIN_CAP,
  CARD_GAP_PX,
  CARD_FETCH_TICK_MS,
} from './policy.js';

export function createCards({ state: layerState, services, parts, source }) {
  /**
   * Configures optional CCTV card presentation without changing card density.
   * The active-camera thumbnail defaults OFF, preserving the shipped behavior
   * where the monitor plane is the camera's sole active representation.
   *
   * @param {Object} [options]
   * @param {boolean} [options.activeCameraCardEnabled=false]
   * @returns {{activeCameraCardEnabled:boolean}}
   */

  function setCctvCardPresentationOptions({
    activeCameraCardEnabled = false,
  } = {}) {
    layerState._activeCameraCardEnabled = activeCameraCardEnabled === true;
    if (layerState._enabled) pushAmbientCardEntries();
    layerState._viewer?.scene?.requestRender?.();

    return { activeCameraCardEnabled: layerState._activeCameraCardEnabled };
  }

  // ---------------------------------------------------------------------------
  // Ambient card tier (2026-07-29 design — spec:
  // docs/superpowers/specs/2026-07-29-cctv-ambient-cards-design.md)
  // ---------------------------------------------------------------------------

  /** Returns (creating on demand) the stable frame slot for a camera id. */

  function ensureCardFrameSlot(cameraId) {
    let slot = layerState._cardFrameSlots.get(cameraId);
    if (!slot) {
      slot = createFrameSlot();
      layerState._cardFrameSlots.set(cameraId, slot);
    }
    return slot;
  }

  /**
   * Rebuilds the ambient card selection: horizon + in-view projection of the
   * catalog (pure math — no scene queries), the zoom-budgeted nearest-first
   * LOD pick, greedy screen-space declutter, and the eviction-grace pass that
   * keeps budget-edge cards alive across small camera moves (zero-flicker).
   * Runs on camera.moveEnd, enable, activation change, and the one-shot
   * geometry-drain completion — NEVER per frame. The active camera is excluded
   * from the ambient selection/quota. By default its monitor plane is the sole
   * active representation; the optional protected-card path is applied only by
   * `pushAmbientCardEntries`. Camera icons are never touched here (cards
   * annotate markers, they don't replace them).
   */

  function refreshAmbientCards() {
    if (
      !layerState._enabled ||
      !layerState._viewer ||
      layerState._viewer.isDestroyed() ||
      !layerState._records.length
    ) {
      layerState._cctvOverlayHost.setEntries(
        CCTV_OVERLAY_SOURCE_ID,
        [],
        CCTV_OVERLAY_SOURCE_OPTIONS,
      );
      return;
    }
    const scene = layerState._viewer.scene;
    const carto = layerState._viewer.camera.positionCartographic;
    const viewerLat = carto ? Cesium.Math.toDegrees(carto.latitude) : 0;
    const viewerLon = carto ? Cesium.Math.toDegrees(carto.longitude) : 0;
    // The active camera is excluded from ambient selection ALWAYS (not just
    // after its async activation settles). It is published separately in the
    // protected lane below, and grace never applies to it.
    const activeId = layerState._activeCameraId;
    const occluder = horizonOccluder(layerState._viewer.camera);
    const width = scene.canvas.clientWidth || scene.canvas.width || 0;
    const height = scene.canvas.clientHeight || scene.canvas.height || 0;
    const marginX = width * CARD_VIEW_MARGIN;
    const marginY = height * CARD_VIEW_MARGIN;

    const candidates = [];
    const screenById = new Map();
    for (const record of layerState._records) {
      const id = record.camera.id;
      if (id === activeId || !record.position) continue;
      let inView = false;
      let sx = NaN;
      let sy = NaN;
      if (occluder.isPointVisible(record.position)) {
        const screen = scene.cartesianToCanvasCoordinates(record.position);
        if (
          screen &&
          Number.isFinite(screen.x) &&
          Number.isFinite(screen.y) &&
          screen.x >= -marginX &&
          screen.x <= width + marginX &&
          screen.y >= -marginY &&
          screen.y <= height + marginY
        ) {
          inView = true;
          sx = screen.x;
          sy = screen.y;
          screenById.set(id, { sx, sy });
        }
      }
      candidates.push({
        id,
        distanceKm: parts.model.haversineKm(
          viewerLat,
          viewerLon,
          record.camera.lat,
          record.camera.lon,
        ),
        inView,
        isVideo: parts.model.isVideoFeedType(
          parts.model.normalizeFeedType(record.camera.feedType),
        ),
        sx,
        sy,
      });
    }

    // Owner finding 4: current card holders rank with the 20% incumbency
    // distance discount, so a small camera move never batch-swaps the ring.
    // Item C: passing the viewport dims + per-candidate screen anchors routes
    // the budget fill through the screen-distribution grid, so periphery
    // cells hold cards instead of everything clustering at screen center.
    const { cardIds, budgets } = selectCctvLod(candidates, {
      cameraHeightM: carto?.height,
      incumbentIds: layerState._cardIds,
      viewW: width,
      viewH: height,
    });
    // Like the cold-fill burst, card density yields to the staggered geometry
    // drain: painting the raised 20/28/40 budget per frame starves the
    // frame-paced mesh-floor queue on weak GPUs (qa-cctv-v2 N=800 drain-budget
    // regression). During the initial load the budget holds at the low tier;
    // full density arrives the moment the drain completes (which triggers its
    // own refreshAmbientCards pass).
    const cardLimit = layerState._geoLoading
      ? Math.min(budgets.cardLimit, CCTV_AMBIENT_CARD_DRAIN_CAP)
      : budgets.cardLimit;
    const decluttered = declutterCctvCards(
      cardIds
        .filter((id) => screenById.has(id))
        .slice(0, cardLimit)
        .map((id, index) => ({
          id,
          ...screenById.get(id),
          // Priority carrier, not kilometers: declutter sorts ascending on
          // this field, and the selection's order (distribution + incumbency)
          // must survive — a periphery cell-winner must not be re-outranked
          // by central proximity when two anchors contest the min separation.
          distanceKm: index,
        })),
      { limit: cardLimit },
    );
    // Owner finding 2: grace must never apply to the active camera — drop any
    // lingering grace entry and keep it out of the retained-card baseline.
    if (activeId) {
      layerState._cardIds.delete(activeId);
      layerState._cardGraceState.delete(activeId);
    }
    const retention = applyEvictionGrace({
      selectedIds: decluttered,
      builtIds: [...layerState._cardIds],
      graceState: layerState._cardGraceState,
      nowMs: Date.now(),
      cardLimit: budgets.cardLimit,
    });
    layerState._cardIds = new Set(retention.keepIds);
    layerState._cardGraceState = retention.graceState;

    // Bounded thumbnail LRU: live cards (grace included) never lose their
    // persisted frame — that persistence IS the no-flicker guarantee. The
    // hover card's slot is protected too while the gesture lasts.
    const keepFrames = new Set(layerState._cardIds);
    if (layerState._hoverCardId) keepFrames.add(layerState._hoverCardId);
    if (layerState._activeCameraCardEnabled && layerState._activeCameraId)
      keepFrames.add(layerState._activeCameraId);
    const drops = planFrameCachePrune(
      [...layerState._cardFrameSlots].map(([id, slot]) => ({
        id,
        stamp: slot.stamp,
      })),
      keepFrames,
    );
    for (const id of drops) layerState._cardFrameSlots.delete(id);

    pushAmbientCardEntries();
  }

  /**
   * Builds and publishes the card entry list from the current kept set and the
   * hover-summoned pin. The hover entry is budget-exempt and high-priority. The
   * active camera is absent by default; `activeCameraCardEnabled` retains the
   * migrated protected-publication path as an explicit product option. If the
   * LOD selection adopts the hovered camera it remains a normal budgeted entry
   * that keeps the pin while the gesture lasts.
   */

  function pushAmbientCardEntries() {
    const entries = [];
    let rank = 0;
    const push = (id, { pinned = false, active = false } = {}) => {
      const record = layerState._recordById.get(id);
      if (!record?.position) return;
      entries.push(
        createCctvThumbnailOverlayEntry({
          id,
          position: record.position,
          gapPx: CARD_GAP_PX,
          title: record.camera.name,
          frameSlot: ensureCardFrameSlot(id),
          rank: rank++,
          pinned,
          active,
        }),
      );
    };
    for (const id of layerState._cardIds)
      push(id, { pinned: id === layerState._hoverCardId });
    if (
      layerState._hoverCardId &&
      !layerState._cardIds.has(layerState._hoverCardId) &&
      layerState._hoverCardId !== layerState._activeCameraId
    ) {
      push(layerState._hoverCardId, { pinned: true });
    }
    if (layerState._activeCameraCardEnabled && layerState._activeCameraId) {
      push(layerState._activeCameraId, { active: true });
    }
    layerState._cctvOverlayHost.setEntries(
      CCTV_OVERLAY_SOURCE_ID,
      entries,
      CCTV_OVERLAY_SOURCE_OPTIONS,
    );
  }

  /**
   * Fetches one paced static frame and settles it into the stable slot via the
   * pure persistence rule (applyFrameResult): success replaces the thumbnail,
   * failure leaves the drawn frame untouched. The frame is downscaled once
   * into a 2x-thumb offscreen canvas; the renderer reads the slot live.
   * @param {Object} record - Camera record.
   * @param {Object} slot - The camera's stable frame slot.
   * @param {number} refreshMs - Source cadence (also keys the frame-URL tick).
   * @param {Object} [options]
   * @param {boolean} [options.userGesture] - Hover fast-track (item B): the
   *   launch bypasses the pacer gate, so its spacing sample would pollute the
   *   pacing telemetry — skip the min-spacing sample only. The launch still
   *   stamps `_cardLastFetchAt`, so the pacer waits a full interval after it.
   */

  function fetchCardFrame(
    record,
    slot,
    refreshMs,
    { userGesture = false } = {},
  ) {
    if (typeof document !== 'undefined' && document.hidden && !userGesture)
      return;
    const now = Date.now();
    const cameraId = record.camera.id;
    layerState._cardFetchInFlightCount += 1;
    layerState._cardFetchPendingIds.add(cameraId);
    if (layerState._cardLastFetchAt > 0 && !userGesture) {
      const spacing = now - layerState._cardLastFetchAt;
      // NOTE: cold-fill bursts legitimately push this to ~250 ms — read it
      // together with the ambientCards.fetchMode telemetry.
      layerState._cardMinFetchSpacingMs =
        layerState._cardMinFetchSpacingMs == null
          ? spacing
          : Math.min(layerState._cardMinFetchSpacingMs, spacing);
    }
    layerState._cardLastFetchAt = now;
    layerState._cardFetchCount += 1;

    const image = new Image();
    layerState._cardFetchImages.add(image);
    const settle = (ok) => {
      image.onload = null;
      image.onerror = null;
      if (layerState._cardFetchImages.delete(image)) {
        layerState._cardFetchInFlightCount = Math.max(
          0,
          layerState._cardFetchInFlightCount - 1,
        );
        layerState._cardFetchPendingIds.delete(cameraId);
      }
      let frame = null;
      if (ok) {
        try {
          const canvas = document.createElement('canvas');
          canvas.width = CCTV_FRAME_CANVAS_W;
          canvas.height = CCTV_FRAME_CANVAS_H;
          canvas
            .getContext('2d')
            .drawImage(image, 0, 0, canvas.width, canvas.height);
          frame = canvas;
        } catch {
          frame = null;
        }
      }
      Object.assign(
        slot,
        applyFrameResult(slot, { ok: !!frame, frame }, Date.now()),
      );
      layerState._viewer?.scene?.requestRender?.();
    };
    image.onload = () => settle(true);
    image.onerror = () => settle(false);
    image.src = parts.frames.frameUrlFor(record.camera, refreshMs);
  }

  /** Starts the card-frame pacer (idempotent; policy-gated per tick). */

  function startCardFrameLoop() {
    if (layerState._cardFetchTimer) return;
    layerState._cardFetchTimer = setInterval(
      parts.model.cardFrameTick,
      CARD_FETCH_TICK_MS,
    );
  }

  /** Stops the pacer and detaches all in-flight fetch handlers. */

  function stopCardFrameLoop() {
    if (layerState._cardFetchTimer) {
      clearInterval(layerState._cardFetchTimer);
      layerState._cardFetchTimer = 0;
    }
    for (const image of layerState._cardFetchImages) {
      image.onload = null;
      image.onerror = null;
      image.removeAttribute('src');
    }
    layerState._cardFetchImages.clear();
    layerState._cardFetchPendingIds.clear();
    layerState._cardFetchInFlightCount = 0;
    layerState._cardFetchMode = 'steady';
  }

  /**
   * Complete ambient-tier teardown (layer disable/destroy): pacer + in-flight
   * handlers, shared-host source entries, card set, grace state, thumbnail
   * cache, and fetch telemetry. Nothing leaks across a toggle.
   */

  function teardownAmbientCards() {
    stopCardFrameLoop();
    layerState._cctvOverlayHost.clearSource(CCTV_OVERLAY_SOURCE_ID);
    layerState._cctvOverlayHost.setVisible(CCTV_OVERLAY_SOURCE_ID, false);
    parts.hover.clearHoverCard();
    layerState._cameraMoving = false;
    layerState._cardIds = new Set();
    layerState._cardGraceState = new Map();
    layerState._cardFrameSlots = new Map();
    layerState._cardFetchCount = 0;
    layerState._cardLastFetchAt = 0;
    layerState._cardMinFetchSpacingMs = null;
  }
  function handleVisibilityChange() {
    if (!document.hidden) return;
    for (const image of layerState._cardFetchImages) {
      image.onload = null;
      image.onerror = null;
      image.removeAttribute('src');
    }
    layerState._cardFetchImages.clear();
    layerState._cardFetchPendingIds.clear();
    layerState._cardFetchInFlightCount = 0;
  }
  return {
    handleVisibilityChange,
    setCctvCardPresentationOptions,
    ensureCardFrameSlot,
    refreshAmbientCards,
    pushAmbientCardEntries,
    fetchCardFrame,
    startCardFrameLoop,
    stopCardFrameLoop,
    teardownAmbientCards,
  };
}
