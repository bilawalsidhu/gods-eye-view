// Ported from CesiumJS 1.138 (Apache-2.0) — Matrix4.js
//
// 4x4 matrices as plain arrays of 16 numbers in Cesium's column-major index
// order (m[column * 4 + row]), so Cesium accepts them wherever it reads
// m[0]..m[15] (e.g. the Model.modelMatrix setter clones by index). Products
// and getters take a required `result` that may be an input; constructors
// take an optional one. Only the subset gev uses is ported.

import { ZERO } from './cartesian3.js';

/** A matrix of zeros (Cesium's `new Matrix4()`). */
export function create() {
  return [
    0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0,
    0.0,
  ];
}

export const IDENTITY = Object.freeze([
  1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0,
  1.0,
]);

/** Copies a matrix; `undefined` when there is none. */
export function clone(matrix, result) {
  if (matrix == null) return undefined;
  if (result == null) result = create();
  for (let i = 0; i < 16; i++) result[i] = matrix[i];
  return result;
}

/** Whether two matrices are component-wise equal. */
export function equals(left, right) {
  // Given that most matrices will be transformation matrices, the elements
  // are tested in order such that the test is likely to fail as early as possible.
  return (
    left === right ||
    (left != null &&
      right != null &&
      // Translation
      left[12] === right[12] &&
      left[13] === right[13] &&
      left[14] === right[14] &&
      // Rotation/scale
      left[0] === right[0] &&
      left[1] === right[1] &&
      left[2] === right[2] &&
      left[4] === right[4] &&
      left[5] === right[5] &&
      left[6] === right[6] &&
      left[8] === right[8] &&
      left[9] === right[9] &&
      left[10] === right[10] &&
      // Bottom row
      left[3] === right[3] &&
      left[7] === right[7] &&
      left[11] === right[11] &&
      left[15] === right[15])
  );
}

/** The product of two matrices. */
export function multiply(left, right, result) {
  const left0 = left[0];
  const left1 = left[1];
  const left2 = left[2];
  const left3 = left[3];
  const left4 = left[4];
  const left5 = left[5];
  const left6 = left[6];
  const left7 = left[7];
  const left8 = left[8];
  const left9 = left[9];
  const left10 = left[10];
  const left11 = left[11];
  const left12 = left[12];
  const left13 = left[13];
  const left14 = left[14];
  const left15 = left[15];

  const right0 = right[0];
  const right1 = right[1];
  const right2 = right[2];
  const right3 = right[3];
  const right4 = right[4];
  const right5 = right[5];
  const right6 = right[6];
  const right7 = right[7];
  const right8 = right[8];
  const right9 = right[9];
  const right10 = right[10];
  const right11 = right[11];
  const right12 = right[12];
  const right13 = right[13];
  const right14 = right[14];
  const right15 = right[15];

  const column0Row0 =
    left0 * right0 + left4 * right1 + left8 * right2 + left12 * right3;
  const column0Row1 =
    left1 * right0 + left5 * right1 + left9 * right2 + left13 * right3;
  const column0Row2 =
    left2 * right0 + left6 * right1 + left10 * right2 + left14 * right3;
  const column0Row3 =
    left3 * right0 + left7 * right1 + left11 * right2 + left15 * right3;

  const column1Row0 =
    left0 * right4 + left4 * right5 + left8 * right6 + left12 * right7;
  const column1Row1 =
    left1 * right4 + left5 * right5 + left9 * right6 + left13 * right7;
  const column1Row2 =
    left2 * right4 + left6 * right5 + left10 * right6 + left14 * right7;
  const column1Row3 =
    left3 * right4 + left7 * right5 + left11 * right6 + left15 * right7;

  const column2Row0 =
    left0 * right8 + left4 * right9 + left8 * right10 + left12 * right11;
  const column2Row1 =
    left1 * right8 + left5 * right9 + left9 * right10 + left13 * right11;
  const column2Row2 =
    left2 * right8 + left6 * right9 + left10 * right10 + left14 * right11;
  const column2Row3 =
    left3 * right8 + left7 * right9 + left11 * right10 + left15 * right11;

  const column3Row0 =
    left0 * right12 + left4 * right13 + left8 * right14 + left12 * right15;
  const column3Row1 =
    left1 * right12 + left5 * right13 + left9 * right14 + left13 * right15;
  const column3Row2 =
    left2 * right12 + left6 * right13 + left10 * right14 + left14 * right15;
  const column3Row3 =
    left3 * right12 + left7 * right13 + left11 * right14 + left15 * right15;

  result[0] = column0Row0;
  result[1] = column0Row1;
  result[2] = column0Row2;
  result[3] = column0Row3;
  result[4] = column1Row0;
  result[5] = column1Row1;
  result[6] = column1Row2;
  result[7] = column1Row3;
  result[8] = column2Row0;
  result[9] = column2Row1;
  result[10] = column2Row2;
  result[11] = column2Row3;
  result[12] = column3Row0;
  result[13] = column3Row1;
  result[14] = column3Row2;
  result[15] = column3Row3;
  return result;
}

