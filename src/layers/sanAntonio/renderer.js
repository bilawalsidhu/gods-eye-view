import * as Cesium from 'cesium';

const positions = (coordinates) =>
  coordinates.map(([lon, lat]) => Cesium.Cartesian3.fromDegrees(lon, lat));
const loopCoordinates = (coordinates) => {
  const [lon, lat] = coordinates[0];
  let end = coordinates.length;
  while (
    end > 1 &&
    coordinates[end - 1][0] === lon &&
    coordinates[end - 1][1] === lat
  )
    end--;
  return coordinates.slice(0, end);
};
const hierarchy = ([outer, ...holes]) =>
  new Cesium.PolygonHierarchy(
    positions(outer),
    holes.map((hole) => new Cesium.PolygonHierarchy(positions(hole))),
  );

/**
 * Batch static surfaces and keep just trailheads in an entity visualizer.
 * Pick ids unwrap to record.id through the application's resolvePickId helper.
 * No acquisition, selection handlers, animation callbacks or page-owned services.
 */
export function createSanAntonioRenderer({ viewer, dataset }) {
  if (!viewer?.scene?.groundPrimitives || !viewer?.dataSources || !dataset?.id)
    throw new TypeError('A viewer and San Antonio dataset are required');
  const color = Cesium.Color.fromCssColorString(dataset.color);
  if (!color) throw new TypeError('Invalid San Antonio display color');
  const groundPrimitives = viewer.scene.groundPrimitives;
  const dataSources = viewer.dataSources;
  let visible = false;
  let destroyed = false;
  let generation = 0;
  let current = null;
  const pending = new Set();

  const requestRender = () => {
    if (!viewer.isDestroyed?.()) viewer.scene.requestRender?.();
  };
  const release = (bundle) => {
    if (!bundle) return;
    for (const primitive of bundle.primitives) {
      try {
        if (!groundPrimitives.isDestroyed?.())
          groundPrimitives.remove(primitive);
      } catch {
        // A host removal listener must not prevent the remaining owned
        // resources from being released during teardown.
      }
      // Also support a host collection configured with destroyPrimitives=false.
      if (!primitive.isDestroyed()) primitive.destroy();
    }
    bundle.primitives.length = 0;
    if (bundle.dataSource) {
      // Repeat after a pending add settles: removing before that microtask
      // would not prevent Cesium from inserting the source later.
      try {
        if (!dataSources.isDestroyed?.())
          dataSources.remove(bundle.dataSource, true);
      } catch {
        // A deferred add can settle after the host collection was destroyed.
      }
      bundle.dataSource.entities.removeAll();
    }
  };
  const show = (bundle) => {
    if (!bundle) return;
    for (const primitive of bundle.primitives) primitive.show = visible;
    if (bundle.dataSource) bundle.dataSource.show = visible;
  };

  function build(records) {
    const fills = [];
    const lines = [];
    let dataSource = null;
    let pointCount = 0;
    for (const record of records) {
      const geometry = record.geometry;
      let part = 0;
      const pickId = () => Object.freeze({ id: record.id, part: part++ });
      const addLine = (coordinates, boundary = false) => {
        lines.push(
          new Cesium.GeometryInstance({
            id: pickId(),
            geometry: new Cesium.GroundPolylineGeometry({
              // GeoJSON rings repeat their first vertex at the end. Cesium's
              // loop flag closes the path itself; remove every redundant
              // closing vertex so its first miter tangent cannot be zero.
              // Polygon hierarchies and source coordinates remain unchanged.
              positions: positions(
                boundary ? loopCoordinates(coordinates) : coordinates,
              ),
              width: boundary ? 1.5 : 3,
              loop: boundary,
            }),
            attributes: {
              color: Cesium.ColorGeometryInstanceAttribute.fromColor(
                color.withAlpha(boundary ? 0.85 : 0.95),
              ),
            },
          }),
        );
      };
      const addPolygon = (rings) => {
        fills.push(
          new Cesium.GeometryInstance({
            id: pickId(),
            geometry: new Cesium.PolygonGeometry({
              polygonHierarchy: hierarchy(rings),
              vertexFormat: Cesium.VertexFormat.POSITION_ONLY,
            }),
            attributes: {
              color: Cesium.ColorGeometryInstanceAttribute.fromColor(
                color.withAlpha(0.2),
              ),
            },
          }),
        );
        for (const ring of rings) addLine(ring, true);
      };
      switch (geometry.type) {
        case 'Polygon':
          addPolygon(geometry.coordinates);
          break;
        case 'MultiPolygon':
          geometry.coordinates.forEach(addPolygon);
          break;
        case 'LineString':
          addLine(geometry.coordinates);
          break;
        case 'MultiLineString':
          geometry.coordinates.forEach((line) => addLine(line));
          break;
        case 'Point':
          dataSource ||= new Cesium.CustomDataSource(dataset.id);
          dataSource.entities.add({
            id: record.id,
            name: record.name,
            position: Cesium.Cartesian3.fromDegrees(
              geometry.coordinates[0],
              geometry.coordinates[1],
            ),
            point: {
              pixelSize: 10,
              color,
              outlineColor: Cesium.Color.BLACK,
              outlineWidth: 1.5,
              heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
              distanceDisplayCondition: new Cesium.DistanceDisplayCondition(
                0,
                250000,
              ),
            },
          });
          pointCount++;
          break;
        default:
          throw new TypeError('Unsupported San Antonio geometry');
      }
    }
    const primitives = [];
    if (fills.length)
      primitives.push(
        new Cesium.GroundPrimitive({
          geometryInstances: fills,
          appearance: new Cesium.PerInstanceColorAppearance({
            flat: true,
            translucent: true,
          }),
          asynchronous: true,
          show: false,
          // BOTH remains correct when the host switches between its terrain
          // and globe-hidden photoreal stacks, without a global event listener.
          classificationType: Cesium.ClassificationType.BOTH,
        }),
      );
    if (lines.length)
      primitives.push(
        new Cesium.GroundPolylinePrimitive({
          geometryInstances: lines,
          appearance: new Cesium.PolylineColorAppearance({
            translucent: true,
          }),
          asynchronous: true,
          show: false,
          classificationType: Cesium.ClassificationType.BOTH,
        }),
      );
    for (const primitive of primitives) primitive.id = dataset.id;
    if (dataSource) dataSource.show = false;
    return {
      primitives,
      dataSource,
      count: records.length,
      pointCount,
      geometryCount: fills.length + lines.length + pointCount,
    };
  }

  return {
    async replace(records) {
      if (destroyed) return false;
      if (!Array.isArray(records))
        throw new TypeError('San Antonio records must be an array');
      const token = ++generation;
      const next = build(records);
      pending.add(next);
      try {
        for (const primitive of next.primitives)
          groundPrimitives.add(primitive);
        if (next.dataSource) await dataSources.add(next.dataSource);
        if (destroyed || token !== generation) {
          release(next);
          return false;
        }
        const previous = current;
        current = next;
        show(current);
        release(previous);
        requestRender();
        return true;
      } catch (error) {
        release(next);
        if (destroyed || token !== generation) return false;
        throw error;
      } finally {
        pending.delete(next);
      }
    },
    setVisible(value) {
      if (destroyed) return;
      visible = Boolean(value);
      show(current);
      requestRender();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      generation++;
      release(current);
      current = null;
      for (const bundle of pending) release(bundle);
      requestRender();
    },
    getStats() {
      return {
        count: current?.count ?? 0,
        primitiveCount: current?.primitives.length ?? 0,
        pointCount: current?.pointCount ?? 0,
        geometryCount: current?.geometryCount ?? 0,
      };
    },
  };
}
