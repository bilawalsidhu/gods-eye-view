// The three side of a Navara line: a ribbon of one quad per segment whose
// vertices are pushed apart in the vertex shader to the line's width in CSS
// pixels (projected ends, the screen-space normal), so the width holds at any
// distance. Drawn after tone mapping (overlay.js) with the depth test in the
// shader (overlayDepth.js); a second copy of the ribbon, drawn only where the
// scene hides it with the alpha scaled, is depthFailAlpha. Dashes in CSS
// pixels are cut in the fragment shader along the segment's screen
// direction (as Cesium's PolylineDash; gl_FragCoord over the pixel ratio, so
// the period is the same on any screen); the tactical dash is the launches'
// pattern over the fraction along the whole line. Positions are relative to
// the first point (the group sits there, in doubles), the model matrix
// multiplies the group's transform (an orbit ring turned by GMST).

import {
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  Group,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
} from 'three';
import {
  OVERLAY_DEPTH_FRAGMENT,
  OVERLAY_DEPTH_MODES,
  OVERLAY_DEPTH_VERTEX,
} from '../overlayDepth.js';

const VERTEX_HEAD = /* glsl */ `
attribute vec3 gevEnd;
attribute vec2 gevSide;
attribute float gevS;
#ifdef GEV_SEGMENTS
attribute vec4 gevColor;
attribute float gevWidth;
varying vec4 vGevColor;
#endif
uniform vec2 uGevViewport;
uniform float uGevWidthPx;
varying float vGevS;
varying float vGevT;
varying vec2 vGevDirection;
${OVERLAY_DEPTH_VERTEX}
`;

const VERTEX_PROJECT = /* glsl */ `
vec4 gevA = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
vec4 gevB = projectionMatrix * modelViewMatrix * vec4(gevEnd, 1.0);
// Ends behind the camera move along the segment to just in front of it.
const float GEV_NEAR_W = 1e-3;
if (gevA.w < GEV_NEAR_W) gevA = mix(gevA, gevB, (GEV_NEAR_W - gevA.w) / (gevB.w - gevA.w));
if (gevB.w < GEV_NEAR_W) gevB = mix(gevB, gevA, (GEV_NEAR_W - gevB.w) / (gevA.w - gevB.w));
vec2 gevScreenA = gevA.xy / gevA.w * 0.5 * uGevViewport;
vec2 gevScreenB = gevB.xy / gevB.w * 0.5 * uGevViewport;
vec2 gevDirection = gevScreenB - gevScreenA;
gevDirection = length(gevDirection) > 1e-6 ? normalize(gevDirection) : vec2(1.0, 0.0);
vec2 gevNormal = vec2(-gevDirection.y, gevDirection.x);
gl_Position = gevSide.x < 0.5 ? gevA : gevB;
#ifdef GEV_SEGMENTS
vGevColor = gevColor;
gl_Position.xy += gevNormal * gevSide.y * gevWidth / uGevViewport * gl_Position.w;
#else
gl_Position.xy += gevNormal * gevSide.y * uGevWidthPx / uGevViewport * gl_Position.w;
#endif
vec4 mvPosition = modelViewMatrix * vec4(gevSide.x < 0.5 ? position : gevEnd, 1.0);
vGevS = gevS;
vGevT = gevSide.y * 0.5 + 0.5;
vGevDirection = gevDirection;
vGevDepthFree = 0.0;
`;

const FRAGMENT_HEAD = /* glsl */ `
uniform vec4 uGevColor;
#ifdef GEV_SEGMENTS
varying vec4 vGevColor;
#endif
uniform float uGevAlphaScale;
uniform float uGevPixelRatio;
${OVERLAY_DEPTH_FRAGMENT}
uniform float uGevDash;
uniform bool uGevArrow;
uniform vec2 uGevDashPx;
uniform vec2 uGevTactical;
varying float vGevS;
varying float vGevT;
varying vec2 vGevDirection;
float gevTactical() {
  float groupPosition = fract(vGevS * uGevTactical.x);
  float markPosition = groupPosition * (uGevTactical.y + 1.0);
  float markIndex = floor(markPosition);
  float localPosition = fract(markPosition);
  float centerDistance = abs(localPosition - 0.5);
  float edge = max(fwidth(localPosition) * 1.35, 0.012);
  float dashAlong = 1.0 - smoothstep(0.27 - edge, 0.27 + edge, centerDistance);
  float dashAcross = 1.0 - smoothstep(0.12, 0.24, abs(vGevT - 0.5));
  float dotAlong = (localPosition - 0.5) / 0.32;
  float dotAcross = (vGevT - 0.5) / 0.5;
  float dot = 1.0 - smoothstep(0.78, 1.0, length(vec2(dotAlong, dotAcross)));
  float isDot = 1.0 - step(0.5, markIndex);
  return mix(dashAlong * dashAcross, dot, isDot) * mix(0.58, 1.0, isDot);
}
`;

