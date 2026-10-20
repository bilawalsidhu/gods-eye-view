import * as Cesium from 'cesium';

/** Amber ring hue marking an aircraft that WAS tracked and remains selected
 *  after the follow-camera moved to a newer contact (multi-track highlight).
 *  Distinct from the cyan tracked target and the white fleet billboards. */
export const SELECTION_HIGHLIGHT_COLOR =
  Cesium.Color.fromCssColorString('#FFB800');

const HIGHLIGHT_ID_PREFIX = 'gev-track-highlight:';

/** True when a pick id is one of `namespace`'s selection rings. Layers include
 *  this in their pick-owner predicate so sibling click handlers do not read a
 *  click on a ring as empty space. */
export function isSelectionHighlightId(pickedId, namespace) {
  return (
    typeof pickedId === 'string' &&
    pickedId.startsWith(`${HIGHLIGHT_ID_PREFIX}${namespace}:`)
  );
}

/**
 * Persistent, camera-independent selection highlights for a tracking layer.
 *
 * The follow-camera is single-slot, so only one aircraft gets the cyan tracked
 * entity. This keeps every OTHER aircraft the operator tracked visibly marked
 * (an outline ring that follows the fleet billboard's live position) so
 * "tracking both at the same time" surfaces as: one followed plane + a stable
 * highlighted ring on the previously-tracked ones. Rings are cheap Cesium
 * entities — no trail, model, readout or camera involvement — and read the
 * fleet billboard position directly (no dead-reckon cache mutation, so the
 * single-slot tracked DR contract is untouched).
 *
 * Callers:
 *  - `add(icao24)` before a tracked flight is superseded, to keep it visible;
 *  - `remove(icao24)` when that flight is followed again or evicted from feed;
 *  - `clear()` on a full deselect or layer teardown.
 */
export function createSelectionHighlights(flightState, namespace = 'flights') {
  const highlights = new Map();

  function add(icao24) {
    if (!icao24 || !flightState._viewer || highlights.has(icao24)) return false;
    const bb = flightState._billboards?.get(icao24);
    if (!bb || !bb.position) return false;
    const fallback = Cesium.Cartesian3.clone(bb.position);
    const entity = flightState._viewer.entities.add({
      id: `${HIGHLIGHT_ID_PREFIX}${namespace}:${icao24}`,
      position: new Cesium.CallbackProperty(
        () => flightState._billboards?.get(icao24)?.position || fallback,
        false,
      ),
      point: {
        pixelSize: 26,
        color: Cesium.Color.TRANSPARENT,
        outlineColor: SELECTION_HIGHLIGHT_COLOR,
        outlineWidth: 3,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    });
    entity.gevSelectionHighlight = { namespace, id: icao24 };
    highlights.set(icao24, entity);
    return true;
  }

  function remove(icao24) {
    const entity = highlights.get(icao24);
    if (!entity) return false;
    highlights.delete(icao24);
    if (flightState._viewer && !flightState._viewer.isDestroyed()) {
      try {
        flightState._viewer.entities.remove(entity);
      } catch {
        /* already gone */
      }
    }
    return true;
  }

  function clear() {
    for (const icao24 of [...highlights.keys()]) remove(icao24);
  }

  return {
    add,
    remove,
    clear,
    has: (icao24) => highlights.has(icao24),
    hasAny: () => highlights.size > 0,
  };
}
