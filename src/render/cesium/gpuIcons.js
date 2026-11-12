/**
 * @module render/cesium/gpuIcons
 * @description The Cesium draw port's GPU icon sets: an icon set whose items
 * move (`motionSegments`), glide their course (`courseGlide`), recede
 * toward the limb, pick through a larger proxy,
 * switch images by drawn size, or that takes columns (`columns`), draws as
 * one instanced primitive (`IconSetPrimitive`) over an icon set's typed
 * columns (`iconSet.js`) instead of a billboard collection. Each item is one
 * row; the GPU moves it along its segment on the set's motion clock, so a
 * row is written only when its item changes.
 *
 * What these sets draw as billboards do not: an icon set becomes one when
 * an item first needs it (or it first takes columns), and stays one. They
 * refuse loudly what billboards draw and they do not: clamped heights,
 * `fadeByDistance`, `displayRange`, pixel offsets, anchors other than the
 * centre, axis and screen rotations, and clustering. Their
 * images (URLs, SVG, blobs, keyed canvases and atlas slots of those)
 * are rasterised square into the icon atlas every GPU icon set shares, and
 * refused when it has no room left for them: an SVG at its own size (its
 * root's larger `width`/`height`, as a billboard rasterises it), any other
 * image at the item's larger side.
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
import { contextIconSlots, IconSetPrimitive } from './iconSetPrimitive.js';
import { iconAtlas, MAX_ICON_SLOTS } from '../../data/iconAtlas.js';
import {
  glideOffset,
  LERP_STEP_MS,
  motionEndsAt,
} from '../motion/iconMotion.js';
import { blobUrl, toCartesian } from './common.js';

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

/**
 * An image's atlas key: a URL itself, SVG as a data URL, a blob as its
 * object URL, a generated canvas by its key; else null.
 */
function imageUrl(image) {
  if (typeof image === 'string') return image;
  if (typeof image?.svg === 'string')
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(image.svg)}`;
  if (image?.blob) return blobUrl(image.blob);
  if (image?.canvas && typeof image.key === 'string')
    return `\u0000key\u0000${image.key}`;
  return null;
}

/** What a row's segment and course easing are written from. */
function motionOf(item) {
  return {
    pos: item.pos ? { ...item.pos } : undefined,
    course: item.course,
    motion: item.motion ? { ...item.motion } : undefined,
    courseGlide: item.courseGlide ? { ...item.courseGlide } : undefined,
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

/** SVG URLs' own raster sizes (px; null: none given), as parsed. */
const svgSizes = new Map();
const SVG_SIZES_KEPT = 128;
/**
 * The largest an SVG is rasterised at its own size (px): past it, at this,
 * so an icon exported at 1024 px still packs.
 */
export const MAX_OWN_RASTER_PX = 256;

/**
 * An SVG data URL's own raster size: the larger of its root's `width` and
 * `height` in pixels (unitless or `px`), at most `MAX_OWN_RASTER_PX`, or null
 * when it gives no such size.
 */
export function svgRasterPx(url) {
  if (!/^data:image\/svg\+xml[;,]/i.test(url)) return null;
  let px = svgSizes.get(url);
  if (px !== undefined) return px;
  px = null;
  try {
    const comma = url.indexOf(',');
    const body = url.slice(comma + 1);
    const text = /;base64$/i.test(url.slice(0, comma))
      ? atob(body)
      : decodeURIComponent(body);
    // The root tag, comments aside, quoted values whole.
    const root =
      /<svg\b(?:[^>"']|"[^"]*"|'[^']*')*>/i.exec(
        text.replace(/<!--[\s\S]*?-->/g, ''),
      )?.[0] ?? '';
    const side = (name) => {
      const m = new RegExp(
        `\\s${name}\\s*=\\s*["']\\s*([0-9]*\\.?[0-9]+)\\s*(px)?\\s*["']`,
        'i',
      ).exec(root);
      return m ? Number(m[1]) : NaN;
    };
    const width = side('width');
    const height = side('height');
    if (width > 0 && height > 0)
      px = Math.min(
        MAX_OWN_RASTER_PX,
        Math.max(1, Math.round(Math.max(width, height))),
      );
  } catch {
    // Not decodable: drawn at the item's size.
  }
  if (svgSizes.size >= SVG_SIZES_KEPT) svgSizes.clear();
  svgSizes.set(url, px);
  return px;
}

