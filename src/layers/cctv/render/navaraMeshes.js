import {
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  DoubleSide,
  Group,
  LinearFilter,
  Mesh,
  MeshBasicMaterial,
  Quaternion,
  Raycaster,
  SRGBColorSpace,
  Vector3,
  VideoTexture,
} from 'three';
import { frustumVolumeGeometryData } from '../../../data/cctvViewshed.js';
import { PLANE_OUTLINE_COLOR } from '../policy.js';

const KIND = 'gevCctvMesh';
const registered = new WeakSet();

/** Local mesh coordinates keep ECEF precision in the double world matrix. */
function placeGeometry(mesh, positions, indices, origin) {
  const local = new Float32Array(positions.length);
  for (let i = 0; i < positions.length; i += 3) {
    local[i] = positions[i] - origin.x;
    local[i + 1] = positions[i + 1] - origin.y;
    local[i + 2] = positions[i + 2] - origin.z;
  }
  mesh.geometry.setAttribute('position', new BufferAttribute(local, 3));
  mesh.geometry.setIndex(Array.from(indices));
  mesh.geometry.computeBoundingSphere();
  mesh.matrix.makeTranslation(origin.x, origin.y, origin.z);
  mesh.matrixWorldNeedsUpdate = true;
}

/** CCTV owns these resources; media playback remains in shared projection. */
export function createCctvNavaraMeshes(engine, { view, MeshDesc }) {
  if (!view?.addMesh || !MeshDesc)
    throw new TypeError('CCTV requires Navara MeshDesc support');
  if (!registered.has(view)) {
    view.registerMesh(
      KIND,
      class extends MeshDesc {
        constructor(owner, ctx, config) {
          super(owner, ctx, config);
          this.cctv = config[KIND];
        }
        // The opaque scene draws after the scene depth is copied into its
        // target, so walls and terrain hide the frame and volume; Navara's
        // transparent pass runs after the effects without that depth and
        // painted them through.
        getPassKey() {
          return 'opaque';
        }
        createMesh() {
          return this.cctv.group;
        }
        onDestroy() {
          this.cctv.dispose();
          super.onDestroy();
        }
      },
    );
    registered.add(view);
  }
  const owned = new Set();
  const materials = new Set();
  const planes = new Set();
  const raycaster = new Raycaster();
  let destroyed = false;
  const request = () => engine.render.request('cctv-mesh');
  const alive = () => {
    if (destroyed) throw new Error('CCTV meshes are destroyed');
  };

  function createMaterial(image) {
    alive();
    const material = new MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.95,
      side: DoubleSide,
      depthWrite: false,
      toneMapped: false,
    });
    const resource = {
      material,
      image: null,
      texture: null,
      disposed: false,
      setImage(next) {
        if (resource.disposed) return;
        if (next === resource.image) {
          if (resource.texture && !resource.texture.isVideoTexture)
            resource.texture.needsUpdate = true;
          request();
          return;
        }
        const texture =
          next?.tagName === 'VIDEO'
            ? new VideoTexture(next)
            : new CanvasTexture(next);
        texture.colorSpace = SRGBColorSpace;
        texture.minFilter = texture.magFilter = LinearFilter;
        texture.generateMipmaps = false;
        const previous = resource.texture;
        resource.image = next;
        resource.texture = texture;
        material.map = texture;
        material.needsUpdate = true;
        previous?.dispose();
        request();
      },
      dispose() {
        if (resource.disposed) return;
        resource.disposed = true;
        resource.texture?.dispose();
        resource.texture = resource.image = null;
        material.map = null;
        material.dispose();
        materials.delete(resource);
      },
    };
    materials.add(resource);
    try {
      if (image) resource.setImage(image);
      return resource;
    } catch (error) {
      resource.dispose();
      throw error;
    }
  }

  function ownMesh(mesh, disposeExtra = () => {}) {
    alive();
    const group = new Group();
    group.frustumCulled = mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false;
    group.add(mesh);
    let freed = false;
    let handle;
    const dispose = () => {
      if (freed) return;
      freed = true;
      mesh.geometry.dispose();
      disposeExtra();
      owned.delete(resource);
    };
    const resource = {
      group,
      mesh,
      get show() {
        return !freed && group.visible;
      },
      set show(value) {
        if (freed || group.visible === Boolean(value)) return;
        group.visible = Boolean(value);
        request();
      },
      destroy() {
        if (freed) return;
        try {
          handle?.delete();
        } finally {
          dispose();
          request();
        }
      },
    };
    owned.add(resource);
    try {
      handle = view.addMesh({ [KIND]: { group, dispose } });
      return resource;
    } catch (error) {
      dispose();
      throw error;
    }
  }

  function updatePlane(plane, geometry, positions, orientation) {
    if (!planes.has(plane)) return;
    // Match the native plane's quaternion and dimensions, including its UVs.
    const q = new Quaternion(
      orientation.x,
      orientation.y,
      orientation.z,
      orientation.w,
    );
    const flat = [];
    for (const [x, y] of [
      [-1, 1],
      [1, 1],
      [-1, -1],
      [1, -1],
    ]) {
      const p = new Vector3(x * geometry.halfW, y * geometry.halfH, 0)
        .applyQuaternion(q)
        .add(positions.capCenter);
      flat.push(p.x, p.y, p.z);
    }
    placeGeometry(plane.mesh, flat, [0, 2, 1, 2, 3, 1], positions.capCenter);
    plane.outline.setPositions(
      [0, 1, 3, 2, 0].map((i) => ({
        x: flat[i * 3],
        y: flat[i * 3 + 1],
        z: flat[i * 3 + 2],
      })),
    );
    request();
  }

  return {
    createMaterial,
    createPlane(cameraId, material, geometry, positions, orientation) {
      alive();
      if (!materials.has(material) || material.disposed)
        throw new Error('CCTV plane material is not owned');
      const mesh = new Mesh(new BufferGeometry(), material.material);
      mesh.geometry.setAttribute(
        'uv',
        new BufferAttribute(new Float32Array([0, 1, 1, 1, 0, 0, 1, 0]), 2),
      );
      let outline;
      let plane;
      let transferred = false;
      try {
        outline = engine.lines.createLine({
          id: `cctv-${cameraId}-plane-outline`,
          widthPx: 1,
          color: PLANE_OUTLINE_COLOR.rgba(),
        });
        transferred = true;
        plane = ownMesh(mesh, () => {
          outline.destroy();
          material.dispose();
          planes.delete(plane);
        });
        plane.id = `cctv-${cameraId}-plane`;
        plane.cameraId = cameraId;
        plane.outline = outline;
        const visibility = Object.getOwnPropertyDescriptor(plane, 'show');
        Object.defineProperty(plane, 'show', {
          get: visibility.get,
          set(value) {
            visibility.set(value);
            if (planes.has(plane)) outline.show(plane.show);
          },
        });
        planes.add(plane);
        updatePlane(plane, geometry, positions, orientation);
        plane.show = false;
        return plane;
      } catch (error) {
        plane?.destroy();
        if (!transferred) {
          mesh.geometry.dispose();
          outline?.destroy();
          material.dispose();
        }
        throw error;
      }
    },
    updatePlane,
    createVolume(positions, tint) {
      alive();
      const data = frustumVolumeGeometryData(positions);
      const material = new MeshBasicMaterial({
        transparent: true,
        opacity: tint.alpha,
        side: DoubleSide,
        depthWrite: false,
        toneMapped: false,
      });
      material.color.setRGB(tint.red, tint.green, tint.blue, SRGBColorSpace);
      const mesh = new Mesh(new BufferGeometry(), material);
      placeGeometry(mesh, data.positions, data.indices, positions.mount);
      return ownMesh(mesh, () => material.dispose());
    },
    /** Actual plane triangles, not a projected rectangle or marker proxy. */
    pickPlane(ray) {
      if (destroyed || !ray) return undefined;
      raycaster.ray.origin.copy(ray.origin);
      raycaster.ray.direction.copy(ray.direction).normalize();
      let nearest;
      for (const plane of planes) {
        if (!plane.show) continue;
        plane.group.updateWorldMatrix(true, true);
        const hit = raycaster.intersectObject(plane.mesh, false)[0];
        if (hit && (!nearest || hit.distance < nearest.distance))
          nearest = { ...hit, plane };
      }
      return nearest;
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      for (const resource of [...owned]) resource.destroy();
      for (const material of [...materials]) material.dispose();
    },
  };
}
