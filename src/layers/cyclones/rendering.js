import { fromDegrees } from '../../geo/ellipsoid.js';
import { sphereFromPoints } from '../../geo/sphere.js';
import { drawOf } from '../../render/rendererOf.js';
import {
  CYCLONE_ACCENT,
  CYCLONE_DANGER_ACCENT,
  CYCLONE_MARKER_PX,
  CYCLONE_SELECTED_ACCENT,
  createCycloneLabels,
} from './labels.js';

/**
 * The draw sets the advisories are drawn in start with this; each rendering
 * has its own (`weather-cyclones:1:points`, …), so several can share a
 * renderer. Picks name them as `Hit.set`.
 */
export const CYCLONE_SET_PREFIX = 'weather-cyclones';
let renderings = 0;

/** Only geometry from the displayed status advisory is eligible for rendering. */
export function coherentCycloneGeometry(storm) {
  return (
    storm.geometryStatus === 'current' &&
    storm.geometryAdvisoryNumber === storm.advisoryNumber
  );
}

/**
 * Where a danger area's label sits: the vertex of its outer ring nearest the
 * forecast point halfway along the track (ECEF).
 */
function dangerAreaAnchor(ring, forecastPoints, ecef, lonLat) {
  const middle = forecastPoints[Math.floor(forecastPoints.length / 2)];
  if (!middle) return ring[0];
  const target = ecef(lonLat(middle.position));
  let best = ring[0],
    bestDistance = Infinity;
  for (const vertex of ring) {
    const d =
      (vertex.x - target.x) ** 2 +
      (vertex.y - target.y) ** 2 +
      (vertex.z - target.z) ** 2;
    if (d < bestDistance) {
      best = vertex;
      bestDistance = d;
    }
  }
  return best;
}

