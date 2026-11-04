/**
 * @module iconSet
 * @description A set of icons Core draws, held as typed-array columns: the only copy of
 * what was pushed. Each row is one icon, keyed by a string id and carrying an opaque
 * `meta` that comes back on picks. A row moves along its segment ({@link module:iconSegment})
 * on the renderer's clock, so the CPU writes a row only when its motion or style changes.
 *
 * Rows are packed: removing one moves the last row into its place, so the renderer
 * draws `count` instances and the CPU walks rows by index. Writes mark rows dirty per
 * column ({@link DirtyRows}) for the renderer to upload.
 *
 * Segment times are float32 seconds since the set's epoch. The renderer calls
 * {@link rebase} once a frame so they stay small (sub-millisecond steps) however
 * long the session runs.
 */
import * as Cesium from 'cesium';
import {
  SEGMENT_STRIDE,
  segmentCourse,
  segmentPosition,
  shiftSegmentTimes,
} from './iconSegment.js';

/** Floats per row of style: size, scale, alpha, atlas slots, flags, focus, near/far scaler. */
export const STYLE_STRIDE = 12;

const WIDTH = 0;
const HEIGHT = 1;
const SCALE = 2;
const ALPHA = 3;
const IMAGE_FAR = 4;
const IMAGE_NEAR = 5;
const FLAGS = 6;
const FOCUS = 7;
const NEAR_DISTANCE = 8;
const NEAR_VALUE = 9;
const FAR_DISTANCE = 10;
const FAR_VALUE = 11;

/** Row flags, combined in the style's flags float. */
export const ICON_SHOWN = 1;
/** Rotate the icon along its course on screen (otherwise upright). */
export const ICON_ROTATES = 2;
/** Fade and shrink toward the globe's limb (aircraft recession). */
export const ICON_RECEDES = 4;
/**
 * Judge the row at no lower than ICON_CULL_HEIGHT_M above the ellipsoid in the
 * horizon test. A fix near or below the ellipsoid (a grounded contact at geoid
 * −31 m before its floor warms) otherwise reads as beyond the limb.
 */
export const ICON_CULL_LIFT = 8;
/** The ellipsoid height a CULL_LIFT row is raised to for the horizon test. */
export const ICON_CULL_HEIGHT_M = 12;

/** Move the epoch forward once render times pass this many seconds. */
const REBASE_AFTER_SEC = 1800;

/**
 * Rows written since the last upload, for one column. Uploads go out as runs of
 * nearby rows, so a removal near the top and a write near the bottom send two
 * small runs rather than the whole column.
 */
export class DirtyRows {
  constructor(capacity) {
    this._marked = new Uint8Array(capacity);
    this._rows = [];
    this._all = false;
  }

  mark(row) {
    if (this._all || this._marked[row]) return;
    this._marked[row] = 1;
    this._rows.push(row);
  }

  markAll() {
    this._all = true;
  }

  get empty() {
    return !this._all && this._rows.length === 0;
  }

  /**
   * Coalesced `[from, to]` runs of dirty rows below `count`, merging rows closer
   * than `gap`; everything when marked all or when most rows are dirty.
   * @param {number} count
   * @param {number} [gap]
   * @returns {Array<[number, number]>}
   */
  runs(count, gap = 32) {
    if (count === 0) return [];
    if (this._all || this._rows.length * 4 > count) return [[0, count - 1]];
    const rows = this._rows.filter((row) => row < count).sort((a, b) => a - b);
    const runs = [];
    for (const row of rows) {
      const last = runs[runs.length - 1];
      if (last && row - last[1] <= gap) last[1] = row;
      else runs.push([row, row]);
    }
    return runs;
  }

  clear() {
    for (const row of this._rows) this._marked[row] = 0;
    this._rows.length = 0;
    this._all = false;
  }

  grow(capacity) {
    const marked = new Uint8Array(capacity);
    marked.set(this._marked);
    this._marked = marked;
    this.markAll();
  }
}

/**
 * @param {{ capacity?: number, epoch?: Cesium.JulianDate }} [options]
 */
