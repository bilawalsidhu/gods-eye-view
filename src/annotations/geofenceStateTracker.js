/**
 * In-memory state tracker for geofence enter/exit.
 * Prevents duplicate alerts: internal `enter` event fires only on
 * initial outside->inside transition.
 *
 * Pure, no DOM, no Cesium — node-testable.
 */

export function createGeofenceStateTracker() {
  // id -> boolean (true = inside, false = outside)
  const states = new Map();

  const normalizeId = (id) => String(id);

  function update(id, isInside) {
    const key = normalizeId(id);
    const prev = states.get(key);
    const next = Boolean(isInside);

    // First sighting: treat unknown as outside, so unknown->inside = entered
    if (prev === undefined) {
      states.set(key, next);
      return next ? 'entered' : null;
    }
    if (prev === next) return null; // no transition -> no duplicate
    states.set(key, next);
    return next ? 'entered' : 'exited';
  }

  function get(id) {
    const v = states.get(normalizeId(id));
    return v === undefined ? null : v;
  }

  function isInside(id) {
    return states.get(normalizeId(id)) === true;
  }

  function remove(id) {
    return states.delete(normalizeId(id));
  }

  function clear() {
    states.clear();
  }

  function getInsideIds() {
    const out = [];
    for (const [k, v] of states) if (v) out.push(k);
    return out;
  }

  function getAll() {
    return new Map(states);
  }

  return {
    update,
    get,
    isInside,
    remove,
    clear,
    getInsideIds,
    getAll,
    get size() {
      return states.size;
    },
  };
}
