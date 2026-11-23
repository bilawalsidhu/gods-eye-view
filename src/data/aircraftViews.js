/**
 * @module data/aircraftViews
 * @description Which block of the aircraft view sheet (`viewSheet.js`) a
 * contact's icon draws from. Each aircraft class is rendered there from a
 * sphere of camera angles; a renderer with the `viewSheets` capability lays
 * the icon flat on the earth along its course and draws the view that
 * matches where the eye is, so an oblique contact looks solid instead of
 * like a paper cut-out. Only an icon drawn along its course
 * (`rotationMode: 'course'`) can do this: a screen-rotated or upright icon
 * keeps its flat glyph. Kinds with no rendered views (the TR-3B triangle,
 * airport vehicles, ground stations) keep their flat glyph as well.
 */
import { AIRCRAFT_VIEWS } from './viewSheet.js';
import {
  aircraftIcon,
  FLEET_ICON_PX,
  ROTOR_FRAMES,
  ROTOR_STILL_FRAME,
} from './aircraftIcons.js';

/** The renderer capability that draws view sheets. */
export const VIEW_SHEETS_CAPABILITY = 'viewSheets';

/** Kinds drawn from the sheet with one block each (helicopters have three). */
const STILL_KINDS = new Set([
  'airliner',
  'widebody',
  'quadjet',
  'turboprop',
  'light',
  'glider',
  'fastjet',
  'bizjet',
  'uav',
]);

/** One frozen image ref per block, so equal refs are the same object. */
const refs = new Map();

/**
 * The ref of the block at `first`, with the flat glyph of `kind` (and its
 * rotor `frame`) as its fallback: what the renderer draws until the sheet
 * has loaded, and for good if it cannot load.
 */
function refAt(first, kind, frame) {
  let ref = refs.get(first);
  if (!ref) {
    ref = Object.freeze({
      views: AIRCRAFT_VIEWS.id,
      first,
      fallback: aircraftIcon(kind, FLEET_ICON_PX, frame),
    });
    refs.set(first, ref);
  }
  return ref;
}

/**
 * The view image of an icon kind: `{views, first, fallback}`, the sheet's
 * id, the first cell of the kind's block and its flat glyph (drawn while
 * the sheet loads, or if it fails), or null for a kind with no views.
 * @param {string} kind An icon kind (`rendering._iconKind`).
 * @param {number} [frame] A helicopter's rotor frame, 0 to `ROTOR_FRAMES - 1`
 *   (the still frame otherwise, as `aircraftIcon` takes it).
 * @returns {{views: string, first: number, fallback: string}|null}
 */
export function aircraftViewRef(kind, frame) {
  const subjects = AIRCRAFT_VIEWS.subjects;
  if (kind === 'helicopter') {
    const f =
      Number.isInteger(frame) && frame >= 0 && frame < ROTOR_FRAMES
        ? frame
        : ROTOR_STILL_FRAME;
    const first = subjects[`helicopter${f}`];
    return Number.isInteger(first) ? refAt(first, kind, f) : null;
  }
  if (!STILL_KINDS.has(kind)) return null;
  const first = subjects[kind];
  return Number.isInteger(first) ? refAt(first, kind) : null;
}

/** Whether an icon image is a view-sheet ref. */
export function isAircraftViewRef(image) {
  return Boolean(image) && typeof image === 'object' && 'views' in image;
}

/** Draw ports the sheet is registered on. */
const registered = new WeakSet();

/**
 * Register the aircraft view sheet on a draw port, once per port, when its
 * renderer draws view sheets, its image URL resolved as the layer resolves
 * its other assets (the fleet models'). Safe to call any number of times.
 * @param {{views?: Function}|null} drawPort
 * @param {ReadonlySet<string>|null} [capabilities] The renderer's.
 * @param {(url: string) => string} [resolveAsset] The layer's asset URL
 *   resolver.
 * @returns {boolean} Whether icons on this port can draw views.
 */
export function registerAircraftViews(
  drawPort,
  capabilities,
  resolveAsset = (url) => url,
) {
  if (!drawPort || typeof drawPort.views !== 'function') return false;
  if (!capabilities?.has?.(VIEW_SHEETS_CAPABILITY)) return false;
  if (!registered.has(drawPort)) {
    const sheet = AIRCRAFT_VIEWS.sheet;
    drawPort.views(AIRCRAFT_VIEWS.id, {
      ...sheet,
      image: resolveAsset(sheet.image),
    });
    registered.add(drawPort);
  }
  return true;
}

/**
 * An icon's look drawn from the view sheet where it can be: with views on,
 * the item drawn along its course and the kind rendered, the image is the
 * view ref and there is no near image (`imageLod: undefined`, so an update
 * clears it); otherwise the look as given, the very same object.
 * @template {{image: unknown, imageLod?: unknown}} T
 * @param {T} look
 * @param {object} options
 * @param {boolean} options.views Whether the renderer draws views
 *   (`registerAircraftViews`).
 * @param {string} options.kind The icon kind.
 * @param {number} [options.frame] A helicopter's rotor frame.
 * @param {string} [options.rotationMode] How the item is rotated.
 * @returns {T}
 */
export function withAircraftView(look, { views, kind, frame, rotationMode }) {
  if (!views || rotationMode !== 'course') return look;
  const ref = aircraftViewRef(kind, frame);
  if (!ref) return look;
  return { ...look, image: ref, imageLod: undefined };
}
