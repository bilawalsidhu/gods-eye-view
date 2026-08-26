/**
 * Shared pick-ownership registry for layers that install their own
 * ScreenSpaceEventHandler click handlers.
 *
 * Problem solved: each entity layer (commercial flights, military flights)
 * receives every LEFT_CLICK. When the user clicks a military aircraft while
 * a commercial flight is tracked, the commercial handler used to classify
 * the pick as "empty space" and clear tracking (with a camera flight) at the
 * same moment the military handler started tracking — two competing camera
 * commands. Layers now register a predicate so siblings can recognize picks
 * that belong to someone else and leave them alone.
 */

/** @type Map<layerId, ownership predicate> */
const _owners = new Map<string, (pickedId: string) => boolean>();

/**
 * Resolves a scene.pick() result to a String pick id for the ownership scan.
 *
 * Layers use heterogeneous pick ids: flights/military/bikeshare/CCTV use
 * strings, satellites use numeric NORAD catalog ids, live AIS vessels attach
 * the vessel record OBJECT (identity = its `mmsi`), and entity picks surface
 * the Cesium Entity (identity = its string `id`). Everything is coerced to a
 * String so predicates match against one canonical form.
 *
 * @param picked - Result of `scene.pick()`.
 * @returns Canonical pick id, or null when the pick carries none.
 */
export function resolvePickId(
  picked: { id?: unknown; primitive?: { id?: unknown } } | null | undefined,
): string | null {
  if (!picked) return null;
  const unwrap = (id: unknown): string | number | undefined => {
    if (id === null || id === undefined) return undefined;
    if (typeof id === 'object') {
      // AIS vessel record (id object with .mmsi) or Cesium Entity (.id string)
      const idObj = id as { mmsi?: string | number; id?: string | number };
      if (typeof idObj.mmsi === 'string' || typeof idObj.mmsi === 'number') return idObj.mmsi;
      if (typeof idObj.id === 'string' || typeof idObj.id === 'number') return idObj.id;
      return undefined;
    }
    return id as string | number;
  };
  let id: string | number | undefined = unwrap(picked.id);
  if (id === undefined) id = unwrap(picked.primitive?.id);
  return (typeof id === 'string' || typeof id === 'number') ? String(id) : null;
}

/**
 * Registers a pick-ownership predicate for a layer.
 * @param layerId - Owning layer id (e.g. 'flights').
 * @param predicate - Returns true when the picked primitive/entity id belongs to this layer.
 */
export function registerPickOwner(layerId: string, predicate: (pickedId: string) => boolean): void {
  if (!layerId || typeof predicate !== 'function') return;
  _owners.set(layerId, predicate);
}

/**
 * Removes a layer's ownership predicate (call on disable/destroy).
 * @param layerId - Owning layer id.
 */
export function unregisterPickOwner(layerId: string): void {
  _owners.delete(layerId);
}

/**
 * True when some OTHER registered layer owns the picked id.
 * @param layerId - The asking layer's id (excluded from the scan).
 * @param pickedId - Picked primitive/entity id.
 */
export function isOwnedByOtherLayer(layerId: string, pickedId: string): boolean {
  if (!pickedId) return false;
  for (const [ownerId, predicate] of _owners) {
    if (ownerId === layerId) continue;
    try {
      if (predicate(pickedId)) return true;
    } catch {
      // a broken predicate must never break click handling
    }
  }
  return false;
}
