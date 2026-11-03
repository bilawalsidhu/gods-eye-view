/**
 * @module modelMirror
 * @description Core's copy of what a layer pushed to its 3D models, so the layer
 * reads its own placement back from Core instead of from the renderer's objects.
 *
 * A layer writes the mirrored fields with {@link setModel} and reads them with
 * {@link modelState}. What the renderer measures (`ready`, `computedScale`) is
 * still read from the model. Colour stays out for the same reason as on
 * billboards: the cyber-sonar theme writes it too and reads the live value.
 */
import * as Cesium from 'cesium';
import { createEntityStore } from './entityRecords.js';

const mirrors = createEntityStore();

/**
 * Core's record for `model`, made on first write with Cesium's defaults for a
 * model loaded without `show` or `modelMatrix` options (shown, at the identity).
 */
function recordFor(model) {
  const record = mirrors.write(model);
  if (!record.modelMatrix) {
    record.show = true;
    record.modelMatrix = Cesium.Matrix4.clone(Cesium.Matrix4.IDENTITY);
  }
  return record;
}

/**
 * Start mirroring a model Core did not write itself (test seams), from its
 * current fields.
 * @param {Object} model
 * @returns {Object} The model.
 */
export function mirrorModel(model) {
  if (!model || typeof model !== 'object') return model;
  const record = recordFor(model);
  record.show = model.show ?? true;
  if (model.modelMatrix)
    Cesium.Matrix4.clone(model.modelMatrix, record.modelMatrix);
  return model;
}

/**
 * Write one mirrored field to the model and to Core's copy. A matrix is copied
 * into both, so a shared scratch can be passed and reused straight after.
 * @param {Object} model
 * @param {'show'|'modelMatrix'} field
 * @param {*} value
 */
export function setModel(model, field, value) {
  if (field !== 'show' && field !== 'modelMatrix')
    throw new TypeError(`The model mirror does not hold ${field}`);
  const record = recordFor(model);
  if (field === 'modelMatrix') {
    Cesium.Matrix4.clone(value, record.modelMatrix);
    // Cesium clones the model's own matrix each frame, so write into it in place.
    if (model.modelMatrix) Cesium.Matrix4.clone(value, model.modelMatrix);
    else model.modelMatrix = Cesium.Matrix4.clone(value);
  } else {
    record[field] = value;
    model[field] = value;
  }
}

/**
 * Core's copy of a model's mirrored fields, or null when nothing was written to
 * it yet (or there is no model).
 * @param {Object|null|undefined} model
 * @returns {{ show: boolean, modelMatrix: Cesium.Matrix4 }|null}
 */
export function modelState(model) {
  return mirrors.read(model);
}
