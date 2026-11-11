import {
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  Raycaster,
  SRGBColorSpace,
  Texture,
  VideoTexture,
} from 'three';
import { createMeshRegistry } from '../meshes.js';
import { cartesian3 } from '../../geo/index.js';
import { createSceneDepthTest } from './sceneDepth.js';

const NEAR_SURFACE_M = 2;

export function createNavaraMeshes(view, { overlay, camera, picker }) {
  const registry = createMeshRegistry(
    (state) => {
      const group = new Group();
      const geometry = new BufferGeometry();
      const material = new MeshBasicMaterial({
        side: DoubleSide,
        transparent: true,
        depthWrite: false,
        toneMapped: false,
      });
      const mesh = new Mesh(geometry, material);
      const sceneDepth = createSceneDepthTest();
      sceneDepth.material(material);
      sceneDepth.object(mesh);
      let depthFree = false;
      const bindDepth = mesh.onBeforeRender;
      mesh.onBeforeRender = function onBeforeRender(...args) {
        // The overlay context can arrive after the mesh is created.
        sceneDepth.attach(overlay.ctx);
        bindDepth.apply(this, args);
        if (depthFree) sceneDepth.uniforms.uGevSceneDepthOn.value = 0;
      };
      group.frustumCulled = mesh.frustumCulled = false;
      group.add(mesh);
      let texture,
        image,
        freed = false;
      const dispose = () => {
        if (freed) return;
        freed = true;
        geometry.dispose();
        material.dispose();
        texture?.dispose();
      };
      function update(next, patch) {
        if ('positions' in patch || 'indices' in patch || 'uv' in patch) {
          const p = next.positions;
          const local = new Float32Array(p.length);
          for (let i = 0; i < p.length; i++) local[i] = p[i] - p[i % 3];
          mesh.position.set(p[0], p[1], p[2]);
          geometry.setAttribute('position', new BufferAttribute(local, 3));
          geometry.setIndex(new BufferAttribute(next.indices, 1));
          if (next.uv)
            geometry.setAttribute('uv', new BufferAttribute(next.uv, 2));
          else geometry.deleteAttribute('uv');
          geometry.computeBoundingSphere();
        }
        if (image !== next.image) {
          texture?.dispose();
          image = next.image;
          texture = !image
            ? null
            : image.tagName === 'VIDEO'
              ? new VideoTexture(image)
              : image.getContext
                ? new CanvasTexture(image)
                : new Texture(image);
          if (texture) {
            texture.colorSpace = SRGBColorSpace;
            texture.needsUpdate = true;
          }
          material.map = texture;
          material.needsUpdate = true;
        } else if (texture && !texture.isVideoTexture && 'image' in patch)
          texture.needsUpdate = true;
        material.color.setRGB(...next.color.slice(0, 3), SRGBColorSpace);
        material.opacity = next.color[3];
        depthFree = next.depthTest === 'always';
        material.depthTest = !depthFree;
        group.visible = next.show;
      }
      try {
        update(state, state);
        overlay.add(group);
      } catch (error) {
        dispose();
        throw error;
      }
      return {
        group,
        mesh,
        update,
        destroy() {
          try {
            overlay.remove(group);
          } finally {
            dispose();
          }
        },
      };
    },
    () => view.forceUpdate(),
  );
  const raycaster = new Raycaster();
  const removePicks = picker.registerMeshPicker((at) => {
    const candidates = [...registry.live.values()].filter(
      ({ state }) => state.show && state.pickId != null,
    );
    if (!candidates.length) return [];
    const ray = camera.pickRay(at);
    if (!ray) return [];
    raycaster.ray.origin.copy(ray.origin);
    raycaster.ray.direction.copy(ray.direction).normalize();
    // The rendered surface hides what lies behind it. Right after another
    // click Navara's depth read can answer with the camera itself: a
    // surface nearer than the near plane is no surface, and the globe
    // stands in for it.
    const surface = picker.pickPosition(at);
    let depth = surface ? cartesian3.distance(ray.origin, surface) : Infinity;
    if (depth < NEAR_SURFACE_M) {
      const globe = picker.pickGlobe?.(at);
      depth = globe ? cartesian3.distance(ray.origin, globe) : Infinity;
    }
    const hits = [];
    for (const { state, backend } of candidates) {
      backend.group.updateWorldMatrix(true, true);
      const hit = raycaster.intersectObject(backend.mesh, false)[0];
      if (!hit || (state.depthTest !== 'always' && hit.distance > depth + 0.1))
        continue;
      hits.push({
        onTop: state.depthTest === 'always' ? 1 : 0,
        order: 0,
        depth: hit.distance,
        result: { id: state.pickId, owner: state.id },
      });
    }
    return hits;
  });
  return {
    meshes: registry.meshes,
    destroy() {
      removePicks();
      registry.destroy();
    },
  };
}
