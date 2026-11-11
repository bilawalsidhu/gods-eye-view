// The wildlife layer's drawing on the globe contract (engine.movers and
// engine.lines), the same on every engine. A sprite bank keeps one sprite
// mover set and hands out handles whose index moves when another handle is
// removed; the set is rebuilt larger when it fills, or with a new atlas.

const FIRST_CAPACITY = 64;
const FIELDS = ['position', 'color', 'scale', 'cell', 'show'];

/** One sprite of a bank. Writes go to the bank's mover set at once. */
class WildlifeSprite {
  constructor(bank, fields) {
    this.bank = bank;
    this.index = -1;
    this.fields = fields;
  }
  get position() {
    return this.fields.position;
  }
  set position(value) {
    this.bank.write(this, { position: value });
  }
  get show() {
    return this.fields.show;
  }
  set show(value) {
    this.bank.write(this, { show: value === true });
  }
  get color() {
    return this.fields.color;
  }
  set color(value) {
    this.bank.write(this, { color: value });
  }
  get scale() {
    return this.fields.scale;
  }
  set scale(value) {
    this.bank.write(this, { scale: value });
  }
  get cell() {
    return this.fields.cell;
  }
  set cell(value) {
    this.bank.write(this, { cell: value });
  }
  get id() {
    return this.fields.pickId;
  }
}

/**
 * A growing sprite mover set: `add(fields)` returns a handle with position,
 * show, color, scale and cell properties; `id` becomes the instance pickId.
 * Writes are stored at once and drawn after commit().
 * @param {object} engine The globe engine.
 * @param {{ id: string, order?: number, pickable?: boolean,
 *   depthTest?: 'normal'|'always'|{ disableWithinM: number },
 *   sprite: { atlas: object, sizePx: number, scaleByDistance?: number[] } }} options
 */
export function createWildlifeSpriteBank(engine, options) {
  const handles = [];
  let atlas = options.sprite.atlas;
  let set = null;
  let capacity = 0;
  let dirty = false;

  function full(handle) {
    const fields = {};
    for (const key of FIELDS)
      if (handle.fields[key] !== undefined) fields[key] = handle.fields[key];
    if ('pickId' in handle.fields) fields.pickId = handle.fields.pickId;
    return fields;
  }

  function build(wanted) {
    set?.destroy();
    set = engine.movers.createSet({
      id: options.id,
      kind: 'sprite',
      capacity: wanted,
      order: options.order ?? 0,
      depthTest: options.depthTest ?? 'always',
      pickable: options.pickable === true,
      sprite: { ...options.sprite, atlas },
    });
    capacity = wanted;
    handles.forEach((handle, index) => set.set(index, full(handle)));
    set.setCount(handles.length);
    dirty = true;
  }

  function ensure(count) {
    if (set && count <= capacity) return;
    let next = Math.max(FIRST_CAPACITY, capacity);
    while (next < count) next *= 2;
    build(next);
  }

  return {
    /** A new sprite: { position, cell?, color?, scale?, show?, id? }. */
    add({ id, ...rest } = {}) {
      const fields = { color: [1, 1, 1, 1], scale: 1, show: true, ...rest };
      if (id !== undefined) fields.pickId = id;
      const handle = new WildlifeSprite(this, fields);
      ensure(handles.length + 1);
      handle.index = handles.length;
      handles.push(handle);
      set.set(handle.index, full(handle));
      set.setCount(handles.length);
      dirty = true;
      return handle;
    },
    /** Removes a sprite; the last one takes its index. */
    remove(handle) {
      if (handle?.bank !== this || handle.index < 0) return false;
      const last = handles.pop();
      if (last !== handle) {
        handles[handle.index] = last;
        last.index = handle.index;
        set.set(last.index, full(last));
      }
      handle.index = -1;
      set.setCount(handles.length);
      dirty = true;
      return true;
    },
    removeAll() {
      for (const handle of handles) handle.index = -1;
      handles.length = 0;
      set?.setCount(0);
      dirty = true;
    },
    write(handle, fields) {
      Object.assign(handle.fields, fields);
      if (handle.index < 0 || !set) return;
      set.set(handle.index, fields);
      dirty = true;
    },
    /** Rebuilds the set on another atlas (same cells), keeping every sprite. */
    setAtlas(next) {
      if (next === atlas) return false;
      atlas = next;
      if (set) build(capacity);
      return true;
    },
    /** Uploads what changed since the last commit; false when nothing did. */
    commit() {
      if (!dirty || !set) return false;
      dirty = false;
      set.commit();
      return true;
    },
    get length() {
      return handles.length;
    },
    get(index) {
      return handles[index];
    },
    get handles() {
      return handles;
    },
    get set() {
      return set;
    },
    destroy() {
      for (const handle of handles) handle.index = -1;
      handles.length = 0;
      set?.destroy();
      set = null;
      capacity = 0;
      dirty = false;
    },
  };
}

/**
 * Cesium's NearFarScalar interpolation over [nearM, nearValue, farM,
 * farValue]: over the squared camera distance, eased by ^0.2.
 */
export function wildlifeNearFarValue(scalar, distance) {
  const [near, nearValue, far, farValue] = scalar;
  const nearSq = near * near;
  const farSq = far * far;
  if (!(farSq > nearSq)) return distance <= near ? nearValue : farValue;
  const t = Math.min(
    1,
    Math.max(0, (distance * distance - nearSq) / (farSq - nearSq)),
  );
  return nearValue + (farValue - nearValue) * t ** 0.2;
}

/**
 * The CSS-pixel diameter of a camera-facing square `metres` wide at
 * `position`, as Cesium draws a billboard sized in metres: its eye-space
 * depth along the view direction sets the size. Undefined behind the camera.
 */
export function wildlifeMetresToPixels(metres, position, view) {
  const dx = position.x - view.position.x;
  const dy = position.y - view.position.y;
  const dz = position.z - view.position.z;
  const depth =
    dx * view.direction.x + dy * view.direction.y + dz * view.direction.z;
  if (!(depth > 0)) return undefined;
  return (metres * view.focalPx) / depth;
}

/** The camera as wildlifeMetresToPixels reads it, from the engine. */
export function wildlifeCameraView(engine) {
  const pose = engine.camera.pose();
  const { height } = engine.host.size();
  return {
    position: pose.position,
    direction: pose.direction,
    focalPx: height / (2 * Math.tan(pose.fovy / 2)),
  };
}
