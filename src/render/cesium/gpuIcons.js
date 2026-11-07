/**
 * @module render/cesium/gpuIcons
 * @description The Cesium draw port's GPU icon sets: an icon set whose items
 * move (`motionSegments`), glide their course (`courseGlide`,
 * `courseBlendMs`), recede toward the limb, pick through a larger proxy,
 * switch images by drawn size, or that takes columns (`columns`), draws as
 * one instanced primitive (`IconSetPrimitive`) over an icon set's typed
 * columns (`iconSet.js`) instead of a billboard collection. Each item is one
 * row; the GPU moves it along its segment on the set's motion clock, so a
 * row is written only when its item changes.
 *
 * What these sets draw as billboards do not: an icon set becomes one when
 * an item first needs it (or it first takes columns), and stays one; a
 * course blend alone moves it only when all of it can move. They refuse
 * loudly what billboards draw and they do not: clamped heights,
 * `fadeByDistance`, `displayRange`, pixel and eye offsets, anchors other
 * than the centre, axis and screen rotations, opaque and additive blends,
 * and images other than URLs, SVG and atlas slots of those. Their images
 * are rasterised square, at the item's larger side, into the icon atlas
 * every GPU icon set shares, and refused when it has no room left for them.
 *
 * Choices the contract leaves open, taken conservatively:
 * - `horizonCull` judges each row no lower than `ICON_CULL_HEIGHT_M` above
 *   the ellipsoid, as the layers drawing their own icon sets do for sea
 *   level and grounded contacts below it (`ICON_CULL_LIFT`).
 * - A row's course is its motion's (`hold.courseDeg`, `lerp.course0Deg`,
 *   the arc's track), else the item's `course`.
 * - Rows draw in the order they were added; removing one moves the last
 *   into its place.
 * - `Columns.dirty` runs include their `end`, and are trusted only when the
 *   ids are those of the last columns, row for row.
 * - A `lerp` whose `t1` is not after `t0` steps from `from` to `to` 1 ms
 *   after `t0`.
 * - A course blend eases from the course shown when its course changes;
 *   writes keeping that course (and columns of neither position nor
 *   course) let it go on rather than start over.
 */
import * as Cesium from 'cesium';
import {
  createIconSet,
  ICON_CULL_LIFT,
  ICON_RECEDES,
  ICON_ROTATES,
} from '../../data/iconSet.js';
import {
  writeArcSegment,
  writeCourseGlide,
  writeHoldSegment,
  writeLerpSegment,
} from '../../data/iconSegment.js';
import { IconSetPrimitive } from '../../data/iconSetPrimitive.js';
import { iconAtlas, MAX_ICON_SLOTS } from '../../data/iconAtlas.js';
import {
  glideOffset,
  iconCourse,
  LERP_STEP_MS,
  motionEndsAt,
  norm180,
} from '../motion/iconMotion.js';
import { toCartesian } from './common.js';

/** The capabilities GPU icon sets bring. */
export const GPU_ICON_CAPABILITIES = Object.freeze([
  'columns',
  'motionSegments',
  'courseGlide',
]);

const nonZero = (v) =>
  Boolean(v) && (v.x !== 0 || v.y !== 0 || (v.z ?? 0) !== 0);

/** Whether a curve is one (as the billboards read it). */
const isCurve = (curve) => Boolean(curve) && curve.far > curve.near;

