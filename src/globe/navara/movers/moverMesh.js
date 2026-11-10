// The three side of a Navara sprite or point set: one InstancedMesh of a
// unit quad, turned to face the screen and sized in CSS pixels in the
// vertex shader (the size comes from uniforms, not the projection, so the
// pick pass draws the same footprint), rotated by the instance's screen
// angle, textured from the atlas cell (sprites) or drawn as a disc with an
// outline (points), coloured per instance. Instance data lives in
// InstancedBufferAttributes written on commit; hidden instances get scale 0.

import {
  CanvasTexture,
  DynamicDrawUsage,
  FrontSide,
  InstancedBufferAttribute,
  InstancedMesh,
  LinearFilter,
  MeshBasicMaterial,
  PlaneGeometry,
  SRGBColorSpace,
  NoColorSpace,
  Texture,
} from 'three';
import {
  atlasUvRects,
  footprintPerDepth,
  originFor,
  packInstances,
} from './pack.js';
import {
  OVERLAY_DEPTH_FRAGMENT,
  OVERLAY_DEPTH_MODES,
  OVERLAY_DEPTH_VERTEX,
} from '../overlayDepth.js';
import { DETACHED_SONAR, SONAR_VERTEX } from '../sonar.js';
import { createMoverRetry } from '../../movers.js';

const VERTEX_HEAD = /* glsl */ `
attribute vec4 gevStyle;
attribute vec4 gevColor;
#ifdef GEV_POINT
attribute vec4 gevOutlineColor;
varying vec4 vGevOutlineColor;
#endif
attribute vec4 gevUv;
uniform float uGevSizePx;
uniform float uGevFootprint;
uniform vec4 uGevScaleByDistance;
uniform float uGevHasScaleByDistance;
uniform vec4 uGevTranslucencyByDistance;
uniform float uGevDisableWithinM;
uniform float uGevOutlinePx;
uniform float uGevPixelRatio;
varying vec4 vGevColor;
varying vec2 vGevLocal;
varying float vGevOutline;
varying float vGevPixelDistance;
varying float vGevTranslucency;
varying float vGevSonarFactor;
uniform vec2 uGevResolution;
${OVERLAY_DEPTH_VERTEX}
${SONAR_VERTEX}
`;

const VERTEX_PROJECT = /* glsl */ `
vec4 mvCenter = modelViewMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
float gevScale = gevStyle.y;
float gevDistanceScale = 1.0;
float gevDistance = length(mvCenter.xyz);
float gevAlphaNearSq = uGevTranslucencyByDistance.x * uGevTranslucencyByDistance.x;
float gevAlphaFarSq = uGevTranslucencyByDistance.z * uGevTranslucencyByDistance.z;
float gevAlphaT = pow(clamp(
  (gevDistance * gevDistance - gevAlphaNearSq) / max(gevAlphaFarSq - gevAlphaNearSq, 1e-6),
  0.0, 1.0
), 0.2);
vGevTranslucency = mix(uGevTranslucencyByDistance.y, uGevTranslucencyByDistance.w, gevAlphaT);
if (uGevHasScaleByDistance > 0.5) {
  // Cesium's czm_nearFarScalar: over the squared distance, eased by ^0.2.
  float gevNearSq = uGevScaleByDistance.x * uGevScaleByDistance.x;
  float gevFarSq = uGevScaleByDistance.z * uGevScaleByDistance.z;
  float t = clamp(
    (gevDistance * gevDistance - gevNearSq) / max(gevFarSq - gevNearSq, 1e-6),
    0.0,
    1.0
  );
  t = pow(t, 0.2);
  gevDistanceScale = mix(uGevScaleByDistance.y, uGevScaleByDistance.w, t);
  gevScale *= gevDistanceScale;
}
float gevSizePx = uGevSizePx * gevScale;
vGevOutline = 0.0;
vGevPixelDistance = 0.0;
#ifdef GEV_POINT
vGevOutlineColor = gevOutlineColor;
float gevBorderPx = 2.0 * uGevOutlinePx * gevDistanceScale;
float gevOutlinedSize = gevSizePx + gevBorderPx;
vGevOutline = gevBorderPx / max(gevOutlinedSize, 1e-3);
// Cesium reserves three physical pixels for the point's smooth edge.
gevSizePx = gevOutlinedSize + 3.0 / uGevPixelRatio;
vGevPixelDistance = 2.0 / max(gevSizePx * uGevPixelRatio, 1e-3);
if (gevStyle.y <= 0.0) gevSizePx = 0.0;
#endif
vec2 gevCorner = position.xy;
vec2 gevTurned = vec2(
  gevCorner.x * gevStyle.z - gevCorner.y * gevStyle.w,
  gevCorner.x * gevStyle.w + gevCorner.y * gevStyle.z
);
vec4 mvPosition = mvCenter;
mvPosition.xy += gevTurned * gevSizePx * uGevFootprint * max(-mvCenter.z, 0.0);
gl_Position = projectionMatrix * mvPosition;
// The Cyber sonar (sonar.js): by the anchor's place on screen, never the
// corner's, so a contact is treated whole; the position stays as it is.
vGevSonarFactor = gevSonarFactor(projectionMatrix * mvCenter, uGevResolution);
vGevColor = gevSonarColor(gevColor, vGevSonarFactor);
vGevLocal = gevCorner;
#ifndef GEV_ALWAYS_VISIBLE
vGevDepthFree = gevDistance < uGevDisableWithinM ? 1.0 : 0.0;
#endif
`;

