/**
 * @module data/aircraftViews
 * @description Maps an icon kind and rotor frame to its block of AIRCRAFT_VIEWS
 * and registers the sheet on a draw port. Course-rotated icons of rendered
 * kinds take a view. Other icons keep the flat glyph.
 * AIRCRAFT_VIEWS is built from `aircraftViews.json`, the manifest
 * `scripts/build-aircraft-views.mjs` writes with the sheet.
 */
import {
  aircraftIcon,
  FLEET_ICON_PX,
  rotorFrameIndex,
} from './aircraftIcons.js';
import manifest from './aircraftViews.json' with { type: 'json' };

// The bake's SUBJECTS order.
const SUBJECTS = Object.keys(manifest.subjects);
const SHEET = Object.freeze({
  image: `/sprites/${manifest.image}`,
  cellPx: manifest.cellPx,
  columns: manifest.columns,
  rows: manifest.rows,
  ringStepDeg: manifest.ringStepDeg,
  rings: Object.freeze([...manifest.rings]),
});
const FRAMES = SHEET.rings.reduce((sum, n) => sum + n, 0);
export const AIRCRAFT_VIEWS = Object.freeze({
  id: 'aircraft-views',
  sheet: SHEET,
  frames: FRAMES,
  subjects: Object.freeze(
    Object.fromEntries(
      SUBJECTS.map((name) => [name, manifest.subjects[name].first]),
    ),
  ),
});
const STILL_KINDS = new Set(
  SUBJECTS.filter((name) => !name.startsWith('helicopter')),
);

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
 * id, the first cell of the kind's block and its flat glyph, or null for a kind with no views.
 * @param {string} kind An icon kind (`rendering._iconKind`).
 * @param {number} [frame] A helicopter's rotor frame, 0 to `ROTOR_FRAMES - 1`
 *   (the still frame otherwise, as `aircraftIcon` takes it).
 * @returns {{views: string, first: number, fallback: string}|null}
 */
export function aircraftViewRef(kind, frame) {
  const subjects = AIRCRAFT_VIEWS.subjects;
  if (kind === 'helicopter') {
    const f = rotorFrameIndex(frame);
    return refAt(subjects[`helicopter${f}`], kind, f);
  }
  return STILL_KINDS.has(kind) ? refAt(subjects[kind], kind) : null;
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
  if (!capabilities?.has?.('viewSheets')) return false;
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
