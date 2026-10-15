import {
  CYCLONE_ACCENT,
  CYCLONE_MARKER_PX,
  CYCLONE_SELECTED_ACCENT,
  createCycloneLabels,
} from './labels.js';

/** Only geometry from the displayed status advisory is eligible for rendering. */
export function coherentCycloneGeometry(storm) {
  return (
    storm.geometryStatus === 'current' &&
    storm.geometryAdvisoryNumber === storm.advisoryNumber
  );
}

/**
 * Static Cesium entities with owned horizon culling; no timers or clock.
 * Storm names and lead hours are published to the shared overlay host at the
 * same anchors the points use.
 */
export function createCycloneRendering({ viewer, cesium: C, overlayHost }) {
  const labels = createCycloneLabels({ host: overlayHost });
  let source = null,
    generation = 0,
    selected = null,
    destroyed = false;
  let centers = new Map(),
    spheres = new Map();
  let entityStorms = new WeakMap();
  let entityIds = new Set();
  let counts = { storms: 0, tracks: 0, cones: 0, forecastPoints: 0 };
  let horizonStorms = [],
    removePreRender = null,
    pointOccluder = null,
    sphereOccluder = null;
  const blue = C.Color.fromCssColorString(CYCLONE_ACCENT);
  const gold = C.Color.fromCssColorString(CYCLONE_SELECTED_ACCENT);
  const white = C.Color.WHITE;
  const render = () => {
    if (!viewer.isDestroyed?.()) viewer.scene.requestRender();
  };
  function cullHorizon() {
    pointOccluder.cameraPosition = viewer.camera.positionWC;
    sphereOccluder.cameraPosition = viewer.camera.positionWC;
    let changed = false;
    for (let i = 0; i < horizonStorms.length; i++) {
      const storm = horizonStorms[i];
      for (let j = 0; j < storm.points.length; j++) {
        const { entity, position } = storm.points[j];
        const show = pointOccluder.isPointVisible(position);
        if (entity.show !== show) {
          entity.show = show;
          changed = true;
        }
      }
      if (!storm.shapes.length) continue;
      const show = sphereOccluder.isBoundingSphereVisible(storm.sphere);
      for (let j = 0; j < storm.shapes.length; j++) {
        const entity = storm.shapes[j];
        if (entity.show !== show) {
          entity.show = show;
          changed = true;
        }
      }
    }
    if (changed) render();
  }
  function syncHorizonListener() {
    if (!horizonStorms.length) {
      removePreRender?.();
      removePreRender = null;
      return;
    }
    if (removePreRender) return;
    pointOccluder ||= new C.EllipsoidalOccluder(
      C.Ellipsoid.WGS84,
      viewer.camera.positionWC,
    );
    // EllipsoidalOccluder only tests points. An inscribed WGS84 sphere
    // conservatively culls extents, retaining partially visible tracks/cones.
    sphereOccluder ||= new C.Occluder(
      new C.BoundingSphere(C.Cartesian3.ZERO, C.Ellipsoid.WGS84.minimumRadius),
      viewer.camera.positionWC,
    );
    removePreRender = viewer.scene.preRender.addEventListener(cullHorizon);
  }
  function remove(value) {
    if (!value) return;
    if (!viewer.dataSources.isDestroyed?.())
      viewer.dataSources.remove(value, true);
    value.entities.removeAll();
  }
  function select(id) {
    selected = id;
    for (const [stormId, entity] of centers) {
      entity.point.color = stormId === id ? gold : blue;
      entity.point.pixelSize =
        stormId === id ? CYCLONE_MARKER_PX.selected : CYCLONE_MARKER_PX.storm;
    }
    labels.setSelection(id);
    render();
  }
  return {
    async setSnapshot(snapshot, { signal } = {}) {
      signal?.throwIfAborted();
      if (destroyed) return false;
      const owner = ++generation;
      const next = new C.CustomDataSource('weather-cyclones');
      const nextCenters = new Map(),
        nextSpheres = new Map();
      const nextEntityStorms = new WeakMap();
      const nextEntityIds = new Set();
      const nextCounts = { storms: 0, tracks: 0, cones: 0, forecastPoints: 0 };
      const nextHorizonStorms = [];
      const nextLabels = [];
      const position = ({ longitude, latitude }) =>
        C.Cartesian3.fromDegrees(longitude, latitude, 0);
      const coordinate = (pair) =>
        position({ longitude: pair[0], latitude: pair[1] });
      try {
        for (const storm of snapshot.storms) {
          const horizon = { points: [], shapes: [], sphere: null };
          const addEntity = (options) => {
            const entity = next.entities.add(options);
            if (options.position)
              horizon.points.push({ entity, position: options.position });
            else horizon.shapes.push(entity);
            nextEntityStorms.set(entity, storm.id);
            nextEntityIds.add(entity.id);
            return entity;
          };
          const center = position(storm.position),
            extent = [center];
          const entity = addEntity({
            id: `cyclone:${storm.id}:center`,
            name: storm.name,
            position: center,
            point: {
              heightReference: C.HeightReference.CLAMP_TO_GROUND,
              disableDepthTestDistance: Number.POSITIVE_INFINITY,
              pixelSize: CYCLONE_MARKER_PX.storm,
              color: blue,
              outlineColor: C.Color.BLACK,
              outlineWidth: 2,
            },
          });
          nextCenters.set(storm.id, entity);
          const label = {
            id: storm.id,
            name: storm.name,
            classification: storm.classification,
            windKt: storm.windKt,
            position: center,
            forecasts: [],
          };
          nextLabels.push(label);
          nextCounts.storms++;
          if (coherentCycloneGeometry(storm)) {
            const lines =
              storm.track?.type === 'LineString'
                ? [storm.track.coordinates]
                : storm.track?.coordinates || [];
            lines.forEach((line, index) => {
              const positions = line.map(coordinate);
              extent.push(...positions);
              addEntity({
                id: `cyclone:${storm.id}:track:${index}`,
                polyline: {
                  clampToGround: true,
                  classificationType: C.ClassificationType.BOTH,
                  positions,
                  width: 2.5,
                  material: blue,
                  arcType: C.ArcType.GEODESIC,
                },
              });
              nextCounts.tracks++;
            });
            const polygons =
              storm.cone?.type === 'Polygon'
                ? [storm.cone.coordinates]
                : storm.cone?.coordinates || [];
            polygons.forEach((rings, index) => {
              // Each exterior retains its own interior holes. Native geographic
              // tessellation handles the antimeridian; never flatten rings.
              const exterior = rings[0].map(coordinate);
              extent.push(...exterior);
              const holes = rings
                .slice(1)
                .map((ring) => new C.PolygonHierarchy(ring.map(coordinate)));
              addEntity({
                id: `cyclone:${storm.id}:cone:${index}`,
                polygon: {
                  hierarchy: new C.PolygonHierarchy(exterior, holes),
                  classificationType: C.ClassificationType.BOTH,
                  material: blue.withAlpha(0.16),
                  arcType: C.ArcType.GEODESIC,
                },
              });
              [exterior, ...holes.map((hole) => hole.positions)].forEach(
                (positions, ringIndex) => {
                  addEntity({
                    id: `cyclone:${storm.id}:cone:${index}:outline:${ringIndex}`,
                    polyline: {
                      positions,
                      width: 1,
                      material: blue.withAlpha(0.55),
                      arcType: C.ArcType.GEODESIC,
                      clampToGround: true,
                      classificationType: C.ClassificationType.BOTH,
                    },
                  });
                },
              );
              nextCounts.cones++;
            });
            for (const [index, point] of storm.forecastPoints.entries()) {
              if (point.tauHours === 0) continue;
              const p = position(point.position);
              extent.push(p);
              addEntity({
                id: `cyclone:${storm.id}:forecast:${index}`,
                position: p,
                point: {
                  heightReference: C.HeightReference.CLAMP_TO_GROUND,
                  disableDepthTestDistance: Number.POSITIVE_INFINITY,
                  pixelSize: CYCLONE_MARKER_PX.forecast,
                  color: white,
                  outlineColor: C.Color.BLACK,
                  outlineWidth: 1,
                },
              });
              label.forecasts.push({ tauHours: point.tauHours, position: p });
              nextCounts.forecastPoints++;
            }
          }
          const sphere = C.BoundingSphere.fromPoints(extent);
          // A status-only point still has a useful regional camera destination.
          sphere.radius = Math.max(sphere.radius, 500_000);
          nextSpheres.set(storm.id, sphere);
          horizon.sphere = sphere;
          nextHorizonStorms.push(horizon);
        }
        await viewer.dataSources.add(next);
        if (destroyed || generation !== owner || signal?.aborted) {
          remove(next);
          return false;
        }
        remove(source);
        source = next;
        centers = nextCenters;
        spheres = nextSpheres;
        entityStorms = nextEntityStorms;
        entityIds = nextEntityIds;
        counts = nextCounts;
        horizonStorms = nextHorizonStorms;
        syncHorizonListener();
        labels.setSnapshot(nextLabels, selected);
        select(selected);
        return true;
      } catch (error) {
        remove(next);
        if (signal?.aborted || generation !== owner || destroyed) return false;
        throw error;
      }
    },
    setSelection: select,
    ownsPickId(id) {
      return source !== null && typeof id === 'string' && entityIds.has(id);
    },
    pickStorm(picked) {
      // Cesium Entity picks carry the exact entity in `id`. IDs/prefixes alone
      // cannot establish ownership, especially after an advisory replacement.
      const entity = picked?.id;
      return source && entity && typeof entity === 'object'
        ? entityStorms.get(entity) || null
        : null;
    },
    getFocusSphere(id) {
      return spheres.get(id) || null;
    },
    clear() {
      ++generation;
      horizonStorms = [];
      syncHorizonListener();
      pointOccluder = null;
      sphereOccluder = null;
      remove(source);
      source = null;
      labels.clear();
      centers.clear();
      spheres.clear();
      entityStorms = new WeakMap();
      entityIds.clear();
      selected = null;
      counts = { storms: 0, tracks: 0, cones: 0, forecastPoints: 0 };
      render();
    },
    destroy() {
      if (destroyed) return;
      this.clear();
      destroyed = true;
    },
    getDiagnostics() {
      return {
        ...counts,
        dataSources: Number(!!source),
        entities: source?.entities.values.length || 0,
        selectedId: selected,
        timerActive: false,
      };
    },
  };
}
