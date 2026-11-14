/**
 * @module detectionPaintCache
 * @description Lets the detection overlay keep what one paint built (bracket
 * paths, counts, callout candidates) and use it again on the next paint when
 * that paint would build exactly the same thing.
 *
 * Nothing announces a change to this cache. Each paint hands over the values
 * the sweep reads from the view and the objects the layers returned, and the
 * cache compares them, value by value, with what the kept paint was built
 * from. A layer therefore cannot leave a stale picture behind by forgetting to
 * say it changed: an object that moved, appeared, left or was relabelled is
 * seen here, and the sweep runs again.
 *
 * Pure: no Cesium, no DOM.
 */

/**
 * The object fields the detection sweep and its callout candidates read.
 * Position is compared separately, by coordinate. `sameFields` and
 * `recordFields` below name each of these outright, in this order, because a
 * field read by a name held in a variable costs several times as much, and
 * this runs for every object on every paint.
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

/**
 * After this many sweeps in a row with no reuse between them, the objects are
 * only recorded on every RECORD_STRIDE-th sweep. A scene whose objects move on
 * every paint can never reuse one, so recording each of them would be work
 * with no return; a scene that settles is picked up again within RECORD_STRIDE
 * paints.
 */
export const SWEEPS_BEFORE_BACKOFF = 8;
export const RECORD_STRIDE = 8;

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

/** Most fields are what they were at the last sweep; only the others are written. */
function recordFields(object, fields, f) {
  let value;
  if ((value = object._layerId) !== fields[f]) fields[f] = value;
  if ((value = object.type) !== fields[f + 1]) fields[f + 1] = value;
  if ((value = object.tier) !== fields[f + 2]) fields[f + 2] = value;
  if ((value = object.skipLabel) !== fields[f + 3]) fields[f + 3] = value;
  if ((value = object.id) !== fields[f + 4]) fields[f + 4] = value;
  if ((value = object.metric) !== fields[f + 5]) fields[f + 5] = value;
  if ((value = object.sourceId) !== fields[f + 6]) fields[f + 6] = value;
  if ((value = object.bracketHalfWidth) !== fields[f + 7])
    fields[f + 7] = value;
  if ((value = object.bracketHalfHeight) !== fields[f + 8])
    fields[f + 8] = value;
  if ((value = object.depthTested) !== fields[f + 9]) fields[f + 9] = value;
  if ((value = object.cardSourceId) !== fields[f + 10]) fields[f + 10] = value;
  if ((value = object.cardEntryId) !== fields[f + 11]) fields[f + 11] = value;
}

/**
 * @returns {{
 *   reuse: (view: Array, objects: Array<object>) => (object|null),
 *   keep: (view: Array, objects: Array<object>, built: object) => boolean,
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
  let sweepsSinceReuse = 0;

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
        // A coordinate that is not a number never equals the kept one, so such
        // an object is swept again on every paint.
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
     * What the kept paint built, when `view` and `objects` are what it was
     * built from; otherwise null.
     * @param {Array} view - Every value of the view the sweep reads, in a fixed order.
     * @param {Array<object>} objects - The objects the layers returned this paint.
     */
    reuse(view, objects) {
      if (!built || !sameView(view) || !sameObjects(objects)) return null;
      sweepsSinceReuse = 0;
      return built;
    },

    /**
     * Keep `result` as the result of sweeping `objects` under `view`.
     * @returns {boolean} False when recording was skipped (see RECORD_STRIDE).
     */
    keep(view, objects, result) {
      sweepsSinceReuse++;
      if (
        sweepsSinceReuse > SWEEPS_BEFORE_BACKOFF &&
        (sweepsSinceReuse - SWEEPS_BEFORE_BACKOFF) % RECORD_STRIDE !== 0
      ) {
        built = null;
        return false;
      }
      viewKept = view.slice();
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
        if (references[i] !== object) references[i] = object;
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
      return true;
    },

    /** Reuse nothing until the next `keep`. */
    forget() {
      built = null;
    },

    /** Forget the kept paint and let go of its objects. */
    clear() {
      built = null;
      viewKept = [];
      count = 0;
      references = [];
      fields = [];
      coordinates = new Float64Array(0);
      positioned = new Uint8Array(0);
      sweepsSinceReuse = 0;
    },
  };
}
