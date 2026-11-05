// Ported from CesiumJS 1.138 (Apache-2.0) — Quaternion.js
//
// Rotations as plain-data {x, y, z, w} objects. Only the subset gev uses is ported.
//
// Geo values are not Object.prototype objects, so src/app/stateChannel.js
// copyState and src/director/documentFields.js jsonTree reject them: copy
// the fields into a literal before putting one into product state or a
// scene document.

import { normalize, create as createCartesian3 } from './cartesian3.js';

// Values are instances of a module-private constructor rather than object
// literals: every `{x, y, z, w}` literal in the process shares one V8 hidden
// class, and code elsewhere that builds such literals would make geo's hot
// functions polymorphic. The instances still look like plain data: own
// enumerable fields only, no prototype methods or getters.
function Rotation(x, y, z, w) {
  this.x = x;
  this.y = y;
  this.z = z;
  this.w = w;
}

/** A quaternion of zeros by default (Cesium's `new Quaternion(x, y, z, w)`). */
export function create(x, y, z, w) {
  return new Rotation(x ?? 0.0, y ?? 0.0, z ?? 0.0, w ?? 0.0);
}

let fromAxisAngleScratch = createCartesian3();

/** The rotation by `angle` radians around `axis` (normalised here; a zero axis gives NaN). */
export function fromAxisAngle(axis, angle, result) {
  const halfAngle = angle / 2.0;
  const s = Math.sin(halfAngle);
  fromAxisAngleScratch = normalize(axis, fromAxisAngleScratch);

  const x = fromAxisAngleScratch.x * s;
  const y = fromAxisAngleScratch.y * s;
  const z = fromAxisAngleScratch.z * s;
  const w = Math.cos(halfAngle);
  if (result == null) return create(x, y, z, w);
  result.x = x;
  result.y = y;
  result.z = z;
  result.w = w;
  return result;
}

const fromRotationMatrixNext = [1, 2, 0];
const fromRotationMatrixQuat = new Array(3);

// Matrix3.getElementIndex(column, row)
const elementIndex = (column, row) => column * 3 + row;

/** The rotation of a 3x3 rotation matrix. */
export function fromRotationMatrix(matrix, result) {
  let root;
  let x;
  let y;
  let z;
  let w;

  const m00 = matrix[0];
  const m11 = matrix[4];
  const m22 = matrix[8];
  const trace = m00 + m11 + m22;

  if (trace > 0.0) {
    // |w| > 1/2, may as well choose w > 1/2
    root = Math.sqrt(trace + 1.0); // 2w
    w = 0.5 * root;
    root = 0.5 / root; // 1/(4w)

    x = (matrix[5] - matrix[7]) * root;
    y = (matrix[6] - matrix[2]) * root;
    z = (matrix[1] - matrix[3]) * root;
  } else {
    // |w| <= 1/2
    const next = fromRotationMatrixNext;

    let i = 0;
    if (m11 > m00) {
      i = 1;
    }
    if (m22 > m00 && m22 > m11) {
      i = 2;
    }
    const j = next[i];
    const k = next[j];

    root = Math.sqrt(
      matrix[elementIndex(i, i)] -
        matrix[elementIndex(j, j)] -
        matrix[elementIndex(k, k)] +
        1.0,
    );

    const quat = fromRotationMatrixQuat;
    quat[i] = 0.5 * root;
    root = 0.5 / root;
    w = (matrix[elementIndex(k, j)] - matrix[elementIndex(j, k)]) * root;
    quat[j] = (matrix[elementIndex(j, i)] + matrix[elementIndex(i, j)]) * root;
    quat[k] = (matrix[elementIndex(k, i)] + matrix[elementIndex(i, k)]) * root;

    x = -quat[0];
    y = -quat[1];
    z = -quat[2];
  }

  if (result == null) return create(x, y, z, w);
  result.x = x;
  result.y = y;
  result.z = z;
  result.w = w;
  return result;
}
