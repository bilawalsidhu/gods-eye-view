import { recordWorkSlice } from '../sources/phaseTiming.js';
import { ringCentroid } from '../sources/featureGeometry.js';
import { showOsmCredit, hideOsmCredit } from '../data/dataCredits.js';
import { fromDegrees } from '../geo/ellipsoid.js';
import {
  drawOf,
  findCamera,
  findFrame,
  frameOf,
} from '../render/rendererOf.js';
import { heightsOf } from '../queries/heights.js';

/**
 * World-space annotation renderer (Direction A).
 *
 * Draws annotations through the renderer's draw port, anchored to lon/lat.
 * Because they live in the 3D scene they track the camera, sit at the right
 * depth, and are occluded by the photoreal buildings the way a real marker
 * would be.
 *
 * IMPORTANT — drawing on Google Photorealistic 3D Tiles:
 *   The globe is hidden, so there is no terrain to clamp to. Ground geometry
 *   (areas, rings, connectors) is draped onto the photoreal tiles and the
 *   terrain alike (`clampTo: 'both'`); points clamp to the surface. This
 *   keeps marks sitting ON the world instead of buried at sea level.
 *
 * Fades follow the mark's alpha: the engine calls `sync` as it changes, and
 * each mark's items take their new colours where they are. Pulsing fills
 * are a declarative pulse the renderer runs; target rings follow the
 * camera's height, read before each frame, and are sent again at the radius
 * it gives when that changes.
 *
 * Each mark draws into sets of its own, so adding or removing one leaves
 * the others' geometry alone.
 *
 * Renderer contract (shared with the screen-space renderer):
 *   add(anno) / remove(anno) / sync(map) / destroy()
 */

/** Each palette colour as `r, g, b`, 0..1. */
const PALETTE = {
  primary: rgb('#8be9ff'),
  amber: rgb('#ffb547'),
  cyan: rgb('#39d0ff'),
  green: rgb('#5dff9f'),
  red: rgb('#ff6b6b'),
};
const WHITE = [1, 1, 1];

/**
 * What a draped mark is allowed to paint onto: terrain AND 3D tiles, so one
 * value covers a keyless boot (imagery on the globe, no tiles) and the
 * photoreal world alike. Tiles alone rendered every area, route and arrow to
 * nothing on a keyless boot.
 */
const CLAMP_TO = 'both';

/**
 * The pulse of a pulsing fill: its alpha swings between 60% and all of its
 * own, a sine of about 0.8 Hz on the wall clock.
 */
const PULSE_MS = (2 * Math.PI) / 0.005;
const PULSE_LOW = 0.6;

/** Target rings: 3% of the camera's height, between 14 m and 170 m. */
const RING_RADIUS = Object.freeze({ factor: 0.03, min: 14, max: 170 });

/** Relative change of the ring radius under which rings are not redrawn. */
const RING_RESIZE = 1e-3;

/**
 * A target ring's radius, metres, for a camera `height` metres above the
 * ellipsoid; 1000 m stands in for a height the camera cannot give.
 * @param {number} height
 */
export function ringRadiusAt(height) {
  const h = Number.isFinite(height) ? height : 1000;
  return Math.max(
    RING_RADIUS.min,
    Math.min(RING_RADIUS.max, h * RING_RADIUS.factor),
  );
}

/**
 * Each renderer's sets have ids of their own, unique across copies of this
 * module on one viewer too.
 */
let rendererSeq = 0;
const MODULE_TOKEN = Math.random().toString(36).slice(2, 8);

