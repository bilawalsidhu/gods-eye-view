import * as Cesium from 'cesium';
import { getOverlayPaintRect } from '../overlays/worldOverlay.js';
import {
  getActiveTrackedReadoutId,
  TRACKED_OVERLAY_SOURCE_ID,
} from '../data/trackedReadout.js';
import { t } from '../i18n/index.js';
import { nextTick } from 'vue';
import { useScreenAnnotationsStore } from '../ui/stores/screenAnnotations.js';
import { applicationPinia } from '../ui/vueRuntime.js';

/** A label whose detailed outline could not be resolved. */
function outlineUnavailableLabel(label) {
  return t('{label} · Detailed outline unavailable', { label: label || '' });
}

/**
 * Screen-space annotation renderer (Direction B — the "whiteboard" aesthetic).
 *
 * Same world-anchored data model as the world-space renderer, but drawn as an
 * SVG overlay that is RE-PROJECTED every frame from the world coordinates via
 * `SceneTransforms.worldToWindowCoordinates`. That gives the best of both:
 *
 *   - World-anchored, so marks PERSIST and track as the camera moves/orbits
 *     (unlike a frame-bound pixel overlay that has to clear on camera motion).
 *   - SVG-rendered, so we get the hand-drawn explainer look — sketchy strokes,
 *     pulsing rings, draw-on outlines, arrows, and glassy callout cards with
 *     leader lines — that native Cesium primitives can't express as nicely.
 *
 * Marks behind the globe horizon are culled with an EllipsoidalOccluder, and
 * anything that projects off-screen / behind the camera is hidden.
 *
 * The board is presented to the screen annotations store, whose view renders
 * the SVG overlay; each mark's parts are plain attribute records here, and the
 * view hands back the elements this measures (callout text and mark groups).
 *
 * Screen-renderer contract (update is used by the hybrid outline-upgrade path):
 *   add(anno) / update(anno) / remove(anno) / sync(map) / destroy()
 */

// Keys each mark, so a mark re-added while its predecessor fades out never
// reuses the fading one's elements.
let marks = 0;
const PALETTE = {
  primary: '#8be9ff',
  amber: '#ffb547',
  cyan: '#39d0ff',
  green: '#5dff9f',
  red: '#ff6b6b',
};

// Altitude-scaled marker geometry. Zoomed in (≤ NEAR_H) reticles are full-size; pulling
// back shrinks them toward small recon dots (MIN floor) so many world-anchored marks no
// longer collapse into an overlapping blob when their anchors project close together.
const MARK_SCALE_NEAR_H = 800; // m: at/below this, full-size reticles
const MARK_SCALE_FAR_H = 6000; // m: at/above this, minimum size
const MARK_SCALE_MIN = 0.32; // floor so dots never vanish
const RING_OUTER_R = 34;
const RING_INNER_R = 18;
const DOT_R = 5;
const LABEL_DOT_R = 4;
function markScale(h) {
  if (!(h > MARK_SCALE_NEAR_H)) return 1;
  if (h >= MARK_SCALE_FAR_H) return MARK_SCALE_MIN;
  const t = (h - MARK_SCALE_NEAR_H) / (MARK_SCALE_FAR_H - MARK_SCALE_NEAR_H);
  return 1 - t * (1 - MARK_SCALE_MIN);
}

