/** Only geometry from the displayed status advisory is eligible for rendering. */
export function coherentCycloneGeometry(storm) {
  return (
    storm.geometryStatus === 'current' &&
    storm.geometryAdvisoryNumber === storm.advisoryNumber
  );
}

/** Static Cesium entities, one data-source owner; no timers, input handlers or clock. */
export function createCycloneRendering({ viewer, cesium: C }) {
  let source = null,
    generation = 0,
    selected = null,
    destroyed = false;
  let centers = new Map(),
    forecasts = new Map(),
    spheres = new Map();
  let entityStorms = new WeakMap();
  let entityIds = new Set();
  let counts = { storms: 0, tracks: 0, cones: 0, forecastPoints: 0 };
  const blue = C.Color.fromCssColorString('#7fe6ed');
  const gold = C.Color.fromCssColorString('#ffe19a');
  const white = C.Color.WHITE;
  const render = () => {
    if (!viewer.isDestroyed?.()) viewer.scene.requestRender();
  };
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
      entity.point.pixelSize = stormId === id ? 12 : 9;
      entity.label.fillColor = stormId === id ? gold : white;
    }
    for (const [stormId, entities] of forecasts)
      for (const entity of entities) entity.label.show = stormId === id;
    render();
  }
  return {
    async setSnapshot(snapshot, { signal } = {}) {
      signal?.throwIfAborted();
      if (destroyed) return false;
      const owner = ++generation;
      const next = new C.CustomDataSource('weather-cyclones');
      const nextCenters = new Map(),
        nextForecasts = new Map(),
        nextSpheres = new Map();
      const nextEntityStorms = new WeakMap();
      const nextEntityIds = new Set();
      const nextCounts = { storms: 0, tracks: 0, cones: 0, forecastPoints: 0 };
      const position = ({ longitude, latitude }) =>
        C.Cartesian3.fromDegrees(longitude, latitude, 3000);
      const coordinate = (pair) =>
        position({ longitude: pair[0], latitude: pair[1] });
      try {
        for (const storm of snapshot.storms) {
          const addEntity = (options) => {
            const entity = next.entities.add(options);
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
              pixelSize: 9,
              color: blue,
              outlineColor: C.Color.BLACK,
              outlineWidth: 2,
            },
            label: {
              text: storm.name,
              font: '13px sans-serif',
              fillColor: white,
              outlineColor: C.Color.BLACK,
              outlineWidth: 3,
              style: C.LabelStyle.FILL_AND_OUTLINE,
              pixelOffset: new C.Cartesian2(12, -12),
              horizontalOrigin: C.HorizontalOrigin.LEFT,
              showBackground: true,
              backgroundColor: C.Color.BLACK.withAlpha(0.55),
            },
          });
          nextCenters.set(storm.id, entity);
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
                  height: 2000,
                  material: blue.withAlpha(0.16),
                  outline: true,
                  outlineColor: blue.withAlpha(0.55),
                  arcType: C.ArcType.GEODESIC,
                },
              });
              nextCounts.cones++;
            });
            const points = [];
            for (const [index, point] of storm.forecastPoints.entries()) {
              if (point.tauHours === 0) continue;
              const p = position(point.position);
              extent.push(p);
              points.push(
                addEntity({
                  id: `cyclone:${storm.id}:forecast:${index}`,
                  position: p,
                  point: {
                    pixelSize: 5,
                    color: white,
                    outlineColor: C.Color.BLACK,
                    outlineWidth: 1,
                  },
                  label: {
                    text: `${point.tauHours} h`,
                    font: '11px sans-serif',
                    fillColor: white,
                    outlineColor: C.Color.BLACK,
                    outlineWidth: 2,
                    style: C.LabelStyle.FILL_AND_OUTLINE,
                    pixelOffset: new C.Cartesian2(8, -8),
                    show: false,
                  },
                }),
              );
              nextCounts.forecastPoints++;
            }
            nextForecasts.set(storm.id, points);
          }
          const sphere = C.BoundingSphere.fromPoints(extent);
          // A status-only point still has a useful regional camera destination.
          sphere.radius = Math.max(sphere.radius, 500_000);
          nextSpheres.set(storm.id, sphere);
        }
        await viewer.dataSources.add(next);
        if (destroyed || generation !== owner || signal?.aborted) {
          remove(next);
          return false;
        }
        remove(source);
        source = next;
        centers = nextCenters;
        forecasts = nextForecasts;
        spheres = nextSpheres;
        entityStorms = nextEntityStorms;
        entityIds = nextEntityIds;
        counts = nextCounts;
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
      remove(source);
      source = null;
      centers.clear();
      forecasts.clear();
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