const VERTEX_UV = /* glsl */ `
#include <uv_vertex>
#ifdef USE_MAP
vMapUv = mix(gevUv.xy, gevUv.zw, uv);
#endif
`;

const FRAGMENT_HEAD = /* glsl */ `
#ifdef GEV_POINT
varying vec4 vGevOutlineColor;
#endif
varying vec4 vGevColor;
varying vec2 vGevLocal;
varying float vGevOutline;
varying float vGevPixelDistance;
varying float vGevTranslucency;
varying float vGevSonarFactor;
${OVERLAY_DEPTH_FRAGMENT}
`;

// Instance colours are sRGB (as Cesium takes them) and the overlay output
// encodes linear to sRGB, so they are decoded first (the atlas is an sRGB
// texture, decoded by the sampler): grey 0.5 draws 128, not 187.
const fragmentColor = (point) =>
  point
    ? /* glsl */ `
#include <color_fragment>
if (gevOverlayHidden()) discard;
float gevRadius = length(vGevLocal) * 2.0;
if (gevRadius > 1.0) discard;
float gevMaxDistance = max(0.0, 0.5 - vGevPixelDistance);
float gevDistanceToCenter = gevRadius * 0.5;
float gevWholeAlpha = 1.0 - smoothstep(gevMaxDistance, 0.5, gevDistanceToCenter);
float gevInner = 1.0 - vGevOutline;
float gevInnerAlpha = 1.0 - smoothstep(gevMaxDistance * gevInner, 0.5 * gevInner, gevDistanceToCenter);
vec4 gevOutline = vec4(vGevOutlineColor.rgb, vGevOutlineColor.a * vGevSonarFactor);
diffuseColor *= sRGBTransferEOTF(mix(gevOutline, vGevColor, gevInnerAlpha));
diffuseColor.a *= gevWholeAlpha * vGevTranslucency;
if (diffuseColor.a < 0.005) discard;
`
    : /* glsl */ `
#include <color_fragment>
if (gevOverlayHidden()) discard;
diffuseColor *= sRGBTransferEOTF(vGevColor);
`;

// Overlay uniforms of a mesh drawn outside an overlay (tests): no depth.
const DETACHED_OVERLAY = Object.freeze({
  tGevSceneDepth: { value: null },
  uGevResolution: { value: [0, 0] },
  uGevDisplayBlend: { value: 0 },
});

