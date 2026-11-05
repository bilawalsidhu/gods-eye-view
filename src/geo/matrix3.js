// Ported from CesiumJS 1.138 (Apache-2.0) — Matrix3.js
//
// 3x3 matrices as plain arrays of 9 numbers in Cesium's column-major index
// order (m[column * 3 + row]), so Cesium accepts them wherever it reads
// m[0]..m[8]. Only the subset gev uses is ported.

/** A matrix of zeros (Cesium's `new Matrix3()`). */
export function create() {
  return [0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0];
}

/** The rotation matrix of a unit quaternion. */
export function fromQuaternion(quaternion, result) {
  const x2 = quaternion.x * quaternion.x;
  const xy = quaternion.x * quaternion.y;
  const xz = quaternion.x * quaternion.z;
  const xw = quaternion.x * quaternion.w;
  const y2 = quaternion.y * quaternion.y;
  const yz = quaternion.y * quaternion.z;
  const yw = quaternion.y * quaternion.w;
  const z2 = quaternion.z * quaternion.z;
  const zw = quaternion.z * quaternion.w;
  const w2 = quaternion.w * quaternion.w;

  const m00 = x2 - y2 - z2 + w2;
  const m01 = 2.0 * (xy - zw);
  const m02 = 2.0 * (xz + yw);

  const m10 = 2.0 * (xy + zw);
  const m11 = -x2 + y2 - z2 + w2;
  const m12 = 2.0 * (yz - xw);

  const m20 = 2.0 * (xz - yw);
  const m21 = 2.0 * (yz + xw);
  const m22 = -x2 - y2 + z2 + w2;

  if (result == null) result = create();
  result[0] = m00;
  result[1] = m10;
  result[2] = m20;
  result[3] = m01;
  result[4] = m11;
  result[5] = m21;
  result[6] = m02;
  result[7] = m12;
  result[8] = m22;
  return result;
}

/** A rotation by `angle` radians around the z-axis. */
export function fromRotationZ(angle, result) {
  const cosAngle = Math.cos(angle);
  const sinAngle = Math.sin(angle);

  if (result == null) result = create();
  result[0] = cosAngle;
  result[1] = sinAngle;
  result[2] = 0.0;
  result[3] = -sinAngle;
  result[4] = cosAngle;
  result[5] = 0.0;
  result[6] = 0.0;
  result[7] = 0.0;
  result[8] = 1.0;
  return result;
}

/** The product of a matrix and a column vector; `result` is required. */
export function multiplyByVector(matrix, cartesian, result) {
  const vX = cartesian.x;
  const vY = cartesian.y;
  const vZ = cartesian.z;

  const x = matrix[0] * vX + matrix[3] * vY + matrix[6] * vZ;
  const y = matrix[1] * vX + matrix[4] * vY + matrix[7] * vZ;
  const z = matrix[2] * vX + matrix[5] * vY + matrix[8] * vZ;

  result.x = x;
  result.y = y;
  result.z = z;
  return result;
}

/** The column at `index` (0..2) as {x, y, z}; `result` is required. */
export function getColumn(matrix, index, result) {
  const startIndex = index * 3;
  const x = matrix[startIndex];
  const y = matrix[startIndex + 1];
  const z = matrix[startIndex + 2];

  result.x = x;
  result.y = y;
  result.z = z;
  return result;
}