/** A `#rrggbb` colour at `alpha`, as CSS. */
function withAlpha(hex, alpha) {
  const n = Number.parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

const BLACK = [0, 0, 0, 1];
const WHITE = [1, 1, 1, 1];

/**
 * Static renderer draw sets with the renderer's horizon cull; no timers or
 * clock. Points are clamped and drawn over depth, so the points set culls
 * them past the horizon; tracks, cones and their outlines drape on the
 * ground, where the globe hides the far side. Storm names and lead hours
 * are published to the shared overlay host at the same anchors the points
 * use.
 */
export function createCycloneRendering({ viewer, overlayHost }) {
  const labels = createCycloneLabels({ host: overlayHost });
  const draw = drawOf(viewer);
  const prefix = `${CYCLONE_SET_PREFIX}:${++renderings}`;
  const setIds = new Set(
    ['points', 'lines', 'cones'].map((kind) => `${prefix}:${kind}`),
  );
  const points = draw.points({
    id: `${prefix}:points`,
    horizonCull: true,
    clampTo: 'both',
  });
  const lines = draw.lines({ id: `${prefix}:lines`, clampTo: 'both' });
  const cones = draw.shapes({ id: `${prefix}:cones`, clampTo: 'both' });
  let committed = false,
    selected = null,
    destroyed = false;
  // Per storm: its center point (redrawn on selection), forecast points and
  // focus sphere; per drawn item, the storm it belongs to.
  let centers = new Map(),
    forecasts = [],
    spheres = new Map(),
    itemStorms = new Map();
  const emptyCounts = () => ({
    storms: 0,
    tracks: 0,
    cones: 0,
    dangerAreas: 0,
    forecastPoints: 0,
  });
  let counts = emptyCounts();
  let itemCount = 0;

  function centerItem(storm) {
    const chosen = storm.id === selected;
    return {
      id: `cyclone:${storm.id}:center`,
      pos: storm.at,
      height: 'clampGround',
      disableDepthTest: Number.POSITIVE_INFINITY,
      pixelSize: chosen ? CYCLONE_MARKER_PX.selected : CYCLONE_MARKER_PX.storm,
      color: chosen ? CYCLONE_SELECTED_ACCENT : CYCLONE_ACCENT,
      outlineColor: BLACK,
      outlineWidth: 2,
    };
  }

  function drawPoints() {
    points.set([...[...centers.values()].map(centerItem), ...forecasts]);
  }

  // Only the centers show the selection: a change redraws the points set.
  function select(id) {
    if (destroyed || id === selected) return;
    selected = id;
    drawPoints();
    labels.setSelection(id);
  }

  return {
    async setSnapshot(snapshot, { signal } = {}) {
      signal?.throwIfAborted();
      if (destroyed) return false;
      const nextCenters = new Map(),
        nextSpheres = new Map(),
        nextItemStorms = new Map();
      const nextForecasts = [],
        nextLines = [],
        nextCones = [],
        nextLabels = [];
      const nextCounts = emptyCounts();
      const lonLat = ({ longitude, latitude }) => ({
        lon: longitude,
        lat: latitude,
        height: 0,
      });
      const pair = (coordinate) => ({
        lon: coordinate[0],
        lat: coordinate[1],
        height: 0,
      });
      const ecef = (p) => fromDegrees(p.lon, p.lat, 0);
      for (const storm of snapshot.storms) {
        const own = (id) => (nextItemStorms.set(id, storm.id), id);
        const at = lonLat(storm.position);
        const center = ecef(at);
        const extent = [center];
        own(`cyclone:${storm.id}:center`);
        nextCenters.set(storm.id, { id: storm.id, at });
        const label = {
          id: storm.id,
          name: storm.name,
          classification: storm.classification,
          windKt: storm.windKt,
          position: center,
          forecasts: [],
          dangerArea: null,
        };
        nextLabels.push(label);
        nextCounts.storms++;
        if (coherentCycloneGeometry(storm)) {
          const tracks =
            storm.track?.type === 'LineString'
              ? [storm.track.coordinates]
              : storm.track?.coordinates || [];
          tracks.forEach((line, index) => {
            // Lines take ECEF (draw.d.ts `LineItem`).
            const positions = line.map((c) => ecef(pair(c)));
            extent.push(...positions);
            nextLines.push({
              id: own(`cyclone:${storm.id}:track:${index}`),
              positions,
              widthPx: 2.5,
              mode: 'draped',
              style: { kind: 'solid', color: CYCLONE_ACCENT },
            });
            nextCounts.tracks++;
          });
          // NHC's cone of centre-track uncertainty, or JTWC's 34-knot wind
          // danger area: drawn apart, never one as the other.
          const areas = [
            { kind: 'cone', shape: storm.cone, color: CYCLONE_ACCENT },
            {
              kind: 'danger',
              shape: storm.dangerArea,
              color: CYCLONE_DANGER_ACCENT,
            },
          ];
          for (const { kind, shape, color } of areas) {
            const polygons =
              shape?.type === 'Polygon'
                ? [shape.coordinates]
                : shape?.coordinates || [];
            polygons.forEach((rings, index) => {
              // Each exterior retains its own interior holes. Native
              // geographic tessellation handles the antimeridian; never
              // flatten rings.
              const all = rings.map((ring) => ring.map(pair));
              const ecefRings = all.map((ring) => ring.map(ecef));
              extent.push(...ecefRings[0]);
              nextCones.push({
                id: own(`cyclone:${storm.id}:${kind}:${index}`),
                geometry: { kind: 'polygon', rings: all },
                fill: withAlpha(color, kind === 'cone' ? 0.16 : 0.12),
                height: 'clampGround',
              });
              ecefRings.forEach((ring, ringIndex) => {
                nextLines.push({
                  id: own(
                    `cyclone:${storm.id}:${kind}:${index}:outline:${ringIndex}`,
                  ),
                  positions: ring,
                  widthPx: kind === 'cone' ? 1 : 1.5,
                  mode: 'draped',
                  style:
                    kind === 'cone'
                      ? { kind: 'solid', color: withAlpha(color, 0.55) }
                      : {
                          kind: 'dash',
                          color: withAlpha(color, 0.8),
                          length: 16,
                        },
                });
              });
              if (kind === 'cone') nextCounts.cones++;
              else {
                nextCounts.dangerAreas++;
                // The area's name sits on its edge nearest the middle of
                // the forecast track.
                label.dangerArea ??= dangerAreaAnchor(
                  ecefRings[0],
                  storm.forecastPoints,
                  ecef,
                  lonLat,
                );
              }
            });
          }
          for (const [index, point] of storm.forecastPoints.entries()) {
            if (point.tauHours === 0) continue;
            const pos = lonLat(point.position);
            const p = ecef(pos);
            extent.push(p);
            nextForecasts.push({
              id: own(`cyclone:${storm.id}:forecast:${index}`),
              pos,
              height: 'clampGround',
              disableDepthTest: Number.POSITIVE_INFINITY,
              pixelSize: CYCLONE_MARKER_PX.forecast,
              color: WHITE,
              outlineColor: BLACK,
              outlineWidth: 1,
            });
            label.forecasts.push({ tauHours: point.tauHours, position: p });
            nextCounts.forecastPoints++;
          }
        }
        const sphere = sphereFromPoints(extent);
        // A status-only point still has a useful regional camera destination.
        sphere.radius = Math.max(sphere.radius, 500_000);
        nextSpheres.set(storm.id, sphere);
      }
      if (destroyed || signal?.aborted) return false;
      centers = nextCenters;
      forecasts = nextForecasts;
      spheres = nextSpheres;
      itemStorms = nextItemStorms;
      counts = nextCounts;
      itemCount = nextItemStorms.size;
      committed = true;
      lines.set(nextLines);
      cones.set(nextCones);
      // Every commit redraws the points, an empty advisory included.
      drawPoints();
      labels.setSnapshot(nextLabels, selected);
      return true;
    },
    setSelection: select,
    ownsPickId(id) {
      return committed && typeof id === 'string' && itemStorms.has(id);
    },
    /**
     * The storm a click's draw hit (`Hit`, query.d.ts) belongs to: an item
     * of these sets in the advisory drawn now, never an id from another.
     */
    pickStorm(hit) {
      if (!committed || !hit || hit.surface) return null;
      if (!setIds.has(hit.set)) return null;
      return itemStorms.get(hit.id) ?? null;
    },
    getFocusSphere(id) {
      return spheres.get(id) || null;
    },
    clear() {
      committed = false;
      if (!destroyed) {
        points.clear();
        lines.clear();
        cones.clear();
      }
      labels.clear();
      centers = new Map();
      forecasts = [];
      spheres = new Map();
      itemStorms = new Map();
      itemCount = 0;
      selected = null;
      counts = emptyCounts();
    },
    destroy() {
      if (destroyed) return;
      this.clear();
      destroyed = true;
      points.dispose();
      lines.dispose();
      cones.dispose();
    },
    getDiagnostics() {
      return {
        ...counts,
        // One display: the committed advisory's sets, and the items in them.
        dataSources: Number(committed),
        entities: itemCount,
        selectedId: selected,
        timerActive: false,
      };
    },
  };
}
