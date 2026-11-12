/**
 * @module iconSet
 * @description A set of icons the app draws, held as typed-array columns: the only copy of
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
import { WGS84 } from '../geo/ellipsoid.js';
import { HORIZON_LIFT_M } from '../geo/horizon.js';
import { cloneJulian, julianNow, secondsDifference } from '../geo/julian.js';
import {
  SEGMENT_STRIDE,
  segmentCourse,
  segmentPosition,
  shiftSegmentTimes,
} from './iconSegment.js';

/**
 * Floats per row of style: size, scale, alpha, atlas slots, flags, focus,
 * near/far scaler, near-image switch, pick proxy and depth-test distance.
 */
export const STYLE_STRIDE = 16;

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
const IMAGE_SWITCH = 12;
const PROXY_WIDTH = 13;
const PROXY_HEIGHT = 14;
const DEPTH_TEST_DISTANCE = 15;

/**
 * Floats per row of extras, as `ICON_EXTRA_TEXELS` RGBA texels the renderer
 * reads by instance: the screen offset, anchor and rotation; the fade by
 * distance; the aligned axis and display range; the ground mode and the
 * ground heights under the segment's two ends, and those ends. All zero (the
 * default) is none of them.
 */
export const ICON_EXTRA_TEXELS = 6;
export const EXTRA_STRIDE = ICON_EXTRA_TEXELS * 4;

const OFFSET_X = 0;
const OFFSET_Y = 1;
const ANCHOR = 2;
const ROTATION = 3;
const FADE_NEAR = 4;
const FADE_NEAR_VALUE = 5;
const FADE_FAR = 6;
const FADE_FAR_VALUE = 7;
const AXIS_X = 8;
const AXIS_Y = 9;
const AXIS_Z = 10;
const RANGE_NEAR = 11;
const RANGE_FAR = 12;
const GROUND_MODE = 13;
const GROUND_FROM = 14;
const GROUND_TO = 15;
const SPAN_FROM = 16;
const SPAN_TO = 20;

/** Ground modes of a row's extras. */
export const ICON_GROUND_NONE = 0;
/** Drawn on the ground under it. */
export const ICON_GROUND_CLAMP = 1;
/** Drawn its height above the ground under it. */
export const ICON_GROUND_RELATIVE = 2;

/**
 * A depth-test distance at or past this draws over depth at any distance
 * (Infinity, which a float column does not carry through every GPU).
 */
export const ICON_ALWAYS_OVER_DEPTH = 1e30;

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
export const ICON_CULL_HEIGHT_M = HORIZON_LIFT_M;
/**
 * Contacts whose fix is below this height (m) get CULL_LIFT in the aircraft
 * layers' icon sets; theirs are the only rows flagged by height.
 *
 * Through the draw port a `horizonCull` set flags every row, so every row
 * drawn below ICON_CULL_HEIGHT_M is lifted. The two agree on every row this
 * rule flags (lifted either way) and every row drawn at or above
 * ICON_CULL_HEIGHT_M (no lift either way). They differ only on rows this
 * rule leaves unflagged (fix at or above 10 m) while drawn below 12 m: a
 * contact between 10 and 12 m (judged up to 2 m higher), or one whose drawn
 * position sits lower than its fix (a climb-out from a lower earlier fix, a
 * dead-reckoned ground drift). The port judges those higher, so it never
 * hides what this rule shows, and shows near-ground contacts at the limb that
 * this rule culled, which is what the lift is for.
 */
export const ICON_CULL_LIFT_BELOW_M = 10;

/** Move the epoch once render times are this many seconds from it. */
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

/** A 0..1 colour channel as a byte, as the default renderer's `Color.floatToByte`. */
const floatToByte = (value) => (value === 1.0 ? 255.0 : (value * 256.0) | 0);