const FRAGMENT_COLOR = /* glsl */ `
#include <color_fragment>
if (gevOverlayHidden()) discard;
// sRGB colours (as Cesium takes them) into the linear output.
#ifdef GEV_SEGMENTS
diffuseColor = sRGBTransferEOTF(vGevColor);
#else
diffuseColor = sRGBTransferEOTF(uGevColor);
#endif
diffuseColor.a *= uGevAlphaScale;
if (uGevArrow) {
  float head = max(fwidth(vGevS) * 10.0 * uGevPixelRatio, 1e-6);
  float halfWidth = vGevS < 1.0 - head ? 0.15 : 0.5 * (1.0 - vGevS) / head;
  float edge = max(fwidth(vGevT), 1e-5);
  diffuseColor.a *= 1.0 - smoothstep(halfWidth - edge, halfWidth + edge, abs(vGevT - 0.5));
}
if (uGevDash > 1.5) {
  diffuseColor.a *= gevTactical();
} else if (uGevDash > 0.5) {
  float gevAlong = dot(gl_FragCoord.xy / uGevPixelRatio, vGevDirection);
  if (mod(gevAlong, uGevDashPx.x + uGevDashPx.y) > uGevDashPx.x) discard;
}
`;

/** Patches three's MeshBasicMaterial shaders into the pixel-width ribbon. */
export function patchLineShader(shader, uniforms) {
  Object.assign(shader.uniforms, uniforms);
  const replace = (source, from, to) => {
    if (!source.includes(from))
      throw new Error(`Line shader: three has no ${from}`);
    return source.replace(from, to);
  };
  shader.vertexShader = replace(
    replace(
      shader.vertexShader,
      'void main() {',
      `${VERTEX_HEAD}\nvoid main() {`,
    ),
    '#include <project_vertex>',
    VERTEX_PROJECT,
  );
  shader.fragmentShader = replace(
    replace(
      shader.fragmentShader,
      'void main() {',
      `${FRAGMENT_HEAD}\nvoid main() {`,
    ),
    '#include <color_fragment>',
    FRAGMENT_COLOR,
  );
  return shader;
}

/**
 * The ribbon geometry of a flat position list, relative to `origin`: per
 * segment 4 vertices (start/end × side) and 2 triangles; `gevS` is the
 * fraction of the line's length at the vertex's end.
 */
export function buildRibbon(flat, origin, items = null) {
  const points = flat.length / 3;
  const segments = items ? items.length : Math.max(0, points - 1);
  const start = new Float32Array(segments * 12);
  const end = new Float32Array(segments * 12);
  const side = new Float32Array(segments * 8);
  const along = new Float32Array(segments * 4);
  const index = new Uint32Array(segments * 6);
  const colors = items ? new Float32Array(segments * 16) : null;
  const widths = items ? new Float32Array(segments * 4) : null;
  const cumulative = new Float64Array(points);
  for (let p = 1; p < points; p++)
    cumulative[p] =
      cumulative[p - 1] +
      Math.hypot(
        flat[p * 3] - flat[p * 3 - 3],
        flat[p * 3 + 1] - flat[p * 3 - 2],
        flat[p * 3 + 2] - flat[p * 3 - 1],
      );
  const total = cumulative[points - 1] || 1;
  for (let s = 0; s < segments; s++) {
    const a = s * (items ? 6 : 3);
    const b = a + 3;
    for (let v = 0; v < 4; v++) {
      const vertex = s * 4 + v;
      for (let k = 0; k < 3; k++) {
        start[vertex * 3 + k] = flat[a + k] - origin[k];
        end[vertex * 3 + k] = flat[b + k] - origin[k];
      }
      const atEnd = v >= 2 ? 1 : 0;
      side[vertex * 2] = atEnd;
      side[vertex * 2 + 1] = v % 2 === 0 ? 1 : -1;
      along[vertex] = items ? atEnd : cumulative[s + atEnd] / total;
      if (items) {
        colors.set(items[s].color, vertex * 4);
        widths[vertex] = items[s].widthPx;
      }
    }
    index.set(
      [s * 4, s * 4 + 1, s * 4 + 2, s * 4 + 2, s * 4 + 1, s * 4 + 3],
      s * 6,
    );
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(start, 3));
  geometry.setAttribute('gevEnd', new BufferAttribute(end, 3));
  geometry.setAttribute('gevSide', new BufferAttribute(side, 2));
  geometry.setAttribute('gevS', new BufferAttribute(along, 1));
  if (items) {
    geometry.setAttribute('gevColor', new BufferAttribute(colors, 4));
    geometry.setAttribute('gevWidth', new BufferAttribute(widths, 1));
  }
  geometry.setIndex(new BufferAttribute(index, 1));
  return geometry;
}

