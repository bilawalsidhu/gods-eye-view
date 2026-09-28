const MAX_KEYS = 2000;

/**
 * A per-client and global budget of units per sliding window: the shape of
 * `makeRateLimiter` in `src/sources/rateLimit.js`, but each admission is
 * charged `units` instead of one request, so a cap bounds spend rather than
 * request count.
 *
 * @param {object} options
 * @param {number} options.windowMs - Sliding window length.
 * @param {number} options.max - Units one key may spend per window.
 * @param {number} options.globalMax - Units all keys together may spend.
 * @param {() => number} [options.now]
 * @returns {(key: string, units: number) => boolean} Charges `units` to
 *   `key` and returns true, or charges nothing and returns false when either
 *   budget would be exceeded. Zero units are always admitted.
 */
export function makeUnitLimiter({
  windowMs,
  max,
  globalMax,
  now = () => Date.now(),
}) {
  const spent = new Map(); // key -> [{at, units}] within the window
  let all = [];
  const total = (entries) => entries.reduce((sum, { units }) => sum + units, 0);
  return function charge(key, units) {
    if (!(units > 0)) return true;
    const at = now();
    all = all.filter((entry) => at - entry.at < windowMs);
    const recent = (spent.get(key) || []).filter(
      (entry) => at - entry.at < windowMs,
    );
    spent.delete(key);
    if (total(all) + units > globalMax || total(recent) + units > max) {
      if (recent.length) spent.set(key, recent);
      return false;
    }
    const entry = { at, units };
    recent.push(entry);
    all.push(entry);
    spent.set(key, recent);
    // Oldest-first key cap, so a key-rotating caller cannot grow the map.
    while (spent.size > MAX_KEYS) spent.delete(spent.keys().next().value);
    return true;
  };
}
