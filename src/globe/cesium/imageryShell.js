// A raised imagery layer on Cesium (engine.imagery's `raise`): one
// rectangle primitive at a height above the ellipsoid drawing one image
// and, inside a window of it, an optional detail image. Cesium's imagery
// drapes on the globe and on 3D tiles only, so a raised layer is a
// primitive of its own: flat shaded, alpha blended in the opaque pass
// without depth writes, first in scene.primitives in the engine's draw
// order (later shells draw over earlier ones, every other primitive over
// them), never picked. It rises with the camera (imagery.js raisedLift)
// by a uniform scale about the Earth's centre, which keeps stacked shells
// in their order.

import * as Cesium from 'cesium';
import { raisedLift } from '../imagery.js';

const MATERIAL_TYPE = 'GevRaisedImagery';
// Renders after an image swap: one queues the upload, one uploads and draws, one spare.
const UPLOAD_FRAMES = 3;
// An empty detail window: the image shows everywhere.
const NO_WINDOW = Object.freeze({ west: 0, south: 0, east: -1, north: -1 });
// Cesium binds a 1×1 white texture to an image uniform until its first upload:
// draw nothing until the image has arrived, and sample the detail image only
// once it has arrived. The window is west, south, east, north in the image's
// texture coordinates.
const MATERIAL_SOURCE = `czm_material czm_getMaterial(czm_materialInput materialInput)
{
  czm_material material = czm_getDefaultMaterial(materialInput);
  vec2 st = materialInput.st;
  vec4 coarse = texture(image, st);
  vec2 dst = (st - window.xy) / max(window.zw - window.xy, vec2(1e-6));
  float inside = float(all(greaterThanEqual(st, window.xy)) && all(lessThanEqual(st, window.zw)));
  float useDetail = inside * step(1.5, float(detailDimensions.x));
  vec4 c = mix(coarse, texture(detail, clamp(dst, 0.0, 1.0)), useDetail);
  material.diffuse = czm_gammaCorrect(c.rgb);
  material.alpha = c.a * alpha * step(1.5, float(imageDimensions.x));
  return material;
}
`;
const ranks = new WeakMap();

function registerMaterial() {
  const cache = Cesium.Material._materialCache;
  if (cache.getMaterial(MATERIAL_TYPE)) return;
  // A plain template: building the first material from a fabric would make that
  // instance Cesium's shared template and keep its last image alive.
  cache.addMaterial(MATERIAL_TYPE, {
    fabric: {
      type: MATERIAL_TYPE,
      uniforms: {
        image: Cesium.Material.DefaultImageId,
        detail: Cesium.Material.DefaultImageId,
        alpha: 1,
        window: { type: 'vec4', x: 0, y: 0, z: -1, w: -1 },
      },
      // Diffuse and alpha share these samples, so one source, not components.
      source: MATERIAL_SOURCE,
    },
    translucent: false,
  });
}

const sameEdges = (a, b) =>
  a.west === b.west &&
  a.south === b.south &&
  a.east === b.east &&
  a.north === b.north;

/** Keep the shells first in the primitive collection, by rank: higher ranks
 * draw over lower ones and other opaque content draws over both. */
function orderImageryShells(primitives, primitive, rank) {
  ranks.set(primitive, rank);
  if (typeof primitives.lowerToBottom !== 'function') return;
  const shells = [];
  for (let i = 0; i < primitives.length; i++) {
    const item = primitives.get(i);
    if (ranks.has(item)) shells.push(item);
  }
  const ordered = [...shells].sort((a, b) => ranks.get(a) - ranks.get(b));
  if (ordered.every((item, i) => primitives.get(i) === item)) return;
  for (const item of ordered.reverse()) primitives.lowerToBottom(item);
}

/**
 * One shell over `rectangle` (degrees) at `height` metres, in draw position
 * `rank`. `onSettled()` runs each time the latest image (and detail) has
 * drawn. The owner calls destroy().
 */
