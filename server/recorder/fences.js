const MAX_STATES = 200000;

/** Whether a position lies in a fence box. The box may cross the antimeridian. */
export function insideFence(fence, p) {
  if (p.lat < fence.south || p.lat > fence.north) return false;
  return fence.west <= fence.east
    ? p.lon >= fence.west && p.lon <= fence.east
    : p.lon >= fence.west || p.lon <= fence.east;
}

/** Check a fence definition from a request; returns the clean fence or throws. */
export function cleanFence(input) {
  const num = (v, lo, hi, name) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < lo || n > hi)
      throw new TypeError(`${name} must be between ${lo} and ${hi}`);
    return n;
  };
  const name = String(input?.name ?? '')
    .trim()
    .slice(0, 64);
  if (!name) throw new TypeError('name is required');
  const fence = {
    name,
    west: num(input.west, -180, 180, 'west'),
    south: num(input.south, -90, 90, 'south'),
    east: num(input.east, -180, 180, 'east'),
    north: num(input.north, -90, 90, 'north'),
    layers: Array.isArray(input.layers) ? input.layers.map(String) : [],
  };
  if (fence.south > fence.north)
    throw new TypeError('south must not be above north');
  return fence;
}

/**
 * Turns a stream of positions into enter and exit events. A contact is only
 * counted from positions newer than the fence itself, so making a fence over
 * live traffic does not report everything already inside.
 */
export function createFenceTracker() {
  let fences = [];
  /** @type {Set<string>} */
  const inside = new Set();
  return {
    setFences(next) {
      fences = next;
      const live = new Set(next.map((f) => `${f.id}|`));
      for (const key of inside)
        if (!live.has(key.slice(0, key.indexOf('|') + 1))) inside.delete(key);
    },
    check(p) {
      const events = [];
      for (const fence of fences) {
        if (p.ts < fence.created_ts) continue;
        if (fence.layers.length && !fence.layers.includes(p.layer)) continue;
        const key = `${fence.id}|${p.layer}:${p.id}`;
        const now = insideFence(fence, p);
        const was = inside.has(key);
        if (now === was) continue;
        if (now) inside.add(key);
        else inside.delete(key);
        events.push({
          ts: p.ts,
          fence_id: fence.id,
          id: p.id,
          layer: p.layer,
          kind: now ? 'enter' : 'exit',
          lat: p.lat,
          lon: p.lon,
        });
      }
      if (inside.size > MAX_STATES) inside.delete(inside.values().next().value);
      return events;
    },
  };
}
