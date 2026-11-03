import * as Cesium from 'cesium';
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  Raycaster,
  SRGBColorSpace,
  Texture,
} from 'three';
const KEY = 'gevScenePack',
  registered = new WeakSet();
const cyan = [0, 1, 1, 1],
  xyz = (p) => Cesium.Cartesian3.fromDegrees(...p);
export function createNavaraPackRenderer(engine, { view, MeshDesc }) {
  if (!registered.has(view)) {
    view.registerMesh(
      KEY,
      class extends MeshDesc {
        constructor(host, ctx, config) {
          super(host, ctx, config);
          this.object = config[KEY];
        }
        getPassKey() {
          return 'transparent';
        }
        createMesh() {
          return this.object.group;
        }
        onDestroy() {
          this.object.dispose();
          super.onDestroy();
        }
      },
    );
    registered.add(view);
  }
  const meshGroup = (handle) => {
    const group = new Group(),
      owned = [];
    let released = false;
    const dispose = () => {
      if (released) return;
      released = true;
      for (const item of owned) item.dispose();
    };
    group.frustumCulled = false;
    let holder;
    try {
      holder = view.addMesh({ [KEY]: { group, dispose } });
    } catch (e) {
      dispose();
      throw e;
    }
    handle.own(() => {
      try {
        holder.delete();
      } finally {
        dispose();
      }
    });
    return { group, owned };
  };
  function addMesh(batch, shape, properties, id, texture) {
    if (!shape) return;
    const source = shape.attributes.position.values,
      origin = shape.boundingSphere.center;
    const coords = new Float32Array(source.length);
    for (let i = 0; i < source.length; i += 3) {
      coords[i] = source[i] - origin.x;
      coords[i + 1] = source[i + 1] - origin.y;
      coords[i + 2] = source[i + 2] - origin.z;
    }
    const geometry = new BufferGeometry();
    batch.owned.push(geometry);
    geometry.setAttribute('position', new BufferAttribute(coords, 3));
    geometry.setIndex(new BufferAttribute(shape.indices, 1));
    if (shape.attributes.st)
      geometry.setAttribute(
        'uv',
        new BufferAttribute(new Float32Array(shape.attributes.st.values), 2),
      );
    const material = new MeshBasicMaterial({
      ...properties,
      map: texture,
      side: DoubleSide,
      transparent: true,
      depthWrite: false,
      toneMapped: false,
    });
    batch.owned.push(material);
    const mesh = new Mesh(geometry, material);
    const pigment = material.color.clone();
    mesh.onBeforeRender = () => {
      material.color
        .copy(pigment)
        .multiplyScalar(1 / Math.max(1, view.toneMappingExposure ?? 1));
    };
    mesh.position.set(origin.x, origin.y, origin.z);
    mesh.userData.pickId = id;
    batch.group.add(mesh);
    return mesh;
  }
  return {
    geometry(pack, features, handle) {
      const points = features.filter((f) => f.type === 'Point');
      let bank;
      if (points.length) {
        bank = engine.movers.createSet({
          id: 'scene-pack-points-' + pack.id,
          capacity: points.length,
          kind: 'point',
          depthTest: 'normal',
          pickable: true,
          point: { sizePx: 12, outlinePx: 2, outlineColor: [0, 0, 0, 1] },
        });
        handle.own(() => bank.destroy());
      }
      let index = 0,
        batch;
      for (const f of features) {
        const id = JSON.stringify([pack.id, f.id]);
        handle.feature({ packId: pack.id, featureId: f.id }, id);
        if (f.type === 'Point') {
          bank.set(index++, {
            position: xyz(f.coordinates),
            color: cyan,
            pickId: id,
            show: true,
          });
        } else if (f.type === 'LineString') {
          const line = engine.lines.createLine({
            id,
            widthPx: 4,
            color: cyan,
            pickId: id,
            arc: 'geodesic',
          });
          handle.own(() => line.destroy());
          line.setPositions(f.coordinates.map(xyz));
        } else {
          batch ??= meshGroup(handle);
          const polygon = new Cesium.PolygonGeometry({
            polygonHierarchy: new Cesium.PolygonHierarchy(
              f.coordinates[0].map(xyz),
              f.coordinates
                .slice(1)
                .map((r) => new Cesium.PolygonHierarchy(r.map(xyz))),
            ),
            perPositionHeight: true,
            vertexFormat: Cesium.VertexFormat.POSITION_ONLY,
            arcType: Cesium.ArcType.GEODESIC,
          });
          addMesh(
            batch,
            Cesium.PolygonGeometry.createGeometry(polygon),
            { color: new Color(0x00ffff), opacity: 0.35 },
            id,
            null,
          );
        }
      }
      if (bank) {
        bank.setCount(index);
        bank.commit();
      }
      if (batch) {
        const raycaster = new Raycaster();
        handle.own(
          engine.picker.registerMeshPicker((at) => {
            const ray = engine.camera.pickRay(at);
            if (!ray) return [];
            raycaster.ray.origin.copy(ray.origin);
            raycaster.ray.direction.copy(ray.direction).normalize();
            batch.group.updateWorldMatrix(true, true);
            const hits = raycaster.intersectObjects(batch.group.children);
            const earth = engine.picker.pickGlobe(at);
            const depth = earth
              ? Cesium.Cartesian3.distance(ray.origin, earth)
              : Infinity;
            return hits
              .filter((h) => h.distance <= depth + 1)
              .map((h) => ({
                onTop: 0,
                order: 0,
                depth: h.distance,
                result: { owner: 'scene-pack', id: h.object.userData.pickId },
              }));
          }),
        );
      }
      engine.render.request('scene-pack');
    },
    image(pack, image, handle) {
      const batch = meshGroup(handle);
      const texture = new Texture(image);
      texture.colorSpace = SRGBColorSpace;
      texture.needsUpdate = true;
      batch.owned.push(texture);
      const shape = Cesium.RectangleGeometry.createGeometry(
        new Cesium.RectangleGeometry({
          rectangle: Cesium.Rectangle.fromDegrees(...pack.placement.bounds),
          height: pack.placement.height,
          vertexFormat: Cesium.VertexFormat.POSITION_AND_ST,
        }),
      );
      addMesh(batch, shape, { color: 0xffffff, opacity: 1 }, null, texture);
      engine.render.request('scene-pack');
    },
    media(pack, anchor, handle) {
      const canvas = document.createElement('canvas');
      canvas.width = 256;
      canvas.height = 256;
      const ctx = canvas.getContext('2d');
      ctx.font = '14px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillStyle = 'white';
      ctx.fillText(pack.id, 128, 105, 250);
      ctx.fillStyle = '#ff0';
      ctx.beginPath();
      ctx.arc(128, 128, 8, 0, Math.PI * 2);
      ctx.fill();
      const set = engine.movers.createSet({
        id: 'scene-media-' + pack.id,
        kind: 'sprite',
        capacity: 1,
        pickable: false,
        depthTest: 'normal',
        sprite: {
          sizePx: 256,
          atlas: { canvas, cells: { icon: [0, 0, 1, 1] } },
        },
      });
      handle.own(() => set.destroy());
      set.set(0, {
        position: xyz([anchor.lon, anchor.lat, anchor.alt]),
        cell: 'icon',
        color: [1, 1, 1, 1],
        show: true,
      });
      set.setCount(1);
      set.commit();
    },
  };
}