export function createImageryShell({
  scene,
  rectangle,
  height,
  rank = 0,
  onSettled = () => {},
}) {
  registerMaterial();
  const primitives = scene.primitives;
  const material = new Cesium.Material({
    fabric: { type: MATERIAL_TYPE },
    translucent: false,
  });
  // Flat shading keeps the image's colours independent of the viewing angle.
  const appearance = new Cesium.EllipsoidSurfaceAppearance({
    aboveGround: true,
    flat: true,
    translucent: false,
    material,
  });
  // Cesium orders its translucent pass itself (weighted OIT or distance), which
  // cannot honour stacked shells. Draw in the opaque pass in scene.primitives
  // order, alpha-blended and without depth writes, so later shells draw over
  // earlier ones and nothing is hidden or picked through a shell.
  appearance.getRenderState = () => ({
    depthTest: { enabled: true },
    depthMask: false,
    blending: Cesium.BlendingState.ALPHA_BLEND,
  });
  const { west, south, east, north } = rectangle;
  const primitive = new Cesium.Primitive({
    geometryInstances: new Cesium.GeometryInstance({
      geometry: new Cesium.RectangleGeometry({
        rectangle: Cesium.Rectangle.fromDegrees(west, south, east, north),
        height,
        granularity: Cesium.Math.toRadians(0.5),
        vertexFormat: Cesium.EllipsoidSurfaceAppearance.VERTEX_FORMAT,
      }),
    }),
    appearance,
    asynchronous: true,
    allowPicking: false,
  });
  primitives.add(primitive);
  orderImageryShells(primitives, primitive, rank);
  let lift = 0;
  const offLift = scene.preRender?.addEventListener(() => {
    const next = raisedLift(scene.camera?.positionCartographic?.height);
    if (next === lift) return;
    lift = next;
    primitive.modelMatrix = Cesium.Matrix4.fromUniformScale(
      1 + lift / Cesium.Ellipsoid.WGS84.maximumRadius,
    );
  });
  let image = null;
  let frames = 0;
  // The detail image, its own upload count and a window waiting for it to draw.
  let detail = null;
  let detailFrames = 0;
  let pendingWindow = null;
  let offRender = null;
  let destroyed = false;

  const fits = (size, value) =>
    !size || (size.x === value.width && size.y === value.height);
  const uploaded = () =>
    image !== null && fits(material.uniforms.imageDimensions, image);
  const detailDrawn = () =>
    detail !== null &&
    detailFrames === 0 &&
    fits(material.uniforms.detailDimensions, detail);
  const drawn = () =>
    primitive.ready &&
    uploaded() &&
    frames === 0 &&
    (detail === null || (detailDrawn() && pendingWindow === null));
  function appliedWindow() {
    const { x, y, z, w } = material.uniforms.window;
    return z < x ? null : { west: x, south: y, east: z, north: w };
  }
  function setWindow(rect) {
    const next = rect ?? NO_WINDOW;
    const { x, y, z, w } = material.uniforms.window;
    if (
      x === next.west &&
      y === next.south &&
      z === next.east &&
      w === next.north
    )
      return;
    material.uniforms.window = new Cesium.Cartesian4(
      next.west,
      next.south,
      next.east,
      next.north,
    );
    scene.requestRender();
  }
  // The render governor may idle the scene; request frames only until the
  // asynchronous geometry is ready and the latest images have been drawn.
  function tick() {
    // Cesium updates a material only while its primitive is shown, so hidden
    // frames upload nothing and count for nothing.
    if (primitive.ready && primitive.show) {
      if (frames > 0) frames--;
      if (detailFrames > 0) detailFrames--;
      // A texture is never shown at another window's place.
      if (pendingWindow && detailDrawn()) {
        setWindow(pendingWindow);
        pendingWindow = null;
      }
    }
    if (primitive.show && !drawn()) {
      scene.requestRender();
      return;
    }
    offRender?.();
    offRender = null;
    if (drawn()) onSettled();
  }
  function wake() {
    if (destroyed || !primitive.show || image === null || drawn()) return;
    offRender ??= scene.postRender.addEventListener(tick);
    scene.requestRender();
  }

  return {
    rectangle,
    /** Draw `next`; Cesium keeps drawing the previous texture until it is uploaded. */
    setImage(next) {
      if (destroyed || next === image) return;
      image = next;
      material.uniforms.image = next;
      frames = UPLOAD_FRAMES;
      wake();
    },
    image: () => image,
    setAlpha(value) {
      if (destroyed || material.uniforms.alpha === value) return;
      material.uniforms.alpha = value;
      scene.requestRender();
    },
    /** Draw `next` inside `rect` (west, south, east, north in the image's
     * texture coordinates, 0–1); null clears it. In the same window only
     * the image changes, and Cesium keeps drawing the previous texture until
     * this one is uploaded. A different window applies once its image has
     * drawn; until then the image covers it. */
    setDetail(next, rect) {
      if (destroyed) return;
      if (!next) {
        if (detail === null) return;
        detail = null;
        detailFrames = 0;
        pendingWindow = null;
        material.uniforms.detail = Cesium.Material.DefaultImageId;
        setWindow(null);
        scene.requestRender();
        return;
      }
      if (next !== detail) {
        detail = next;
        material.uniforms.detail = next;
        detailFrames = UPLOAD_FRAMES;
      }
      const applied = appliedWindow();
      if (applied && sameEdges(applied, rect)) {
        pendingWindow = null;
      } else {
        setWindow(null);
        pendingWindow = rect;
      }
      wake();
    },
    detail: () => detail,
    setShow(value) {
      const show = Boolean(value);
      if (destroyed || primitive.show === show) return;
      primitive.show = show;
      wake();
      scene.requestRender();
    },
    setRank(value) {
      if (!destroyed && !primitives.isDestroyed?.())
        orderImageryShells(primitives, primitive, value);
    },
    drawn,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      offRender?.();
      offRender = null;
      offLift?.();
      if (!primitives.isDestroyed?.() && primitives.contains(primitive))
        primitives.remove(primitive);
      if (!primitive.isDestroyed()) primitive.destroy();
      // Primitive.destroy leaves the material and its texture alive.
      if (!material.isDestroyed()) material.destroy();
      image = null;
      detail = null;
      pendingWindow = null;
      scene.requestRender();
    },
    diagnostics: () => ({
      height,
      ready: Boolean(primitive.ready),
      uploaded: uploaded(),
      show: primitive.show,
      alpha: material.uniforms.alpha,
      rendering: offRender !== null,
      detail: { uploaded: detailDrawn(), window: appliedWindow() },
    }),
  };
}
