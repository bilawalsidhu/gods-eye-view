// The three side of a Navara model set: the glTF shared by the set, one
// InstancedMesh per mesh in it (all instances share the model's meshes),
// each instance placed by position, orientation and scale relative to an
// origin near the camera. Cesium's minimumPixelSize is kept on the CPU once
// per drawn frame (models are few: tracked and proximity aircraft), and the
// instance colour is mixed into the surface colour (colorBlend), or the model
// drawn unlit.

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
import { createMoverRetry } from '../../movers.js';
import { footprintPerDepth, originFor } from './pack.js';
import { createModelTint } from './modelTint.js';

/**
 * Ambient share of the base surface: Cesium supplies image-based lighting
 * besides the sun. Navara's sky light alone left it grey-brown at dawn.
 * The instance colour is applied after lighting, independently of this share.
 */
const MODEL_AMBIENT = 0.5;

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
 * Cesium's ModelFS applies modelColorStage after lightingStage in sRGB.
 * Mix the lit output in that space, then return to linear for Navara's look.
 * Alpha remains opacity before alpha testing, independently of the mix.
 */
function blendInstanceColor(material, uniforms, displayTint) {
  const alpha = 'diffuseColor.a *= vGevColor.a;';
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
        `uniform float uGevBlend;\nuniform float uGevAmbient;\nvarying vec4 vGevColor;\nvoid main() {`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        '#include <emissivemap_fragment>\ntotalEmissiveRadiance += diffuseColor.rgb * uGevAmbient;',
      )
      .replace('#include <map_fragment>', `#include <map_fragment>\n${alpha}`)
      .replace(
        '#include <opaque_fragment>',
        `#include <opaque_fragment>\nif (!${displayTint} && uGevBlend > 0.0) {\nvec3 gevLitSrgb = sRGBTransferOETF(vec4(gl_FragColor.rgb, 1.0)).rgb;\nvec3 gevMixedColor = sRGBTransferEOTF(vec4(clamp(mix(gevLitSrgb, vGevColor.rgb, uGevBlend), 0.0, 1.0), 1.0)).rgb;\ngl_FragColor.rgb = gevMixedColor;\n}`,
      );
  };
  material.customProgramCacheKey = () =>
    `gev-mover-model-display-color-${displayTint ? 'overlay' : 'linear'}`;
}

/**
 * @param {object} options normalized model set options
 * @param {object} store the set's mover store
 * @param {{ load: (url: string) => Promise<{ scene: object }>, onLoad?: () => void, overlay?: object }} ports
 */
