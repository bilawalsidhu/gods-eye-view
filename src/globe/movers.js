// engine.movers, the engine-neutral part: the options of a set of moving
// objects (sprites, points, models) and the flat per-instance store every
// engine draws from. Layers write instances with set(); an engine uploads
// what changed on commit(). Positions are src/geo Cartesian3 values (ECEF
// metres), colours rgba in 0..1, rotations radians. No engine imports.

export const MOVER_KINDS = Object.freeze(['sprite', 'point', 'model']);
const MOVER_DEPTH_TESTS = Object.freeze(['normal', 'always']);

const isFiniteNumber = (value) =>
  typeof value === 'number' && Number.isFinite(value);
const isObject = (value) => value != null && typeof value === 'object';

function fail(message) {
  throw new TypeError(`Mover set: ${message}`);
}

function positive(value, label) {
  if (!(isFiniteNumber(value) && value > 0))
    fail(`${label} must be a positive number: ${value}`);
  return value;
}

function nonNegative(value, label, fallback) {
  if (value === undefined) return fallback;
  if (!(isFiniteNumber(value) && value >= 0))
    fail(`${label} must be a number >= 0: ${value}`);
  return value;
}

function depthTestOf(value = 'normal') {
  if (MOVER_DEPTH_TESTS.includes(value)) return value;
  if (isObject(value) && isFiniteNumber(value.disableWithinM))
    return {
      disableWithinM: nonNegative(value.disableWithinM, 'disableWithinM'),
    };
  return fail(`depthTest must be 'normal', 'always' or { disableWithinM }`);
}

function scaleByDistanceOf(value) {
  if (value == null) return null;
  if (
    !Array.isArray(value) ||
    value.length !== 4 ||
    !value.every(isFiniteNumber)
  )
    fail('scaleByDistance must be [nearM, nearScale, farM, farScale]');
  return Object.freeze([...value]);
}

function atlasOf(atlas) {
  if (!isObject(atlas) || !(atlas.url || atlas.canvas))
    fail('sprite.atlas needs a url or a canvas');
  if (!isObject(atlas.cells) || !Object.keys(atlas.cells).length)
    fail('sprite.atlas.cells must name at least one cell');
  for (const [key, rect] of Object.entries(atlas.cells))
    if (
      !Array.isArray(rect) ||
      rect.length !== 4 ||
      !rect.every((value) => isFiniteNumber(value) && value >= 0 && value <= 1)
    )
      fail(`atlas cell ${key} must be [u0, v0, u1, v1] in 0..1`);
  return atlas;
}

/**
 * The createSet options with defaults filled in, or a TypeError.
 * @returns {{ id: string, kind: string, capacity: number, order: number,
 *   depthTest: 'normal'|'always'|{ disableWithinM: number }, pickable: boolean, sharpen: boolean,
 *   cellKeys: string[], sprite: object | null, point: object | null,
 *   model: object | null }}
 */
export function normalizeMoverSetOptions(options) {
  if (!isObject(options)) fail('options must be an object');
  const { id, kind, capacity } = options;
  if (typeof id !== 'string' || !id) fail('id must be a non-empty string');
  if (!MOVER_KINDS.includes(kind))
    fail(`kind must be one of ${MOVER_KINDS.join(', ')}: ${kind}`);
  if (!(Number.isInteger(capacity) && capacity > 0))
    fail(`capacity must be a positive integer: ${capacity}`);
  const order = options.order ?? 0;
  if (!isFiniteNumber(order)) fail(`order must be a number: ${order}`);
  if (options.sharpen !== undefined && typeof options.sharpen !== 'boolean')
    fail('sharpen must be a boolean');
  if (options.sharpen && kind === 'model')
    fail('sharpen applies to sprites and points');
  const normalized = {
    id,
    kind,
    capacity,
    order,
    depthTest: depthTestOf(options.depthTest),
    pickable: options.pickable === true,
    sharpen: options.sharpen === true,
    cellKeys: [],
    sprite: null,
    point: null,
    model: null,
  };
  if (kind === 'sprite') {
    const sprite = options.sprite;
    if (!isObject(sprite)) fail('a sprite set needs sprite options');
    normalized.sprite = {
      atlas: atlasOf(sprite.atlas),
      sizePx: positive(sprite.sizePx, 'sprite.sizePx'),
      scaleByDistance: scaleByDistanceOf(sprite.scaleByDistance),
    };
    normalized.cellKeys = Object.keys(sprite.atlas.cells);
  } else if (kind === 'point') {
    const point = options.point;
    if (!isObject(point)) fail('a point set needs point options');
    const outlineColor = point.outlineColor ?? [0, 0, 0, 1];
    if (
      !Array.isArray(outlineColor) ||
      outlineColor.length !== 4 ||
      !outlineColor.every(
        (value) => isFiniteNumber(value) && value >= 0 && value <= 1,
      )
    )
      fail('point.outlineColor must be [r, g, b, a] in 0..1');
    normalized.point = {
      outlineColor: Object.freeze([...outlineColor]),
      sizePx: positive(point.sizePx, 'point.sizePx'),
      outlinePx: nonNegative(point.outlinePx, 'point.outlinePx', 0),
      scaleByDistance: scaleByDistanceOf(point.scaleByDistance),
      translucencyByDistance: scaleByDistanceOf(point.translucencyByDistance),
    };
  } else {
    const model = options.model;
    if (!isObject(model) || typeof model.url !== 'string' || !model.url)
      fail('a model set needs model.url');
    const blend = model.colorBlend ?? null;
    if (
      blend !== null &&
      !(
        isObject(blend) &&
        ['mix', 'replace'].includes(blend.mode) &&
        isFiniteNumber(blend.amount ?? 0.5)
      )
    )
      fail("model.colorBlend must be { mode: 'mix'|'replace', amount }");
    normalized.model = {
      url: model.url,
      minimumPixelSize: nonNegative(
        model.minimumPixelSize,
        'model.minimumPixelSize',
        0,
      ),
      colorBlend: blend
        ? { mode: blend.mode, amount: blend.amount ?? 0.5 }
        : null,
      unlit: model.unlit === true,
    };
  }
  return normalized;
}