/** An image's atlas URL: itself, or SVG as a data URL; else null. */
function imageUrl(image) {
  if (typeof image === 'string') return image;
  if (typeof image?.svg === 'string')
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(image.svg)}`;
  return null;
}

/** What a row's segment and course easing are written from. */
function motionOf(item) {
  return {
    pos: item.pos ? { ...item.pos } : undefined,
    course: item.course,
    motion: item.motion ? { ...item.motion } : undefined,
    courseGlide: item.courseGlide ? { ...item.courseGlide } : undefined,
    courseBlendMs: item.courseBlendMs,
  };
}

/** Whether two plain records hold the same values, nested ones included. */
function sameFields(a, b) {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  for (const key of keys) if (!sameFields(a[key], b[key])) return false;
  return true;
}

/** Whether two `motionOf`s write the same segment. */
const sameMotion = (a, b) => Boolean(a) && sameFields(a, b);

/** The square raster size an item's images take in the atlas. */
function rasterPxOf(item) {
  const [width = 0, height = 0] = item.size ?? [];
  return Math.max(1, Math.round(Math.max(width, height)));
}

/**
 * @param {{scene: object, capabilities: ReadonlySet<string>,
 *   toColor: (color: unknown) => Cesium.Color,
 *   imageOf: (record: object, image: unknown) => unknown,
 *   peekImage: (ref: {atlas: string, slot: string}) => unknown,
 *   requestRender: () => void}} options `imageOf` reads an atlas slot
 *   through the draw port's atlases (undefined while it is not registered),
 *   noting that the set draws from it; `peekImage` only reads it.
 */
export function createGpuIcons({
  scene,
  capabilities,
  toColor,
  imageOf,
  peekImage,
  requestRender,
}) {
  const can = (capability) => capabilities.has(capability);

  /**
   * Whether drawing these items needs a GPU icon set ('needs'), would only
   * draw them better on one ('prefers': a course blend, which billboards
   * draw as a snap), or neither (false).
   */
  function wants(items) {
    let prefers = false;
    for (const item of items) {
      if (
        (item.motion && can('motionSegments')) ||
        (item.courseGlide && can('courseGlide')) ||
        item.recede ||
        item.pickProxy ||
        item.imageLod
      )
        return 'needs';
      if (item.courseBlendMs > 0) prefers = true;
    }
    return prefers ? 'prefers' : false;
  }

  /** Refuse what a GPU icon set cannot draw, before anything changes. */
  function check(items, spec = {}) {
    if (spec.blend === 'opaque' || spec.blend === 'additive')
      throw new Error(
        `the Cesium renderer's GPU icons have no ${spec.blend} blend`,
      );
    // Atlas slots these items would take anew: they must all fit.
    const fresh = new Set();
    for (const item of items) {
      const refuse = (what) => {
        throw new Error(`the Cesium renderer's GPU icons have no ${what}`);
      };
      if (item.height !== undefined && item.height !== 'absolute')
        refuse('clamped heights');
      if (item.fadeByDistance) refuse('fadeByDistance');
      if (item.displayRange) refuse('displayRange');
      if (nonZero(item.pixelOffset)) refuse('pixelOffset');
      if (nonZero(item.eyeOffset)) refuse('eyeOffset');
      if (item.anchor !== undefined && item.anchor !== 'center')
        refuse('anchors but the centre');
      if (item.rotationMode === 'axis') refuse('axis rotation');
      if (item.rotationMode === 'screen' && (item.rotation ?? 0) !== 0)
        refuse('screen rotation');
      for (const given of [item.image, item.imageLod?.near]) {
        // An atlas slot as what it holds now (none yet draws once it does).
        const image =
          typeof given?.atlas === 'string' ? peekImage(given) : given;
        if (
          image !== undefined &&
          typeof image !== 'string' &&
          typeof image?.svg !== 'string'
        )
          refuse('images but URLs and SVG');
        const url = imageUrl(image);
        const px = rasterPxOf(item);
        if (url !== null && !iconAtlas.has(url, px)) fresh.add(`${px}|${url}`);
      }
    }
    if (iconAtlas.size + fresh.size > MAX_ICON_SLOTS)
      throw new Error(
        `the Cesium renderer's GPU icons have no room for ${fresh.size} more images (at most ${MAX_ICON_SLOTS} in all)`,
      );
  }

  /**
   * Draw `record`'s icons on the GPU from now on: its icon set, the
   * primitive drawing it, and the writes that keep it in step with the
   * record's items.
   */
  function attach(record) {
    const spec = record.spec;
    const scratch = new Cesium.JulianDate();
    // The motion clock's time now, and in the frame being drawn.
    function clockTime(frameState, result = scratch) {
      const clock = spec.motionClock;
      if (clock?.kind === 'scene')
        return Cesium.JulianDate.clone(
          frameState?.time ?? scene.frameState?.time ?? Cesium.JulianDate.now(),
          result,
        );
      return Cesium.JulianDate.addSeconds(
        Cesium.JulianDate.now(result),
        -(clock?.delayMs ?? 0) / 1000,
        result,
      );
    }
    // Its epoch starts at the clock, and the primitive keeps it near it.
    const set = createIconSet({ epoch: clockTime() });
    const msScratch = new Cesium.JulianDate();
    const tauOf = (ms) =>
      set.seconds(Cesium.JulianDate.fromDate(new Date(ms), msScratch));
    const host = new IconSetPrimitive({
      set,
      renderTime: (frameState) =>
        clockTime(frameState, new Cesium.JulianDate()),
      requestRender,
      cull: () => spec.horizonCull === true,
      // Picked as the draw port's other items are: `{set, id, meta,
      // lodGroup}` as the item now is, hidden row by row for drill picks.
      pickObject: (id, _set, primitive) => ({
        primitive,
        id: {
          set: spec.id,
          id,
          get meta() {
            return record.items.get(id)?.meta;
          },
          get lodGroup() {
            return record.items.get(id)?.lodGroup;
          },
        },
      }),
    });
    record.atlases ??= new Set();
    // Until when (epoch ms on the motion clock) a row may still move or turn.
    let movingUntil = -Infinity;
    const clockMs = () => Cesium.JulianDate.toDate(clockTime()).getTime();
    // Each row's course blend, by id: {target, from, t0 (epoch ms), rate}.
    const blends = new Map();
    // What each row's segment was last written from, by id.
    const written = new Map();
    // What each row is drawn along now, by id: its position, course and
    // motion as the renderer reads them, and the course glide in effect
    // (`iconMotion` evaluates it as the GPU does).
    const drawn = new Map();
    // The ids of the last columns, while no other write came after them.
    let columnIds = null;
    // Written in full on the first write.
    let fresh = true;

    /** An image as its atlas slot, or -1 while it is not registered. */
    function slotOf(image, sizePx) {
      const resolved = imageOf(record, image);
      if (resolved === undefined) return -1;
      const url = imageUrl(resolved);
      if (url !== null) return iconAtlas.slot(url, sizePx);
      throw new Error(
        "the Cesium renderer's GPU icons have no images but URLs and SVG",
      );
    }

    /** The course a row's motion (else its item) gives. */
    function courseOf(item) {
      const motion = can('motionSegments') ? item.motion : undefined;
      if (motion?.kind === 'hold') return motion.courseDeg ?? item.course ?? 0;
      if (motion?.kind === 'lerp') return motion.course0Deg ?? item.course ?? 0;
      return item.course ?? 0;
    }

    /** Write a row's segment. */
    function writeMotion(row, item) {
      const seg = set.segments;
      const motion = can('motionSegments') ? item.motion : undefined;
      const pos = toCartesian(item.pos);
      switch (motion?.kind) {
        case 'lerp': {
          const t0 = tauOf(motion.t0);
          // Not after t0: a step 1 ms after it.
          const t1 = Math.max(tauOf(motion.t1), t0 + LERP_STEP_MS / 1000);
          writeLerpSegment(seg, row, {
            from: toCartesian(motion.from),
            to: toCartesian(motion.to),
            t0,
            t1,
            course0Deg: courseOf(item),
            courseSlopeDeg: motion.courseSlopeDeg ?? 0,
          });
          return;
        }
        case 'arc': {
          const t0 = tauOf(motion.t0);
          writeArcSegment(seg, row, {
            fix: toCartesian(motion.fix),
            t0,
            minDt: motion.minDtS,
            maxDt: motion.maxDtS,
            speedMps: motion.speedMps,
            trackDeg: motion.trackDeg,
            turnRateDps: motion.turnRateDps,
            climbMps: motion.climbMps ?? 0,
          });
          return;
        }
        default:
          writeHoldSegment(seg, row, pos, courseOf(item));
      }
    }

    /**
     * Draw an item as its row (added when it has none). With `motion` false
     * (a column change of neither position nor course) its segment and
     * course easing are kept as they are.
     */
    function writeRow(item, { motion = true } = {}) {
      let row = set.row(item.id);
      const added = row < 0;
      if (added) row = set.add(item.id);
      const now = clockMs();
      // The course on screen before this write, to ease from.
      const shownCourse =
        added || !drawn.has(item.id)
          ? null
          : iconCourse(drawn.get(item.id), now);
      const [width = 0, height = 0] = item.size ?? [];
      const rasterPx = rasterPxOf(item);
      const far = slotOf(item.image, rasterPx);
      const near = item.imageLod ? slotOf(item.imageLod.near, rasterPx) : far;
      set.setImage(row, far, near);
      // A switch at 0 px or less is near at any size.
      set.setImageSwitch(
        row,
        item.imageLod ? Math.max(item.imageLod.switchPx, 1e-3) : 0,
      );
      set.setSize(row, width, height);
      set.setScale(row, item.scale ?? 1);
      set.setAlpha(row, item.alpha ?? 1);
      set.setColor(row, toColor(item.color));
      set.setFocus(row, item.focus ?? 1);
      set.setScaleByDistance(
        row,
        isCurve(item.scaleByDistance) ? item.scaleByDistance : undefined,
      );
      set.setFlag(row, ICON_ROTATES, item.rotationMode === 'course');
      set.setFlag(row, ICON_RECEDES, item.recede === true);
      set.setFlag(row, ICON_CULL_LIFT, spec.horizonCull === true);
      set.setPickProxy(
        row,
        item.pickProxy?.size?.[0] ?? 0,
        item.pickProxy?.size?.[1] ?? 0,
      );
      set.setDepthTestDistance(row, item.disableDepthTest ?? 0);
      set.setShown(row, item.show !== false);
      if (!motion && !added) return;
      // A write moving it as it already moves (a restyle, a focus change)
      // keeps its segment and course easing as they are.
      const from = motionOf(item);
      if (!added && sameMotion(written.get(item.id), from)) return;
      written.set(item.id, from);
      writeMotion(row, item);
      // The row as the renderer reads it (copies, as `written`'s are): its
      // motion, without a glide yet.
      const along = {
        pos: from.pos,
        course: from.course,
        motion: can('motionSegments') ? from.motion : undefined,
      };
      // A glide written with the offset the app reads, so a half turn goes the
      // way `iconMotion` says.
      const writeGlide = (g) =>
        writeCourseGlide(
          set.segments,
          row,
          g.fromCourseDeg,
          tauOf(g.t0),
          g.rateDps,
          glideOffset(along.motion, along.course, g),
        );
      let end = motionEndsAt(along);
      let glide = can('courseGlide') ? from.courseGlide : undefined;
      if (glide) {
        writeGlide(glide);
        end = motionEndsAt({ ...along, courseGlide: glide });
      } else if (item.courseBlendMs > 0 && shownCourse !== null) {
        const target = iconCourse(along, now);
        let blend = blends.get(item.id);
        // The same course as the blend under way heads for: it goes on.
        if (!blend || blend.target !== target) {
          // Over `courseBlendMs`: at the rate that closes the gap in that time.
          const gap = Math.abs(norm180(shownCourse - target));
          blend =
            gap > 0
              ? {
                  target,
                  from: shownCourse,
                  t0: now,
                  rate: gap / (item.courseBlendMs / 1000),
                  until: now + item.courseBlendMs,
                }
              : null;
          if (blend) blends.set(item.id, blend);
          else blends.delete(item.id);
        }
        if (blend) {
          glide = {
            fromCourseDeg: blend.from,
            t0: blend.t0,
            rateDps: blend.rate,
          };
          writeGlide(glide);
          end = Math.max(end, blend.until);
        }
      } else blends.delete(item.id);
      drawn.set(item.id, { ...along, courseGlide: glide });
      set.segmentWritten(row);
      if (end > movingUntil) movingUntil = end;
    }

    /** Bring the rows in line with every item. */
    function sync() {
      fresh = false;
      columnIds = null;
      // Every row is written anew.
      movingUntil = -Infinity;
      written.clear();
      for (let row = set.count - 1; row >= 0; row--) {
        const id = set.idAt(row);
        if (!record.items.has(id)) {
          set.remove(id);
          blends.delete(id);
          written.delete(id);
          drawn.delete(id);
        }
      }
      for (const item of record.items.values()) writeRow(item);
    }

    return {
      host,
      set,
      sync,
      /** Rows for these items, already in the record's. */
      write(items) {
        if (fresh) return sync();
        columnIds = null;
        for (const item of items) writeRow(record.items.get(item.id) ?? item);
      },
      /** Rows of items gone from the record's. */
      drop(ids) {
        if (fresh) return sync();
        columnIds = null;
        for (const id of ids) {
          set.remove(id);
          blends.delete(id);
          written.delete(id);
          drawn.delete(id);
        }
        if (record.items.size === 0) movingUntil = -Infinity;
      },
      /**
       * Columns as rows, as the contract's `Columns`: each column's value
       * merged into its row's item (added when it has none), and the rows
       * not in `ids` removed.
       */
      columns(columns) {
        if (fresh) sync();
        const ids = columns.ids.map(String);
        const n = ids.length;
        const same =
          columnIds !== null &&
          columnIds.length === n &&
          ids.every((id, i) => columnIds[i] === id);
        if (!same) {
          const keep = new Set(ids);
          for (const id of [...record.items.keys()])
            if (!keep.has(id)) {
              record.items.delete(id);
              set.remove(id);
              blends.delete(id);
              written.delete(id);
              drawn.delete(id);
            }
        }
        const runs =
          same && columns.dirty ? columns.dirty : [{ start: 0, end: n - 1 }];
        const {
          positions: p,
          courses,
          shown,
          scales,
          alphas,
          colors,
          meta,
        } = columns;
        // Neither moved nor turned: segments and course easing stay.
        const motion = Boolean(p || courses);
        for (const run of runs)
          for (
            let i = Math.max(0, run.start);
            i <= Math.min(n - 1, run.end);
            i++
          ) {
            const id = ids[i];
            const item = { ...(record.items.get(id) ?? { id }) };
            if (p) item.pos = { x: p[i * 3], y: p[i * 3 + 1], z: p[i * 3 + 2] };
            if (courses) item.course = courses[i];
            if (shown) item.show = shown[i] !== 0;
            if (scales) item.scale = scales[i];
            if (alphas) item.alpha = alphas[i];
            if (colors)
              item.color = [0, 1, 2, 3].map((k) => colors[i * 4 + k] / 255);
            if (meta) item.meta = meta[i];
            record.items.set(id, item);
            writeRow(item, { motion });
          }
        columnIds = ids;
      },
      /** After `setOptions`: the cull lift follows `horizonCull`. */
      restyle() {
        for (let row = 0; row < set.count; row++)
          set.setFlag(row, ICON_CULL_LIFT, spec.horizonCull === true);
      },
      /** Rewrite the rows drawing from atlas `id`. */
      reatlas(id) {
        const drawing = [];
        for (const item of record.items.values())
          if (item.image?.atlas === id || item.imageLod?.near?.atlas === id)
            drawing.push(item);
        if (fresh) return sync();
        for (const item of drawing) writeRow(item);
      },
      /** Whether a live-clock row is still moving: frames should keep coming. */
      animating() {
        if (spec.motionClock?.kind === 'scene' || spec.show === false)
          return false;
        return set.count > 0 && clockMs() < movingUntil;
      },
      /** The images shown rows draw: `failed`, `loading` or `settled`. */
      imageState() {
        let loading = false;
        for (let row = 0; row < set.count; row++) {
          if (!set.shown(row)) continue;
          for (const slot of [set.imageFar(row), set.imageNear(row)]) {
            if (slot < 0) continue;
            if (iconAtlas.failed(slot)) return 'failed';
            if (!iconAtlas.ready(slot)) loading = true;
          }
        }
        return loading ? 'loading' : 'settled';
      },
    };
  }

  return { wants, check, attach };
}
