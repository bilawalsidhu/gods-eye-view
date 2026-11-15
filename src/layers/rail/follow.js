import * as Cesium from 'cesium';
import {
  FOLLOW_HANDOVER_MS,
  railFollowOffset,
  railTrainFollowable,
} from './policy.js';

/** The selected train's kind in the shared world-focus framing. */
export const RAIL_FOCUS_KIND = 'train';

/**
 * The selected train's camera.
 *
 * A moving train is followed as a tracked aircraft or satellite is: the layer
 * gives Cesium's `viewer.trackedEntity` an entity that stands on the train's
 * marker, framed by the shared world-focus framing for a train, so the camera
 * rides with the train and the user still orbits and zooms around it. Any
 * other train gets one fly-to through the shared world-focus request, as a
 * vessel does. Inside the Cockpit that request is refused with its toast.
 *
 * The follow lets go when the train is deselected (an empty click, Escape, its
 * category hidden, the train leaving its feed, the layer turned off), when
 * another train is selected (which takes the camera in its turn), and when
 * another owner takes the camera: an aircraft or satellite tracked by another
 * layer clears the selection as well, while a navigation that only releases
 * the follow camera (a search, a fly-to) leaves the train selected. Letting
 * go leaves the camera where it is.
 *
 * When the selection moves to another feed's copy of the same train
 * (dedupe.js), the tracked entity stays and glides to the new copy.
 *
 * Services (all optional; without them a selection has no camera):
 *   services.camera = {
 *     framing: {rangeM, pitchDeg},          // WORLD_FOCUS_FRAMING.train
 *     requestWorldFocus(detail) → boolean,  // src/worldFocus.js
 *     applyTrackedCameraFrame(viewer, entity, viewFrom) → stop,
 *     isCockpitActive() → boolean,
 *   }
 *
 * @param {object} context
 * @returns {object}
 */