export function createScreenAnnotationRenderer(
  viewer,
  {
    overlayPaintRect = getOverlayPaintRect,
    activeTrackedReadoutId = getActiveTrackedReadoutId,
    store = useScreenAnnotationsStore(applicationPinia()),
  } = {},
) {
  // The arrowhead markers the board's defs hold, in the order first used.
  const arrowMarkers = new Map();
  let viewBox = null;

  const scene = viewer.scene;
  const occluder = new Cesium.EllipsoidalOccluder(
    Cesium.Ellipsoid.WGS84,
    scene.camera.positionWC,
  );
  const records = new Map(); // anno.id -> { key, anno, group, parts }
  const leaving = new Map(); // key -> a removed mark's record while it fades out
  const byKey = new Map(); // key -> record, live or fading
  const timers = new Set();
  const owner = {};
  let published = '';
  // Only the renderer whose board the store shows may change or remove it.
  const shown = () => store.board?.owner === owner;
  const scratch = new Cesium.Cartesian2();
  const scratchDir = new Cesium.Cartesian3();
  // Per-point ground height cache. Marks must sit on the real surface, not at
  // sea level — otherwise in elevated cities (Austin ~150 m) they project
  // underground and parallax sinks them at oblique angles. Sampled once the
  // tiles under the point load, then settled (stable, no per-frame jitter).
  const heightCache = new Map();
  const HEIGHT_CACHE_SOFT = 600; // target size; over this we evict keys not used this frame
  const HEIGHT_CACHE_HARD = 8000; // absolute ceiling (one big ring + others) — never exceeded
  let projGen = 0; // bumped each projection frame; entries used this frame are "hot"
  function trimHeightCache() {
    if (heightCache.size <= HEIGHT_CACHE_SOFT) return;
    // Evict COLD keys first (not touched this frame), so a single large area/route
    // — the screen renderer can project a ring up to ~4000 points — cannot churn its
    // OWN active heights out of cache and force a clampToHeight every frame.
    for (const [k, v] of heightCache) {
      if (heightCache.size <= HEIGHT_CACHE_SOFT) break;
      if (v.gen !== projGen) heightCache.delete(k);
    }
    // Backstop if a single frame legitimately needs more than the soft cap.
    while (heightCache.size > HEIGHT_CACHE_HARD) {
      const oldest = heightCache.keys().next().value;
      if (oldest === undefined) break;
      heightCache.delete(oldest);
    }
  }

  // Re-project every annotation each rendered frame so marks stay glued to the
  // world. postRender runs after the camera/tiles update, so positions are exact.
  const onPostRender = () => projectAll();
  scene.postRender.addEventListener(onPostRender);

  function color(anno) {
    return PALETTE[anno.color] || PALETTE.primary;
  }

  // Best-effort surface height under a coordinate (clamps onto the 3D tiles).
  // Returns 0 until the tile loads, then caches the validated height.
  function groundHeight(lon, lat) {
    const key = `${lon.toFixed(5)},${lat.toFixed(5)}`;
    const cached = heightCache.get(key);
    if (cached && cached.settled) {
      // Mark hot for this frame + bump to most-recently-used so heights for live
      // marks survive eviction while places we've navigated away from age out.
      cached.gen = projGen;
      heightCache.delete(key);
      heightCache.set(key, cached);
      return cached.h;
    }
    try {
      if (
        scene.clampToHeightSupported &&
        typeof scene.clampToHeight === 'function'
      ) {
        const c = scene.clampToHeight(
          Cesium.Cartesian3.fromDegrees(lon, lat, 0),
        );
        if (c) {
          const h = Cesium.Cartographic.fromCartesian(c).height;
          if (Number.isFinite(h) && h > -430 && h < 9000) {
            heightCache.set(key, { h, settled: true, gen: projGen });
            trimHeightCache();
            return h;
          }
        }
      }
    } catch {
      /* tiles not ready */
    }
    const fallback = cached ? cached.h : 0;
    heightCache.set(key, { h: fallback, settled: false, gen: projGen });
    trimHeightCache();
    return fallback;
  }

  function add(anno) {
    const c = color(anno);
    const group = { opacity: '0', display: '', entered: false };
    const parts = {};

    if (anno.type === 'area' && anno.ring && anno.ring.length >= 3) {
      // Synthesized (buffered/approximate) areas render DASHED + fainter, with no
      // "draw-on" gesture, so they never masquerade as an authoritative boundary.
      parts.poly = svgPart('path', {
        class: anno.synthesized ? 'gev-anno-area' : 'gev-anno-area gev-draw',
        fill: c,
        'fill-rule': 'evenodd',
        stroke: c,
        'fill-opacity': anno.synthesized ? '0.08' : '0.14',
        'stroke-width': '2.5',
        ...(anno.synthesized ? { 'stroke-dasharray': '9 7' } : {}),
        filter: 'url(#gev-sketch)',
      });
      parts.label = makeCallout(
        anno.outlineUnavailable
          ? outlineUnavailableLabel(anno.label)
          : anno.label,
        c,
      );
    } else if (anno.type === 'arrow' && anno.to) {
      parts.path = svgPart('path', {
        class: 'gev-anno-arrow gev-draw',
        fill: 'none',
        stroke: c,
        'stroke-width': '3',
        'marker-end': `url(#gev-arrow-${anno.color || 'primary'})`,
        filter: 'url(#gev-sketch)',
      });
      ensureArrowMarker(arrowMarkers, anno.color || 'primary', c);
      parts.label = makeCallout(
        anno.outlineUnavailable
          ? outlineUnavailableLabel(anno.label)
          : anno.label,
        c,
      );
    } else if (
      anno.type === 'route' &&
      Array.isArray(anno.path) &&
      anno.path.length >= 2
    ) {
      // Multi-waypoint path: a drawn-on polyline with a dot at each waypoint.
      parts.poly = svgPart('polyline', {
        class: 'gev-anno-arrow gev-draw',
        fill: 'none',
        stroke: c,
        'stroke-width': '3',
        'marker-end': `url(#gev-arrow-${anno.color || 'primary'})`,
        filter: 'url(#gev-sketch)',
      });
      ensureArrowMarker(arrowMarkers, anno.color || 'primary', c);
      parts.dots = anno.path.map(() =>
        svgPart('circle', {
          class: 'gev-anno-dot',
          fill: c,
          stroke: '#06121c',
          'stroke-width': '2',
          r: '4',
        }),
      );
      parts.label = makeCallout(
        anno.outlineUnavailable
          ? outlineUnavailableLabel(anno.label)
          : anno.label,
        c,
      );
    } else {
      // pin / highlight / label — pulsing target rings + a marker dot + callout
      if (anno.type !== 'label') {
        parts.ringOuter = svgPart('circle', {
          class: 'gev-anno-ring gev-pulse',
          fill: 'none',
          stroke: c,
          'stroke-width': '2',
          r: '34',
        });
        parts.ringInner = svgPart('circle', {
          class: 'gev-anno-ring',
          fill: c,
          'fill-opacity': '0.12',
          stroke: c,
          'stroke-width': '2.5',
          r: '18',
          filter: 'url(#gev-sketch)',
        });
      }
      parts.dot = svgPart('circle', {
        class: 'gev-anno-dot',
        fill: c,
        stroke: '#06121c',
        'stroke-width': '2',
        r: anno.type === 'label' ? '4' : '5',
      });
      parts.leader = svgPart('line', {
        class: 'gev-anno-leader',
        stroke: c,
        'stroke-width': '1.5',
        'stroke-opacity': '0.7',
      });
      parts.label = makeCallout(
        anno.outlineUnavailable
          ? outlineUnavailableLabel(anno.label)
          : anno.label,
        c,
      );
    }

    // Record the mark BEFORE it reaches the board, then unwind on any throw
    // from here down (projectAll reaches into Cesium and can fail on a lost
    // context). Previously a throw past the insert left an ORPHANED mark: the
    // engine's rollback only deletes its own map entry, so the next annotate
    // of the same geometry stacked a fresh mark on top of the corpse.
    const rec = { key: ++marks, anno, group, parts, drawn: false };
    records.set(anno.id, rec);
    byKey.set(rec.key, rec);
    try {
      publish({ force: true });
      // Trigger draw-on / fade-in on the next frame, once the view has the
      // mark in the document. The draw-on effect uses a fixed
      // stroke-dasharray of 1400 (see CSS); the view reports the end of the
      // dashoffset transition, after which the stroke drops its dasharray so
      // a stroke longer than 1400px reads solid (H6).
      requestAnimationFrame(() => {
        group.entered = true;
        publish();
      });
      projectAll();
    } catch (error) {
      // Hard, immediate unwind — a mark that never finished has nothing to
      // fade out, and the caller (engine rollback) must find a clean board.
      records.delete(anno.id);
      byKey.delete(rec.key);
      try {
        publish({ force: true });
      } catch {
        /* the board is unreachable */
      }
      if (records.size === 0) heightCache.clear();
      throw error;
    }
  }

  /**
   * Re-seat a progressive area upgrade without replacing its SVG group. The hybrid
   * renderer converts the pending reticle to a centroid label; keeping the group
   * preserves element identity and prevents the old/new 320 ms fades from overlapping.
   */
  function update(anno, { empty = false } = {}) {
    const rec = records.get(anno.id);
    if (!rec) {
      if (!empty) add(anno);
      return;
    }
    rec.anno = anno;
    if (anno.outlineUnavailable && rec.parts.label) {
      rec.parts.label.text = outlineUnavailableLabel(anno.label);
      // Re-measure once the view shows the new text.
      const label = rec.parts.label;
      publish();
      void nextTick(() => {
        if (rec.parts.label !== label || !sizeCallout(label)) return;
        projectAll();
        publish();
      });
    }

    if (empty) {
      rec.parts = {};
      rec.hidden = true;
      projectAll();
      return;
    }
    rec.hidden = false;

    // Pending areas are initially rendered by this branch as point reticles. On
    // outline resolution the hybrid renderer changes only their screen proxy to a
    // label, whose dot/leader/callout already exist; remove the two reticle rings and
    // keep every remaining node (especially the group and callout) alive.
    if (anno.type === 'label' && rec.parts.dot) {
      delete rec.parts.ringOuter;
      delete rec.parts.ringInner;
      rec.parts.dot.set.r = String(LABEL_DOT_R);
      projectAll();
      return;
    }

    // Area-type updates route through the hybrid proxy only.
  }

  function project(lon, lat, allowOffscreen = false) {
    // Anchor at the real surface height (cached + validated), so marks sit on
    // the ground/building instead of at sea level. The settle-once cache keeps
    // it stable (no per-frame jitter that earlier broke nearby projections).
    const world = Cesium.Cartesian3.fromDegrees(
      lon,
      lat,
      groundHeight(lon, lat),
    );
    // Reject points behind the camera (they produce wrapped/extreme coords).
    Cesium.Cartesian3.subtract(world, scene.camera.positionWC, scratchDir);
    if (Cesium.Cartesian3.dot(scratchDir, scene.camera.directionWC) <= 0)
      return null;
    // Reject points beyond the globe horizon.
    if (!occluder.isPointVisible(world)) return null;
    const win = Cesium.SceneTransforms.worldToWindowCoordinates(
      scene,
      world,
      scratch,
    );
    if (!win || !Number.isFinite(win.x) || !Number.isFinite(win.y)) return null;
    // Reject absurd off-screen projections (anchor not in view).
    const w = scene.canvas.clientWidth || scene.canvas.width;
    const h = scene.canvas.clientHeight || scene.canvas.height;
    if (
      !allowOffscreen &&
      (win.x < -w || win.x > 2 * w || win.y < -h || win.y > 2 * h)
    )
      return null;
    return { x: win.x, y: win.y };
  }

  // Tracked-entity z-order: the tracked aircraft is a Cesium billboard in the
  // CANVAS, which sits BELOW this SVG overlay (z-90, HTML over canvas). So a screen mark
  // could hide it. After layout, any mark whose ACTUAL projected bounding box (rings,
  // leader, polygon, route line, callout card — not just the anchor) INTERSECTS the
  // tracked subject's screen FOOTPRINT is faded. The complete card footprint comes
  // from the host's ACTUAL painted rectangle after final layout; the billboard extent
  // is unioned for aircraft/satellites that also own a native tracked graphic.
  const TRACKED_BBOX_MARGIN = 8; // px buffer added around the footprint
  const TRACKED_FADE_EASE = 0.22; // per-frame ease toward hidden(0) / visible(1)
  const TRACKED_HYSTERESIS_PX = 18; // dead-band so the overlap test can't flip-flop
  const _scratchTrackedWin = new Cesium.Cartesian2();

  // Evaluate a NearFarScalar (billboard scaleByDistance) at a camera distance.
  function nearFarValue(nfs, dist) {
    if (dist <= nfs.near) return nfs.nearValue;
    if (dist >= nfs.far) return nfs.farValue;
    const t = (dist - nfs.near) / (nfs.far - nfs.near);
    return nfs.nearValue + t * (nfs.farValue - nfs.nearValue);
  }
  // Tracked-subject screen footprint, or null when neither host card nor native
  // tracked graphic painted. The host rectangle is authoritative for the card.
  function trackedEntityRect() {
    const trackedId = activeTrackedReadoutId();
    const painted = trackedId
      ? overlayPaintRect(TRACKED_OVERLAY_SOURCE_ID, trackedId)
      : null;
    let left = painted?.x;
    let right = painted ? painted.x + painted.w : undefined;
    let top = painted?.y;
    let bottom = painted ? painted.y + painted.h : undefined;

    const ent = viewer.trackedEntity;
    const now = Cesium.JulianDate.now();
    const world =
      typeof ent?.gevDisplayPosition === 'function'
        ? ent.gevDisplayPosition()
        : null;
    const win = world
      ? Cesium.SceneTransforms.worldToWindowCoordinates(
          scene,
          world,
          _scratchTrackedWin,
        )
      : null;

    // Billboard box — centered on the anchor, magnified by scaleByDistance.
    const bb = ent?.billboard;
    if (bb && win && Number.isFinite(win.x) && Number.isFinite(win.y)) {
      const baseW = bb.width?.getValue?.(now) ?? 28;
      const baseH = bb.height?.getValue?.(now) ?? 28;
      let scale = 1;
      const sbd = bb.scaleByDistance?.getValue?.(now);
      if (sbd)
        scale = nearFarValue(
          sbd,
          Cesium.Cartesian3.distance(scene.camera.positionWC, world),
        );
      const hw = (baseW * scale) / 2;
      const hh = (baseH * scale) / 2;
      const bbLeft = win.x - hw;
      const bbRight = win.x + hw;
      const bbTop = win.y - hh;
      const bbBottom = win.y + hh;
      left = Number.isFinite(left) ? Math.min(left, bbLeft) : bbLeft;
      right = Number.isFinite(right) ? Math.max(right, bbRight) : bbRight;
      top = Number.isFinite(top) ? Math.min(top, bbTop) : bbTop;
      bottom = Number.isFinite(bottom) ? Math.max(bottom, bbBottom) : bbBottom;
    }
    if (![left, right, top, bottom].every(Number.isFinite)) return null;

    const m = TRACKED_BBOX_MARGIN;
    return {
      left: left - m,
      right: right + m,
      top: top - m,
      bottom: bottom + m,
    };
  }

  function projectAll() {
    if (!records.size) {
      publish();
      return;
    }
    projGen += 1; // new frame: entries touched below are "hot" and survive trimming
    const trackedRect = trackedEntityRect();
    occluder.cameraPosition = scene.camera.positionWC;
    const h = scene.canvas.clientHeight || scene.canvas.height;
    const w = scene.canvas.clientWidth || scene.canvas.width;
    viewBox = `0 0 ${w} ${h}`;
    // Shrink point-marker geometry as the camera pulls back (declutter the blob).
    const mScale = markScale(
      viewer.camera.positionCartographic?.height ?? 1000,
    );

    for (const rec of records.values()) {
      const { anno, group, parts } = rec;
      // A mark hidden from Draw's list is not projected, so it neither shows
      // nor pushes a visible callout aside in the placement below.
      if (rec.hidden || anno.hidden) {
        group.display = 'none';
        continue;
      }
      // The last frame's tracked fade holds until this frame's is measured.
      group.opacity = String(
        (anno.alpha ?? 1) *
          (rec._trackedFade !== undefined && rec._trackedFade !== 1
            ? rec._trackedFade
            : 1),
      );

      if (anno.type === 'area' && parts.poly) {
        const paths = [];
        let cx = 0;
        let cy = 0;
        let n = 0;
        const polygons = anno.polygons?.length ? anno.polygons : [[anno.ring]];
        for (const polygon of polygons) {
          const projectedRings = polygon.map((ring) =>
            ring.map(([lon, lat]) => project(lon, lat, polygon.length > 1)),
          );
          // Keep the historical visible-outer projection, but never fill over
          // an unprojectable hole or hide another independently visible part.
          const outer = projectedRings[0].filter(Boolean);
          const holes = projectedRings.slice(1);
          if (
            outer.length < 3 ||
            (holes.length && projectedRings[0].some((p) => !p)) ||
            holes.some((ring) => ring.length < 3 || ring.some((p) => !p))
          )
            continue;
          for (const projected of [outer, ...holes]) {
            paths.push(
              `M ${projected.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' L ')} Z`,
            );
          }
          if (!n) {
            for (const p of outer) {
              cx += p.x;
              cy += p.y;
              n++;
            }
          }
        }
        if (paths.length) {
          parts.poly.set.d = paths.join(' ');
          group.display = '';
          if (parts.label)
            positionCallout(parts.label, cx / n, cy / n - 6, true);
        } else {
          group.display = 'none';
        }
      } else if (anno.type === 'arrow' && parts.path) {
        const a = project(anno.anchor.lon, anno.anchor.lat);
        const b = project(anno.to.lon, anno.to.lat);
        if (a && b) {
          // gentle arc so the connector reads as a drawn gesture, not a ruler line
          const mx = (a.x + b.x) / 2;
          const my = (a.y + b.y) / 2;
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const len = Math.hypot(dx, dy) || 1;
          const bow = Math.min(60, len * 0.18);
          const ctrlX = mx - (dy / len) * bow;
          const ctrlY = my + (dx / len) * bow;
          parts.path.set.d = `M ${a.x.toFixed(1)} ${a.y.toFixed(1)} Q ${ctrlX.toFixed(1)} ${ctrlY.toFixed(1)} ${b.x.toFixed(1)} ${b.y.toFixed(1)}`;
          group.display = '';
          // Anchor the label to the (stable) endpoint midpoint, lifted toward the bow.
          if (parts.label)
            positionCallout(
              parts.label,
              mx + (ctrlX - mx) * 0.5,
              my + (ctrlY - my) * 0.5 - 8,
              true,
            );
        } else {
          group.display = 'none';
        }
      } else if (anno.type === 'route' && parts.poly) {
        const projected = anno.path.map((pt) => project(pt.lon, pt.lat));
        const pts = [];
        for (const p of projected) {
          if (p) pts.push(`${p.x.toFixed(1)},${p.y.toFixed(1)}`);
        }
        if (pts.length >= 2) {
          parts.poly.set.points = pts.join(' ');
          // dots at each resolvable waypoint; hide the rest
          parts.dots.forEach((dot, i) => {
            const p = projected[i];
            if (p) {
              dot.set.cx = p.x.toFixed(1);
              dot.set.cy = p.y.toFixed(1);
              dot.display = '';
            } else {
              dot.display = 'none';
            }
          });
          group.display = '';
          // label at the middle waypoint
          const mid =
            projected.filter(Boolean)[
              Math.floor(projected.filter(Boolean).length / 2)
            ];
          if (parts.label && mid)
            positionCallout(parts.label, mid.x, mid.y - 12, true);
        } else {
          group.display = 'none';
        }
      } else {
        const p = project(anno.anchor.lon, anno.anchor.lat);
        if (p) {
          group.display = '';
          const baseDotR = anno.type === 'label' ? LABEL_DOT_R : DOT_R;
          for (const [part, radius] of [
            [parts.dot, baseDotR],
            [parts.ringOuter, RING_OUTER_R],
            [parts.ringInner, RING_INNER_R],
          ]) {
            if (!part) continue;
            part.set.cx = p.x.toFixed(1);
            part.set.cy = p.y.toFixed(1);
            part.set.r = (radius * mScale).toFixed(1);
          }
          if (parts.label) {
            // Keep the callout tucked near the (now smaller) reticle by scaling its offset.
            const lx = p.x + 18 * mScale;
            const ly = p.y - 34 * mScale;
            positionCallout(parts.label, lx, ly, false);
            if (parts.leader) {
              parts.leader.set.x1 = p.x.toFixed(1);
              parts.leader.set.y1 = p.y.toFixed(1);
              parts.leader.set.x2 = lx.toFixed(1);
              parts.leader.set.y2 = (ly + parts.label.height).toFixed(1);
              parts.label._leader = parts.leader; // so de-collision can re-point it
            }
          }
        } else {
          group.display = 'none';
        }
      }
    }

    // Keep clustered callouts readable.
    const placed = [];
    for (const rec of records.values()) {
      const cal = rec.parts.label;
      if (
        cal &&
        cal.sized &&
        rec.group.display !== 'none' &&
        Number.isFinite(cal._x)
      ) {
        placed.push(cal);
      }
    }
    if (placed.length > 1) decollideCallouts(placed);
    placeCalloutsAboveVoicePreview(placed, w, h);

    publish();
    // Tracked-entity z-order — measured once the view shows this frame's
    // geometry (still before the browser paints it).
    const fading = [...records.values()].some(
      (rec) => rec._trackedFade !== undefined && rec._trackedFade !== 1,
    );
    if ((trackedRect || fading) && !trackedPending) {
      trackedPending = true;
      void nextTick(() => {
        trackedPending = false;
        fadeTracked(trackedRect);
      });
    }
  }

  let trackedPending = false;

  // Runs AFTER all geometry + callout de-collision are in the document so each
  // group's bbox reflects its final on-screen extent. Any mark whose bbox
  // INTERSECTS the tracked entity's screen footprint is faded toward FULLY
  // HIDDEN (target 0, not a partial dim) so the tracked plane/ship reads as
  // genuinely ON TOP. The fade is EASED per frame (no abrupt pop as the entity
  // crosses a mark) and reverses smoothly when it moves off. Every screen mark
  // here is point-like (pins/labels/reticles/arrows) — the big area/route
  // footprints live in the world layer — so fully hiding an overlapped one is
  // safe and not jarring.
  function fadeTracked(trackedRect) {
    if (!shown()) return;
    let changed = false;
    for (const rec of records.values()) {
      const { anno, group } = rec;
      if (group.display === 'none') continue;
      const cur = rec._trackedFade ?? 1;
      let overlapping = false;
      if (trackedRect) {
        let bb = null;
        try {
          bb = rec.element?.getBBox() ?? null;
        } catch {
          bb = null;
        }
        if (bb && (bb.width !== 0 || bb.height !== 0)) {
          // HYSTERESIS: a mark that's already hidden must clear the rect by
          // TRACKED_HYSTERESIS_PX before it starts showing again; one that's visible fades
          // as soon as it touches. The dead-band stops the overlap test from flip-flopping
          // frame-to-frame (the pulsing reticle stroke + de-collided cards keep the bbox in
          // motion), which was the source of the flicker.
          const m = cur < 0.5 ? TRACKED_HYSTERESIS_PX : 0;
          overlapping =
            bb.x <= trackedRect.right + m &&
            bb.x + bb.width >= trackedRect.left - m &&
            bb.y <= trackedRect.bottom + m &&
            bb.y + bb.height >= trackedRect.top - m;
        }
      }
      const target = overlapping ? 0 : 1;
      const next = cur + (target - cur) * TRACKED_FADE_EASE;
      rec._trackedFade = Math.abs(next - target) < 0.02 ? target : next;
      // The base alpha applies unless faded. (The CSS `transition: opacity` was
      // removed from .gev-anno so this per-frame JS ease is the ONLY easing —
      // previously the two fought and produced an opacity oscillation.)
      const opacity = String(
        (anno.alpha ?? 1) * (rec._trackedFade !== 1 ? rec._trackedFade : 1),
      );
      if (opacity !== group.opacity) {
        group.opacity = opacity;
        changed = true;
      }
    }
    if (changed) publish();
  }

  /** The board as its view renders it: one entry per live or fading mark. */
  function boardView() {
    const view = (rec, fading) => ({
      key: rec.key,
      className: fading
        ? 'gev-anno gev-out'
        : rec.group.entered
          ? 'gev-anno gev-in'
          : 'gev-anno',
      opacity: rec.group.opacity,
      display: rec.group.display,
      drawn: rec.drawn,
      children: partViews(rec.parts),
    });
    return {
      owner,
      viewBox,
      markers: [...arrowMarkers].map(([key, fill]) => ({ key, fill })),
      // In the order the marks were added, fading ones where they were.
      marks: [
        ...[...records.values()].map((rec) => view(rec, false)),
        ...[...leaving.values()].map((rec) => rec.view),
      ].sort((a, b) => a.key - b.key),
    };
  }

  /** Present the board; an unchanged one is not sent again unless forced. */
  function publish({ force = false } = {}) {
    if (!shown()) return;
    const board = boardView();
    const signature = JSON.stringify(board, (name, value) =>
      name === 'owner' ? undefined : value,
    );
    if (!force && signature === published) return;
    published = signature;
    store.publish(board);
  }

  /** Take (or, with null, drop) an element the view rendered for a mark. */
  function attach(key, kind, element) {
    const rec = byKey.get(key);
    if (!rec) return;
    if (kind === 'group') {
      rec.element = element;
      // Lay the new mark out before its next-frame `gev-in`, so the draw-on
      // transition starts from the undrawn stroke.
      try {
        element?.getBBox();
      } catch {
        /* not laid out */
      }
    } else if (kind === 'text' && rec.parts.label) {
      rec.parts.label.element = element;
      // Size the card to its text once the text is in the document.
      if (element && sizeCallout(rec.parts.label) && records.has(rec.anno.id))
        projectAll();
    }
  }

  /** The draw-on stroke finished: it reads solid from now on. */
  function drawn(key) {
    const rec = byKey.get(key);
    if (!rec || rec.drawn) return;
    rec.drawn = true;
    publish();
  }

  function remove(anno) {
    const rec = records.get(anno.id);
    if (!rec) return;
    // The fading mark keeps the look it had; it leaves the board after 360 ms.
    rec.view = { ...boardView().marks.find((mark) => mark.key === rec.key) };
    rec.view.className = 'gev-anno gev-out';
    leaving.set(rec.key, rec);
    let timer;
    try {
      timer = window.setTimeout(() => {
        timers.delete(timer);
        leaving.delete(rec.key);
        byKey.delete(rec.key);
        publish();
      }, 360);
    } catch (error) {
      leaving.delete(rec.key);
      throw error;
    }
    if (leaving.has(rec.key)) timers.add(timer);
    records.delete(anno.id);
    publish();
    // Board emptied → drop accumulated height samples (natural reset point).
    if (records.size === 0) heightCache.clear();
  }

  function sync() {
    // Positioning is driven by the postRender loop; nothing to batch here.
    projectAll();
  }

  function destroy() {
    try {
      scene.postRender.removeEventListener(onPostRender);
    } catch {
      /* torn down */
    }
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    if (shown()) {
      store.connect(null);
      store.publish(null);
    }
    records.clear();
    leaving.clear();
    byKey.clear();
    heightCache.clear();
  }

  // Claim the board; from here on only this renderer's own board changes.
  store.publish(boardView());
  store.connect({
    attach: (from, key, kind, element) => {
      if (from === owner && shown()) attach(key, kind, element);
    },
    drawn: (from, key) => {
      if (from === owner && shown()) drawn(key);
    },
  });

  return { add, update, remove, sync, destroy };
}