/** The product of two affine transformations (bottom rows assumed [0, 0, 0, 1]). */
export function multiplyTransformation(left, right, result) {
  const left0 = left[0];
  const left1 = left[1];
  const left2 = left[2];
  const left4 = left[4];
  const left5 = left[5];
  const left6 = left[6];
  const left8 = left[8];
  const left9 = left[9];
  const left10 = left[10];
  const left12 = left[12];
  const left13 = left[13];
  const left14 = left[14];

  const right0 = right[0];
  const right1 = right[1];
  const right2 = right[2];
  const right4 = right[4];
  const right5 = right[5];
  const right6 = right[6];
  const right8 = right[8];
  const right9 = right[9];
  const right10 = right[10];
  const right12 = right[12];
  const right13 = right[13];
  const right14 = right[14];

  const column0Row0 = left0 * right0 + left4 * right1 + left8 * right2;
  const column0Row1 = left1 * right0 + left5 * right1 + left9 * right2;
  const column0Row2 = left2 * right0 + left6 * right1 + left10 * right2;

  const column1Row0 = left0 * right4 + left4 * right5 + left8 * right6;
  const column1Row1 = left1 * right4 + left5 * right5 + left9 * right6;
  const column1Row2 = left2 * right4 + left6 * right5 + left10 * right6;

  const column2Row0 = left0 * right8 + left4 * right9 + left8 * right10;
  const column2Row1 = left1 * right8 + left5 * right9 + left9 * right10;
  const column2Row2 = left2 * right8 + left6 * right9 + left10 * right10;

  const column3Row0 =
    left0 * right12 + left4 * right13 + left8 * right14 + left12;
  const column3Row1 =
    left1 * right12 + left5 * right13 + left9 * right14 + left13;
  const column3Row2 =
    left2 * right12 + left6 * right13 + left10 * right14 + left14;

  result[0] = column0Row0;
  result[1] = column0Row1;
  result[2] = column0Row2;
  result[3] = 0.0;
  result[4] = column1Row0;
  result[5] = column1Row1;
  result[6] = column1Row2;
  result[7] = 0.0;
  result[8] = column2Row0;
  result[9] = column2Row1;
  result[10] = column2Row2;
  result[11] = 0.0;
  result[12] = column3Row0;
  result[13] = column3Row1;
  result[14] = column3Row2;
  result[15] = 1.0;
  return result;
}

/** Transforms a point (w = 1). */
export function multiplyByPoint(matrix, cartesian, result) {
  const vX = cartesian.x;
  const vY = cartesian.y;
  const vZ = cartesian.z;

  const x = matrix[0] * vX + matrix[4] * vY + matrix[8] * vZ + matrix[12];
  const y = matrix[1] * vX + matrix[5] * vY + matrix[9] * vZ + matrix[13];
  const z = matrix[2] * vX + matrix[6] * vY + matrix[10] * vZ + matrix[14];

  result.x = x;
  result.y = y;
  result.z = z;
  return result;
}

