import { findCamera } from '../../render/rendererOf.js';
import {
  FOLLOW_MIN_RANGE_M,
  followViewFrom,
  SELECTION_FOLLOW_TRANSITION_S,
} from '../../data/trackedCamera.js';
import { copyInto, lerpInto } from '../../geo/vector.js';
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
 * A moving train is followed as a tracked aircraft is: the layer hands the
 * camera port a follow target that stands on the train's marker, seen from
 * where the camera is (its distance and angle kept, the train sliding to
 * the centre) and never closer than the aircraft's readable minimum, so the
 * camera rides with the train and the user still orbits and zooms around it.
 * Any other train gets one fly-to through the shared world-focus request,
 * keeping the view as a vessel's does. Inside the Cockpit that request is
 * refused with its toast. Without a view to keep (no camera pose), the
 * shared world-focus framing for a train frames it.
 *
 * The follow lets go when the train is deselected (an empty click, Escape, its
 * category hidden, the train leaving its feed, the layer turned off), when
 * another train is selected (which takes the camera in its turn), and when
 * another owner takes the camera: anything else the camera follows (an
 * aircraft or satellite tracked by another layer) clears the selection as
 * well, while a navigation that only stops the follow (a search, a fly-to)
 * leaves the train selected. Letting go leaves the camera where it is.
 *
 * When the selection moves to another feed's copy of the same train
 * (dedupe.js), the follow target stays and glides to the new copy.
 *
 * Services (all optional; without them a selection has no camera):
 *   services.camera = {
 *     framing: {rangeM, pitchDeg},          // WORLD_FOCUS_FRAMING.train
 *     requestWorldFocus(detail) → boolean,  // src/worldFocus.js
 *     isCockpitActive() → boolean,
 *   }
 *
 * @param {object} context
 * @returns {object}
 */
export function createFollow({ state, services, parts }) {
  const camera = services.camera ?? null;
  let removeFollowListener = null;

  function markerPosition(entry) {
    const p = entry?.marker?.position;
    return p &&
      Number.isFinite(p.x) &&
      Number.isFinite(p.y) &&
      Number.isFinite(p.z) &&
      p.x * p.x + p.y * p.y + p.z * p.z > 0
      ? p
      : null;
  }

  /**
   * Where the follow target stands: on the selected train's marker, or
   * gliding to it after a handover. A new object each call, never the
   * marker's own vector.
   */
  function followedPosition(follow) {
    const live = markerPosition(state._trains.get(state._selectedKey));
    if (live) copyInto(live, follow.last);
    const blend = follow.blend;
    if (blend) {
      const t = (performance.now() - blend.startMs) / FOLLOW_HANDOVER_MS;
      if (t < 1) {
        const eased = t <= 0 ? 0 : t * t * (3 - 2 * t);
        lerpInto(blend.from, follow.last, eased, follow.shown);
        return { ...follow.shown };
      }
      follow.blend = null;
    }
    copyInto(follow.last, follow.shown);
    return { ...follow.shown };
  }

  /** Whether the camera follows this train now. */
  function isFollowing(key) {
    const follow = state._follow;
    return Boolean(
      follow &&
      follow.key === key &&
      findCamera(state._viewer)?.followed === follow.target,
    );
  }

  /**
   * Let go of the train. The camera stays where the follow left it.
   * @param {{untrack?: boolean}} [options] `untrack: false` when another
   *   owner already took the camera: what it follows is left alone.
   */
  function release({ untrack = true } = {}) {
    const follow = state._follow;
    if (!follow) return;
    // Cleared first: the follow change below is this layer's own.
    state._follow = null;
    const viewer = state._viewer;
    if (!untrack || !viewer || viewer.isDestroyed?.()) return;
    const port = findCamera(viewer);
    if (port?.followed === follow.target) port.follow(null);
  }

  function startFollow(entry, position, port) {
    const offset =
      followViewFrom(port.pose(), position) ??
      railFollowOffset(camera.framing, port.pose()?.heading);
    const follow = {
      key: entry.key,
      target: null,
      last: { x: position.x, y: position.y, z: position.z },
      shown: { x: position.x, y: position.y, z: position.z },
      blend: null,
    };
    follow.target = {
      key: `rail:${entry.key}`,
      position: () => followedPosition(follow),
      frame: 'enu',
      viewFrom: { x: offset.x, y: offset.y, z: offset.z },
      // Framed once, as a tracked aircraft is, and never closer.
      minRange: FOLLOW_MIN_RANGE_M,
      transitionS: SELECTION_FOLLOW_TRANSITION_S,
      selectionOrigin: 'user',
    };
    state._follow = follow;
    // A flight in progress would keep the camera from taking the frame.
    port.cancelFlight();
    port.follow(follow.target);
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
    const port = findCamera(viewer);
    if (
      port &&
      camera.framing &&
      !camera.isCockpitActive?.() &&
      railTrainFollowable(entry)
    )
      return startFollow(entry, position, port);
    const label = String(entry.record?.label || entry.record?.id || '').trim();
    return (
      camera.requestWorldFocus?.({
        kind: RAIL_FOCUS_KIND,
        id: entry.key,
        label: label || entry.key,
        position: { x: position.x, y: position.y, z: position.z },
        keepView: true,
      }) === true
    );
  }

  /**
   * The selection moved to another feed's copy of the followed train: the
   * follow target stays, and glides from where it stands to the new copy.
   * @param {object} entry The copy now selected.
   */
  function handover(entry) {
    const follow = state._follow;
    if (!follow || !entry || follow.key === entry.key) return;
    follow.key = entry.key;
    follow.blend = {
      from: { ...follow.shown },
      startMs: performance.now(),
    };
  }

  function onFollowChanged() {
    const follow = state._follow;
    const followed = findCamera(state._viewer)?.followed ?? null;
    if (!follow || followed === follow.target) return;
    // An aircraft or satellite another layer tracks takes the scene, as it
    // does from a selected vessel. A navigation that only stops the follow
    // keeps the train selected.
    if (followed) parts.selection.clearSelection({ untrack: false });
    else release({ untrack: false });
  }

  /** Watch for other camera owners while the layer is on. */
  function install(viewer) {
    if (removeFollowListener) return;
    removeFollowListener =
      findCamera(viewer)?.on('followChanged', onFollowChanged) ?? null;
  }

  function uninstall() {
    removeFollowListener?.();
    removeFollowListener = null;
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