// --- SVG helpers ------------------------------------------------------------

/**
 * One SVG element of a mark as plain data: the attributes it starts with, the
 * ones each frame sets, and whether it is shown.
 */
function svgPart(tag, attrs) {
  return { tag, attrs, set: {}, display: '' };
}

/** A mark's parts in document order, as the view renders them. */
function partViews(parts) {
  const views = [];
  const element = (key, part) =>
    views.push({
      key,
      tag: part.tag,
      attrs: { ...part.attrs, ...part.set },
      display: part.display,
    });
  if (parts.poly) element('poly', parts.poly);
  if (parts.path) element('path', parts.path);
  parts.dots?.forEach((dot, index) => element(`dot-${index}`, dot));
  if (parts.ringOuter) element('ring-outer', parts.ringOuter);
  if (parts.ringInner) element('ring-inner', parts.ringInner);
  if (parts.dot) element('dot', parts.dot);
  if (parts.leader) element('leader', parts.leader);
  const label = parts.label;
  if (label)
    views.push({
      key: 'callout',
      tag: 'callout',
      text: label.text,
      fill: label.fill,
      transform: label.transform,
      // The card is sized to its text once the text has been measured.
      card: label.sized
        ? { width: String(label.width), height: String(label.height) }
        : {},
      accent: label.sized
        ? { height: String(label.height - 8), x: '0', y: '4' }
        : {},
    });
  return views;
}