export function createWorldAnnotationRenderer(viewer) {
  const draw = drawOf(viewer);
  const instance = `${MODULE_TOKEN}${(rendererSeq += 1)}`;
  let markSeq = 0;
  const osmAnnotations = new Set();
  // Every mark with sets on the globe, so sync() can take a hidden one out.
  const drawn = new Set();
  const pendingGround = new Map();
  const groundQueue = [];
  let offGroundFrame = null;
  let destroyed = false;
  // Marks with a target ring, and the radius they are drawn at.
  const ringed = new Set();
  let offRingFrame = null;
  let ringRadius = ringRadiusAt(cameraHeight());

  /** The camera's height above the ellipsoid, or NaN when it has none. */
  function cameraHeight() {
    try {
      return findCamera(viewer)?.pose().height ?? Number.NaN;
    } catch {
      return Number.NaN;
    }
  }

  /** The current ring radius, for the items that draw rings. */
  const ringRadiusNow = () => ringRadius;

  /**
   * Before each frame: when the camera's height gives the rings another
   * radius, every shown mark's ring is sent again at it. A hidden mark's
   * ring catches up when it shows (`sync`).
   */
  function followRings() {
    const radius = ringRadiusAt(cameraHeight());
    if (Math.abs(radius - ringRadius) <= RING_RESIZE * ringRadius) return;
    ringRadius = radius;
    for (const anno of ringed) if (!anno.hidden) resizeRing(anno);
  }

  /** Send a mark's ring again at the current radius, when it differs. */
  function resizeRing(anno) {
    const was = anno._drawn;
    const set = anno._draw?.shapes;
    if (!was?.ring || !set || was.ringRadius === ringRadius) return;
    was.ringRadius = ringRadius;
    set.upsert([was.ring(was.alpha)]);
  }

  /**
   * Keep the ring frame listener while any mark has a ring. A host with no
   * frame port draws its rings at the radius they were added with.
   */
  function watchRings() {
    if (ringed.size && !offRingFrame)
      offRingFrame = findFrame(viewer)?.on('preRender', followRings) ?? null;
    else if (!ringed.size && offRingFrame) {
      offRingFrame();
      offRingFrame = null;
    }
  }

  const requestRender = () => frameOf(viewer).requestRender('annotations');

  function sampleBuilding(anno, options) {
    pendingGround.get(anno)?.finish('cancelled');
    return new Promise((resolve, reject) => {
      const queuedAt = performance.now();
      // The 2 s budget starts when this task reaches the head of the queue, so
      // waiting behind other buildings on a slow device never spends it.
      let started = null;
      const workTrace = options.workTrace;
      if (workTrace) workTrace.samplerStart = queuedAt;
      let groundDetailSlots = 0;
      let groundDetailReady = true;
      if (workTrace) {
        try {
          workTrace.groundDetailDropped = 0;
        } catch {
          groundDetailReady = false;
        }
      }
      const task = {
        anno,
        points: groundProbePositions(anno.ring),
        samples: [],
        index: 0,
      };
      const timing = {
        workMs: 0,
        maxSliceMs: 0,
        lastSliceMs: 0,
        probes: 0,
        queuedMs: 0,
        deadlineMs: null,
      };
      task.current = () =>
        !destroyed &&
        !options.signal?.aborted &&
        pendingGround.get(anno) === task &&
        (options.isCurrent?.() ?? true);
      task.begin = () => {
        if (started !== null) return;
        started = performance.now();
        timing.queuedMs = started - queuedAt;
        timing.deadlineMs = started + 2000;
        if (workTrace) workTrace.samplerHeadAt = started;
        task.timer = setTimeout(() => task.finish('timeout'), 2000);
        // A task promoted outside a frame (its predecessor timed out or was
        // cancelled) still needs frames in request-render mode.
        try {
          requestRender();
        } catch {
          /* the enqueue path reports render failures */
        }
      };
      task.finish = (status, error) => {
        if (pendingGround.get(anno) !== task) return;
        pendingGround.delete(anno);
        const position = groundQueue.indexOf(task);
        groundQueue.splice(position, 1);
        clearTimeout(task.timer);
        if (position === 0) groundQueue[0]?.begin();
        options.signal?.removeEventListener('abort', task.abort);
        if (!groundQueue.length && offGroundFrame) {
          offGroundFrame();
          offGroundFrame = null;
        }
        timing.elapsedMs = performance.now() - (started ?? queuedAt);
        if (workTrace) {
          workTrace.probes = timing.probes;
          workTrace.samplerStatus = status;
        }
        if (error) reject(error);
        else resolve({ status, timing });
      };
      task.abort = () => task.finish('cancelled');
      task.step = () => {
        const workStart = workTrace ? performance.now() : 0;
        // Nested call/commit wall-time only; the original parent remains the gate.
        const detail =
          workTrace && groundDetailSlots++ < 8
            ? {
                index: task.index,
                status: groundDetailReady ? 'recorded' : 'missing',
                clampStart: null,
                clampEnd: null,
                clampResult: 'not-run',
                commitStart: null,
                commitEnd: null,
                commitStatus: 'not-run',
              }
            : undefined;
        const note = detail
          ? (key) => {
              try {
                const at = performance.now();
                if (Number.isFinite(at)) detail[key] = at;
                else detail.status = 'missing';
              } catch {
                detail.status = 'missing';
              }
            }
          : null;
        if (workTrace && !detail) {
          try {
            workTrace.groundDetailDropped += 1;
          } catch {
            // Missing attribution must not change the sampler outcome.
          }
        }
        try {
          if (!task.current()) return task.finish('cancelled');
          if (performance.now() - started >= 2000)
            return task.finish('timeout');
          const sliceStart = performance.now();
          let error;
          try {
            // Without depth support the surface answers nothing: the
            // probes are skipped, and the fallback height is taken.
            if (heightsOf(viewer).supported().surface) {
              const [lon, lat] = task.points[task.index++];
              timing.probes += 1;
              try {
                let h;
                note?.('clampStart');
                try {
                  // The surface under the probe: the drawn tiles or terrain,
                  // never a mark (no draw set is in height queries).
                  h = heightsOf(viewer).now({ lon, lat });
                  if (detail)
                    detail.clampResult = Number.isFinite(h) ? 'hit' : 'missed';
                } finally {
                  note?.('clampEnd');
                }
                if (Number.isFinite(h) && h > -430 && h < 9000)
                  task.samples.push(h);
              } catch {
                /* surface not ready: preserve the existing sample filter */
              }
            } else task.index = task.points.length;
            if (performance.now() - started >= 2000) {
              task.finish('timeout');
              return;
            }
            if (!task.current()) return task.finish('cancelled');
            if (task.index === task.points.length) {
              if (detail) detail.commitStatus = 'attempted';
              note?.('commitStart');
              task.samples.sort((a, b) => a - b);
              const ground = task.samples.length
                ? task.samples[Math.floor(task.samples.length * 0.3)]
                : null;
              add(anno, {
                sampledGroundHeight: ground,
                isCurrent: task.current,
              });
              if (performance.now() >= timing.deadlineMs) {
                task.finish('timeout');
                remove(anno);
                return;
              }
            }
          } catch (caught) {
            error = caught;
          } finally {
            timing.lastSliceMs = performance.now() - sliceStart;
            timing.workMs += timing.lastSliceMs;
            timing.maxSliceMs = Math.max(timing.maxSliceMs, timing.lastSliceMs);
          }
          if (error) {
            task.finish('failed', error);
            try {
              remove(anno);
            } catch {
              /* retain the original commit error */
            }
          } else if (task.index === task.points.length)
            task.finish('installed');
        } finally {
          // Commit includes sort/selection/add/deadline/finish or rollback,
          // including intervening bookkeeping; it is not exclusive draw cost.
          if (detail?.commitStatus === 'attempted') note('commitEnd');
          if (workTrace)
            recordWorkSlice(
              workTrace,
              'ground-step',
              workStart,
              undefined,
              detail,
            );
        }
      };
      pendingGround.set(anno, task);
      groundQueue.push(task);
      if (groundQueue[0] === task) task.begin();
      options.signal?.addEventListener('abort', task.abort, { once: true });
      if (!task.current()) return task.finish('cancelled');
      try {
        if (!offGroundFrame)
          offGroundFrame = frameOf(viewer).on('postRender', onGroundFrame);
        requestRender();
      } catch (error) {
        task.finish('failed', error);
      }
    });
  }

  function onGroundFrame() {
    // One building probe TOTAL, not one per mark. Other renderers have their own work.
    const task = groundQueue[0];
    try {
      task?.step();
      if (groundQueue.length) requestRender();
    } catch (error) {
      for (const pending of [...groundQueue]) pending.finish('failed', error);
    }
  }
  /**
   * The mark's draw sets, made on first use: shapes (fills, volumes, rings),
   * lines (outlines, routes, arrows) and points (markers).
   */
  function setsOf(anno) {
    if (!anno._draw) {
      markSeq += 1;
      const prefix = `annotations:${instance}:${markSeq}`;
      anno._draw = { prefix, shapes: null, lines: null, points: null };
    }
    return anno._draw;
  }

  function setOf(anno, kind) {
    const sets = setsOf(anno);
    if (!sets[kind]) {
      sets[kind] = draw[kind]({
        id: `${sets.prefix}:${kind}`,
        clampTo: CLAMP_TO,
        show: !anno.hidden,
      });
    }
    return sets[kind];
  }

  function add(anno, options = {}) {
    // A destroyed renderer draws nothing more.
    if (destroyed) return;
    // Published to the mark BEFORE anything is drawn: a mid-add failure (bad
    // geometry, lost context) must leave the sets that DID land visible to
    // remove(), or the rollback path cannot reach them and they stay on the
    // globe forever.
    drawn.add(anno);

    if (
      anno.ring?.length >= 3 &&
      anno.footprintKind === 'building' &&
      !Object.hasOwn(options, 'sampledGroundHeight')
    ) {
      return sampleBuilding(anno, options);
    }

    // Rings not yet followed take the camera's height now.
    if (!offRingFrame) ringRadius = ringRadiusAt(cameraHeight());
    const items = itemsOf(anno, options, ringRadiusNow);
    anno._drawn = {
      alpha: alphaOf(anno),
      items,
      ring: items.ring,
      ringRadius,
    };
    if (items.ring) ringed.add(anno);
    else ringed.delete(anno);
    watchRings();
    const current = () => options.isCurrent?.() ?? true;
    const building = anno.footprintKind === 'building';
    for (const kind of ['shapes', 'lines', 'points']) {
      if (!items[kind].length) {
        // Added again as another kind: what it drew before goes.
        disposeSet(anno, kind);
        continue;
      }
      if (building && !current()) throw new Error('Building install cancelled');
      setOf(anno, kind).set(items[kind].map((item) => item(anno._drawn.alpha)));
      if (building && !current()) {
        clearSets(anno);
        throw new Error('Building install cancelled');
      }
    }
    if (anno.type === 'route' && items.lines.length) {
      osmAnnotations.add(anno);
      showOsmCredit(viewer, anno);
    }
    if (
      (items.shapes.length || items.lines.length || items.points.length) &&
      anno.ring?.length >= 3 &&
      !anno.synthesized &&
      (anno.outlineCredit === 'tiles' || anno.outlineCredit === 'osm') &&
      current()
    ) {
      // The actual world proxy owns both geometry and credit, including rollback.
      osmAnnotations.add(anno);
      showOsmCredit(viewer, anno, {
        openMapTiles: anno.outlineCredit === 'tiles',
      });
    }
  }

  function disposeSet(anno, kind) {
    const sets = anno?._draw;
    if (!sets?.[kind]) return;
    try {
      sets[kind].dispose();
    } catch {
      /* already gone */
    }
    sets[kind] = null;
  }

  function clearSets(anno) {
    for (const kind of ['shapes', 'lines', 'points']) disposeSet(anno, kind);
  }

  function remove(anno) {
    pendingGround.get(anno)?.finish('cancelled');
    hideOsmCredit(viewer, anno);
    osmAnnotations.delete(anno);
    drawn.delete(anno);
    ringed.delete(anno);
    watchRings();
    clearSets(anno);
    if (anno) {
      anno._draw = null;
      anno._drawn = null;
    }
  }

  /**
   * A hidden mark is taken out whole (its sets hidden), so no fill, line or
   * pick can still show it; a mark whose alpha moved (fading in or out)
   * takes its new colours in place.
   */
  function sync() {
    for (const anno of drawn) {
      const sets = anno._draw;
      if (!sets) continue;
      const show = !anno.hidden;
      for (const kind of ['shapes', 'lines', 'points'])
        if (sets[kind] && sets[kind].show !== show) sets[kind].show = show;
      const was = anno._drawn;
      const alpha = alphaOf(anno);
      if (!was || was.alpha === alpha) {
        // Shown again: its ring catches up with the camera.
        if (show) resizeRing(anno);
        continue;
      }
      was.alpha = alpha;
      was.ringRadius = ringRadius;
      for (const kind of ['shapes', 'lines', 'points'])
        if (sets[kind] && was.items[kind].length)
          sets[kind].upsert(was.items[kind].map((item) => item(alpha)));
    }
  }

  function destroy() {
    destroyed = true;
    for (const task of [...pendingGround.values()]) task.finish('cancelled');
    for (const anno of osmAnnotations) hideOsmCredit(viewer, anno);
    osmAnnotations.clear();
    ringed.clear();
    watchRings();
    for (const anno of drawn) {
      clearSets(anno);
      anno._draw = null;
      anno._drawn = null;
    }
    drawn.clear();
  }

  return { add, remove, sync, destroy };
}

