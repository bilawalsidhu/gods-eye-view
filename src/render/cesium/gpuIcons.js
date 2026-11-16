/**
 * @module render/cesium/gpuIcons
 * @description The Cesium draw port's GPU icon sets: an icon set whose items
 * move (`motionSegments`), glide their course (`courseGlide`), recede
 * toward the limb (`recede`, the set's), pick through a larger proxy,
 * switch images by drawn size, or that takes columns (`columns`), draws as
 * one instanced primitive (`IconSetPrimitive`) over an icon set's typed
 * columns (`iconSet.js`) instead of a billboard collection. Each item is one
 * row; the GPU moves it along its segment on the set's motion clock, so a
 * row is written only when its item changes.
 *
 * What these sets draw as billboards do not: an icon set becomes one when
 * an item first needs it (or it first takes columns), and stays one. They
 * draw what billboards draw, clustering included (the draw port clusters
 * the rows where their segments put them in the frame drawn); on WebGL 1
 * they refuse what each row reads from its extras texture
 * there is none of: clamped heights, `fadeByDistance`, `displayRange`, pixel
 * offsets, anchors other than the centre, and axis and screen rotations.
 *
 * A clamped row (`clampGround`, `relativeGround`) stands on the ground
 * taken between the heights under its segment's two ends, sampled after a
 * frame draws, `GROUND_SAMPLES_PER_FRAME` ends a frame across the port's
 * sets: the loaded terrain first, then, but for `clampTo: 'terrain'`, the
 * drawn surface (`SURFACE_SAMPLES_PER_FRAME`, where the scene samples it).
 * An end with no height yet stands on the ellipsoid. Every end is sampled
 * again once the globe's tiles finish loading, and, clamped to more than
 * terrain, every `GROUND_REFRESH_MS`. Their
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
  ICON_GROUND_CLAMP,
  ICON_GROUND_NONE,
  ICON_GROUND_RELATIVE,
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
import { heightsFor } from './heights.js';

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

/** Whether a `displayRange` shows anything: `[near, far)` is not empty. */
const displayable = (range) => !range || range[1] > range[0];

/** An anchor as the row's vertical origin: the edge on the position. */
const ANCHORS = { center: 0, bottom: 1, top: -1 };

const GROUND_MODES = {
  clampGround: ICON_GROUND_CLAMP,
  relativeGround: ICON_GROUND_RELATIVE,
};

