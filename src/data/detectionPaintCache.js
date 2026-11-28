/**
 * @module detectionPaintCache
 * @description Lets the detection overlay use what one sweep built (its
 * bracket paths and counts; detection.js keeps the callout candidates beside
 * it) again on a later paint whose view and objects are exactly the ones that
 * sweep read. Nothing announces a change:
 * each paint hands over its view values and objects, and the cache compares
 * them value by value, so an object that moved, appeared, left or was
 * relabelled is always swept again. Pure: no Cesium, no DOM.
 */

/**
 * The object fields the detection sweep and its callout candidates read;
 * position is compared separately, by coordinate. `sameFields` and
 * `recordFields` name each of them outright, in this order (a field read by a
 * name held in a variable costs several times as much on every object of
 * every paint), so a field added here must be added to both.
 */
export const PAINTED_OBJECT_FIELDS = Object.freeze([
  '_layerId',
  'type',
  'tier',
  'skipLabel',
  'id',
  'metric',
  'sourceId',
  'bracketHalfWidth',
  'bracketHalfHeight',
  'depthTested',
  'cardSourceId',
  'cardEntryId',
]);

const FIELD_COUNT = PAINTED_OBJECT_FIELDS.length;

function sameFields(object, fields, f) {
  return (
    object._layerId === fields[f] &&
    object.type === fields[f + 1] &&
    object.tier === fields[f + 2] &&
    object.skipLabel === fields[f + 3] &&
    object.id === fields[f + 4] &&
    object.metric === fields[f + 5] &&
    object.sourceId === fields[f + 6] &&
    object.bracketHalfWidth === fields[f + 7] &&
    object.bracketHalfHeight === fields[f + 8] &&
    object.depthTested === fields[f + 9] &&
    object.cardSourceId === fields[f + 10] &&
    object.cardEntryId === fields[f + 11]
  );
}

function recordFields(object, fields, f) {
  fields[f] = object._layerId;
  fields[f + 1] = object.type;
  fields[f + 2] = object.tier;
  fields[f + 3] = object.skipLabel;
  fields[f + 4] = object.id;
  fields[f + 5] = object.metric;
  fields[f + 6] = object.sourceId;
  fields[f + 7] = object.bracketHalfWidth;
  fields[f + 8] = object.bracketHalfHeight;
  fields[f + 9] = object.depthTested;
  fields[f + 10] = object.cardSourceId;
  fields[f + 11] = object.cardEntryId;
}

/**
 * @returns {{
 *   reuse: (view: Array, objects: Array<object>) => (object|null),
 *   keep: (view: Array, objects: Array<object>, result: object) => void,
 *   forget: () => void,
 *   clear: () => void,
 * }}
 */
export function createDetectionPaintCache() {
  let built = null;
  let viewKept = [];
  let count = 0;
  let references = [];
  let fields = [];
  let coordinates = new Float64Array(0);
  let positioned = new Uint8Array(0);

  /** Let go of the recorded objects from index `from` on. */
  function release(from) {
    references.fill(undefined, from, count);
    fields.fill(undefined, from * FIELD_COUNT, count * FIELD_COUNT);
  }

  function forget() {
    built = null;
    release(0);
    count = 0;
  }

  function sameView(view) {
    if (view.length !== viewKept.length) return false;
    for (let i = 0; i < view.length; i++)
      if (view[i] !== viewKept[i]) return false;
    return true;
  }

  function sameObjects(objects) {
    if (objects.length !== count) return false;
    for (let i = 0, c = 0, f = 0; i < count; i++, c += 3, f += FIELD_COUNT) {
      const object = objects[i];
      if (object !== references[i]) return false;
      const position = object.position;
      if (position) {
        if (
          positioned[i] !== 1 ||
          position.x !== coordinates[c] ||
          position.y !== coordinates[c + 1] ||
          position.z !== coordinates[c + 2]
        )
          return false;
      } else if (positioned[i] !== 0) {
        return false;
      }
      if (!sameFields(object, fields, f)) return false;
    }
    return true;
  }

  return {
    /**
     * What the kept paint built, when `view` (every view value the sweep reads,
     * in a fixed order) and `objects` are what it was built from; otherwise null.
     */
    reuse(view, objects) {
      if (!built || !sameView(view) || !sameObjects(objects)) return null;
      return built;
    },

    /**
     * Keep `result` as the result of sweeping `objects` under `view`. `view` is
     * kept as it is, so the caller hands over a new array on each paint.
     */
    keep(view, objects, result) {
      viewKept = view;
      if (objects.length < count) release(objects.length);
      count = objects.length;
      if (positioned.length < count) {
        // Room to spare, so a feed that grows by a few contacts a poll does
        // not allocate on each of them.
        const room = Math.ceil(count * 1.25);
        coordinates = new Float64Array(room * 3);
        positioned = new Uint8Array(room);
        references = new Array(room).fill(undefined);
        fields = new Array(room * FIELD_COUNT).fill(undefined);
      }
      for (let i = 0, c = 0, f = 0; i < count; i++, c += 3, f += FIELD_COUNT) {
        const object = objects[i];
        references[i] = object;
        const position = object.position;
        positioned[i] = position ? 1 : 0;
        if (position) {
          coordinates[c] = position.x;
          coordinates[c + 1] = position.y;
          coordinates[c + 2] = position.z;
        }
        recordFields(object, fields, f);
      }
      built = result;
    },

    /** Reuse nothing until the next `keep`, and let go of the recorded objects. */
    forget,

    /** As `forget`, and also drop the kept view and the recording buffers. */
    clear() {
      built = null;
      viewKept = [];
      count = 0;
      references = [];
      fields = [];
      coordinates = new Float64Array(0);
      positioned = new Uint8Array(0);
    },
  };
}
