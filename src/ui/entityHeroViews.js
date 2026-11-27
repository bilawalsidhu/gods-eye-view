import { subjectModelSpec } from '../data/fleetModels.js';

// Which top image a card shows, and which views its switch offers. Kept
// apart from EntityPreview.vue so the choice can be tested without a
// renderer.

/** The views a card's top image can switch between, in the switch's order. */
export const HERO_VIEWS = Object.freeze([
  'photo',
  'route',
  'model',
  'cockpit',
  'map',
]);

/** How long each view shows, once it has drawn, before the next one. */
export const HERO_AUTOPLAY_MS = 6000;

/**
 * The longest a view still drawing holds the turn: one that never says it
 * has drawn hands over after this.
 */
export const HERO_READY_WAIT_MS = 15000;

/**
 * Whether an item's fleet model can be drawn: its model's bytes are in the
 * loaded set, or the set is still loading (the model view waits for it).
 * @param {{fleet: string}|null} subject What picks the model (`card.modelSubject`).
 * @param {{set?: object|null, loading?: Promise<object>|null}} fleet
 * @returns {boolean}
 */
export function heroModelReady(subject, { set = null, loading = null } = {}) {
  if (!subject) return false;
  if (!set) return Boolean(loading);
  try {
    const spec = subjectModelSpec(set, subject);
    return Boolean(spec && set.bytes?.has(spec.model));
  } catch {
    return false;
  }
}

/**
 * The kind of top image a card has.
 * - 'place-street': a place with a street-level photo a short walk away;
 * - 'flight': an aircraft with a photo, a route or a model;
 * - 'model': anything else drawn with a fleet model (a vessel, a train);
 * - 'photo', 'satellite' (the ground beneath it: the fleet has no satellite
 *   models), 'camera', 'street', 'map', or 'none'.
 * @param {{kind?: string, layerId?: string, placeStreet?: boolean,
 *   photo?: boolean, route?: boolean, model?: boolean, position?: boolean, mapped?: boolean}} item
 * @returns {string}
 */
export function heroKindOf({
  kind,
  layerId,
  placeStreet,
  photo,
  route,
  model,
  position,
  mapped = position,
}) {
  if (placeStreet) return 'place-street';
  if (kind === 'aircraft' && (photo || route || model)) return 'flight';
  if (model) return 'model';
  if (kind === 'vessel' && photo) return 'photo';
  if (layerId === 'satellites' && position) return 'satellite';
  if (layerId === 'cctv') return 'camera';
  if (layerId === 'street-level') return 'street';
  // Use a close-up only where the imagery covers the item's position.
  if (mapped) return 'map';
  return 'none';
}

/**
 * The views a 'flight' or 'model' top image offers, in the switch's order:
 * the close-up map for positions covered by the imagery.
 * @param {{photo?: boolean, route?: boolean, model?: boolean,
 *   cockpit?: boolean, position?: boolean}} has
 * @returns {string[]}
 */
export function heroViews({ photo, route, model, cockpit, position }) {
  const known = { photo, route, model, cockpit, map: position };
  return HERO_VIEWS.filter((view) => Boolean(known[view]));
}

/** The view a card opens on: its photo, else its model, else the first. */
const LEAD = ['photo', 'model'];

/**
 * The view showing: the one picked or reached, while the item has it;
 * otherwise the photo, else the model, else the first view.
 * @param {string[]} views {@link heroViews}
 * @param {string|null} chosen The view picked or reached, or null.
 * @returns {string|null}
 */
export function shownHeroView(views, chosen = null) {
  if (chosen && views.includes(chosen)) return chosen;
  return LEAD.find((view) => views.includes(view)) ?? views[0] ?? null;
}

/**
 * The view after `current` in the switch's order, round to the first after
 * the last. A view the item no longer has is followed by the first.
 * @param {string[]} views {@link heroViews}
 * @param {string|null} current
 * @returns {string|null}
 */
export function nextHeroView(views, current) {
  if (!views.length) return null;
  const at = views.indexOf(current);
  return views[(at + 1) % views.length];
}