/** The square raster size an image (its atlas URL) takes for an item. */
function rasterPxOf(url, item) {
  const own = url === null ? null : svgRasterPx(url);
  if (own !== null) return own;
  const [width = 0, height = 0] = item.size ?? [];
  return Math.max(1, Math.round(Math.max(width, height)));
}

/**
 * @param {{scene: object, capabilities: ReadonlySet<string>,
 *   toColor: (color: unknown) => Cesium.Color,
 *   imageOf: (record: object, image: unknown) => unknown,
 *   peekImage: (ref: {atlas: string, slot: string}) => unknown,
 *   requestRender: (reason: string) => void}} options `imageOf` reads an atlas slot
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

  /** Whether drawing these items needs a GPU icon set. */
  function wants(items) {
    for (const item of items) {
      if (
        (item.motion && can('motionSegments')) ||
        (item.courseGlide && can('courseGlide')) ||
        item.recede ||
        item.pickProxy ||
        item.imageLod
      )
        return true;
    }
    return false;
  }

  /** Refuse what a GPU icon set cannot draw, before anything changes. */
  function check(items, spec = {}) {
    if (spec.cluster)
      throw new Error("the Cesium renderer's GPU icons have no clustering");
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
      if (item.anchor !== undefined && item.anchor !== 'center')
        refuse('anchors but the centre');
      if (item.rotationMode === 'axis') refuse('axis rotation');
      if (item.rotationMode === 'screen' && (item.rotation ?? 0) !== 0)
        refuse('screen rotation');
      for (const given of [item.image, item.imageLod?.near]) {
        // An atlas slot as what it holds now (none yet draws once it does).
        const image =
          typeof given?.atlas === 'string' ? peekImage(given) : given;
        const url = image === undefined ? null : imageUrl(image);
        if (image !== undefined && url === null)
          throw new TypeError(
            'an image is a URL, SVG, blob, keyed canvas or atlas slot',
          );
        const px = rasterPxOf(url, item);
        if (url !== null && !iconAtlas.has(url, px)) fresh.add(`${px}|${url}`);
      }
    }
    // As many as this scene's context addresses (all of them on WebGL 2).
    const room = Math.min(MAX_ICON_SLOTS, contextIconSlots(scene.context));
    if (iconAtlas.size + fresh.size > room)
      throw new Error(
        `the Cesium renderer's GPU icons have no room for ${fresh.size} more images (at most ${room} in all)`,
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
      requestRender: () => requestRender(`icons:${spec.id}`),
      cull: () => spec.horizonCull === true,
      // Picked as the draw port's other items are: `{set, id, meta}` as
      // the item now is, hidden row by row for drill picks.
      pickObject: (id, _set, primitive) => ({
        primitive,
        id: {
          set: spec.id,
          id,
          get meta() {
            return record.items.get(id)?.meta;
          },
        },
      }),
    });
    record.atlases ??= new Set();
    // Until when (epoch ms on the motion clock) a row may still move or turn.
    let movingUntil = -Infinity;
    const clockMs = () => Cesium.JulianDate.toDate(clockTime()).getTime();
    // What each row's segment was last written from, by id.
    const written = new Map();
    // The ids of the last columns, while no other write came after them.
    let columnIds = null;
    // Written in full on the first write.
    let fresh = true;

    /** An item's image as its atlas slot, or -1 while it is not registered. */
    function slotOf(image, item) {
      const resolved = imageOf(record, image);
      if (resolved === undefined) return -1;
      const url = imageUrl(resolved);
      if (url !== null)
        return iconAtlas.slot(url, rasterPxOf(url, item), resolved?.canvas);
      throw new TypeError(
        'an image is a URL, SVG, blob, keyed canvas or atlas slot',
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
      const [width = 0, height = 0] = item.size ?? [];
      const far = slotOf(item.image, item);
      const near = item.imageLod ? slotOf(item.imageLod.near, item) : far;
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
      const glide = can('courseGlide') ? from.courseGlide : undefined;
      if (glide) {
        writeGlide(glide);
        end = motionEndsAt({ ...along, courseGlide: glide });
      }
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
          written.delete(id);
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
          written.delete(id);
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
              written.delete(id);
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