/** Patches three's MeshBasicMaterial shaders into the screen-space quad. */
export function patchMoverShader(
  shader,
  uniforms,
  { point = false, encodedAtlas = false, alwaysVisible = false } = {},
) {
  Object.assign(shader.uniforms, uniforms);
  const replace = (source, from, to) => {
    if (!source.includes(from))
      throw new Error(`Mover shader: three has no ${from}`);
    return source.replace(from, to);
  };
  let vertex = replace(
    shader.vertexShader,
    'void main() {',
    `${point ? '#define GEV_POINT\n' : ''}${alwaysVisible ? '#define GEV_ALWAYS_VISIBLE\n' : ''}${VERTEX_HEAD}\nvoid main() {`,
  );
  vertex = replace(vertex, '#include <project_vertex>', VERTEX_PROJECT);
  vertex = replace(vertex, '#include <uv_vertex>', VERTEX_UV);
  let fragment = replace(
    shader.fragmentShader,
    'void main() {',
    `${point ? '#define GEV_POINT\n' : ''}${FRAGMENT_HEAD}\nvoid main() {`,
  );
  let colorFragment = fragmentColor(point);
  if (alwaysVisible)
    colorFragment = replace(
      colorFragment,
      'if (gevOverlayHidden()) discard;',
      '',
    );
  fragment = replace(fragment, '#include <color_fragment>', colorFragment);
  fragment = replace(
    fragment,
    '#include <colorspace_fragment>',
    'gl_FragColor=gevOverlayDisplayColor(gl_FragColor);\n#include <colorspace_fragment>',
  );
  if (encodedAtlas)
    fragment = replace(
      fragment,
      '#include <map_fragment>',
      '#include <map_fragment>\ndiffuseColor.rgb = sRGBTransferEOTF(vec4(diffuseColor.rgb, 1.0)).rgb;',
    );
  shader.vertexShader = vertex;
  shader.fragmentShader = fragment;
  return shader;
}
// Sampled as Cesium samples its billboard atlas: linear, no mipmaps (a
// mipmapped atlas greys small glyphs that Cesium draws at full colour).
function cesiumSampling(texture, encoded = false) {
  // Native FIRMS filters its original encoded PNG colors before display blending.
  texture.colorSpace = encoded ? NoColorSpace : SRGBColorSpace;
  texture.generateMipmaps = false;
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  return texture;
}

