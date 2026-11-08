/**
 * @module modelRecord
 * @description A layer's own record of one 3D model it draws through a draw
 * port `models` set, held in the layer's maps under the contact's id, so the
 * layer reads what it pushed (and what the set told it) back from itself.
 *
 * Write `show` and the placement with {@link showModel} and
 * {@link placeModel}; the set's `ready` event sets `ready`, and its
 * `loadFailed` event `failedAt`. The placement is
 * kept as the column-major frame the model is posed in, the same frame a
 * renderer builds from the item's position and heading, so anchors on the
 * model can be read from it.
 */
import { eastNorthUp } from '../geo/frames.js';

/**
 * @typedef {object} ModelRecord
 * @property {string|null} id The item's id in its set, where the record
 *   does not live under it in a map (the tracked model).
 * @property {string|null} url The model asset the layer sends.
 * @property {boolean} ready Whether the set reported the model loaded and
 *   posed (`ready`).
 * @property {number} failedAt When (epoch ms) the set last reported the
 *   model's load failed (`loadFailed`); 0 when it has not.
 * @property {boolean} show Whether the layer last showed the model.
 * @property {boolean} placed Whether the layer has placed it yet.
 * @property {Float64Array} matrix Where the layer last placed it: the
 *   east-north-up frame at its position turned by its heading, column-major.
 * @property {{x:number,y:number,z:number}} position Where it is placed.
 * @property {number} heading Radians, as the item's `orientation.heading`.
 * @property {string|null} specKey The model spec it was admitted for; a
 *   class change readmits.
 * @property {number} bellyM Metres from the model origin to its belly, to sit
 *   it on the ground.
 * @property {number} scale The `scale` the layer last sent.
 * @property {number} minPixelSize The `minPixelSize` the layer last sent.
 * @property {number[]|null} tint The `tint` the layer last sent.
 * @property {string|null} sent The item last sent, as a key, or null.
 */

/**
 * A record for a model the layer just admitted.
 * @param {{id?: string|null, url?: string|null, specKey?: string,
 *   bellyM?: number, scale?: number, minPixelSize?: number}} [fields]
 * @returns {ModelRecord}
 */
export function createModelRecord({
  id = null,
  url = null,
  specKey = null,
  bellyM = 0,
  scale = 1,
  minPixelSize = 0,
} = {}) {
  const matrix = new Float64Array(16);
  matrix[0] = matrix[5] = matrix[10] = matrix[15] = 1;
  return {
    id,
    url,
    ready: false,
    failedAt: 0,
    show: false,
    placed: false,
    matrix,
    position: { x: 0, y: 0, z: 0 },
    heading: 0,
    specKey,
    bellyM,
    scale,
    minPixelSize,
    tint: null,
    sent: null,
  };
}

/**
 * Show or hide a model and record it.
 * @param {ModelRecord} record
 * @param {boolean} show
 */
export function showModel(record, show) {
  record.show = show;
}

/**
 * Place a model at `position` turned by `heading` (radians clockwise from
 * north about the local up, as `orientation.heading`), and record its frame.
 * @param {ModelRecord} record
 * @param {{x:number,y:number,z:number}} position ECEF; copied.
 * @param {number} heading
 */
export function placeModel(record, position, heading) {
  record.position.x = position.x;
  record.position.y = position.y;
  record.position.z = position.z;
  record.heading = heading;
  record.placed = true;
  headingFrame(record.position, heading, record.matrix);
}

/**
 * The east-north-up frame at `origin` turned by `heading` about its up axis,
 * as a column-major 4x4: a heading of 0 keeps local x east, and a positive
 * heading turns it clockwise seen from above.
 * @param {{x:number,y:number,z:number}} origin
 * @param {number} heading Radians.
 * @param {Float64Array|number[]} out
 * @returns {Float64Array|number[]} `out`.
 */
export function headingFrame(origin, heading, out) {
  const enu = eastNorthUp(origin);
  const c = Math.cos(heading);
  const s = Math.sin(heading);
  const e = enu.x;
  const n = enu.y;
  const u = enu.z;
  out[0] = e.x * c - n.x * s;
  out[1] = e.y * c - n.y * s;
  out[2] = e.z * c - n.z * s;
  out[3] = 0;
  out[4] = e.x * s + n.x * c;
  out[5] = e.y * s + n.y * c;
  out[6] = e.z * s + n.z * c;
  out[7] = 0;
  out[8] = u.x;
  out[9] = u.y;
  out[10] = u.z;
  out[11] = 0;
  out[12] = origin.x;
  out[13] = origin.y;
  out[14] = origin.z;
  out[15] = 1;
  return out;
}

/**
 * Whether a record's model is what the user sees: loaded and shown.
 * @param {ModelRecord|null|undefined} record
 * @returns {boolean}
 */
export function modelIsRendering(record) {
  return !!record && record.ready === true && record.show === true;
}