// Overlay uniforms of a line drawn outside an overlay (tests): no depth.
const DETACHED_OVERLAY = Object.freeze({
  tGevSceneDepth: { value: null },
  uGevResolution: { value: [0, 0] },
});

/** @param {ReturnType<import('../../lines.js').normalizeLineOptions>} options */
export function createLineMesh(
  options,
  { overlayUniforms = DETACHED_OVERLAY } = {},
) {
  const dash = options.dash;
  const shared = {
    uGevViewport: { value: [1, 1] },
    uGevPixelRatio: { value: 1 },
    tGevSceneDepth: overlayUniforms.tGevSceneDepth,
    uGevResolution: overlayUniforms.uGevResolution,
    uGevWidthPx: { value: options.widthPx },
    uGevColor: { value: [...options.color] },
    uGevDash: { value: dash?.kind === 'tactical' ? 2 : dash ? 1 : 0 },
    uGevArrow: { value: options.arrow === true },
    uGevDashPx: {
      value: dash?.kind === 'pixels' ? [dash.lengthPx, dash.gapPx] : [1, 0],
    },
    uGevTactical: {
      value: dash?.kind === 'tactical' ? [dash.groups, dash.dashes] : [1, 1],
    },
  };
  const material = (alphaScale, depthMode) => {
    const value = new MeshBasicMaterial({
      transparent: true,
      depthTest: false,
      depthWrite: false,
      side: DoubleSide,
    });
    const uniforms = {
      ...shared,
      uGevAlphaScale: { value: alphaScale },
      uGevDepthMode: { value: depthMode },
    };
    if (options.segments) value.defines = { GEV_SEGMENTS: 1 };
    value.userData.gevDepthMode = depthMode;
    value.onBeforeCompile = (shader) => patchLineShader(shader, uniforms);
    value.customProgramCacheKey = () =>
      options.segments ? 'gev-segments' : 'gev-line';
    return value;
  };
  const group = new Group();
  group.matrixAutoUpdate = false;
  group.frustumCulled = false;
  const main = new Mesh(
    new BufferGeometry(),
    material(1, OVERLAY_DEPTH_MODES.normal),
  );
  main.frustumCulled = false;
  main.renderOrder = options.order;
  group.add(main);
  let behind = null;
  if (options.depthFailAlpha > 0) {
    behind = new Mesh(
      main.geometry,
      material(options.depthFailAlpha, OVERLAY_DEPTH_MODES.fail),
    );
    behind.frustumCulled = false;
    behind.renderOrder = options.order;
    group.add(behind);
  }
  let origin = [0, 0, 0];
  const model = new Matrix4();
  if (options.modelMatrix) model.fromArray(options.modelMatrix);
  const place = () => {
    group.matrix
      .copy(model)
      .multiply(new Matrix4().makeTranslation(origin[0], origin[1], origin[2]));
    group.matrixWorldNeedsUpdate = true;
  };
  place();
  return {
    group,
    uniforms: shared,
    meshes: () => (behind ? [main, behind] : [main]),
    setPositions(flat, items = null) {
      const previous = main.geometry;
      origin = flat.length >= 3 ? [flat[0], flat[1], flat[2]] : [0, 0, 0];
      const geometry = buildRibbon(flat, origin, items);
      main.geometry = geometry;
      if (behind) behind.geometry = geometry;
      previous.dispose();
      place();
    },
    setColor(rgba) {
      shared.uGevColor.value = [...rgba];
    },
    setModelMatrix(matrix) {
      model.fromArray(matrix);
      place();
    },
    show(visible) {
      group.visible = visible;
    },
    /**
     * Each drawn frame: the viewport (CSS px) the width is measured in and
     * the device pixel ratio the dashes are measured with. In place: no
     * allocation per frame.
     */
    update(width, height, pixelRatio = 1) {
      const viewport = shared.uGevViewport.value;
      viewport[0] = width;
      viewport[1] = height;
      shared.uGevPixelRatio.value = pixelRatio;
    },
    dispose() {
      main.geometry.dispose();
      for (const mesh of [main, behind]) mesh?.material.dispose();
    },
  };
}