/** The atlas as a three texture (a canvas at once, a URL once loaded). */
function atlasTexture(atlas, encoded, onLoad, onError) {
  if (atlas.canvas)
    return cesiumSampling(new CanvasTexture(atlas.canvas), encoded);
  const texture = cesiumSampling(new Texture(), encoded);
  const image = new Image();
  image.crossOrigin = 'anonymous';
  const release = () => {
    image.onload = image.onerror = null;
    texture.image = null;
    texture.removeEventListener('dispose', release);
  };
  texture.addEventListener('dispose', release);
  image.onload = () => {
    image.onload = image.onerror = null;
    texture.image = image;
    texture.needsUpdate = true;
    onLoad();
  };
  image.onerror = () => {
    image.onload = image.onerror = null;
    onError();
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
  { onTextureLoad = () => {}, overlayUniforms = DETACHED_OVERLAY } = {},
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
  const outlineAttribute = point ? attribute('gevOutlineColor', 4) : null;
  const uvRects = point
    ? null
    : atlasUvRects(options.sprite.atlas.cells, options.cellKeys);
  const sbd = style.scaleByDistance;
  const uniforms = {
    uGevSizePx: { value: style.sizePx },
    uGevFootprint: { value: 0 },
    uGevScaleByDistance: { value: sbd ? [...sbd] : [0, 1, 1, 1] },
    uGevHasScaleByDistance: { value: sbd ? 1 : 0 },
    uGevTranslucencyByDistance: {
      value: style.translucencyByDistance ?? [0, 1, 1, 1],
    },
    uGevDisableWithinM: {
      value: typeof depthTest === 'object' ? depthTest.disableWithinM : -1,
    },
    uGevOutlinePx: { value: point ? options.point.outlinePx : 0 },
    uGevPixelRatio: { value: 1 },
    uGevDepthMode: {
      value:
        depthTest === 'always'
          ? OVERLAY_DEPTH_MODES.always
          : OVERLAY_DEPTH_MODES.normal,
    },
    // Shared by every overlay: the scene depth and the target's size.
    tGevSceneDepth: overlayUniforms.tGevSceneDepth,
    uGevResolution: overlayUniforms.uGevResolution,
    uGevDisplayBlend:
      overlayUniforms.uGevDisplayBlend ?? DETACHED_OVERLAY.uGevDisplayBlend,
    // Shared by every overlay of the view: the Cyber sonar (sonar.js).
    uGevSonar: overlayUniforms.uGevSonar ?? DETACHED_SONAR.uGevSonar,
    uGevSonarSector:
      overlayUniforms.uGevSonarSector ?? DETACHED_SONAR.uGevSonarSector,
    uGevSonarEnabled:
      overlayUniforms.uGevSonarEnabled ?? DETACHED_SONAR.uGevSonarEnabled,
  };
  // A canvas atlas is there at once; a URL one once its image loads.
  let textureReady = point || Boolean(options.sprite.atlas.canvas);
  const encodedAtlas = !point && options.sharpen === true;
  const material = new MeshBasicMaterial({
    map: null,
    transparent: true,
    alphaTest: point || encodedAtlas ? 0.005 : 0.02,
    // Drawn after tone mapping, with no depth buffer: the shader tests the
    // scene depth itself (overlayDepth.js).
    depthTest: false,
    depthWrite: false,
    side: FrontSide,
  });
  const retry = createMoverRetry(options.retryAfterMs, () => {
    material.map?.dispose();
    material.map = atlasTexture(
      options.sprite.atlas,
      encodedAtlas,
      () => {
        textureReady = true;
        retry.succeed();
        onTextureLoad();
      },
      () => retry.fail(),
    );
    material.needsUpdate = true;
  });
  if (!point) retry.start();
  material.onBeforeCompile = (shader) =>
    patchMoverShader(shader, uniforms, {
      point,
      encodedAtlas,
      alwaysVisible: depthTest === 'always',
    });
  material.customProgramCacheKey = () =>
    `gev-mover-${kind}${encodedAtlas ? '-encoded-atlas' : ''}${depthTest === 'always' ? '-always-visible' : ''}`;
  const mesh = new InstancedMesh(geometry, material, capacity);
  mesh.userData.gevStaticSprite =
    kind === 'sprite' &&
    options.sharpen &&
    depthTest === 'always' &&
    !style.scaleByDistance;
  mesh.instanceMatrix.setUsage(DynamicDrawUsage);
  mesh.frustumCulled = false;
  mesh.renderOrder = options.order;
  mesh.count = 0;
  let origin = null;
  const out = {
    matrices: mesh.instanceMatrix.array,
    style: styleAttribute.array,
    colors: colorAttribute.array,
    outlineColors: outlineAttribute?.array,
    uvs: uvAttribute.array,
  };
  const upload = (from, to) => {
    packInstances(store, from, to, origin, uvRects, out);
    for (const [value, size] of [
      [mesh.instanceMatrix, 16],
      [styleAttribute, 4],
      [colorAttribute, 4],
      [uvAttribute, 4],
      ...(outlineAttribute ? [[outlineAttribute, 4]] : []),
    ]) {
      // Ranges add up until three uploads them (and clears them): a
      // partial commit after a full rewrite in the same frame (an origin
      // move) must not drop the rewrite — sprites drew offset by the move.
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
  let previousCamera = null;
  return {
    mesh,
    uniforms,
    ready: () => textureReady,
    failed: retry.failed,
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
    update({
      cameraPosition,
      cameraHeight,
      fovDeg,
      viewportHeightPx,
      pixelRatio = 1,
    }) {
      if (
        previousCamera &&
        previousCamera.x === cameraPosition.x &&
        previousCamera.y === cameraPosition.y &&
        previousCamera.z === cameraPosition.z &&
        previousCamera.height === cameraHeight &&
        previousCamera.fov === fovDeg &&
        previousCamera.viewportHeight === viewportHeightPx &&
        previousCamera.pixelRatio === pixelRatio
      )
        return false;
      previousCamera = {
        x: cameraPosition.x,
        y: cameraPosition.y,
        z: cameraPosition.z,
        height: cameraHeight,
        fov: fovDeg,
        viewportHeight: viewportHeightPx,
        pixelRatio,
      };
      uniforms.uGevPixelRatio.value = pixelRatio;
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
      retry.destroy();
      geometry.dispose();
      material.map?.dispose();
      material.dispose();
      mesh.dispose?.();
    },
  };
}
