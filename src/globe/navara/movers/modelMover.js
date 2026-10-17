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

/**
 * Ambient light on the tinted surface, as an emissive share of it: Cesium
 * lights models with image-based lighting besides the sun, so a tinted
 * aircraft reads near-white at any sun angle; Navara's sky light alone left
 * them grey-brown at dawn. 0.5 matched Cesium's model luminance at the near
 * pose (qa-flights-engines --models=on: median 190 vs 193 on Cesium; 139
 * without it).
 */
export const MODEL_AMBIENT = 0.5;

/**
 * The distance Cesium sizes a model's minimumPixelSize at (Camera
 * distanceToBoundingSphere): |offset · view direction| less `radiusM`, at
 * least 0; the straight-line distance when no direction is known.
 */
export function modelPixelDistance(dx, dy, dz, direction, radiusM) {
  const along = direction
    ? Math.abs(dx * direction.x + dy * direction.y + dz * direction.z)
    : Math.sqrt(dx * dx + dy * dy + dz * dz);
  return Math.max(0, along - radiusM);
}

const scratchMatrix = new Matrix4();
const scratchQuaternion = new Quaternion();
const scratchTranslation = new Vector3();
const scratchScale = new Vector3();

/**
 * Mixes the instance colour, decoded from sRGB (as Cesium takes colours;
 * the material works in linear), into the material's colour by uGevBlend (the
 * set's colorBlend, as Cesium's colorBlendAmount); the instance alpha is the
 * model's opacity (Cesium: a model colour's alpha makes it translucent; the
 * aircraft fade with distance through it), not a blend weight.
 */
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
        'uniform float uGevBlend;\nuniform float uGevAmbient;\nvarying vec4 vGevColor;\nvoid main() {',
      )
      .replace(
        '#include <emissivemap_fragment>',
        '#include <emissivemap_fragment>\ntotalEmissiveRadiance += diffuseColor.rgb * uGevAmbient;',
      )
      .replace(
        '#include <map_fragment>',
        '#include <map_fragment>\ndiffuseColor.rgb = mix(diffuseColor.rgb, sRGBTransferEOTF(vGevColor).rgb, uGevBlend);\ndiffuseColor.a *= vGevColor.a;',
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
    uGevAmbient: { value: MODEL_AMBIENT },
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
  let cameraDirection = null;
  let loaded = false;
  let disposed = false;
  const colorAttributes = [];
  const materials = [];
  // Translucent only while an instance is faded (opaque models keep the
  // opaque pass).
  const syncTransparency = () => {
    const { colors } = store;
    let faded = false;
    for (let index = 0; index < store.count && !faded; index++)
      if (store.shows[index] === 1 && colors[index * 4 + 3] < 1) faded = true;
    for (const material of materials)
      if (material.transparent !== faded) {
        material.transparent = faded;
        material.needsUpdate = true;
      }
  };

  const write = (from, to) => {
    if (!loaded || !origin) return;
    const { positions, orientations, scales, shows, colors } = store;
    for (let index = from; index < to; index++) {
      let scale = shows[index] === 1 ? scales[index] : 0;
      if (scale > 0 && cameraPosition && footprint > 0) {
        const dx = positions[index * 3] - cameraPosition.x;
        const dy = positions[index * 3 + 1] - cameraPosition.y;
        const dz = positions[index * 3 + 2] - cameraPosition.z;
        // Cesium's distance for minimumPixelSize (Camera
        // distanceToBoundingSphere): the depth along the view direction
        // less the model's radius at its own scale.
        const distance = modelPixelDistance(
          dx,
          dy,
          dz,
          cameraDirection,
          radius * scale,
        );
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
    syncTransparency();
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
      materials.push(material);
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
    update({
      cameraPosition: camera,
      cameraDirection: direction = null,
      cameraHeight,
      fovDeg,
      viewportHeightPx,
    }) {
      footprint = footprintPerDepth(fovDeg, viewportHeightPx);
      cameraPosition = camera;
      cameraDirection = direction;
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
