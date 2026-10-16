// The three side of a Navara sprite or point set: one InstancedMesh of a
// unit quad, turned to face the screen and sized in CSS pixels in the
// vertex shader (the size comes from uniforms, not the projection, so the
// pick pass draws the same footprint), rotated by the instance's screen
// angle, textured from the atlas cell (sprites) or drawn as a disc with an
// outline (points), coloured per instance. Instance data lives in
// InstancedBufferAttributes written on commit; hidden instances get scale 0.

import {
  CanvasTexture,
  DoubleSide,
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedMesh,
  MeshBasicMaterial,
  PlaneGeometry,
  SRGBColorSpace,
  Texture,
} from 'three';
import {
  atlasUvRects,
  footprintPerDepth,
  originFor,
  packInstances,
} from './pack.js';

const VERTEX_HEAD = /* glsl */ `
attribute vec4 gevStyle;
attribute vec4 gevColor;
attribute vec4 gevUv;
uniform float uGevSizePx;
uniform float uGevFootprint;
uniform vec4 uGevScaleByDistance;
uniform float uGevHasScaleByDistance;
uniform float uGevDisableWithinM;
uniform float uGevOutlinePx;
varying vec4 vGevColor;
varying vec2 vGevLocal;
varying float vGevOutline;
`;

const VERTEX_PROJECT = /* glsl */ `
vec4 mvCenter = modelViewMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
float gevScale = gevStyle.y;
float gevDistance = length(mvCenter.xyz);
if (uGevHasScaleByDistance > 0.5) {
  float t = clamp(
    (gevDistance - uGevScaleByDistance.x) /
      max(uGevScaleByDistance.z - uGevScaleByDistance.x, 1e-6),
    0.0,
    1.0
  );
  gevScale *= mix(uGevScaleByDistance.y, uGevScaleByDistance.w, t);
}
float gevSizePx = uGevSizePx * gevScale;
float gevCos = cos(gevStyle.x);
float gevSin = sin(gevStyle.x);
vec2 gevCorner = position.xy;
vec2 gevTurned = vec2(
  gevCorner.x * gevCos - gevCorner.y * gevSin,
  gevCorner.x * gevSin + gevCorner.y * gevCos
);
vec4 mvPosition = mvCenter;
mvPosition.xy += gevTurned * gevSizePx * uGevFootprint * max(-mvCenter.z, 0.0);
gl_Position = projectionMatrix * mvPosition;
vGevColor = gevColor;
vGevLocal = gevCorner;
vGevOutline = uGevOutlinePx / max(gevSizePx, 1e-3);
`;

const VERTEX_UV = /* glsl */ `
#include <uv_vertex>
#ifdef USE_MAP
vMapUv = mix(gevUv.xy, gevUv.zw, uv);
#endif
`;

const VERTEX_DEPTH = /* glsl */ `
#include <logdepthbuf_vertex>
#ifdef USE_LOGARITHMIC_DEPTH_BUFFER
if (gevDistance < uGevDisableWithinM) vFragDepth = 1.0;
#endif
`;

const FRAGMENT_HEAD = /* glsl */ `
varying vec4 vGevColor;
varying vec2 vGevLocal;
varying float vGevOutline;
`;

const fragmentColor = (point) =>
  point
    ? /* glsl */ `
#include <color_fragment>
float gevRadius = length(vGevLocal) * 2.0;
if (gevRadius > 1.0) discard;
diffuseColor *= vGevColor;
if (gevRadius > 1.0 - vGevOutline) diffuseColor.rgb = vec3(0.0);
`
    : /* glsl */ `
#include <color_fragment>
diffuseColor *= vGevColor;
`;

/** Patches three's MeshBasicMaterial shaders into the screen-space quad. */
export function patchMoverShader(shader, uniforms, { point = false } = {}) {
  Object.assign(shader.uniforms, uniforms);
  const replace = (source, from, to) => {
    if (!source.includes(from))
      throw new Error(`Mover shader: three has no ${from}`);
    return source.replace(from, to);
  };
  let vertex = replace(
    shader.vertexShader,
    'void main() {',
    `${VERTEX_HEAD}\nvoid main() {`,
  );
  vertex = replace(vertex, '#include <project_vertex>', VERTEX_PROJECT);
  vertex = replace(vertex, '#include <uv_vertex>', VERTEX_UV);
  vertex = replace(vertex, '#include <logdepthbuf_vertex>', VERTEX_DEPTH);
  let fragment = replace(
    shader.fragmentShader,
    'void main() {',
    `${FRAGMENT_HEAD}\nvoid main() {`,
  );
  fragment = replace(
    fragment,
    '#include <color_fragment>',
    fragmentColor(point),
  );
  shader.vertexShader = vertex;
  shader.fragmentShader = fragment;
  return shader;
}

