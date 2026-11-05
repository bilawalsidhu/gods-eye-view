import * as geo from '../../../geo/index.js';
import { coherentCycloneGeometry } from '../rendering.js';
import {
  createCycloneLabels,
  CYCLONE_ACCENT,
  CYCLONE_SELECTED_ACCENT,
  CYCLONE_MARKER_PX,
} from '../labels.js';
import { createNavaraPolygonDisplay } from '../../shared/render/navaraPolygons.js';
import { bindGroundShapePicks } from '../../shared/render/navaraGroundPicks.js';
import { rgbaFromCss } from '../../shared/color.js';

const LAYER = 'weather-cyclones';
const BLUE = rgbaFromCss(CYCLONE_ACCENT).rgba();
const GOLD = rgbaFromCss(CYCLONE_SELECTED_ACCENT).rgba();
const zeroCounts = () => ({
  storms: 0,
  tracks: 0,
  cones: 0,
  forecastPoints: 0,
});
const world = ([lon, lat]) => geo.cartesian3.fromDegrees(lon, lat);

export function createCyclonesNavaraRenderer(engine, view, { overlayHost }) {
  const display = createNavaraPolygonDisplay(engine, view, (color) => ({
    polyline: { color, width: 2.5, clampToGround: true },
    polygon: {
      color,
      opacity: 0.16,
      transparent: true,
      clampToGround: true,
      outline: true,
      outlineColor: color,
      outlineWidth: 1,
    },
  }));
  const labels = createCycloneLabels({ host: overlayHost });
  // The source validates at most 32 storms and 500 forecast fixes.
  const points = engine.movers.createSet({
    id: LAYER,
    kind: 'point',
    capacity: 532,
    order: 1,
    pickable: true,
    depthTest: 'always',
    point: {
      sizePx: CYCLONE_MARKER_PX.storm,
      outlinePx: 1,
      outlineColor: [0, 0, 0, 1],
    },
  });
  let counts = zeroCounts(),
    rows = [],
    spheres = new Map(),
    stormById = new Map(),
    selected = null,
    unbind = null;
  function paintPoints() {
    rows.forEach((row, i) => {
      const highlight = row.center && row.stormId === selected;
      const px = row.center
        ? highlight
          ? CYCLONE_MARKER_PX.selected
          : CYCLONE_MARKER_PX.storm
        : CYCLONE_MARKER_PX.forecast;
      points.set(i, {
        position: row.position,
        pickId: row.id,
        color: highlight ? GOLD : row.center ? BLUE : [1, 1, 1, 1],
        scale: px / CYCLONE_MARKER_PX.storm,
        show: true,
      });
    });
    points.setCount(rows.length);
    points.commit();
    engine.render.request(LAYER);
  }
  function clear() {
    unbind?.();
    unbind = null;
    display.destroy();
    labels.clear();
    rows = [];
    spheres.clear();
    stormById.clear();
    selected = null;
    counts = zeroCounts();
    points.setCount(0);
    points.commit();
  }
  return {
    setSnapshot(snapshot, { signal } = {}) {
      signal?.throwIfAborted();
      const shapes = [],
        features = [],
        markers = [],
        anchors = [],
        nextSpheres = new Map(),
        ids = new Map(),
        nextCounts = zeroCounts();
      for (const storm of snapshot.storms) {
        const prefix = 'cyclone:' + storm.id + ':';
        const center = world([
            storm.position.longitude,
            storm.position.latitude,
          ]),
          extent = [center];
        const anchor = { ...storm, position: center, forecasts: [] };
        anchors.push(anchor);
        const mark = (id, position, central) => {
          markers.push({ id, stormId: storm.id, position, center: central });
          ids.set(id, storm.id);
        };
        mark(prefix + 'center', center, true);
        nextCounts.storms++;
        if (coherentCycloneGeometry(storm)) {
          const shape = (id, geometry, kind, coords) => {
            ids.set(id, storm.id);
            shapes.push({ id, geometry, style: { lineWidth: 2.5 } });
            features.push({
              type: 'Feature',
              id,
              properties: {},
              geometry: { type: kind, coordinates: coords },
            });
          };
          const lines =
            storm.track?.type === 'LineString'
              ? [storm.track.coordinates]
              : (storm.track?.coordinates ?? []);
          lines.forEach((line, i) => {
            shape(
              prefix + 'track:' + i,
              { type: 'line', positions: line },
              'LineString',
              line,
            );
            for (const pair of line) extent.push(world(pair));
            nextCounts.tracks++;
          });
          const polygons =
            storm.cone?.type === 'Polygon'
              ? [storm.cone.coordinates]
              : (storm.cone?.coordinates ?? []);
          polygons.forEach((rings, i) => {
            shape(
              prefix + 'cone:' + i,
              { type: 'polygon', outer: rings[0], holes: rings.slice(1) },
              'Polygon',
              rings,
            );
            for (const pair of rings[0]) extent.push(world(pair));
            nextCounts.cones++;
          });
          storm.forecastPoints.forEach((point, i) => {
            if (!point.tauHours) return;
            const pos = world([
              point.position.longitude,
              point.position.latitude,
            ]);
            extent.push(pos);
            mark(prefix + 'forecast:' + i, pos, false);
            anchor.forecasts.push({ tauHours: point.tauHours, position: pos });
            nextCounts.forecastPoints++;
          });
        }
        const sphere = geo.boundingSphere.fromPoints(extent);
        sphere.radius = Math.max(500000, sphere.radius);
        nextSpheres.set(storm.id, sphere);
      }
      display.setVisible(true);
      display.replace(
        features.length ? new Map([[CYCLONE_ACCENT, features]]) : new Map(),
      );
      unbind?.();
      unbind = shapes.length
        ? bindGroundShapePicks(engine, LAYER, shapes)
        : null;
      counts = nextCounts;
      rows = markers;
      stormById = ids;
      spheres = nextSpheres;
      paintPoints();
      labels.setSnapshot(anchors, selected);
      return true;
    },
    setSelection(id) {
      selected = id;
      paintPoints();
      labels.setSelection(id);
    },
    ownsPickId: (id) => stormById.has(id),
    pickStorm: (picked) =>
      picked?.owner === LAYER ? (stormById.get(picked.id) ?? null) : null,
    getFocusSphere: (id) => spheres.get(id) ?? null,
    clear,
    destroy() {
      clear();
      points.destroy();
    },
    getDiagnostics: () => ({
      ...counts,
      selectedId: selected,
      entities: stormById.size,
      dataSources: Number(stormById.size > 0),
      timerActive: false,
    }),
  };
}