function makeCallout(text, c) {
  if (!text) return null;
  return {
    text,
    fill: c,
    element: null,
    transform: null,
    width: 0,
    height: 26,
    sized: false,
  };
}

/** Size a callout to its rendered text; false until the text is laid out. */
function sizeCallout(callout) {
  try {
    const bbox = callout.element.getBBox();
    const w = Math.max(24, bbox.width + 18);
    const h = Math.max(22, bbox.height + 10);
    callout.width = w;
    callout.height = h;
    callout.sized = true;
    return true;
  } catch {
    /* not laid out yet */
    return false;
  }
}

function positionCallout(callout, x, y, center) {
  if (!callout.sized) sizeCallout(callout);
  const tx = center ? x - callout.width / 2 : x;
  callout._x = tx;
  callout._y = y;
  callout.transform = `translate(${tx.toFixed(1)}, ${y.toFixed(1)})`;
}

/**
 * Nudge overlapping callout cards apart so labels stay readable when several
 * marks cluster on screen. Simple top-down sweep: each card that overlaps an
 * earlier one is pushed just below it. O(n²) but n is small.
 */
function decollideCallouts(callouts) {
  callouts.sort((a, b) => a._y - b._y);
  for (let i = 0; i < callouts.length; i++) {
    const a = callouts[i];
    for (let j = 0; j < i; j++) {
      const b = callouts[j];
      const overlapX = a._x < b._x + b.width + 6 && a._x + a.width + 6 > b._x;
      const overlapY = a._y < b._y + b.height && a._y + a.height > b._y;
      if (overlapX && overlapY) {
        a._y = b._y + b.height + 5;
        a.transform = `translate(${a._x.toFixed(1)}, ${a._y.toFixed(1)})`;
        if (a._leader) {
          a._leader.set.x2 = a._x.toFixed(1);
          a._leader.set.y2 = a._y.toFixed(1);
        }
      }
    }
  }
}