export function createFollow({ state, services, parts }) {
  const camera = services.camera ?? null;
  let removeTrackedListener = null;

  function markerPosition(entry) {
    const p = entry?.marker?.position;
    return p &&
      Number.isFinite(p.x) &&
      Number.isFinite(p.y) &&
      Number.isFinite(p.z) &&
      Cesium.Cartesian3.magnitudeSquared(p) > 0
      ? p
      : null;
  }

  /**
   * Where the tracked entity stands: on the selected train's marker, or
   * gliding to it after a handover. Never hands out the marker's own vector.
   */
  function followedPosition(follow, result) {
    const live = markerPosition(state._trains.get(state._selectedKey));
    if (live) Cesium.Cartesian3.clone(live, follow.last);
    const out = result ?? new Cesium.Cartesian3();
    const blend = follow.blend;
    if (blend) {
      const t = (performance.now() - blend.startMs) / FOLLOW_HANDOVER_MS;
      if (t < 1) {
        const eased = t <= 0 ? 0 : t * t * (3 - 2 * t);
        Cesium.Cartesian3.lerp(blend.from, follow.last, eased, out);
        return Cesium.Cartesian3.clone(out, follow.shown);
      }
      follow.blend = null;
    }
    Cesium.Cartesian3.clone(follow.last, out);
    Cesium.Cartesian3.clone(out, follow.shown);
    return out;
  }

  /** Whether the camera follows this train now. */
  function isFollowing(key) {
    const follow = state._follow;
    return Boolean(
      follow &&
      follow.key === key &&
      state._viewer?.trackedEntity === follow.entity,
    );
  }

  /**
   * Let go of the train. The camera stays where the follow left it.
   * @param {{untrack?: boolean}} [options] `untrack: false` when another
   *   owner already took the camera: its tracked entity is left alone.
   */
  function release({ untrack = true } = {}) {
    const follow = state._follow;
    if (!follow) return;
    // Cleared first: the tracked-entity change below is this layer's own.
    state._follow = null;
    follow.stopFrame?.();
    const viewer = state._viewer;
    if (!viewer || viewer.isDestroyed?.()) return;
    if (untrack && viewer.trackedEntity === follow.entity)
      viewer.trackedEntity = undefined;
    viewer.entities.remove(follow.entity);
  }

  function startFollow(entry, position) {
    const viewer = state._viewer;
    const offset = railFollowOffset(camera.framing, viewer.camera?.heading);
    const follow = {
      key: entry.key,
      entity: null,
      last: Cesium.Cartesian3.clone(position),
      shown: Cesium.Cartesian3.clone(position),
      blend: null,
      stopFrame: null,
    };
    // Cesium's tracking camera engages only on an entity it can bound, so the
    // entity has a point: a transparent one, never drawn or picked, leaving
    // the marker the train's only visual.
    const entity = viewer.entities.add({
      position: new Cesium.CallbackProperty(
        (time, result) => followedPosition(follow, result),
        false,
      ),
      // The frame the close-range guard (applyTrackedCameraFrame) uses too.
      trackingReferenceFrame: Cesium.TrackingReferenceFrame.ENU,
      viewFrom: new Cesium.Cartesian3(offset.x, offset.y, offset.z),
      point: { pixelSize: 1, color: Cesium.Color.TRANSPARENT },
    });
    entity.gevSelectionOrigin = 'user';
    follow.entity = entity;
    state._follow = follow;
    // A flight in progress would keep Cesium from applying the frame.
    viewer.camera?.cancelFlight?.();
    viewer.trackedEntity = entity;
    follow.stopFrame =
      camera.applyTrackedCameraFrame?.(viewer, entity, entity.viewFrom) || null;
    return true;
  }

  /**
   * Give the camera to a train the user selected: follow it when it moves,
   * else fly to it once. A train already followed keeps its follow.
   * @param {object} entry
   * @returns {boolean} Whether the camera was taken or kept.
   */
  function focus(entry) {
    if (!camera || !entry) return false;
    if (isFollowing(entry.key)) return true;
    release();
    const viewer = state._viewer;
    const position = markerPosition(entry);
    if (!viewer || !position) return false;
    if (
      camera.framing &&
      !camera.isCockpitActive?.() &&
      railTrainFollowable(entry)
    )
      return startFollow(entry, position);
    const label = String(entry.record?.label || entry.record?.id || '').trim();
    return (
      camera.requestWorldFocus?.({
        kind: RAIL_FOCUS_KIND,
        id: entry.key,
        label: label || entry.key,
        position: Cesium.Cartesian3.clone(position),
      }) === true
    );
  }

  /**
   * The selection moved to another feed's copy of the followed train: the
   * tracked entity stays, and glides from where it stands to the new copy.
   * @param {object} entry The copy now selected.
   */
  function handover(entry) {
    const follow = state._follow;
    if (!follow || !entry || follow.key === entry.key) return;
    follow.key = entry.key;
    follow.blend = {
      from: Cesium.Cartesian3.clone(follow.shown),
      startMs: performance.now(),
    };
  }

  function onTrackedEntityChanged() {
    const follow = state._follow;
    const tracked = state._viewer?.trackedEntity;
    if (!follow || tracked === follow.entity) return;
    // An aircraft or satellite another layer tracks takes the scene, as it
    // does from a selected vessel. A navigation that only releases the follow
    // camera keeps the train selected.
    if (tracked) parts.selection.clearSelection({ untrack: false });
    else release({ untrack: false });
  }

  /** Watch for other camera owners while the layer is on. */
  function install(viewer) {
    if (removeTrackedListener || !viewer?.trackedEntityChanged) return;
    removeTrackedListener = viewer.trackedEntityChanged.addEventListener(
      onTrackedEntityChanged,
    );
  }

  function uninstall() {
    removeTrackedListener?.();
    removeTrackedListener = null;
  }

  /** For QA probes: which train the camera follows, if any. */
  function stats() {
    const follow = state._follow;
    return follow
      ? { key: follow.key, tracked: isFollowing(follow.key) }
      : null;
  }

  return {
    focus,
    release,
    handover,
    isFollowing,
    install,
    uninstall,
    stats,
  };
}
