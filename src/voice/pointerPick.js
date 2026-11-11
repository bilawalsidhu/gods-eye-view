import * as geo from '../geo/index.js';
import { resolvePickedContext } from '../data/pickedContext.js';
import { cameraPoseKey } from './pointerContext.js';
import * as defaultAnnotationResolver from '../annotations/annotationResolver.js';

/** "Around here" radius as a share of camera height, clamped to sane bounds. */
function pointerRadiusKm(cameraHeightM) {
  const heightKm = Number(cameraHeightM) / 1000;
  if (!Number.isFinite(heightKm) || heightKm <= 0) return 50;
  return Math.round(Math.min(400, Math.max(5, heightKm * 0.75)));
}

/**
 * The globe side of point-and-ask: one object pick (engine.picker.pick) and
 * one depth-aware world pick at canvas CSS pixels, on either engine. Called
 * lazily by the pointer tracker (dwell and snapshot only), never per mouse
 * move.
 * @param {object} options
 * @param {object} options.engine The globe engine.
 * @param {object} [options.dataManager] Layer lifecycle.
 * @param {Function} [options.pickWorldFromScreen] Normalized-pixel world pick.
 * @returns {(x: number, y: number) => {entity: object|null, ground: object|null, radiusKm: number}|null}
 */
export function createPointerPicker({
  engine,
  dataManager = null,
  pickWorldFromScreen = defaultAnnotationResolver.pickWorldFromScreen,
}) {
  return function pickPointer(x, y) {
    if (!engine || engine.isDestroyed?.()) return null;
    const { width, height } = engine.host.size();
    if (!width || !height) return null;
    let picked = null;
    try {
      picked = engine.picker.pick(geo.cartesian2.create(x, y)) ?? null;
    } catch {
      picked = null;
    }
    const entity = resolvePickedContext(picked, { dataManager, engine });
    let ground = null;
    try {
      const hit = pickWorldFromScreen(engine, x / width, y / height);
      if (hit && Number.isFinite(hit.lat) && Number.isFinite(hit.lon))
        ground = {
          lat: hit.lat,
          lon: hit.lon,
          heightM: Number.isFinite(hit.height) ? Math.round(hit.height) : null,
        };
    } catch {
      ground = null;
    }
    return {
      entity,
      ground,
      radiusKm: pointerRadiusKm(engine.camera.height()),
      cameraKey: cameraPoseKey(engine),
    };
  };
}