/** Transforms a direction (w = 0), ignoring the translation. */
export function multiplyByPointAsVector(matrix, cartesian, result) {
  const vX = cartesian.x;
  const vY = cartesian.y;
  const vZ = cartesian.z;

  const x = matrix[0] * vX + matrix[4] * vY + matrix[8] * vZ;
  const y = matrix[1] * vX + matrix[5] * vY + matrix[9] * vZ;
  const z = matrix[2] * vX + matrix[6] * vY + matrix[10] * vZ;

  result.x = x;
  result.y = y;
  result.z = z;
  return result;
}

/** The translation part as {x, y, z}. */
export function getTranslation(matrix, result) {
  result.x = matrix[12];
  result.y = matrix[13];
  result.z = matrix[14];
  return result;
}

/** The upper-left 3x3 part. */
export function getMatrix3(matrix, result) {
  result[0] = matrix[0];
  result[1] = matrix[1];
  result[2] = matrix[2];
  result[3] = matrix[4];
  result[4] = matrix[5];
  result[5] = matrix[6];
  result[6] = matrix[8];
  result[7] = matrix[9];
  result[8] = matrix[10];
  return result;
}

/** The column at `index` (0..3) as {x, y, z, w}. */
export function getColumn(matrix, index, result) {
  const startIndex = index * 4;
  const x = matrix[startIndex];
  const y = matrix[startIndex + 1];
  const z = matrix[startIndex + 2];
  const w = matrix[startIndex + 3];

  result.x = x;
  result.y = y;
  result.z = z;
  result.w = w;
  return result;
}

/** The inverse of a rotation-plus-translation matrix (no scale or shear). */
export function inverseTransformation(matrix, result) {
  const matrix0 = matrix[0];
  const matrix1 = matrix[1];
  const matrix2 = matrix[2];
  const matrix4 = matrix[4];
  const matrix5 = matrix[5];
  const matrix6 = matrix[6];
  const matrix8 = matrix[8];
  const matrix9 = matrix[9];
  const matrix10 = matrix[10];

  const vX = matrix[12];
  const vY = matrix[13];
  const vZ = matrix[14];

  const x = -matrix0 * vX - matrix1 * vY - matrix2 * vZ;
  const y = -matrix4 * vX - matrix5 * vY - matrix6 * vZ;
  const z = -matrix8 * vX - matrix9 * vY - matrix10 * vZ;

  result[0] = matrix0;
  result[1] = matrix4;
  result[2] = matrix8;
  result[3] = 0.0;
  result[4] = matrix1;
  result[5] = matrix5;
  result[6] = matrix9;
  result[7] = 0.0;
  result[8] = matrix2;
  result[9] = matrix6;
  result[10] = matrix10;
  result[11] = 0.0;
  result[12] = x;
  result[13] = y;
  result[14] = z;
  result[15] = 1.0;
  return result;
}

/** A transformation from a 3x3 rotation and a translation (zero when absent). */
export function fromRotationTranslation(rotation, translation, result) {
  translation = translation ?? ZERO;
  if (result == null) result = create();
  result[0] = rotation[0];
  result[1] = rotation[1];
  result[2] = rotation[2];
  result[3] = 0.0;
  result[4] = rotation[3];
  result[5] = rotation[4];
  result[6] = rotation[5];
  result[7] = 0.0;
  result[8] = rotation[6];
  result[9] = rotation[7];
  result[10] = rotation[8];
  result[11] = 0.0;
  result[12] = translation.x;
  result[13] = translation.y;
  result[14] = translation.z;
  result[15] = 1.0;
  return result;
}
