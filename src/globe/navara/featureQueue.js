// Logic over a Navara view internal that internals.js reads (the queued
// feature changes), kept apart so Node tests can load it without the SDK.

/**
 * Drop the queued feature changes of vector layers that no longer exist, and
 * return how many went. Navara processes a change only for a feature it
 * knows, and keeps any other in its queue for good: a change that arrives
 * after its layer was deleted (a polygon display replacing its layers while
 * their tiles are still being cut) leaves the queue non-empty, so the view
 * never goes idle and tilesLoaded() stays false.
 * @param {{ events: object[], remove: (index: number) => void } | null} queue
 *   The queued changes (internals.js featureChangeQueue).
 * @param {(layerId: string) => boolean} layerExists
 */
export function dropOrphanFeatureChanges(queue, layerExists) {
  if (!queue?.events.length) return 0;
  let dropped = 0;
  for (let index = queue.events.length - 1; index >= 0; index--) {
    const event = queue.events[index];
    const layerId = event?.layer_id;
    if (layerId == null || layerExists(String(layerId))) continue;
    queue.remove(index);
    event.free?.();
    dropped++;
  }
  return dropped;
}
