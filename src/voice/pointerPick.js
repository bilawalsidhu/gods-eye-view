import { pickAt as defaultPickAt } from '../input/dispatcher.js';
import { findCamera } from '../render/rendererOf.js';
import { resolvePickedContext } from '../data/pickedContext.js';
import { cameraPoseKey } from './pointerContext.js';
import * as defaultAnnotationResolver from '../annotations/annotationResolver.js';

/** "Around here" radius as a share of camera height, clamped to sane bounds. */
function pointerRadiusKm(cameraHeightM) {
  const heightKm = Number(cameraHeightM) / 1000;
  if (!Number.isFinite(heightKm) || heightKm <= 0) return 50;
  return Math.round(Math.min(400, Math.max(5, heightKm * 0.75)));
}

function cameraHeightM(viewer) {
  try {
    return findCamera(viewer)?.pose().height;
  } catch {
    return undefined;
  }
}

/**
 * The scene side of point-and-ask: one entity pick and one depth-aware world
 * pick at canvas CSS pixels. Called lazily by the pointer tracker (dwell and
 * snapshot only), never per mouse move.
 * @param {object} options
 * @param {object} options.viewer The scene object.
 * @param {object} [options.dataManager] Layer lifecycle.
 * @param {Function} [options.pickWorldFromScreen] Normalized-pixel world pick.
 * @param {Function} [options.pickAt] Entity pick at canvas CSS pixels.
 * @returns {(x: number, y: number) => {entity: object|null, ground: object|null, radiusKm: number}|null}
 */
export function createPointerPicker({
  viewer,
  dataManager = null,
  pickWorldFromScreen = defaultAnnotationResolver.pickWorldFromScreen,
  pickAt = defaultPickAt,
}) {
  return function pickPointer(x, y) {
    const scene = viewer?.scene;
    const canvas = scene?.canvas;
    if (!scene || !canvas) return null;
    const width = canvas.clientWidth || canvas.width || 0;
    const height = canvas.clientHeight || canvas.height || 0;
    if (!width || !height) return null;
    const picked = pickAt(viewer, x, y);
    const entity = resolvePickedContext(picked, { dataManager });
    let ground = null;
    try {
      const hit = pickWorldFromScreen(viewer, x / width, y / height);
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
      radiusKm: pointerRadiusKm(cameraHeightM(viewer)),
      cameraKey: cameraPoseKey(viewer),
    };
  };
}