/**
 * The per-instance store of one set: flat typed arrays the engines read,
 * and the range of indices changed since the last clean().
 */
export function createMoverStore(options) {
  const { capacity, cellKeys, kind } = options;
  const cellIndex = new Map(cellKeys.map((key, index) => [key, index]));
  let positions = new Float64Array(capacity * 3);
  let orientations = new Float64Array(capacity * 4);
  let colors = new Float32Array(capacity * 4).fill(1);
  let outlineColors = kind === 'point' ? new Float32Array(capacity * 4) : null;
  if (outlineColors)
    for (let index = 0; index < capacity; index++)
      outlineColors.set(options.point.outlineColor, index * 4);
  let rotations = new Float32Array(capacity);
  let scales = new Float32Array(capacity).fill(1);
  let cells = new Uint16Array(capacity);
  let shows = new Uint8Array(capacity).fill(1);
  let pickIds = new Array(capacity);
  for (let index = 0; index < capacity; index++)
    orientations[index * 4 + 3] = 1;
  let count = 0;
  const range = { from: 0, to: 0 };
  let dirtyFrom = Infinity;
  let dirtyTo = -Infinity;
  const touch = (from, to) => {
    if (from < dirtyFrom) dirtyFrom = from;
    if (to > dirtyTo) dirtyTo = to;
  };

  // Validates before writing anything, so a refused set() changes nothing.
  function check(index, fields) {
    if (!(Number.isInteger(index) && index >= 0 && index < capacity))
      throw new TypeError(`Mover index ${index} is outside [0, ${capacity})`);
    if (!isObject(fields))
      throw new TypeError('Mover fields must be an object');
    const { position, orientation, color, rotation, scale, cell } = fields;
    if (
      position !== undefined &&
      !(
        isObject(position) &&
        isFiniteNumber(position.x) &&
        isFiniteNumber(position.y) &&
        isFiniteNumber(position.z)
      )
    )
      throw new TypeError('Mover position must be a finite Cartesian3');
    if (
      orientation !== undefined &&
      !(
        isObject(orientation) &&
        isFiniteNumber(orientation.x) &&
        isFiniteNumber(orientation.y) &&
        isFiniteNumber(orientation.z) &&
        isFiniteNumber(orientation.w)
      )
    )
      throw new TypeError('Mover orientation must be a quaternion');
    if (
      color !== undefined &&
      !(
        (Array.isArray(color) || ArrayBuffer.isView(color)) &&
        color.length === 4 &&
        isFiniteNumber(color[0]) &&
        isFiniteNumber(color[1]) &&
        isFiniteNumber(color[2]) &&
        isFiniteNumber(color[3])
      )
    )
      throw new TypeError('Mover color must be [r, g, b, a]');
    if (
      fields.outlineColor !== undefined &&
      (kind !== 'point' ||
        !(
          Array.isArray(fields.outlineColor) ||
          ArrayBuffer.isView(fields.outlineColor)
        ) ||
        fields.outlineColor.length !== 4 ||
        !Array.from(fields.outlineColor).every(
          (v) => isFiniteNumber(v) && v >= 0 && v <= 1,
        ))
    )
      throw new TypeError('Mover outlineColor must be point rgba in 0..1');
    if (rotation !== undefined && !isFiniteNumber(rotation))
      throw new TypeError('Mover rotation must be a number');
    if (scale !== undefined && !(isFiniteNumber(scale) && scale >= 0))
      throw new TypeError('Mover scale must be a number >= 0');
    if (cell !== undefined && !cellIndex.has(cell))
      throw new TypeError(`Mover cell ${cell} is not in the ${kind} atlas`);
  }

  return {
    capacity,
    positions,
    orientations,
    colors,
    outlineColors,
    rotations,
    scales,
    cells,
    shows,
    pickIds,
    cellKeys,
    get count() {
      return count;
    },
    set(index, fields) {
      check(index, fields);
      const { position, orientation, color, rotation, scale, cell, show } =
        fields;
      if (position) {
        positions[index * 3] = position.x;
        positions[index * 3 + 1] = position.y;
        positions[index * 3 + 2] = position.z;
      }
      if (orientation) {
        orientations[index * 4] = orientation.x;
        orientations[index * 4 + 1] = orientation.y;
        orientations[index * 4 + 2] = orientation.z;
        orientations[index * 4 + 3] = orientation.w;
      }
      if (color)
        for (let channel = 0; channel < 4; channel++)
          colors[index * 4 + channel] = color[channel];
      if (fields.outlineColor)
        outlineColors.set(fields.outlineColor, index * 4);
      if (rotation !== undefined) rotations[index] = rotation;
      if (scale !== undefined) scales[index] = scale;
      if (cell !== undefined) cells[index] = cellIndex.get(cell);
      if (show !== undefined) shows[index] = show ? 1 : 0;
      if ('pickId' in fields) pickIds[index] = fields.pickId;
      touch(index, index + 1);
    },
    setCount(next) {
      if (!(Number.isInteger(next) && next >= 0 && next <= capacity))
        throw new RangeError(`Mover count ${next} is outside [0, ${capacity}]`);
      if (next !== count) touch(Math.min(count, next), Math.max(count, next));
      count = next;
    },
    positionsView: () => positions.subarray(0, count * 3),
    /**
     * Drops the instance arrays (a destroyed set): the count goes to 0 and
     * the arrays to empty ones, so a set object still held keeps no memory.
     */
    release() {
      count = 0;
      positions = new Float64Array(0);
      orientations = new Float64Array(0);
      colors = new Float32Array(0);
      outlineColors = outlineColors ? new Float32Array(0) : null;
      rotations = new Float32Array(0);
      scales = new Float32Array(0);
      cells = new Uint16Array(0);
      shows = new Uint8Array(0);
      pickIds = [];
      Object.assign(this, {
        positions,
        orientations,
        colors,
        outlineColors,
        rotations,
        scales,
        cells,
        shows,
        pickIds,
      });
      this.clean();
    },
    /**
     * Indices changed since clean(), as [from, to) (one object, reused: read
     * it at once), or null.
     */
    dirty() {
      if (dirtyFrom === Infinity) return null;
      range.from = dirtyFrom;
      range.to = dirtyTo;
      return range;
    },
    clean() {
      dirtyFrom = Infinity;
      dirtyTo = -Infinity;
    },
  };
}