/** A mark's alpha as drawn, 0..1. */
const alphaOf = (anno) => Math.max(0, Math.min(1, anno.alpha ?? 1));

/** `[r, g, b, a]` for a palette colour at `alpha`. */
const colour = (base, alpha) => [base[0], base[1], base[2], alpha];

/** A fill or outline that pulses about `alpha`. */
const pulse = (alpha) => ({
  property: 'alpha',
  from: alpha * PULSE_LOW,
  to: alpha,
  periodMs: PULSE_MS,
});

/**
 * What a mark draws, as item makers by kind, each taking the mark's alpha:
 * built once per add, called again on each fade step. `ring` is the target
 * ring's maker among the shapes, drawn at `ringRadiusNow()`.
 */
function itemsOf(anno, options, ringRadiusNow) {
  const base = PALETTE[anno.color] || PALETTE.primary;
  const shapes = [];
  const lines = [];
  const points = [];
  const meta = { annotation: anno.id };
  let ring = null;
  const draped = (id, positions, widthPx, style) => (alpha) => ({
    id,
    positions,
    widthPx,
    mode: 'draped',
    clampTo: CLAMP_TO,
    style: style(alpha),
    meta,
  });
  if (anno.ring?.length >= 3 && anno.footprintKind === 'building') {
    // Single building → the PRIMARY highlight is a translucent extruded
    // column round the building that pulses, from just under its ground to
    // well over its roof, with a faint wireframe cage on it as a secondary
    // cue and a crisp draped base outline.
    const parts =
      Array.isArray(anno.polygons) && anno.polygons.length
        ? anno.polygons
        : [[anno.ring]];
    const groundH =
      options.sampledGroundHeight ??
      (Number.isFinite(anno.anchor.height)
        ? anno.anchor.height - (anno.buildingHeight || 25)
        : 0);
    const baseH = groundH - 3;
    // Tall headroom so under-tagged building heights are covered too.
    const topH = groundH + Math.max(18, anno.buildingHeight || 25) + 24;
    const at = (ring) =>
      ring.map(([lon, lat]) => ({ lon, lat, height: baseH }));
    parts.forEach(([outer, ...holes], p) => {
      const buffered = bufferRing(outer, 3);
      // Built once: a fade step only changes colours.
      const volume = { kind: 'polygon', rings: [buffered, ...holes].map(at) };
      shapes.push((alpha) => ({
        id: `volume:${p}`,
        geometry: volume,
        fill: colour(base, 0.45 * alpha),
        animate: pulse(0.45 * alpha),
        extrudeHeight: topH,
        height: 'absolute',
        meta,
      }));
      // Faint, SIMPLIFIED wireframe cage: the footprint decimated so the
      // extruded outline draws ~14 clean verticals, not one per (often
      // 100+) ring vertex.
      const cage = {
        kind: 'polygon',
        rings: [at(decimateRing(buffered, 14))],
      };
      shapes.push((alpha) => ({
        id: `cage:${p}`,
        geometry: cage,
        outline: colour(base, 0.32 * alpha),
        outlineOnly: true,
        animate: pulse(0.32 * alpha),
        extrudeHeight: topH,
        height: 'absolute',
        meta,
      }));
      [outer, ...holes].forEach((ring, r) =>
        lines.push(
          draped(`base:${p}:${r}`, ecefOf(closedRing(ring)), 3, (alpha) => ({
            kind: 'glow',
            color: colour(base, 0.7 * alpha),
            power: 0.25,
          })),
        ),
      );
    });
  } else if (anno.ring?.length >= 3) {
    // Larger area (district / compound / park / state) → flat fill draped on
    // the tiles + a glowing outline. Draping is right here: you can't extrude
    // a whole neighbourhood, and the GIS overlay shows the boundary clearly.
    // A multi-part outline (`anno.polygons`: Hawaii's islands, Berlin as a
    // hole in Brandenburg) draws every part with its holes.
    const parts =
      Array.isArray(anno.polygons) && anno.polygons.length
        ? anno.polygons
        : [[anno.ring]];
    // Synthesized (approximate) areas get a fainter fill so they don't read
    // as solid, and a DASHED outline (signals "approximate, not an
    // authoritative boundary", research §8.4/§8.6); real footprints a solid
    // glow.
    const fillAlpha = anno.synthesized ? 0.1 : 0.2;
    const style = anno.synthesized
      ? (alpha) => ({
          kind: 'dash',
          color: colour(base, 0.95 * alpha),
          length: 24,
        })
      : (alpha) => ({ kind: 'glow', color: colour(base, alpha), power: 0.35 });
    parts.forEach(([outer, ...holes], p) => {
      if (!Array.isArray(outer) || outer.length < 3) return;
      const rings = [outer, ...holes.filter((h) => h?.length >= 3)];
      const area = {
        kind: 'polygon',
        rings: rings.map((ring) => ring.map(([lon, lat]) => ({ lon, lat }))),
      };
      shapes.push((alpha) => ({
        id: `fill:${p}`,
        geometry: area,
        fill: colour(base, fillAlpha * alpha),
        animate: pulse(fillAlpha * alpha),
        height: 'clampGround',
        clampTo: CLAMP_TO,
        meta,
      }));
      rings.forEach((ring, r) =>
        lines.push(
          draped(`outline:${p}:${r}`, ecefOf(closedRing(ring)), 6, style),
        ),
      );
    });
  } else if (
    anno.type === 'route' &&
    Array.isArray(anno.path) &&
    anno.path.length >= 2
  ) {
    // A real path (street-following) draped on the surface, with dashes that
    // FLOW toward the destination.
    lines.push(
      draped(
        'route',
        anno.path.map((p) => fromDegrees(p.lon, p.lat, 0)),
        9,
        (alpha) => ({
          kind: 'flow',
          color: colour(base, 0.95 * alpha),
          repeat: 64,
          duty: 0.46,
          speed: 0.55,
        }),
      ),
    );
  } else if (anno.type === 'arrow' && anno.to) {
    // Connector draped across the ground from origin to destination.
    lines.push(
      draped(
        'arrow',
        [
          fromDegrees(anno.anchor.lon, anno.anchor.lat, 0),
          fromDegrees(anno.to.lon, anno.to.lat, 0),
        ],
        16,
        (alpha) => ({ kind: 'arrow', color: colour(base, 0.95 * alpha) }),
      ),
    );
  } else {
    // pin / highlight / label — a camera-proportional target ring + a marker.
    const pos = { lon: anno.anchor.lon, lat: anno.anchor.lat };
    if (anno.type !== 'label') {
      ring = (alpha) => ({
        id: 'ring',
        geometry: {
          kind: 'ellipse',
          center: pos,
          semiMajor: ringRadiusNow(),
          semiMinor: ringRadiusNow(),
        },
        fill: colour(base, 0.38 * alpha),
        animate: pulse(0.38 * alpha),
        height: 'clampGround',
        clampTo: CLAMP_TO,
        meta,
      });
      shapes.push(ring);
    }
    // Captions belong to the hybrid renderer's screen-space callouts.
    points.push((alpha) => ({
      id: 'marker',
      pos,
      height: 'clampGround',
      pixelSize: anno.type === 'label' ? 8 : 14,
      color: colour(base, alpha),
      outlineColor: colour(WHITE, 0.95 * alpha),
      outlineWidth: 3,
      disableDepthTest: Number.POSITIVE_INFINITY,
      meta,
    }));
  }
  return { shapes, lines, points, ring };
}

