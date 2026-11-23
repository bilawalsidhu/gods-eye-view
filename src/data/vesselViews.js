/**
 * @module data/vesselViews
 * @description Which block of the vessel view sheet (`viewSheet.js`) a
 * vessel's icon draws from. Each hull shape (`vesselShape`, vesselTypes.js)
 * is rendered there from a sphere of camera angles, from straight above
 * down to the horizon; a renderer with the `viewSheets` capability lays the icon
 * flat on the water along its course and draws the view that matches where
 * the eye is, so a ship seen at an oblique angle looks solid instead of
 * like a flat hull. An aid to navigation keeps its upright buoy.
 */
import { VESSEL_VIEWS } from './viewSheet.js';
import { vesselSprite } from './vesselSprites.js';
import { VESSEL_KINDS } from './vesselTypes.js';

/** One frozen image ref per shape and kind, so equal refs are the same. */
const refs = new Map();

/**
 * The view image of a vessel: `{views, first, fallback}`, the sheet's id,
 * the first cell of its hull shape's block and its kind's flat hull sprite
 * (drawn while the sheet loads, or if it fails). A shape the sheet does not
 * hold draws its kind's block, and a kind it does not hold `other`'s.
 * @param {string} shape One of `VESSEL_SHAPES` (`vesselShape`).
 * @param {string} [kind] One of `VESSEL_KINDS` (`vesselKind`); the shape
 *   itself by default.
 * @returns {{views: string, first: number, fallback: string}}
 */
export function vesselViewRef(shape, kind = shape) {
  const held = (name) => Number.isInteger(VESSEL_VIEWS.subjects[name]);
  const flat = VESSEL_KINDS.includes(kind) ? kind : 'other';
  const subject = held(shape) ? shape : held(flat) ? flat : 'other';
  const key = `${subject}|${flat}`;
  let ref = refs.get(key);
  if (!ref) {
    ref = Object.freeze({
      views: VESSEL_VIEWS.id,
      first: VESSEL_VIEWS.subjects[subject],
      fallback: vesselSprite(flat),
    });
    refs.set(key, ref);
  }
  return ref;
}

/** Draw ports the sheet is registered on. */
const registered = new WeakSet();

/**
 * Register the vessel view sheet on a draw port, once per port, when its
 * renderer draws view sheets, its image URL resolved as the layer resolves
 * its other assets (the fleet models'). Safe to call any number of times.
 * @param {{views?: Function}|null} drawPort
 * @param {ReadonlySet<string>|null} [capabilities] The renderer's.
 * @param {(url: string) => string} [resolveAsset] The layer's asset URL
 *   resolver.
 * @returns {boolean} Whether icons on this port can draw views.
 */
export function registerVesselViews(
  drawPort,
  capabilities,
  resolveAsset = (url) => url,
) {
  if (!drawPort || typeof drawPort.views !== 'function') return false;
  if (!capabilities?.has?.('viewSheets')) return false;
  if (!registered.has(drawPort)) {
    const sheet = VESSEL_VIEWS.sheet;
    drawPort.views(VESSEL_VIEWS.id, {
      ...sheet,
      image: resolveAsset(sheet.image),
    });
    registered.add(drawPort);
  }
  return true;
}