/** Segment ends sampled for their ground after a frame, across the sets. */
export const GROUND_SAMPLES_PER_FRAME = 256;
/** Of those, how many also sample the drawn surface (each draws a view). */
export const SURFACE_SAMPLES_PER_FRAME = 8;
/** How often rows clamped to more than terrain are sampled again, ms. */
export const GROUND_REFRESH_MS = 5000;

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
 *   date?: (() => number)|null,
 *   toColor: (color: unknown) => Cesium.Color,
 *   imageOf: (record: object, image: unknown) => unknown,
 *   peekImage: (ref: {atlas: string, slot: string}) => unknown,
 *   requestRender: (reason: string) => void}} options `date` is the epoch
 *   ms a `live` motion clock reads (null: the system clock's); `imageOf` reads an atlas slot
 *   through the draw port's atlases (undefined while it is not registered),
 *   noting that the set draws from it; `peekImage` only reads it.
 */
export function createGpuIcons({
  scene,
  capabilities,
  date = null,
  toColor,
  imageOf,
  peekImage,
  requestRender,
}) {
  const can = (capability) => capabilities.has(capability);

  /** Whether drawing these items (in a set of `spec`) needs a GPU icon set. */
  function wants(items, spec = {}) {
    if (spec.recede) return true;
    for (const item of items) {
      if (
        (item.motion && can('motionSegments')) ||
        (item.courseGlide && can('courseGlide')) ||
        item.pickProxy ||
        item.imageLod
      )
        return true;
    }
    return false;
  }

  /** Refuse what a GPU icon set cannot draw, before anything changes. */
  function check(items, spec = {}) {
    // Atlas slots these items would take anew: they must all fit.
    const fresh = new Set();
    for (const item of items) {
      const refuse = (what) => {
        throw new Error(`the Cesium renderer's GPU icons have no ${what}`);
      };
      if (item.offsetScalesByDistance && nonZero(item.pixelOffset))
        refuse('pixel offsets scaled by distance');
      // What a row reads from its extras texture, which WebGL 1 has not.
      if (scene.context?.webgl2 === false) {
        if (item.height !== undefined && item.height !== 'absolute')
          refuse('clamped heights on WebGL 1');
        if (item.fadeByDistance) refuse('fadeByDistance on WebGL 1');
        if (item.displayRange) refuse('displayRange on WebGL 1');
        if (nonZero(item.pixelOffset)) refuse('pixelOffset on WebGL 1');
        if (item.anchor !== undefined && item.anchor !== 'center')
          refuse('anchors but the centre on WebGL 1');
        if (item.rotationMode === 'axis') refuse('axis rotation on WebGL 1');
        if (item.rotationMode === 'screen' && (item.rotation ?? 0) !== 0)
          refuse('screen rotation on WebGL 1');
      }
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
        date
          ? Cesium.JulianDate.fromDate(new Date(date()), result)
          : Cesium.JulianDate.now(result),
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
      recede: () => spec.recede,
      translucent: () => spec.blend === 'translucent',
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
    // Rows drawn as part of a cluster, hidden.
    let clustered = new Set();
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
      set.setFlag(row, ICON_RECEDES, Boolean(spec.recede));
      set.setFlag(row, ICON_CULL_LIFT, spec.horizonCull === true);
      set.setPickProxy(
        row,
        item.pickProxy?.size?.[0] ?? 0,
        item.pickProxy?.size?.[1] ?? 0,
      );
      set.setDepthTestDistance(row, item.disableDepthTest ?? 0);
      // An empty range shows it nowhere.
      set.setShown(
        row,
        item.show !== false &&
          displayable(item.displayRange) &&
          !clustered.has(item.id),
      );
      writeExtras(row, item);
      writeSegment(row, item, added, motion);
      writeGround(row, item);
    }

    /** A row's offset, anchor, rotation, fade and display range. */
    function writeExtras(row, item) {
      set.setOffset(row, item.pixelOffset?.x ?? 0, item.pixelOffset?.y ?? 0);
      set.setAnchor(row, ANCHORS[item.anchor] ?? 0);
      set.setRotation(
        row,
        item.rotationMode === 'screen' || item.rotationMode === 'axis'
          ? (item.rotation ?? 0)
          : 0,
      );
      // Its up along the axis, as a billboard's, then turned by its
      // rotation; one of zero length stands upright.
      const {
        x = 0,
        y = 0,
        z = 0,
      } = (item.rotationMode === 'axis' && item.alignedAxis) || {};
      const length = Math.hypot(x, y, z);
      if (length > 0) set.setAxis(row, x / length, y / length, z / length);
      else set.setAxis(row, 0, 0, 0);
      set.setFade(
        row,
        isCurve(item.fadeByDistance) ? item.fadeByDistance : undefined,
      );
      const range =
        item.displayRange && displayable(item.displayRange)
          ? item.displayRange
          : [0, 0];
      set.setDisplayRange(row, range[0], range[1]);
    }

    /**
     * Write a row's segment and course easing, unless `motion` is false
     * (and the row not new) or its motion is as written.
     */
    function writeSegment(row, item, added, motion) {
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

    // Clamped rows by id, those whose ground is still to sample, those never
    // sampled yet, and what each row's ground was last written from.
    const grounded = new Set();
    const groundQueue = new Set();
    const unsampled = new Set();
    const groundKeys = new Map();
    let groundRefreshedAt = -Infinity;
    let tilesWereLoaded = false;

    /** The two ends of a row's segment, ECEF. */
    function spanOf(row, item) {
      const motion = can('motionSegments') ? item.motion : undefined;
      let t0 = 0;
      let t1 = 0;
      if (motion?.kind === 'lerp') {
        t0 = tauOf(motion.t0);
        t1 = Math.max(tauOf(motion.t1), t0 + LERP_STEP_MS / 1000);
      } else if (motion?.kind === 'arc') {
        const t = tauOf(motion.t0);
        t0 = t + motion.minDtS;
        t1 = t + motion.maxDtS;
      }
      return [
        set.position(row, t0, { x: 0, y: 0, z: 0 }),
        set.position(row, t1, { x: 0, y: 0, z: 0 }),
      ];
    }

    /** A row's ground mode and segment ends, queued to sample when new. */
    function writeGround(row, item) {
      const mode = GROUND_MODES[item.height] ?? ICON_GROUND_NONE;
      if (mode === ICON_GROUND_NONE) {
        if (grounded.delete(item.id)) {
          set.setGround(row, ICON_GROUND_NONE);
          set.setGroundHeights(row, 0, 0);
          groundQueue.delete(item.id);
          unsampled.delete(item.id);
          groundKeys.delete(item.id);
        }
        return;
      }
      const [from, to] = spanOf(row, item);
      const key = `${mode}|${from.x}|${from.y}|${from.z}|${to.x}|${to.y}|${to.z}`;
      if (!grounded.has(item.id)) {
        grounded.add(item.id);
        unsampled.add(item.id);
      }
      if (groundKeys.get(item.id) === key) return;
      groundKeys.set(item.id, key);
      set.setGround(row, mode, from, to);
      groundQueue.add(item.id);
    }

    /**
     * `p` on a clamped row's ground, as its shader puts it: the ground
     * between the heights under its segment's ends, by how far along it is.
     */
    function onGround(row, p) {
      const [from, to] = set.groundSpan(row);
      const [g0, g1] = set.groundHeights(row);
      const sx = to.x - from.x;
      const sy = to.y - from.y;
      const sz = to.z - from.z;
      const spanSq = sx * sx + sy * sy + sz * sz;
      const along =
        spanSq > 0
          ? Math.min(
              1,
              Math.max(
                0,
                ((p.x - from.x) * sx +
                  (p.y - from.y) * sy +
                  (p.z - from.z) * sz) /
                  spanSq,
              ),
            )
          : 0;
      const ground = g0 + (g1 - g0) * along;
      const carto = Cesium.Cartographic.fromCartesian(
        Cesium.Cartesian3.fromElements(p.x, p.y, p.z, groundAt),
        undefined,
        groundCarto,
      );
      if (!carto) return p;
      const height =
        set.groundMode(row) === ICON_GROUND_CLAMP
          ? ground
          : carto.height + ground;
      const c = Cesium.Cartesian3.fromRadians(
        carto.longitude,
        carto.latitude,
        height,
      );
      return { x: c.x, y: c.y, z: c.z };
    }

    const groundAt = new Cesium.Cartesian3();
    const groundCarto = new Cesium.Cartographic();
    /**
     * The ground's height under `p`: the drawn surface when `surface`
     * (else, or where it has none, the loaded terrain, but for `clampTo:
     * 'tiles'`); null where neither answers.
     */
    function groundHeight(p, surface) {
      Cesium.Cartesian3.fromElements(p.x, p.y, p.z, groundAt);
      const carto = Cesium.Cartographic.fromCartesian(
        groundAt,
        undefined,
        groundCarto,
      );
      if (!carto) return null;
      const heights = heightsFor(scene);
      if (surface) {
        const h = heights.now(carto);
        if (h !== null) return h;
      }
      if (spec.clampTo === 'tiles') return null;
      return heights.now(carto, { against: 'terrain' });
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
      /**
       * After `setOptions`: the cull lift follows `horizonCull`, and every
       * row recedes while the set does.
       */
      restyle() {
        for (let row = 0; row < set.count; row++) {
          set.setFlag(row, ICON_CULL_LIFT, spec.horizonCull === true);
          set.setFlag(row, ICON_RECEDES, Boolean(spec.recede));
        }
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
      /**
       * After a frame: sample the ground under clamped rows' segment ends,
       * from `budget` (`{ends, surface}`, spent). Whether a row's ground
       * changed.
       */
      ground(budget) {
        if (grounded.size === 0) return false;
        const loaded = scene.globe?.tilesLoaded === true;
        const now = Date.now();
        const clampTo = spec.clampTo ?? 'both';
        if (
          (loaded && !tilesWereLoaded) ||
          (clampTo !== 'terrain' &&
            now - groundRefreshedAt >= GROUND_REFRESH_MS)
        ) {
          for (const id of grounded) groundQueue.add(id);
          groundRefreshedAt = now;
        }
        tilesWereLoaded = loaded;
        const surface =
          clampTo !== 'terrain' && scene.sampleHeightSupported === true;
        let changed = false;
        const later = [];
        for (const id of groundQueue) {
          if (budget.ends < 1) break;
          const row = set.row(id);
          if (row < 0 || set.groundMode(row) === ICON_GROUND_NONE) {
            groundQueue.delete(id);
            grounded.delete(id);
            unsampled.delete(id);
            groundKeys.delete(id);
            continue;
          }
          const [from, to] = set.groundSpan(row);
          const same = from.x === to.x && from.y === to.y && from.z === to.z;
          const ends = same ? 1 : 2;
          if (budget.ends < ends) continue;
          const drawn = surface && budget.surface >= ends;
          // Out of surface samples: a row never sampled takes the terrain
          // for now and waits; the rest wait as they stand.
          if (surface && !drawn && !unsampled.has(id)) continue;
          groundQueue.delete(id);
          if (surface && !drawn) later.push(id);
          budget.ends -= ends;
          if (drawn) budget.surface -= ends;
          const h0 = groundHeight(from, drawn) ?? 0;
          const h1 = same ? h0 : (groundHeight(to, drawn) ?? 0);
          unsampled.delete(id);
          const [g0, g1] = set.groundHeights(row);
          if (g0 !== Math.fround(h0) || g1 !== Math.fround(h1)) {
            set.setGroundHeights(row, h0, h1);
            changed = true;
          }
        }
        for (const id of later) groundQueue.add(id);
        return changed;
      },
      /**
       * The rows a cluster pass sees: each whose item is shown, where it
       * is drawn at `frameState`'s time (on its segment, on its ground),
       * with its item.
       */
      drawnRows(frameState) {
        const tau = set.seconds(clockTime(frameState));
        const out = [];
        for (let row = 0; row < set.count; row++) {
          const id = set.idAt(row);
          const item = record.items.get(id);
          if (!item || item.show === false || !displayable(item.displayRange))
            continue;
          const p = set.position(row, tau, { x: 0, y: 0, z: 0 });
          out.push({
            id,
            item,
            position: grounded.has(id) ? onGround(row, p) : p,
          });
        }
        return out;
      },
      /**
       * Where the row of `id` is drawn `aheadMs` after the motion clock's
       * time in `frameState` (now without one), on its ground when clamped;
       * null without a row.
       */
      drawnAt(id, aheadMs = 0, frameState = undefined) {
        const row = set.row(id);
        if (row < 0) return null;
        const tau = set.seconds(clockTime(frameState)) + aheadMs / 1000;
        const p = set.position(row, tau, { x: 0, y: 0, z: 0 });
        return grounded.has(id) ? onGround(row, p) : p;
      },
      /** Hide the rows of `ids` (in clusters); show the rest again. */
      setClustered(ids) {
        const before = clustered;
        clustered = ids;
        for (const id of new Set([...before, ...ids])) {
          if (before.has(id) === ids.has(id)) continue;
          const row = set.row(id);
          const item = record.items.get(id);
          if (row < 0 || !item) continue;
          set.setShown(
            row,
            item.show !== false &&
              displayable(item.displayRange) &&
              !ids.has(id),
          );
        }
      },
      /** Whether rows still move at the motion clock's time in `frameState`. */
      moving(frameState) {
        return (
          set.count > 0 &&
          Cesium.JulianDate.toDate(clockTime(frameState)).getTime() <
            movingUntil
        );
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

  /** A frame's ground samples, shared by the port's GPU icon sets. */
  const groundBudget = () => ({
    ends: GROUND_SAMPLES_PER_FRAME,
    surface: SURFACE_SAMPLES_PER_FRAME,
  });

  return { wants, check, attach, groundBudget };
}