export function createIconSet({ capacity = 1024, epoch } = {}) {
  capacity = Math.max(1, capacity);
  const rowOfId = new Map();
  let ids = [];
  let metas = [];
  let handles = [];
  let segments = new Float32Array(capacity * SEGMENT_STRIDE);
  let style = new Float32Array(capacity * STYLE_STRIDE);
  let colors = new Uint8Array(capacity * 4);
  // CPU only: until when (seconds since the epoch) the row's segment holds.
  let expires = new Float64Array(capacity);
  let count = 0;
  const epochTime = Cesium.JulianDate.clone(epoch ?? Cesium.JulianDate.now());

  const set = {
    /** Bumped when the columns are reallocated; the renderer rebuilds its buffers. */
    generation: 0,
    dirty: {
      segments: new DirtyRows(capacity),
      style: new DirtyRows(capacity),
      colors: new DirtyRows(capacity),
    },
    show: true,
    /** Called with a row's renderer handle when the row goes away. */
    onRelease: null,

    get count() {
      return count;
    },
    get capacity() {
      return capacity;
    },
    get segments() {
      return segments;
    },
    get style() {
      return style;
    },
    get colors() {
      return colors;
    },
    get epoch() {
      return epochTime;
    },

    /** Seconds since the set's epoch: the clock segments are written in. */
    seconds(julianDate) {
      return Cesium.JulianDate.secondsDifference(julianDate, epochTime);
    },

    /**
     * Move the epoch to `julianDate` once it is more than half an hour ahead,
     * shifting every stored time. Call between frames, never while a caller holds
     * times in the old base.
     * @returns {boolean} Whether it moved.
     */
    rebase(julianDate) {
      const shift = set.seconds(julianDate);
      if (shift < REBASE_AFTER_SEC) return false;
      for (let row = 0; row < count; row++) {
        shiftSegmentTimes(segments, row, -shift);
        expires[row] -= shift;
      }
      Cesium.JulianDate.clone(julianDate, epochTime);
      set.dirty.segments.markAll();
      return true;
    },

    has(id) {
      return rowOfId.has(id);
    },
    row(id) {
      return rowOfId.get(id) ?? -1;
    },
    idAt(row) {
      return ids[row];
    },
    metaAt(row) {
      return metas[row];
    },
    handleAt(row) {
      return handles[row];
    },
    setHandle(row, handle) {
      handles[row] = handle;
    },

    /**
     * Add a row (hidden, no image) or return the existing row for `id`.
     * @param {string} id
     * @param {*} [meta]
     * @returns {number} The row.
     */
    add(id, meta) {
      const existing = rowOfId.get(id);
      if (existing !== undefined) {
        metas[existing] = meta;
        return existing;
      }
      if (count === capacity) grow(capacity * 2);
      const row = count++;
      rowOfId.set(id, row);
      ids[row] = id;
      metas[row] = meta;
      handles[row] = undefined;
      segments.fill(0, row * SEGMENT_STRIDE, (row + 1) * SEGMENT_STRIDE);
      style.fill(0, row * STYLE_STRIDE, (row + 1) * STYLE_STRIDE);
      const o = row * STYLE_STRIDE;
      style[o + SCALE] = 1;
      style[o + ALPHA] = 1;
      style[o + FOCUS] = 1;
      style[o + IMAGE_FAR] = -1;
      style[o + IMAGE_NEAR] = -1;
      colors.fill(255, row * 4, row * 4 + 4);
      expires[row] = -Infinity;
      markRow(row);
      return row;
    },

    /** Remove `id`'s row; the last row moves into its place. */
    remove(id) {
      const row = rowOfId.get(id);
      if (row === undefined) return false;
      rowOfId.delete(id);
      const handle = handles[row];
      const last = --count;
      if (row !== last) {
        segments.copyWithin(
          row * SEGMENT_STRIDE,
          last * SEGMENT_STRIDE,
          (last + 1) * SEGMENT_STRIDE,
        );
        style.copyWithin(
          row * STYLE_STRIDE,
          last * STYLE_STRIDE,
          (last + 1) * STYLE_STRIDE,
        );
        colors.copyWithin(row * 4, last * 4, last * 4 + 4);
        expires[row] = expires[last];
        ids[row] = ids[last];
        metas[row] = metas[last];
        handles[row] = handles[last];
        rowOfId.set(ids[row], row);
        markRow(row);
      }
      ids[last] = undefined;
      metas[last] = undefined;
      handles[last] = undefined;
      if (handle !== undefined) set.onRelease?.(handle);
      return true;
    },

    clear() {
      for (let row = 0; row < count; row++)
        if (handles[row] !== undefined) set.onRelease?.(handles[row]);
      rowOfId.clear();
      ids = [];
      metas = [];
      handles = [];
      count = 0;
    },

    /** Mark a row's segment written (after a write*Segment call on `segments`). */
    segmentWritten(row, expiresAt = Infinity) {
      expires[row] = expiresAt;
      set.dirty.segments.mark(row);
    },
    /** Until when (seconds since the epoch) the row's segment holds. */
    expires(row) {
      return expires[row];
    },

    setShown(row, shown) {
      setFlag(row, ICON_SHOWN, shown);
    },
    shown(row) {
      return (style[row * STYLE_STRIDE + FLAGS] & ICON_SHOWN) !== 0;
    },
    setFlag(row, flag, on) {
      setFlag(row, flag, on);
    },
    flags(row) {
      return style[row * STYLE_STRIDE + FLAGS];
    },

    setSize(row, width, height) {
      const o = row * STYLE_STRIDE;
      if (
        style[o + WIDTH] === Math.fround(width) &&
        style[o + HEIGHT] === Math.fround(height)
      )
        return;
      style[o + WIDTH] = width;
      style[o + HEIGHT] = height;
      set.dirty.style.mark(row);
    },
    width(row) {
      return style[row * STYLE_STRIDE + WIDTH];
    },
    height(row) {
      return style[row * STYLE_STRIDE + HEIGHT];
    },

    setScale(row, scale) {
      writeStyle(row, SCALE, scale);
    },
    scale(row) {
      return style[row * STYLE_STRIDE + SCALE];
    },

    /** The row's own alpha; the renderer multiplies in recession and focus. */
    setAlpha(row, alpha) {
      writeStyle(row, ALPHA, alpha);
    },
    alpha(row) {
      return style[row * STYLE_STRIDE + ALPHA];
    },

    /** Focus de-emphasis factor, 1 when not de-emphasised. */
    setFocus(row, factor) {
      writeStyle(row, FOCUS, factor);
    },
    focus(row) {
      return style[row * STYLE_STRIDE + FOCUS];
    },

    /** Atlas slots: `far` for small on-screen sizes, `near` once the icon is large. */
    setImage(row, far, near = far) {
      const o = row * STYLE_STRIDE;
      if (style[o + IMAGE_FAR] === far && style[o + IMAGE_NEAR] === near)
        return;
      style[o + IMAGE_FAR] = far;
      style[o + IMAGE_NEAR] = near;
      set.dirty.style.mark(row);
    },
    imageFar(row) {
      return style[row * STYLE_STRIDE + IMAGE_FAR];
    },
    imageNear(row) {
      return style[row * STYLE_STRIDE + IMAGE_NEAR];
    },

    /** Size by camera distance, as Cesium's NearFarScalar (unset: 1 everywhere). */
    setScaleByDistance(row, scalar) {
      const o = row * STYLE_STRIDE;
      const near = scalar?.near ?? 0;
      const nearValue = scalar?.nearValue ?? 1;
      const far = scalar?.far ?? 0;
      const farValue = scalar?.farValue ?? 1;
      if (
        style[o + NEAR_DISTANCE] === Math.fround(near) &&
        style[o + NEAR_VALUE] === Math.fround(nearValue) &&
        style[o + FAR_DISTANCE] === Math.fround(far) &&
        style[o + FAR_VALUE] === Math.fround(farValue)
      )
        return;
      style[o + NEAR_DISTANCE] = near;
      style[o + NEAR_VALUE] = nearValue;
      style[o + FAR_DISTANCE] = far;
      style[o + FAR_VALUE] = farValue;
      set.dirty.style.mark(row);
    },
    scaleByDistance(row, result = new Cesium.NearFarScalar()) {
      const o = row * STYLE_STRIDE;
      result.near = style[o + NEAR_DISTANCE];
      result.nearValue = style[o + NEAR_VALUE];
      result.far = style[o + FAR_DISTANCE];
      result.farValue = style[o + FAR_VALUE];
      return result;
    },

    /** Tint as a Cesium.Color; its alpha multiplies the row's own alpha. */
    setColor(row, color) {
      const o = row * 4;
      const r = Cesium.Color.floatToByte(color.red);
      const g = Cesium.Color.floatToByte(color.green);
      const b = Cesium.Color.floatToByte(color.blue);
      const a = Cesium.Color.floatToByte(color.alpha);
      if (
        colors[o] === r &&
        colors[o + 1] === g &&
        colors[o + 2] === b &&
        colors[o + 3] === a
      )
        return;
      colors[o] = r;
      colors[o + 1] = g;
      colors[o + 2] = b;
      colors[o + 3] = a;
      set.dirty.colors.mark(row);
    },
    color(row, result = new Cesium.Color()) {
      const o = row * 4;
      return Cesium.Color.fromBytes(
        colors[o],
        colors[o + 1],
        colors[o + 2],
        colors[o + 3],
        result,
      );
    },

    /** Where the row is at `tau` (seconds since the epoch). */
    position(row, tau, result) {
      return segmentPosition(segments, row, tau, result);
    },
    /** The row's displayed course at `tau`, degrees clockwise from north. */
    course(row, tau) {
      return segmentCourse(segments, row, tau);
    },
    /** The point the horizon test judges for a row drawn at `position`. */
    cullPoint(row, position, result = new Cesium.Cartesian3()) {
      if (!(style[row * STYLE_STRIDE + FLAGS] & ICON_CULL_LIFT))
        return Cesium.Cartesian3.clone(position, result);
      // Height above the ellipsoid along the geocentric ray, as the shader
      // computes it: exact to millimetres this close to the surface.
      const radius = Cesium.Cartesian3.magnitude(position);
      Cesium.Cartesian3.multiplyComponents(
        position,
        Cesium.Ellipsoid.WGS84.oneOverRadii,
        result,
      );
      const height = radius * (1 - 1 / Cesium.Cartesian3.magnitude(result));
      const lift = Math.max(0, ICON_CULL_HEIGHT_M - height);
      Cesium.Cartesian3.normalize(position, result);
      Cesium.Cartesian3.multiplyByScalar(result, lift, result);
      return Cesium.Cartesian3.add(position, result, result);
    },
  };

  function markRow(row) {
    set.dirty.segments.mark(row);
    set.dirty.style.mark(row);
    set.dirty.colors.mark(row);
  }

  function writeStyle(row, field, value) {
    const o = row * STYLE_STRIDE + field;
    if (style[o] === Math.fround(value)) return;
    style[o] = value;
    set.dirty.style.mark(row);
  }

  function setFlag(row, flag, on) {
    const o = row * STYLE_STRIDE + FLAGS;
    const flags = style[o];
    const next = on ? flags | flag : flags & ~flag;
    if (next === flags) return;
    style[o] = next;
    set.dirty.style.mark(row);
  }

  function grow(next) {
    const s = new Float32Array(next * SEGMENT_STRIDE);
    s.set(segments);
    const st = new Float32Array(next * STYLE_STRIDE);
    st.set(style);
    const c = new Uint8Array(next * 4);
    c.set(colors);
    const e = new Float64Array(next);
    e.set(expires);
    segments = s;
    style = st;
    colors = c;
    expires = e;
    capacity = next;
    set.generation++;
    for (const rows of Object.values(set.dirty)) rows.grow(next);
  }

  return set;
}