/** The atlas as a three texture (a canvas at once, a URL once loaded). */
function atlasTexture(atlas, onLoad) {
  if (atlas.canvas) {
    const texture = new CanvasTexture(atlas.canvas);
    texture.colorSpace = SRGBColorSpace;
    return texture;
  }
  const texture = new Texture();
  texture.colorSpace = SRGBColorSpace;
  const image = new Image();
  image.crossOrigin = 'anonymous';
  image.onload = () => {
    texture.image = image;
    texture.needsUpdate = true;
    onLoad();
  };
  image.src = atlas.url;
  return texture;
}

/**
 * @param {ReturnType<import('../../movers.js').normalizeMoverSetOptions>} options
 * @param {ReturnType<import('../../movers.js').createMoverStore>} store
 * @param {{ onTextureLoad?: () => void }} [hooks]
 */
export function createMoverMesh(
  options,
  store,
  { onTextureLoad = () => {} } = {},
) {
  const { capacity, kind, depthTest } = options;
  const point = kind === 'point';
  const style = point ? options.point : options.sprite;
  const geometry = new PlaneGeometry(1, 1);
  const attribute = (name, size) => {
    const value = new InstancedBufferAttribute(
      new Float32Array(capacity * size),
      size,
    );
    value.setUsage(DynamicDrawUsage);
    geometry.setAttribute(name, value);
    return value;
  };
  const styleAttribute = attribute('gevStyle', 4);
  const colorAttribute = attribute('gevColor', 4);
  const uvAttribute = attribute('gevUv', 4);
  const uvRects = point
    ? null
    : atlasUvRects(options.sprite.atlas.cells, options.cellKeys);
  const sbd = style.scaleByDistance;
  const uniforms = {
    uGevSizePx: { value: style.sizePx },
    uGevFootprint: { value: 0 },
    uGevScaleByDistance: { value: sbd ? [...sbd] : [0, 1, 1, 1] },
    uGevHasScaleByDistance: { value: sbd ? 1 : 0 },
    uGevDisableWithinM: {
      value: typeof depthTest === 'object' ? depthTest.disableWithinM : -1,
    },
    uGevOutlinePx: { value: point ? options.point.outlinePx : 0 },
  };
  const material = new MeshBasicMaterial({
    map: point ? null : atlasTexture(options.sprite.atlas, onTextureLoad),
    transparent: true,
    alphaTest: 0.02,
    depthTest: depthTest !== 'always',
    depthWrite: false,
    side: DoubleSide,
  });
  material.onBeforeCompile = (shader) =>
    patchMoverShader(shader, uniforms, { point });
  material.customProgramCacheKey = () => `gev-mover-${kind}`;
  const mesh = new InstancedMesh(geometry, material, capacity);
  mesh.instanceMatrix.setUsage(DynamicDrawUsage);
  mesh.frustumCulled = false;
  mesh.renderOrder = options.order;
  mesh.count = 0;
  let origin = null;
  const out = {
    matrices: mesh.instanceMatrix.array,
    style: styleAttribute.array,
    colors: colorAttribute.array,
    uvs: uvAttribute.array,
  };
  const upload = (from, to) => {
    packInstances(store, from, to, origin, uvRects, out);
    for (const [value, size] of [
      [mesh.instanceMatrix, 16],
      [styleAttribute, 4],
      [colorAttribute, 4],
      [uvAttribute, 4],
    ]) {
      value.clearUpdateRanges();
      value.addUpdateRange(from * size, (to - from) * size);
      value.needsUpdate = true;
    }
  };
  const placeAt = (next) => {
    origin = { x: next.x, y: next.y, z: next.z };
    mesh.position.set(origin.x, origin.y, origin.z);
    mesh.updateMatrix();
    mesh.updateMatrixWorld(true);
  };
  return {
    mesh,
    uniforms,
    origin: () => origin,
    /** Writes the changed instances; the origin starts at the first one. */
    commit(range) {
      if (!origin && store.count > 0)
        placeAt({
          x: store.positions[0],
          y: store.positions[1],
          z: store.positions[2],
        });
      mesh.count = store.count;
      if (range && origin) {
        const to = Math.min(range.to, store.count);
        if (to > range.from) upload(range.from, to);
      }
    },
    /**
     * Once per drawn frame: the pixel footprint from the camera, and the
     * origin moved to the camera when it has gone too far (a full rewrite).
     * Returns true when it rewrote the instances.
     */
    update({ cameraPosition, cameraHeight, fovDeg, viewportHeightPx }) {
      uniforms.uGevFootprint.value = footprintPerDepth(
        fovDeg,
        viewportHeightPx,
      );
      if (!origin || store.count === 0) return false;
      const next = originFor(cameraPosition, origin, cameraHeight);
      if (next === origin) return false;
      placeAt(next);
      upload(0, store.count);
      return true;
    },
    dispose() {
      geometry.dispose();
      material.map?.dispose();
      material.dispose();
      mesh.dispose?.();
    },
  };
}