export function createModelMover(
  options,
  store,
  { load, onLoad = () => {}, overlay = null },
) {
  const { capacity, model } = options;
  const uniforms = {
    uGevAmbient: { value: MODEL_AMBIENT },
    uGevModelExposure: overlay?.uniforms.uGevModelExposure ?? { value: 1 },
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
  // GLTFLoader returns a fresh asset per load. Cloned materials still share
  // its textures; Material.dispose() does not release their GPU allocations.
  const textures = new Set();
  const disposeTextures = () => {
    for (const texture of textures) texture.dispose();
    textures.clear();
  };
  // Each instance's drawn diameter (px) at its last write (CPU picks).
  const drawnPx = new Float32Array(capacity);
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
      drawnPx[index] = 0;
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
        drawnPx[index] = (pixels * scale) / scales[index];
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
    for (const { mesh, tint } of parts) {
      if (tint) {
        tint.count = store.count;
        tint.visible = loaded && store.count > 0;
      }
      mesh.count = store.count;
      mesh.visible = loaded && store.count > 0;
      mesh.instanceMatrix.needsUpdate = true;
    }
    for (const attribute of colorAttributes) attribute.needsUpdate = true;
    syncTransparency();
  };

  const group = { meshes: [], pickMeshes: [], ready: null, onLoad: null };
  const pickIds = new Map();
  const current = (index) => pickIds.get(index) === store.pickIds[index];
  let generation = 0;
  let finish;
  group.ready = new Promise((resolve) => (finish = resolve));
  const releaseParts = () => {
    for (const { mesh, tint } of parts) {
      if (tint) {
        overlay.remove(tint);
        tint.material.dispose();
        tint.dispose();
      }
      mesh.removeFromParent();
      mesh.geometry.dispose();
      mesh.material.dispose();
      mesh.dispose?.();
    }
    parts.length = materials.length = colorAttributes.length = 0;
    group.meshes.length = group.pickMeshes.length = 0;
    disposeTextures();
  };
  const releaseAsset = (gltf, releaseTexture) => {
    gltf.scene.traverse((child) => {
      child.geometry?.dispose();
      for (const material of Array.isArray(child.material)
        ? child.material
        : [child.material]) {
        if (!material) continue;
        if (releaseTexture)
          for (const value of Object.values(material))
            if (value?.isTexture) value.dispose();
        material.dispose();
      }
    });
  };
  const retry = createMoverRetry(options.retryAfterMs, () => {
    const version = generation;
    load(model.url)
      .then((gltf) => {
        if (disposed || version !== generation) {
          releaseAsset(gltf, true);
          return;
        }
        releaseParts();
        const root = gltf.scene;
        root.traverse((child) => {
          for (const material of Array.isArray(child.material)
            ? child.material
            : [child.material])
            if (material)
              for (const value of Object.values(material))
                if (value?.isTexture) textures.add(value);
        });
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
          blendInstanceColor(material, uniforms, Boolean(overlay));
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
          mesh.visible = false;
          const tint = overlay
            ? createModelTint(mesh, uniforms, overlay.uniforms)
            : null;
          if (tint) {
            // Still present in the scene depth and GPU pick registry. Only colour
            // moves to the display pass, where it is toned before raster resolve.
            material.colorWrite = false;
            overlay.add(tint);
          }
          materials.push(material);
          parts.push({ mesh, tint, local: child.matrixWorld.clone() });
          group.meshes.push(mesh);
          group.pickMeshes.push(tint ?? mesh);
        });
        loaded = true;
        retry.succeed();
        releaseAsset(gltf, false);
        if (origin)
          for (const { mesh, tint } of parts) {
            mesh.position.set(origin.x, origin.y, origin.z);
            tint?.position.copy(mesh.position);
          }
        write(0, store.count);
        group.onLoad?.();
        finish();
        onLoad(group.meshes);
      })
      .catch(() => {
        if (disposed || version !== generation) return;
        retry.fail();
        console.warn('[globe] Model asset unavailable');
      });
  });
  retry.start();

  const placeAt = (next) => {
    origin = { x: next.x, y: next.y, z: next.z };
    for (const { mesh, tint } of parts) {
      mesh.position.set(origin.x, origin.y, origin.z);
      tint?.position.copy(mesh.position);
      mesh.updateMatrix();
      mesh.updateMatrixWorld(true);
    }
  };

  return {
    group,
    uniforms,
    ready(index) {
      if (disposed) return false;
      if (index !== undefined) return loaded && current(index);
      for (let at = 0; at < store.count; at++)
        if (!loaded || !current(at)) return false;
      return true;
    },
    failed(index) {
      if (disposed || !retry.failed()) return false;
      if (index !== undefined) return current(index);
      for (let at = 0; at < store.count; at++) if (current(at)) return true;
      return false;
    },
    origin: () => origin,
    /**
     * The drawn radius (px) of an instance at its last write, or null when
     * not known yet (not loaded, no camera): CPU picks check a model hit
     * against it.
     */
    pickRadiusPx: (index) =>
      loaded && index < store.count && drawnPx[index] > 0
        ? drawnPx[index] / 2
        : null,
    commit(range) {
      let changed = false;
      for (let index = 0; index < store.count; index++) {
        if (pickIds.has(index) ? !current(index) : retry.failed())
          changed = true;
        pickIds.set(index, store.pickIds[index]);
      }
      if (changed) {
        generation++;
        loaded = false;
        retry.start();
      }
      if (!origin && store.count > 0)
        placeAt({
          x: store.positions[0],
          y: store.positions[1],
          z: store.positions[2],
        });
      if (range) write(range.from, Math.min(range.to, store.count));
      for (const { mesh, tint } of parts) {
        if (tint) {
          tint.count = store.count;
          tint.visible = loaded && store.count > 0;
        }
        mesh.count = store.count;
        // Retained empty banks must also skip three's material/uniform work.
        mesh.visible = loaded && store.count > 0;
      }
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
      if (disposed) return;
      disposed = true;
      retry.destroy();
      releaseParts();
      finish();
    },
  };
}
