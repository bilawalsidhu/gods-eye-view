/** Read C-ITS state through the server-side OpenTrafficMap relay. */
export function createCitsSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  async function read(route, bounds, signal, mode) {
    signal?.throwIfAborted();
    const params = new URLSearchParams({
      west: bounds.west.toFixed(5),
      south: bounds.south.toFixed(5),
      east: bounds.east.toFixed(5),
      north: bounds.north.toFixed(5),
    });
    if (mode === 'full') params.set('mode', 'full');
    const response = await fetchImpl(`/api/cits/${route}?${params}`, {
      headers: { Accept: 'application/json' },
      signal,
    });
    if (!response.ok) throw new Error(`C-ITS relay HTTP ${response.status}`);
    const payload = await response.json();
    signal?.throwIfAborted();
    if (!payload || typeof payload !== 'object')
      throw new Error('Malformed C-ITS payload');
    return payload;
  }
  return {
    /** Live stations, hazards and tracks inside `bounds`. */
    getState: (bounds, { signal, mode } = {}) =>
      read('state', bounds, signal, mode),
    /** MAPEM intersection lane geometry inside `bounds`. */
    getIntersections: (bounds, { signal, mode } = {}) =>
      read('intersections', bounds, signal, mode),
  };
}
