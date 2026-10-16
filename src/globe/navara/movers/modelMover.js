// The three side of a Navara model set: the glTF loaded once, one
// InstancedMesh per mesh in it (all instances share the model's meshes),
// each instance placed by position, orientation and scale relative to an
// origin near the camera. Cesium's minimumPixelSize/maximumScale are kept on
// the CPU once per drawn frame (models are few: tracked and proximity
// aircraft), and the instance colour is mixed into the surface colour
// (colorBlend), or the model drawn unlit.

import {
  Box3,
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  Quaternion,
  Sphere,
  Vector3,
} from 'three';
import { footprintPerDepth, originFor } from './pack.js';

const scratchMatrix = new Matrix4();
const scratchQuaternion = new Quaternion();
const scratchTranslation = new Vector3();
const scratchScale = new Vector3();

/** Mixes the instance colour into the material's colour by uGevBlend × alpha. */
function blendInstanceColor(material, uniforms) {
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace(
        'void main() {',
        'attribute vec4 gevColor;\nvarying vec4 vGevColor;\nvoid main() {',
      )
      .replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\nvGevColor = gevColor;',
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        'void main() {',
        'uniform float uGevBlend;\nvarying vec4 vGevColor;\nvoid main() {',
      )
      .replace(
        '#include <map_fragment>',
        '#include <map_fragment>\ndiffuseColor.rgb = mix(diffuseColor.rgb, vGevColor.rgb, uGevBlend * vGevColor.a);',
      );
  };
  material.customProgramCacheKey = () => 'gev-mover-model-blend';
}

/**
 * @param {object} options normalized model set options
 * @param {object} store the set's mover store
 * @param {{ load: (url: string) => Promise<{ scene: object }>, onLoad?: () => void }} ports
 */
export function createModelMover(options, store, { load, onLoad = () => {} }) {
  const { capacity, model } = options;
  const uniforms = {
    uGevBlend: {
      value: model.colorBlend
        ? model.colorBlend.mode === 'replace'
          ? 1
          : model.colorBlend.amount
        : 0,
    },
  };
  const parts = []; // { mesh, local: Matrix4 }
  let radius = 1;
  let origin = null;
  let footprint = 0;
  let cameraPosition = null;
  let loaded = false;
  let disposed = false;
  const colorAttributes = [];

  const write = (from, to) => {
    if (!loaded || !origin) return;
    const { positions, orientations, scales, shows, colors } = store;
    for (let index = from; index < to; index++) {
      let scale = shows[index] === 1 ? scales[index] : 0;
      if (scale > 0 && cameraPosition && footprint > 0) {
        const dx = positions[index * 3] - cameraPosition.x;
        const dy = positions[index * 3 + 1] - cameraPosition.y;
        const dz = positions[index * 3 + 2] - cameraPosition.z;
        const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
        const pixels = (2 * radius * scale) / (footprint * distance);
        if (pixels < model.minimumPixelSize)
          scale *= model.minimumPixelSize / pixels;
        scale = Math.min(scale, model.maximumScale);
      }
      scratchTranslation.set(
        positions[index * 3] - origin.x,
        positions[index * 3 + 1] - origin.y,
        positions[index * 3 + 2] - origin.z,
      );
      scratchQuaternion.set(
        orientations[index * 4],
        orientations[index * 4 + 1],
        orientations[index * 4 + 2],
        orientations[index * 4 + 3],
      );
      scratchScale.setScalar(scale);
      for (const { mesh, local } of parts) {
        scratchMatrix
          .compose(scratchTranslation, scratchQuaternion, scratchScale)
          .multiply(local);
        mesh.setMatrixAt(index, scratchMatrix);
      }
      for (const attribute of colorAttributes)
        attribute.array.set(
          colors.subarray(index * 4, index * 4 + 4),
          index * 4,
        );
    }
    for (const { mesh } of parts) {
      mesh.count = store.count;
      mesh.instanceMatrix.needsUpdate = true;
    }
    for (const attribute of colorAttributes) attribute.needsUpdate = true;
  };

  const group = { meshes: [], ready: null };
  group.ready = load(model.url).then((gltf) => {
    if (disposed) return;
    const root = gltf.scene;
    root.updateMatrixWorld(true);
    const sphere = new Box3()
      .setFromObject(root)
      .getBoundingSphere(new Sphere());
    radius = Math.max(sphere.radius, 1e-3);
    root.traverse((child) => {
      if (!child.isMesh) return;
      let material = child.material;
      if (model.unlit)
        material = new MeshBasicMaterial({
          map: material.map ?? null,
          color: material.color,
        });
      else material = material.clone();
      blendInstanceColor(material, uniforms);
      const geometry = child.geometry.clone();
      const color = new InstancedBufferAttribute(
        new Float32Array(capacity * 4).fill(1),
        4,
      );
      color.setUsage(DynamicDrawUsage);
      geometry.setAttribute('gevColor', color);
      colorAttributes.push(color);
      const mesh = new InstancedMesh(geometry, material, capacity);
      mesh.instanceMatrix.setUsage(DynamicDrawUsage);
      mesh.frustumCulled = false;
      mesh.renderOrder = options.order;
      mesh.count = 0;
      parts.push({ mesh, local: child.matrixWorld.clone() });
      group.meshes.push(mesh);
    });
    loaded = true;
    if (origin)
      for (const { mesh } of parts)
        mesh.position.set(origin.x, origin.y, origin.z);
    write(0, store.count);
    onLoad(group.meshes);
  });

  const placeAt = (next) => {
    origin = { x: next.x, y: next.y, z: next.z };
    for (const { mesh } of parts) {
      mesh.position.set(origin.x, origin.y, origin.z);
      mesh.updateMatrix();
      mesh.updateMatrixWorld(true);
    }
  };

  return {
    group,
    uniforms,
    ready: () => loaded,
    origin: () => origin,
    commit(range) {
      if (!origin && store.count > 0)
        placeAt({
          x: store.positions[0],
          y: store.positions[1],
          z: store.positions[2],
        });
      if (range) write(range.from, Math.min(range.to, store.count));
      for (const { mesh } of parts) mesh.count = store.count;
    },
    /** Each drawn frame: pixel limits need every instance rewritten. */
    update({ cameraPosition: camera, cameraHeight, fovDeg, viewportHeightPx }) {
      footprint = footprintPerDepth(fovDeg, viewportHeightPx);
      cameraPosition = camera;
      if (!origin || store.count === 0) return false;
      const next = originFor(camera, origin, cameraHeight);
      if (next !== origin) placeAt(next);
      write(0, store.count);
      return true;
    },
    dispose() {
      disposed = true;
      for (const { mesh } of parts) {
        mesh.geometry.dispose();
        mesh.material.dispose();
        mesh.dispose?.();
      }
    },
  };
}