/** `[lon, lat]` pairs as ECEF positions on the ellipsoid. */
const ecefOf = (ring) => ring.map(([lon, lat]) => fromDegrees(lon, lat, 0));

function rgb(css) {
  const n = parseInt(css.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/** The ring with its first vertex repeated at the end, so an outline closes. */
function closedRing(ring) {
  const first = ring[0];
  const last = ring[ring.length - 1];
  return first[0] === last[0] && first[1] === last[1] ? ring : [...ring, first];
}

/** Evenly down-sample a [[lon,lat],...] ring to at most n points (keeps shape). */
function decimateRing(ring, n) {
  if (ring.length <= n) return ring;
  const out = [];
  for (let i = 0; i < n; i++) out.push(ring[Math.floor((i * ring.length) / n)]);
  return out;
}

/**
 * The original eight outside-footprint probes. Keep their coordinates and order
 * while scheduling the expensive scene picks across rendered frames.
 */
function groundProbePositions(ring) {
  const { lon: clon, lat: clat } = ringCentroid(ring);
  const latS = 111320;
  const lonS = latS * Math.cos((clat * Math.PI) / 180);
  let maxR = 0;
  for (const [lon, lat] of ring) {
    maxR = Math.max(maxR, Math.hypot((lon - clon) * lonS, (lat - clat) * latS));
  }
  const out = maxR * 1.5 + 12;
  const dirs = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
    [0.7, 0.7],
    [-0.7, -0.7],
    [0.7, -0.7],
    [-0.7, 0.7],
  ];
  return dirs.map(([dx, dy]) => {
    const lon = clon + (dx * out) / lonS;
    const lat = clat + (dy * out) / latS;
    return [lon, lat];
  });
}

/**
 * Inflate a [[lon,lat],...] ring outward from its centroid by `meters`, so an
 * extruded building volume encloses the photogrammetry mesh instead of slicing
 * through its edges. Radial buffer — fine for compact building footprints.
 */
function bufferRing(ring, meters) {
  let clon = 0;
  let clat = 0;
  for (const [lon, lat] of ring) {
    clon += lon;
    clat += lat;
  }
  clon /= ring.length;
  clat /= ring.length;
  const latScale = 111320;
  const lonScale = latScale * Math.cos((clat * Math.PI) / 180);
  return ring.map(([lon, lat]) => {
    const dx = (lon - clon) * lonScale;
    const dy = (lat - clat) * latScale;
    const d = Math.hypot(dx, dy) || 1;
    const k = (d + meters) / d;
    return [clon + (dx * k) / lonScale, clat + (dy * k) / latScale];
  });
}