/** Keep an overlapping callout above the actual open Voice Preview, when it fits. */
function placeCalloutsAboveVoicePreview(callouts, width, height) {
  if (!callouts.length) return;
  const panel = document.getElementById('gev-voice-panel');
  const svg = document.querySelector('.gev-screen-whiteboard-svg');
  if (
    !panel ||
    !svg ||
    panel.hidden ||
    panel.dataset.view !== 'preview' ||
    panel.checkVisibility?.({
      opacityProperty: true,
      visibilityProperty: true,
    }) === false
  )
    return;
  const rect = panel.getBoundingClientRect(),
    bounds = svg.getBoundingClientRect();
  if (
    rect.width <= 0 ||
    rect.height <= 0 ||
    bounds.width <= 0 ||
    bounds.height <= 0
  )
    return;
  // The overlay uses preserveAspectRatio="none": each axis scales independently.
  const sx = width / bounds.width,
    sy = height / bounds.height;
  const blocked = {
    _x: (rect.left - bounds.left) * sx,
    _y: (rect.top - bounds.top) * sy,
    width: rect.width * sx,
    height: rect.height * sy,
  };
  const intersects = (a, b) =>
    a._x < b._x + b.width &&
    a._x + a.width > b._x &&
    a._y < b._y + b.height &&
    a._y + a.height > b._y;
  for (const callout of callouts) {
    if (!intersects(callout, blocked) || callout.width > width - 16) continue;
    const candidate = {
      _x: Math.max(8, Math.min(callout._x, width - callout.width - 8)),
      _y: blocked._y - callout.height - 8,
      width: callout.width,
      height: callout.height,
    };
    if (
      candidate._y < 8 ||
      candidate._y + candidate.height > height - 8 ||
      callouts.some(
        (other) => other !== callout && intersects(candidate, other),
      )
    )
      continue;
    positionCallout(callout, candidate._x, candidate._y, false);
    if (callout._leader) {
      callout._leader.set.x2 = candidate._x.toFixed(1);
      callout._leader.set.y2 = (candidate._y + candidate.height).toFixed(1);
    }
  }
}

/** Record the arrowhead marker for a color, unless one is already defined. */
function ensureArrowMarker(markers, key, c) {
  if (!markers.has(key)) markers.set(key, c);
}