/**
 * The MoverSet a layer holds, over a store and the engine's own commit and
 * destroy. commit() hands the engine the changed range and cleans the store;
 * a destroyed set refuses every call but destroy().
 */
export function createMoverSet(
  store,
  { id, commit, destroy, ready = () => true, failed = () => false },
) {
  let destroyed = false;
  const alive = () => {
    if (destroyed) throw new Error('Mover set was destroyed');
  };
  return {
    // The set's id (createSet's `id`): surface exclusion and picks name it.
    id,
    set(index, fields) {
      alive();
      store.set(index, fields);
    },
    setCount(count) {
      alive();
      store.setCount(count);
    },
    count: () => store.count,
    commit() {
      alive();
      commit();
      store.clean();
    },
    // Whether what it draws has loaded (a model's glTF, an atlas image); with
    // an index, what that instance draws.
    ready: (index) => !destroyed && ready(index) === true,
    // Whether that load failed for good (the set is not tried again).
    failed: (index) => !destroyed && failed(index) === true,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      destroy();
      store.release();
    },
    isDestroyed: () => destroyed,
  };
}

/**
 * engine.movers over an engine's own drawing: `build(options, store)` makes
 * the engine part of one set ({ commit, destroy }, both called with the
 * set's store already holding the instances). Set ids are unique while the
 * set lives. destroyAll() is for the engine's destroy.
 * @returns {{ movers: { createSet: Function, list: Function },
 *   sets: Map<string, object>, destroyAll: () => void }}
 */
export function createMoverRegistry(build) {
  const sets = new Map();
  const movers = {
    createSet(input) {
      const options = normalizeMoverSetOptions(input);
      if (sets.has(options.id))
        throw new Error(`Mover set ${options.id} already exists`);
      const store = createMoverStore(options);
      const part = build(options, store);
      const entry = { options, store, part, set: null };
      entry.set = createMoverSet(store, {
        id: options.id,
        commit: () => part.commit(),
        destroy: () => {
          sets.delete(options.id);
          part.destroy();
        },
        ready: (index) => (part.ready ? part.ready(index) : true),
        failed: (index) => part.failed?.(index) === true,
      });
      sets.set(options.id, entry);
      return entry.set;
    },
    list: () =>
      [...sets.values()].map(({ options, store }) => ({
        id: options.id,
        kind: options.kind,
        count: store.count,
        capacity: store.capacity,
        shown: store.shows.subarray(0, store.count).some(Boolean),
      })),
  };
  return {
    movers,
    sets,
    destroyAll() {
      for (const entry of [...sets.values()]) entry.set.destroy();
    },
  };
}
