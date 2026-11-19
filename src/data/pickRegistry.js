/**
 * Shared pick-ownership registry for the layers that read globe clicks
 * (src/input/dispatcher.js).
 *
 * Problem solved: each entity layer (commercial flights, military flights)
 * receives every LEFT_CLICK. When the user clicks a military aircraft while
 * a commercial flight is tracked, the commercial handler used to classify
 * the pick as "empty space" and clear tracking (with a camera flight) at the
 * same moment the military handler started tracking — two competing camera
 * commands. Layers now register a predicate so siblings can recognize picks
 * that belong to someone else and leave them alone.
 */

/**
 * A click's hits are the renderer contract's `Hit` (src/render/contract/
 * query.d.ts), plus, for something drawn outside the draw port, a `Hit`
 * with no set (`set: ''`, `id` null when it has none) named by the renderer
 * adapter
 * (`nativeClickOf`, src/render/rendererOf.js). The raw forms of these
 * rules, for code that still holds a Cesium pick, are the adapter's
 * (src/render/cesium/nativeClick.js).
 */

/** Whether a hit is the map itself, or nothing. */
const isSurface = (hit) => !hit || hit.surface === true;

/** @type {Map<string, (pickedId: string) => boolean>} layerId -> ownership predicate */
const _owners = new Map();

/**
 * A hit's canonical pick id, for the ownership scan: its item's id. Layers'
 * ids differ (strings, satellites' NORAD catalog numbers as strings), but a
 * draw-set item's id is always a string.
 *
 * @param {import('../render/contract/query').Hit|null|undefined} hit
 * @returns {string|null} Its id (an empty one is still an id); null for the
 *   map, nothing, or something with no id.
 */
export function resolvePickId(hit) {
  if (isSurface(hit)) return null;
  const id = hit.id;
  return typeof id === 'string' || typeof id === 'number' ? String(id) : null;
}

/**
 * Registers a pick-ownership predicate for a layer.
 * @param {string} layerId - Owning layer id (e.g. 'flights').
 * @param {(pickedId: string) => boolean} predicate - Returns true when the
 *   picked primitive/entity id belongs to this layer.
 * @returns {void}
 */
export function registerPickOwner(layerId, predicate) {
  if (!layerId || typeof predicate !== 'function') return;
  _owners.set(layerId, predicate);
}

/**
 * Removes a layer's ownership predicate (call on disable/destroy).
 * @param {string} layerId - Owning layer id.
 * @returns {void}
 */
export function unregisterPickOwner(layerId) {
  _owners.delete(layerId);
}

/**
 * The registered layer that owns a picked id, or null.
 * @param {string} pickedId - Canonical pick id from {@link resolvePickId}.
 * @returns {string|null} Owning layer id.
 */
export function findPickOwner(pickedId) {
  if (!pickedId) return null;
  for (const [ownerId, predicate] of _owners) {
    try {
      if (predicate(pickedId)) return ownerId;
    } catch {
      // a broken predicate must never break picking
    }
  }
  return null;
}

/**
 * True when some OTHER registered layer owns the picked id.
 * @param {string} layerId - The asking layer's id (excluded from the scan).
 * @param {string} pickedId - Picked primitive/entity id.
 * @returns {boolean}
 */
export function isOwnedByOtherLayer(layerId, pickedId) {
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

/**
 * Resolve a moving-contact click without letting map tiles hide a nearby touch
 * target. Exact picks always win; only a coarse primary pointer may expand a
 * surface miss. Every consumer uses the same ordered, bounded hits, so sibling
 * layers do not each choose their own contact under one tap.
 * Unowned items remain barriers, not permission to pick through.
 *
 * @param {import('../render/contract/query').QueryPort} query
 * @param {{x: number, y: number}} position Screen position in CSS pixels.
 * @param {{picked?: import('../render/contract/query').Hit|null, drill?: (limit: number, width: number, height: number) => import('../render/contract/query').Hit[]}} [options]
 *   The click's own passes when the caller has them, so a click is picked
 *   once: `picked` is `query.pick(position)` (a miss is passed as `null`
 *   too, so the key's presence counts), `drill` a shared `query.drillPick`.
 * @returns {import('../render/contract/query').Hit|null} The pick, or the
 *   first registered touch hit.
 */
export function pickContact(query, position, options = {}) {
  const picked =
    'picked' in options
      ? options.picked
      : (query.pick(position.x, position.y) ?? null);
  if (
    !globalThis.matchMedia?.('(pointer: coarse)').matches ||
    findPickOwner(resolvePickId(picked)) ||
    !isSurface(picked)
  )
    return picked;
  let hits;
  try {
    hits =
      (options.drill
        ? options.drill(8, 14, 14)
        : query.drillPick(position.x, position.y, {
            width: 14,
            height: 14,
            limit: 8,
          })) || [];
  } catch {
    return picked;
  }
  for (const hit of hits.slice(0, 8)) {
    if (findPickOwner(resolvePickId(hit))) return hit;
    if (!isSurface(hit)) break;
  }
  return picked;
}

/**
 * The world overlay's hit test: the topmost interactive card or label painted
 * at CSS-pixel coordinates, or null. Set by the overlay host while it runs.
 * @type {((x: number, y: number) => {sourceId: string, entryId: string}|null)|null}
 */
let _overlayHitTest = null;
/** @type {WeakMap<object, {sourceId: string, entryId: string}|null>} */
const clickCards = new WeakMap();

/**
 * Sets (or with null, clears) the hit test that names the card or label
 * painted at a click. The world-overlay host sets it while it runs.
 * @param {((x: number, y: number) => object|null)|null} hitTest
 * @returns {void}
 */
export function setClickCardHitTest(hitTest) {
  _overlayHitTest = typeof hitTest === 'function' ? hitTest : null;
}

/**
 * The topmost interactive card or label painted at a click, read once per
 * click so every handler of it sees the same one whatever ran first.
 * @param {{screenPosition?: {x: number, y: number}}|null|undefined} click
 * @returns {{sourceId: string, entryId: string}|null}
 */
export function clickCard(click) {
  if (!click || typeof click !== 'object') return null;
  if (clickCards.has(click)) return clickCards.get(click);
  const at = click.screenPosition;
  let card = null;
  try {
    card = _overlayHitTest?.(at?.x, at?.y) ?? null;
  } catch {
    // a broken hit test must never break click handling
  }
  clickCards.set(click, card);
  return card;
}

/**
 * True when another layer's card or label is painted on top at a click. The
 * card on top takes the click: a scene item under it does not act, and is
 * not empty space either, so the layer leaves its selection alone.
 * @param {object} click The shared dispatcher event.
 * @param {Iterable<string>} [ownSourceIds] The asking layer's overlay
 *   sources: its own card on top is its click.
 * @returns {boolean}
 */
export function isUnderOtherCard(click, ownSourceIds = []) {
  const card = clickCard(click);
  if (!card) return false;
  for (const sourceId of ownSourceIds)
    if (card.sourceId === sourceId) return false;
  return true;
}
