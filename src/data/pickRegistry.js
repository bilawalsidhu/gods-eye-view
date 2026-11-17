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
 * Owners that claim picks but never act on a click on them (flight trails, a
 * directions route line): `true` for all of an owner's picks, or a predicate
 * naming which. Their picks are still not empty space to other layers.
 * @type {Map<string, true | ((pickedId: string) => boolean)>}
 */
const _passive = new Map();
/** Owners whose click handlers also select nearby contacts. */
const _expanded = new Set();
/** @type {WeakMap<object, Map<string, [string, boolean][]>>} */
const clickActions = new WeakMap();
/**
 * Layers whose shapes are background to any card painted over them: their
 * click handlers stand aside under a card, so the card's layer may act there.
 * @type {Map<string, (hit: import('../render/contract/query').Hit) => boolean>}
 */
const _cardBackgrounds = new Map();

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
 * @param {{passive?: boolean | ((pickedId: string) => boolean), expanded?: boolean}} [options]
 *   `passive`: the layer never acts on a click on these picks (all of them,
 *   or those the predicate names). See {@link isActedOnByOtherLayer}.
 *   `expanded`: preserve precedence for handlers that select nearby contacts,
 *   through the shared contact hit or their own pick window.
 * @returns {void}
 */
export function registerPickOwner(
  layerId,
  predicate,
  { passive, expanded = false } = {},
) {
  if (!layerId || typeof predicate !== 'function') return;
  _owners.set(layerId, predicate);
  if (expanded) _expanded.add(layerId);
  else _expanded.delete(layerId);
  if (passive === true || typeof passive === 'function')
    _passive.set(layerId, passive);
  else _passive.delete(layerId);
}

/**
 * Removes a layer's ownership predicate (call on disable/destroy).
 * @param {string} layerId - Owning layer id.
 * @returns {void}
 */
export function unregisterPickOwner(layerId) {
  _owners.delete(layerId);
  _expanded.delete(layerId);
  _passive.delete(layerId);
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

/** @param {string} pickedId @returns {Generator<[string, boolean]>} */
function* actingPickOwners(pickedId) {
  for (const [ownerId, predicate] of _owners) {
    try {
      if (!predicate(pickedId)) continue;
      const passive = _passive.get(ownerId);
      if (passive === true) continue;
      if (typeof passive === 'function' && passive(pickedId)) continue;
      yield [ownerId, _expanded.has(ownerId)];
    } catch {
      // a broken predicate must never break click handling
    }
  }
}

/**
 * Hold the acting owners as soon as a click resolves a hit. A handler can
 * start tracking the hit and make it passive before later handlers run.
 * @param {object} click The shared dispatcher event.
 * @param {import('../render/contract/query').Hit|null} hit The resolved hit.
 */
export function rememberClickPickActions(click, hit) {
  const pickedId = resolvePickId(hit);
  if (!pickedId) return;
  let actions = clickActions.get(click);
  if (!actions) clickActions.set(click, (actions = new Map()));
  if (!actions.has(pickedId)) {
    actions.set(pickedId, [...actingPickOwners(pickedId)]);
  }
}

/**
 * True when some OTHER registered layer owns the picked id and acts on a
 * click on it: {@link isOwnedByOtherLayer} without passive owners. A card
 * painted over a passive pick (a flight trail) is still the card's click.
 * @param {string} layerId - The asking layer's id (excluded from the scan).
 * @param {string} pickedId - Picked primitive/entity id.
 * @param {{expanded?: boolean, click?: object}} [options] For a nearby hit,
 *   only expanded owners take precedence. Pass the shared click to use the
 *   acting owners from when it first resolved this hit.
 * @returns {boolean}
 */
export function isActedOnByOtherLayer(
  layerId,
  pickedId,
  { expanded = false, click } = {},
) {
  if (!pickedId) return false;
  const owners =
    clickActions.get(click)?.get(pickedId) ?? actingPickOwners(pickedId);
  for (const [ownerId, selectsNearby] of owners) {
    if (ownerId !== layerId && (!expanded || selectsNearby)) return true;
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
 * Registers a layer's unowned shapes that stand aside for a card painted over
 * them (its click handler returns when a world-overlay entry is on top).
 * @param {string} layerId - Registering layer id.
 * @param {(hit: import('../render/contract/query').Hit) => boolean} predicate
 *   True when a click's draw hit is one of this layer's shapes.
 * @returns {void}
 */
export function registerCardBackground(layerId, predicate) {
  if (!layerId || typeof predicate !== 'function') return;
  _cardBackgrounds.set(layerId, predicate);
}

/**
 * Removes a layer's card-background predicate (call when its clicks stop).
 * @param {string} layerId - Registering layer id.
 * @returns {void}
 */
export function unregisterCardBackground(layerId) {
  _cardBackgrounds.delete(layerId);
}

/**
 * True when a click's draw hit is a shape whose layer stands aside for a card
 * painted over it, so that card may act on the click.
 * @param {import('../render/contract/query').Hit|null|undefined} hit
 * @returns {boolean}
 */
export function isCardBackground(hit) {
  if (isSurface(hit)) return false;
  for (const predicate of _cardBackgrounds.values()) {
    try {
      if (predicate(hit)) return true;
    } catch {
      // a broken predicate must never break click handling
    }
  }
  return false;
}
