/**
 * @module render/cesium/drawMeshes
 * @description The Cesium draw port's `meshes` sets: each item one
 * primitive of its triangles, in the east-north-up frame at its `origin`,
 * in its colour. `flat` draws it unlit with both faces (a translucent
 * volume seen from inside or behind); otherwise it is lit by its own
 * normals and its back faces are culled. Its vertices are placed in the
 * Earth-fixed frame when it is built (a primitive whose own vertices sit at
 * its frame's origin cannot be projected for the 2D views Cesium prepares),
 * so any change but `show` builds it anew, at once, and it draws in the
 * frame it replaces the old one. `positions` and `indices` are compared by
 * identity: give new arrays to change a shape.
 */
import * as Cesium from 'cesium';

/** A colour as a key: a CSS string as it is, an RGBA array joined. */
const colorKey = (color) =>
  typeof color === 'string' ? color : Array.from(color).join(',');

/**
 * The meshes part of a Cesium draw port.
 * @param {{toColor: Function, pickId: Function, replaceHost: Function,
 *   requestRender: () => void}} options From the draw port.
 */
export function createMeshSets({
  toColor,
  pickId,
  replaceHost,
  requestRender,
}) {
  /** The set's host, made once: its meshes are changed where they are. */
  function hostOf(record) {
    if (record.host && !record.host.isDestroyed?.()) return record.host;
    const host = new Cesium.PrimitiveCollection();
    record.meshes = new Map();
    replaceHost(record, host);
    return host;
  }

  function notePickIds(record) {
    record.pickIds = [];
    for (const entry of record.meshes.values())
      record.pickIds.push(entry.pickId);
  }

  const pickableOf = (record, item) =>
    record.spec.pickable !== false && item.pickable !== false;

  const scratchFrame = new Cesium.Matrix4();
  const scratchPoint = new Cesium.Cartesian3();

  /** The item's east-north-up positions, in the Earth-fixed frame. */
  function fixedPositions(item) {
    const { origin, positions } = item;
    const frame = Cesium.Transforms.eastNorthUpToFixedFrame(
      new Cesium.Cartesian3(origin.x, origin.y, origin.z),
      Cesium.Ellipsoid.WGS84,
      scratchFrame,
    );
    const out = new Float64Array(positions.length);
    for (let i = 0; i + 2 < positions.length; i += 3) {
      scratchPoint.x = positions[i];
      scratchPoint.y = positions[i + 1];
      scratchPoint.z = positions[i + 2];
      Cesium.Matrix4.multiplyByPoint(frame, scratchPoint, scratchPoint);
      out[i] = scratchPoint.x;
      out[i + 1] = scratchPoint.y;
      out[i + 2] = scratchPoint.z;
    }
    return out;
  }

  /** What an entry's primitive is built from: equal keys need no rebuild. */
  const shapeKey = (record, item) => ({
    origin: `${item.origin.x},${item.origin.y},${item.origin.z}`,
    positions: item.positions,
    indices: item.indices,
    color: colorKey(item.color),
    flat: item.flat === true,
    pickable: pickableOf(record, item),
  });

  const sameShape = (a, b) =>
    a.origin === b.origin &&
    a.positions === b.positions &&
    a.indices === b.indices &&
    a.color === b.color &&
    a.flat === b.flat &&
    a.pickable === b.pickable;

  function primitiveOf(record, item, entry) {
    const values = fixedPositions(item);
    const geometry = new Cesium.Geometry({
      attributes: {
        position: new Cesium.GeometryAttribute({
          componentDatatype: Cesium.ComponentDatatype.DOUBLE,
          componentsPerAttribute: 3,
          values,
        }),
      },
      indices: item.indices,
      primitiveType: Cesium.PrimitiveType.TRIANGLES,
      boundingSphere: Cesium.BoundingSphere.fromVertices(Array.from(values)),
    });
    const flat = item.flat === true;
    if (!flat) Cesium.GeometryPipeline.computeNormal(geometry);
    const color = toColor(item.color);
    return new Cesium.Primitive({
      geometryInstances: new Cesium.GeometryInstance({
        geometry,
        attributes: {
          color: Cesium.ColorGeometryInstanceAttribute.fromColor(color),
        },
        id: entry.pickId,
      }),
      appearance: new Cesium.PerInstanceColorAppearance({
        flat,
        translucent: color.alpha < 1,
        // Flat: both faces. Lit: a closed shape, its back faces culled.
        closed: !flat,
        ...(flat ? { renderState: { cull: { enabled: false } } } : {}),
      }),
      allowPicking: pickableOf(record, item),
      asynchronous: false,
      show: item.show !== false,
    });
  }

  function put(record, item) {
    const host = record.host;
    let entry = record.meshes.get(item.id);
    if (!entry) {
      entry = {
        item,
        pickId: pickId(record, item),
        key: null,
        primitive: null,
      };
      record.meshes.set(item.id, entry);
    }
    entry.item = item;
    entry.pickId.meta = item.meta;
    const key = shapeKey(record, item);
    if (entry.primitive && entry.key && sameShape(entry.key, key)) {
      entry.primitive.show = item.show !== false;
      return;
    }
    const next = host.add(primitiveOf(record, item, entry));
    if (entry.primitive) host.remove(entry.primitive);
    entry.primitive = next;
    entry.key = key;
  }

  function drop(record, id) {
    const entry = record.meshes.get(id);
    if (!entry) return;
    record.meshes.delete(id);
    const host = record.host;
    if (entry.primitive && host && !host.isDestroyed())
      host.remove(entry.primitive);
  }

  /** Add or change items, by id; true once handled (always, for meshes). */
  function upsert(record, list) {
    hostOf(record);
    for (const item of list) put(record, item);
    notePickIds(record);
    requestRender();
    return true;
  }

  /** The set's items as they are now: meshes gone dropped, the rest kept. */
  function build(record) {
    hostOf(record);
    for (const id of [...record.meshes.keys()])
      if (!record.items.has(id)) drop(record, id);
    for (const item of record.items.values()) put(record, item);
    notePickIds(record);
  }

  return { build, upsert };
}
