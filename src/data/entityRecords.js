/**
 * @module entityRecords
 * @description Core-owned records for the entities layers draw, so layer state lives in Core
 * rather than on the renderer's objects. A layer writes the record for an entity it draws;
 * the tracked readout, follow camera, cockpit, share links and awareness read it back
 * through the entity the renderer hands them (a pick or the tracked entity).
 *
 * Fields a record may hold:
 * - `trackedId`: the normalized `layer:id` identity, e.g. `flights:a1b2c3`.
 * - `displayPosition()`: the layer's cached display position (the follow camera's
 *   anti-jitter contract: the value the camera settled on, never recomputed late).
 * - `visualPosition()`: where a 3D model is actually drawn, for the tracked card.
 * - `labelModel`: the tracked card's `{ title, details, accent, … }`.
 * - `selectionOrigin`: what started the selection (`'user'`, …).
 */

const records = new WeakMap();

/**
 * The record for `entity`, made empty on first use. For layers writing their own state.
 * @param {Object} entity An entity the layer draws.
 * @returns {Object}
 */
export function entityRecord(entity) {
  let record = records.get(entity);
  if (!record) {
    record = {};
    records.set(entity, record);
  }
  return record;
}

/**
 * The record for `entity`, or null when it has none (or there is no entity). For readers.
 * @param {Object|null|undefined} entity
 * @returns {Object|null}
 */
export function readEntityRecord(entity) {
  if (!entity || typeof entity !== 'object') return null;
  return records.get(entity) ?? null;
}

/**
 * Write `fields` into `entity`'s record and return the entity.
 * @param {Object} entity
 * @param {Object} fields Record fields to set.
 * @returns {Object} `entity`
 */
export function withEntityRecord(entity, fields) {
  Object.assign(entityRecord(entity), fields);
  return entity;
}