/**
 * @param {{ capacity?: number,
 *   epoch?: {dayNumber: number, secondsOfDay: number} }} [options] `epoch`
 *   is a Julian date (`geo/julian.js`, or the renderer's own, which is the
 *   same numbers).
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
  let extras = new Float32Array(capacity * EXTRA_STRIDE);
  // CPU only: until when (seconds since the epoch) the row's segment holds.
  let expires = new Float64Array(capacity);
  let count = 0;
  const epochTime = cloneJulian(epoch ?? julianNow(), {});

  const set = {
    /** Bumped when the columns are reallocated; the renderer rebuilds its buffers. */
    generation: 0,
    dirty: {
      segments: new DirtyRows(capacity),
      style: new DirtyRows(capacity),
      colors: new DirtyRows(capacity),
      extras: new DirtyRows(capacity),
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
    get extras() {
      return extras;
    },
    get epoch() {
      return epochTime;
    },

    /** Seconds since the set's epoch: the clock segments are written in. */
    seconds(julianDate) {
      return secondsDifference(julianDate, epochTime);
    },

    /**
     * Move the epoch to `julianDate` once it is more than half an hour away
     * (ahead, or behind on a clock set back), shifting every stored time. Call between frames, never while a caller holds
     * times in the old base.
     * @returns {boolean} Whether it moved.
     */
    rebase(julianDate) {
      const shift = set.seconds(julianDate);
      if (Math.abs(shift) < REBASE_AFTER_SEC) return false;
      for (let row = 0; row < count; row++) {
        shiftSegmentTimes(segments, row, -shift);
        expires[row] -= shift;
      }
      cloneJulian(julianDate, epochTime);
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
      style[o + DEPTH_TEST_DISTANCE] = ICON_ALWAYS_OVER_DEPTH;
      colors.fill(255, row * 4, row * 4 + 4);
      extras.fill(0, row * EXTRA_STRIDE, (row + 1) * EXTRA_STRIDE);
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
        extras.copyWithin(
          row * EXTRA_STRIDE,
          last * EXTRA_STRIDE,
          (last + 1) * EXTRA_STRIDE,
        );
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

    /**
     * Draw the near image once the icon is wider than `px` CSS pixels on
     * screen; 0 (the default) switches past the renderer's own device-pixel
     * threshold.
     */
    setImageSwitch(row, px) {
      writeStyle(row, IMAGE_SWITCH, px);
    },
    imageSwitch(row) {
      return style[row * STYLE_STRIDE + IMAGE_SWITCH];
    },

    /**
     * An invisible pick target of `width × height` CSS pixels, picked
     * wherever it or the icon covers; 0 × 0 (the default) picks the icon's
     * drawn pixels only.
     */
    setPickProxy(row, width, height) {
      const o = row * STYLE_STRIDE;
      if (
        style[o + PROXY_WIDTH] === Math.fround(width) &&
        style[o + PROXY_HEIGHT] === Math.fround(height)
      )
        return;
      style[o + PROXY_WIDTH] = width;
      style[o + PROXY_HEIGHT] = height;
      set.dirty.style.mark(row);
    },
    pickProxyWidth(row) {
      return style[row * STYLE_STRIDE + PROXY_WIDTH];
    },
    pickProxyHeight(row) {
      return style[row * STYLE_STRIDE + PROXY_HEIGHT];
    },

    /**
     * Draw over depth within `metres` of the eye, as a billboard's
     * `disableDepthTestDistance`: 0 tests depth everywhere, Infinity (the
     * default) never does.
     */
    setDepthTestDistance(row, metres) {
      writeStyle(
        row,
        DEPTH_TEST_DISTANCE,
        metres >= ICON_ALWAYS_OVER_DEPTH ? ICON_ALWAYS_OVER_DEPTH : metres,
      );
    },
    depthTestDistance(row) {
      return style[row * STYLE_STRIDE + DEPTH_TEST_DISTANCE];
    },

    /**
     * Size by camera distance, as a `{near, nearValue, far, farValue}` curve
     * (the default renderer's NearFarScalar; unset: 1 everywhere).
     */
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
    scaleByDistance(
      row,
      result = { near: 0, nearValue: 0, far: 0, farValue: 0 },
    ) {
      const o = row * STYLE_STRIDE;
      result.near = style[o + NEAR_DISTANCE];
      result.nearValue = style[o + NEAR_VALUE];
      result.far = style[o + FAR_DISTANCE];
      result.farValue = style[o + FAR_VALUE];
      return result;
    },

    /**
     * Tint as `{red, green, blue, alpha}` (0..1, the default renderer's
     * Color); its alpha multiplies the row's own alpha.
     */
    setColor(row, color) {
      const o = row * 4;
      const r = floatToByte(color.red);
      const g = floatToByte(color.green);
      const b = floatToByte(color.blue);
      const a = floatToByte(color.alpha);
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
    /** The row's tint as `{red, green, blue, alpha}`, 0..1. */
    color(row, result = { red: 0, green: 0, blue: 0, alpha: 0 }) {
      const o = row * 4;
      result.red = colors[o] / 255.0;
      result.green = colors[o + 1] / 255.0;
      result.blue = colors[o + 2] / 255.0;
      result.alpha = colors[o + 3] / 255.0;
      return result;
    },

    /**
     * Shift on screen by `x` right and `y` down, CSS pixels, as a billboard's
     * `pixelOffset`.
     */
    setOffset(row, x, y) {
      writeExtra(row, OFFSET_X, x);
      writeExtra(row, OFFSET_Y, y);
    },
    offset(row) {
      const o = row * EXTRA_STRIDE;
      return { x: extras[o + OFFSET_X], y: extras[o + OFFSET_Y] };
    },

    /**
     * Which edge sits on the position: 0 the centre, 1 the bottom, -1 the
     * top (a billboard's vertical origin).
     */
    setAnchor(row, anchor) {
      writeExtra(row, ANCHOR, anchor);
    },
    anchor(row) {
      return extras[row * EXTRA_STRIDE + ANCHOR];
    },

    /** Radians counter-clockwise on screen. */
    setRotation(row, radians) {
      writeExtra(row, ROTATION, radians);
    },
    rotation(row) {
      return extras[row * EXTRA_STRIDE + ROTATION];
    },

    /**
     * Turn the icon's up along an ECEF axis on screen, as a billboard's
     * `alignedAxis` (zero: upright).
     */
    setAxis(row, x, y, z) {
      writeExtra(row, AXIS_X, x);
      writeExtra(row, AXIS_Y, y);
      writeExtra(row, AXIS_Z, z);
    },
    axis(row) {
      const o = row * EXTRA_STRIDE;
      return {
        x: extras[o + AXIS_X],
        y: extras[o + AXIS_Y],
        z: extras[o + AXIS_Z],
      };
    },

    /**
     * Fade by camera distance, as a `{near, nearValue, far, farValue}`
     * curve multiplying the alpha (unset: none); faded to nothing, the row
     * is not drawn.
     */
    setFade(row, curve) {
      writeExtra(row, FADE_NEAR, curve?.near ?? 0);
      writeExtra(row, FADE_NEAR_VALUE, curve?.nearValue ?? 0);
      writeExtra(row, FADE_FAR, curve?.far ?? 0);
      writeExtra(row, FADE_FAR_VALUE, curve?.farValue ?? 0);
    },
    fade(row) {
      const o = row * EXTRA_STRIDE;
      return {
        near: extras[o + FADE_NEAR],
        nearValue: extras[o + FADE_NEAR_VALUE],
        far: extras[o + FADE_FAR],
        farValue: extras[o + FADE_FAR_VALUE],
      };
    },

    /**
     * Drawn only at camera distances from `near` to `far`, metres; a `far`
     * not past `near` is no range.
     */
    setDisplayRange(row, near, far) {
      writeExtra(row, RANGE_NEAR, near);
      writeExtra(row, RANGE_FAR, Math.min(far, ICON_ALWAYS_OVER_DEPTH));
    },
    displayRange(row) {
      const o = row * EXTRA_STRIDE;
      return [extras[o + RANGE_NEAR], extras[o + RANGE_FAR]];
    },

    /**
     * Draw on the ground (`ICON_GROUND_CLAMP`) or above it
     * (`ICON_GROUND_RELATIVE`) along the segment from `from` to `to` (ECEF,
     * its two ends), the ground taken between the heights at those ends
     * (`setGroundHeights`); `ICON_GROUND_NONE` where it is.
     */
    setGround(row, mode, from, to) {
      writeExtra(row, GROUND_MODE, mode);
      for (const [at, p] of [
        [SPAN_FROM, from],
        [SPAN_TO, to],
      ]) {
        writeExtra(row, at, p?.x ?? 0);
        writeExtra(row, at + 1, p?.y ?? 0);
        writeExtra(row, at + 2, p?.z ?? 0);
      }
    },
    groundMode(row) {
      return extras[row * EXTRA_STRIDE + GROUND_MODE];
    },
    /** The ground's ellipsoid heights under the segment's ends, metres. */
    setGroundHeights(row, from, to) {
      writeExtra(row, GROUND_FROM, from);
      writeExtra(row, GROUND_TO, to);
    },
    /** The segment's ends the ground is taken along, ECEF. */
    groundSpan(row) {
      const o = row * EXTRA_STRIDE;
      return [SPAN_FROM, SPAN_TO].map((at) => ({
        x: extras[o + at],
        y: extras[o + at + 1],
        z: extras[o + at + 2],
      }));
    },
    groundHeights(row) {
      const o = row * EXTRA_STRIDE;
      return [extras[o + GROUND_FROM], extras[o + GROUND_TO]];
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
    cullPoint(row, position, result = { x: 0, y: 0, z: 0 }) {
      const { x, y, z } = position;
      if (!(style[row * STYLE_STRIDE + FLAGS] & ICON_CULL_LIFT)) {
        result.x = x;
        result.y = y;
        result.z = z;
        return result;
      }
      // Height above the ellipsoid along the geocentric ray, as the shader
      // computes it: exact to millimetres this close to the surface.
      const o = WGS84.oneOverRadii;
      const radius = Math.sqrt(x * x + y * y + z * z);
      const sx = x * o.x;
      const sy = y * o.y;
      const sz = z * o.z;
      const height = radius * (1 - 1 / Math.sqrt(sx * sx + sy * sy + sz * sz));
      const lift = Math.max(0, ICON_CULL_HEIGHT_M - height);
      result.x = x + (x / radius) * lift;
      result.y = y + (y / radius) * lift;
      result.z = z + (z / radius) * lift;
      return result;
    },
  };

  function markRow(row) {
    set.dirty.segments.mark(row);
    set.dirty.style.mark(row);
    set.dirty.colors.mark(row);
    set.dirty.extras.mark(row);
  }

  function writeExtra(row, field, value) {
    const o = row * EXTRA_STRIDE + field;
    if (extras[o] === Math.fround(value)) return;
    extras[o] = value;
    set.dirty.extras.mark(row);
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
    const x = new Float32Array(next * EXTRA_STRIDE);
    x.set(extras);
    const e = new Float64Array(next);
    e.set(expires);
    segments = s;
    style = st;
    colors = c;
    extras = x;
    expires = e;
    capacity = next;
    set.generation++;
    for (const rows of Object.values(set.dirty)) rows.grow(next);
  }

  return set;
}
