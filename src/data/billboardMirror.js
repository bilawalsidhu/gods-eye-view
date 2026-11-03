/**
 * @module billboardMirror
 * @description Core's copy of what a layer pushed to its billboards, so the layer
 * reads its own state back from Core instead of from the renderer's objects.
 *
 * A layer adds billboards with {@link addBillboard}, writes the mirrored fields
 * with {@link setBillboard}, and reads them with {@link billboardState}. Fields
 * outside the mirror (image, colour, eye offset, …) are written to the billboard
 * directly. Colour stays out because the cyber-sonar theme writes it too and
 * tells the two writers apart by reading the live value.
 */
import * as Cesium from 'cesium';
import { createEntityStore } from './entityRecords.js';

const mirrors = createEntityStore();

/**
 * Mirrored fields with Cesium's defaults for a billboard added without them.
 * Width and height have none: unset, Cesium reports the loaded image's size,
 * which Core cannot know, so {@link addBillboard} requires them.
 */
const DEFAULTS = Object.freeze({
  show: true,
  scale: 1,
  rotation: 0,
  width: undefined,
  height: undefined,
  scaleByDistance: undefined,
});

/** Cesium copies positions and scalers on write; the mirror keeps its own copy too. */
function copyInto(record, field, value) {
  if (field === 'position') {
    // Cesium keeps its old position when handed none; so does the mirror.
    if (!value && record.position) return;
    record.position = Cesium.Cartesian3.clone(
      value ?? Cesium.Cartesian3.ZERO,
      record.position,
    );
  } else if (field === 'scaleByDistance') {
    record.scaleByDistance = value
      ? Cesium.NearFarScalar.clone(value, record.scaleByDistance)
      : undefined;
  } else {
    record[field] = value;
  }
}

function seed(billboard, source) {
  const record = mirrors.write(billboard);
  copyInto(record, 'position', source.position);
  for (const [field, fallback] of Object.entries(DEFAULTS))
    copyInto(record, field, source[field] ?? fallback);
  return record;
}

/**
 * Add a billboard and remember what was pushed.
 * @param {Cesium.BillboardCollection} collection
 * @param {Object} options Billboard options, as for `collection.add`, with an
 *   explicit `width` and `height`.
 * @returns {Cesium.Billboard}
 */
export function addBillboard(collection, options) {
  if (!Number.isFinite(options?.width) || !Number.isFinite(options?.height))
    throw new TypeError(
      'A mirrored billboard needs an explicit width and height',
    );
  const billboard = collection.add(options);
  seed(billboard, options);
  return billboard;
}

/**
 * Start mirroring a billboard Core did not add itself (test seams), from its
 * current fields.
 * @param {Object} billboard
 * @returns {Object} The billboard.
 */
export function mirrorBillboard(billboard) {
  if (billboard && typeof billboard === 'object') seed(billboard, billboard);
  return billboard;
}

/**
 * Write one mirrored field to the billboard and to Core's copy.
 * @param {Object} billboard
 * @param {'show'|'position'|'scale'|'rotation'|'width'|'height'|'scaleByDistance'} field
 * @param {*} value
 */
export function setBillboard(billboard, field, value) {
  copyInto(mirrors.write(billboard), field, value);
  billboard[field] = value;
}

/**
 * Core's copy of a billboard's mirrored fields, or null when it has none (or
 * there is no billboard).
 * @param {Object|null|undefined} billboard
 * @returns {{ show: boolean, position: Cesium.Cartesian3, scale: number,
 *   rotation: number, width?: number, height?: number,
 *   scaleByDistance?: Cesium.NearFarScalar }|null}
 */
export function billboardState(billboard) {
  return mirrors.read(billboard);
}
