/**
 * @module modelRecord
 * @description A layer's own record of one 3D model it draws, held in the
 * layer's maps under the contact's id, so the layer reads what it pushed back
 * from itself instead of from the renderer's object.
 *
 * Write `show` and the placement with {@link showModel} and {@link placeModel};
 * read them from the record. What the renderer measures (`ready`,
 * `computedScale`) is still read from `record.model`. Colour stays out: the
 * cyber-sonar theme writes it too and reads the live value.
 */
import * as Cesium from 'cesium';

/**
 * @typedef {object} ModelRecord
 * @property {Cesium.Model} model
 * @property {boolean} show Whether the layer last showed the model.
 * @property {Cesium.Matrix4} matrix Where the layer last placed it.
 * @property {string|null} specKey The model spec it was loaded for; a class
 *   change reloads.
 * @property {boolean|null} irBoost The IR boost it was loaded with; a flip
 *   reloads.
 * @property {number} bellyM Metres from the model origin to its belly, to sit
 *   it on the ground.
 */

/**
 * A record for a model the layer just made, from the options it made it with
 * (Cesium's defaults when none: shown, at the identity).
 * @param {Cesium.Model} model
 * @param {{specKey?: string, irBoost?: boolean, bellyM?: number}} [fields]
 * @returns {ModelRecord}
 */
export function createModelRecord(
  model,
  { specKey = null, irBoost = null, bellyM = 0 } = {},
) {
  return {
    model,
    show: model.show ?? true,
    matrix: Cesium.Matrix4.clone(model.modelMatrix ?? Cesium.Matrix4.IDENTITY),
    specKey,
    irBoost,
    bellyM,
  };
}

/**
 * Show or hide a model and record it.
 * @param {ModelRecord} record
 * @param {boolean} show
 */
export function showModel(record, show) {
  record.show = show;
  record.model.show = show;
}

/**
 * Place a model and record where. The matrix is copied into both, so a shared
 * scratch can be passed and reused straight after.
 * @param {ModelRecord} record
 * @param {Cesium.Matrix4} matrix
 */
export function placeModel(record, matrix) {
  Cesium.Matrix4.clone(matrix, record.matrix);
  const model = record.model;
  // Cesium clones the model's own matrix each frame, so write into it in place.
  if (model.modelMatrix) Cesium.Matrix4.clone(matrix, model.modelMatrix);
  else model.modelMatrix = Cesium.Matrix4.clone(matrix);
}

/**
 * Whether a record's model is what the user sees: loaded and shown.
 * @param {ModelRecord|null|undefined} record
 * @returns {boolean}
 */
export function modelIsRendering(record) {
  return !!record && record.model.ready === true && record.show === true;
}
