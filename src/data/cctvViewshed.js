/**
 * @module cctvViewshed
 *
 * Viewshed presentation for the CCTV layer (design:
 * docs/superpowers/specs/2026-07-05-cctv-viewshed-gizmo-design.md §3a/§3b).
 *
 * Two responsibilities, both pure of layer state:
 *  - Color identity: a stable per-camera hue (golden-angle spaced over the
 *    id-sorted catalog index) and the derived fill/line renderer colors.
 *  - Volume geometry: the vertex and index buffers of a translucent frustum
 *    pyramid built FROM the exact frustumCartesians positions the wireframe
 *    uses — welded by construction, never recomputed independently. 5
 *    vertices, 6 triangles; the layer's rendering part draws them.
 *
 * Nothing here queries the scene or persists anything: colors are
 * presentation-only and volumes are rebuilt only at the moments the frustum
 * wireframe already rewrites (pose edits / visible-set changes).
 */
import { hslColor } from '../render/color.js';

/** Golden angle in degrees — maximally spreads consecutive indices around the hue wheel. */
const GOLDEN_ANGLE_DEG = 137.50776405003785;

const FILL_ALPHA_IDLE = 0.12;
const FILL_ALPHA_ACTIVE = 0.22;
const LINE_ALPHA_IDLE = 0.85;
const LINE_ALPHA_ACTIVE = 1.0;

/**
 * Stable hue (degrees, [0, 360)) for a camera's position in the id-sorted
 * catalog. Golden-angle spacing keeps any local cluster of neighbor cameras
 * visually separated; id-sorting makes the assignment deterministic across
 * sessions for a stable catalog (design §3a, owner question Q4).
 * @param {number} index - Camera index in the id-sorted catalog.
 * @returns {number} Hue in degrees.
 */
export function cameraHue(index) {
  const i = Number.isFinite(index) ? Math.max(0, Math.floor(index)) : 0;
  return (i * GOLDEN_ANGLE_DEG) % 360;
}

/**
 * Derived viewshed colors for a hue: translucent volume fills (idle/active)
 * and wireframe line tints (idle/active), all in the same hue family.
 * @param {number} hueDeg - Hue in degrees.
 * @returns {{fill: number[], fillActive: number[], line: number[], lineActive: number[]}}
 *   Renderer colours, [r, g, b, a] in 0..1.
 */
export function viewshedColors(hueDeg) {
  const hue = (((Number(hueDeg) % 360) + 360) % 360) / 360;
  return {
    fill: hslColor(hue, 0.85, 0.6, FILL_ALPHA_IDLE),
    fillActive: hslColor(hue, 0.85, 0.6, FILL_ALPHA_ACTIVE),
    line: hslColor(hue, 0.9, 0.65, LINE_ALPHA_IDLE),
    lineActive: hslColor(hue, 0.9, 0.7, LINE_ALPHA_ACTIVE),
  };
}

/**
 * Flattens frustumCartesians positions into the raw vertex/index buffers of
 * the frustum volume: vertex order [mount, tl, tr, br, bl]; 4 side faces from
 * the apex + the far cap split into 2 triangles. Pure — this is the ONLY
 * geometry definition (weld-by-construction with the wireframe, which draws
 * its rays/cap from the same 5 Cartesians).
 * @param {{mount: object, tl: object, tr: object, br: object, bl: object}}
 *   positions - frustumCartesians shape: ECEF points with x, y and z.
 * @returns {{positions: Float64Array, indices: Uint16Array}}
 */
export function frustumVolumeGeometryData(positions) {
  const pts = [
    positions.mount,
    positions.tl,
    positions.tr,
    positions.br,
    positions.bl,
  ];
  const flat = new Float64Array(15);
  pts.forEach((p, i) => {
    flat[i * 3] = p.x;
    flat[i * 3 + 1] = p.y;
    flat[i * 3 + 2] = p.z;
  });
  // apex=0, tl=1, tr=2, br=3, bl=4 — 4 side faces + far cap (2 triangles).
  const indices = new Uint16Array([
    0, 1, 2, 0, 2, 3, 0, 3, 4, 0, 4, 1, 1, 2, 3, 1, 3, 4,
  ]);
  return { positions: flat, indices };
}
