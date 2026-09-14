import {
  CCTV_CARD_FETCH_BURST_LIMIT,
  frameFetchDue,
} from '../../data/cctvCards.js';
import { staticFrameRefreshMs } from '../../data/cctvLod.js';
import { HOVER_PICK_THROTTLE_MS, HOVER_RELEASE_MS } from './policy.js';

export function createHover({ state: layerState, services, parts, source }) {
  /**
   * Throttled MOUSE_MOVE hover pass (owner round 2, item B): pointing at a
   * camera icon that has no card summons its card immediately. This is
   * EVENT-DRIVEN picking on a user gesture, not steady-state work — the
   * ≥120 ms throttle caps it at ~8 scene.pick calls/s while the pointer is
   * actually moving (a still pointer costs nothing), so it can never approach
   * per-frame cost. Skipped while the camera is in motion, while ADJUST mode
   * owns the pointer (gizmo drags), and while the layer is disabled.
   * @param {Cesium.Cartesian2} position - Pointer position (CSS px).
   */

  function handleHoverMove(position) {
    if (
      !layerState._enabled ||
      layerState._cameraMoving ||
      layerState._calibrationMode ||
      !position
    )
      return;
    if (!layerState._viewer || layerState._viewer.isDestroyed()) return;
    const now = Date.now();
    if (now - layerState._hoverLastPickAt < HOVER_PICK_THROTTLE_MS) return;
    layerState._hoverLastPickAt = now;
    let picked = null;
    try {
      picked = layerState._viewer.scene.pick(position);
    } catch {
      picked = null;
    }
    const cameraId = parts.selection.extractPickedCameraId(picked);
    if (cameraId && cameraId === layerState._hoverCardId) {
      // Still on the hovered camera — keep the card alive.
      cancelHoverRelease();
      return;
    }
    const record = cameraId ? layerState._recordById.get(cameraId) : null;
    // Hovering the active camera or a camera that already has a card is a
    // no-op; video feeds stay icon-only until activated (ambient tier is
    // stills-only — same rule as the LOD selection).
    const eligible =
      !!record &&
      cameraId !== layerState._activeCameraId &&
      !layerState._cardIds.has(cameraId) &&
      !parts.model.isVideoFeedType(
        parts.model.normalizeFeedType(record.camera.feedType),
      );
    if (eligible) {
      cancelHoverRelease();
      layerState._hoverCardId = cameraId;
      // Immediacy: the pinned entry publishes now — chrome may paint before
      // the first frame arrives (documented exception in cctvCards.js).
      parts.cards.pushAmbientCardEntries();
      hoverFetchCardFrame(record);
    } else if (layerState._hoverCardId) {
      // Pointer left the hovered icon: linger ~1 s, then release.
      scheduleHoverRelease();
    }
  }

  /** Cancels a pending hover-card release. */

  function cancelHoverRelease() {
    if (layerState._hoverReleaseTimer) {
      clearTimeout(layerState._hoverReleaseTimer);
      layerState._hoverReleaseTimer = 0;
    }
  }

  /**
   * Schedules the hover card's release ~1 s after unhover. On release the pin
   * drops; the card stays only if the LOD selection has adopted the camera
   * (it is then a normal budgeted entry in `_cardIds`).
   */

  function scheduleHoverRelease() {
    if (layerState._hoverReleaseTimer) return;
    layerState._hoverReleaseTimer = setTimeout(() => {
      layerState._hoverReleaseTimer = 0;
      layerState._hoverCardId = null;
      parts.cards.pushAmbientCardEntries();
    }, HOVER_RELEASE_MS);
  }

  /** Clears the hover-card state (teardown / activation of the hovered camera). */

  function clearHoverCard() {
    cancelHoverRelease();
    layerState._hoverCardId = null;
    layerState._hoverLastPickAt = 0;
  }

  /**
   * Fast-tracked frame fetch for the hover-summoned card: launches
   * immediately, bypassing the pacer's launch-spacing gate (a single
   * user-gesture fetch is fine even during the geometry drain), but still
   * respecting the per-camera failure backoff / freshness check
   * (frameFetchDue), the no-double-fetch pending set, and the burst in-flight
   * cap of 4.
   * @param {Object} record - The hovered camera's record.
   */

  function hoverFetchCardFrame(record) {
    const cameraId = record.camera.id;
    if (layerState._cardFetchPendingIds.has(cameraId)) return;
    if (layerState._cardFetchInFlightCount >= CCTV_CARD_FETCH_BURST_LIMIT)
      return;
    const slot = parts.cards.ensureCardFrameSlot(cameraId);
    const refreshMs = staticFrameRefreshMs(record.camera);
    if (!frameFetchDue(slot, refreshMs, Date.now())) return;
    parts.cards.fetchCardFrame(record, slot, refreshMs, { userGesture: true });
  }
  return {
    handleHoverMove,
    cancelHoverRelease,
    scheduleHoverRelease,
    clearHoverCard,
    hoverFetchCardFrame,
  };
}
