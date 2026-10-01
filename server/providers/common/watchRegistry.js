/**
 * Process-wide set of assets that any user is watching. The alert engine
 * keeps it current; the history recorder reads it to decide which fixes
 * get long retention. Keys are `${domain}:${id}` with lowercase ids.
 */

let watched = new Set();
/** @type {Set<(added: string[]) => void>} */
const listeners = new Set();

export const watchKey = (domain, id) => `${domain}:${String(id).toLowerCase()}`;

export function isWatched(domain, id) {
  return watched.has(watchKey(domain, id));
}

/** Replace the watched set; listeners hear about newly added keys. */
export function setWatched(keys) {
  const next = new Set(keys);
  const added = [...next].filter((k) => !watched.has(k));
  watched = next;
  if (added.length)
    for (const fn of listeners) {
      try {
        fn(added);
      } catch (error) {
        console.error('[watch-registry]', error?.message);
      }
    }
}

export function watchedKeys() {
  return [...watched];
}

export function onWatchAdded(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
