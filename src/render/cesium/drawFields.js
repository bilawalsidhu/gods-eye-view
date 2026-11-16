/**
 * @module render/cesium/drawFields
 * @description The Cesium draw port's `field` handles. It draws two kinds:
 * `windStreamlines` (drawStreamlines.js) and `rasterShell`, a raster on a
 * rectangle raised above the ellipsoid, drawn flat in the opaque pass in
 * the scene's primitive order (ascending height), alpha-blended, without
 * depth writes and never picked. Other kinds are refused loudly.
 *
 * Choices the contract leaves open, taken conservatively:
 * - An image is read when it is first named, as a Cesium material reads
 *   one: to show new pixels, name another canvas. URL, SVG and blob images
 *   are decoded before they are handed over, so the frame they replace
 *   stays until they can be drawn; an atlas slot is read as the image it
 *   holds when the field is drawn or updated.
 * - An `update` of `image` alone, inside the same rectangle and height,
 *   swaps the texture on the drawn surface: Cesium keeps drawing the old
 *   one until the new one is uploaded. A new `rectangle` or `heightM` is
 *   built as a second surface, drawn invisibly until its geometry and
 *   images are ready, and then takes the first one's place in one frame.
 * - A `detail` in a new rectangle shows the full image there until the
 *   detail image has drawn, never the old detail at the new place; one in
 *   the same rectangle swaps only the image, the old one drawing until the
 *   new is uploaded.
 * - `liftM` scales the shell about the Earth's centre, so every shell
 *   rises alike and keeps its order.
 */
import * as Cesium from 'cesium';
import { listenerList, uncaught } from './common.js';
import { createWindStreamlines } from './drawStreamlines.js';

const MATERIAL_TYPE = 'DrawRasterShell';
// Renders after an image swap: one queues the upload, one uploads and draws, one spare.
const UPLOAD_FRAMES = 3;
// An empty detail window: the full-extent image shows everywhere.
const NO_WINDOW = Object.freeze({ west: 0, south: 0, east: -1, north: -1 });
const shellHeights = new WeakMap();
// Cesium binds a 1×1 white texture to an image uniform until its first upload:
// draw nothing until the full-extent image has arrived, and sample the detail
// image only once it has arrived. The window is west, south, east, north in the
// full-extent image's texture coordinates.
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

function registerMaterial(cesium) {
  const cache = cesium.Material._materialCache;
  if (cache.getMaterial(MATERIAL_TYPE)) return;
  // A plain template: building the first material from a fabric would make that
  // instance Cesium's shared template and keep its last image alive.
  cache.addMaterial(MATERIAL_TYPE, {
    fabric: {
      type: MATERIAL_TYPE,
      uniforms: {
        image: cesium.Material.DefaultImageId,
        detail: cesium.Material.DefaultImageId,
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

/** Keep raster shells first in the primitive collection, in ascending height:
 * higher shells draw over lower ones and other opaque content draws over both. */
export function orderShells(primitives, primitive, height) {
  shellHeights.set(primitive, height);
  if (typeof primitives.lowerToBottom !== 'function') return;
  const shells = [];
  for (let i = 0; i < primitives.length; i++) {
    const item = primitives.get(i);
    if (shellHeights.has(item)) shells.push(item);
  }
  const ordered = [...shells].sort(
    (a, b) => shellHeights.get(a) - shellHeights.get(b),
  );
  if (ordered.every((item, i) => primitives.get(i) === item)) return;
  for (const item of ordered.reverse()) primitives.lowerToBottom(item);
}

/** One raised rectangle drawing one full-extent image and, inside a window of
 * it, an optional detail image. The owner calls destroy(). `onSettled` is
 * told each time what it was last given has drawn. With `onWake` its owner
 * runs its frames: it is told when the surface needs them, and calls
 * `tick()` after each render while `awake()`; without, it listens itself. */
export function createShellSurface({
  scene,
  cesium = Cesium,
  rectangle,
  height,
  onSettled = () => {},
  onWake = null,
}) {
  registerMaterial(cesium);
  const primitives = scene.primitives;
  // A scene destroyed under it asks for nothing.
  const ask = () => {
    if (!scene.isDestroyed?.()) scene.requestRender();
  };
  const material = new cesium.Material({
    fabric: { type: MATERIAL_TYPE },
    translucent: false,
  });
  // Flat shading keeps the product colours independent of the viewing angle.
  const appearance = new cesium.EllipsoidSurfaceAppearance({
    aboveGround: true,
    flat: true,
    translucent: false,
    material,
  });
  // Cesium orders its translucent pass itself (weighted OIT or distance), which
  // cannot honour stacked heights. Draw in the opaque pass in scene.primitives
  // order, alpha-blended and without depth writes, so higher shells draw over
  // lower ones and nothing is hidden or picked through a shell.
  appearance.getRenderState = () => ({
    depthTest: { enabled: true },
    depthMask: false,
    blending: cesium.BlendingState.ALPHA_BLEND,
  });
  const primitive = new cesium.Primitive({
    geometryInstances: new cesium.GeometryInstance({
      geometry: new cesium.RectangleGeometry({
        rectangle,
        height,
        granularity: cesium.Math.toRadians(0.5),
        vertexFormat: cesium.EllipsoidSurfaceAppearance.VERTEX_FORMAT,
      }),
    }),
    appearance,
    asynchronous: true,
    allowPicking: false,
  });
  primitives.add(primitive);
  orderShells(primitives, primitive, height);
  let lift = 0;
  // What it was given, and what the material draws (`widened`).
  let imageSource = null;
  let image = null;
  let frames = 0;
  // The detail image, its own upload count and a window waiting for it to draw.
  let detailSource = null;
  let detail = null;
  let detailFrames = 0;
  let pendingWindow = null;
  let offRender = null;
  let awake = false;
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
    material.uniforms.window = new cesium.Cartesian4(
      next.west,
      next.south,
      next.east,
      next.north,
    );
    ask();
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
      ask();
      return;
    }
    awake = false;
    offRender?.();
    offRender = null;
    if (drawn()) onSettled();
  }
  function wake() {
    if (destroyed || !primitive.show || image === null || drawn()) return;
    awake = true;
    if (onWake) onWake();
    else offRender ??= scene.postRender.addEventListener(tick);
    ask();
  }

  return {
    setImage(next) {
      if (destroyed || next === imageSource) return;
      imageSource = next;
      image = widened(next);
      material.uniforms.image = image;
      frames = UPLOAD_FRAMES;
      wake();
    },
    setAlpha(value) {
      if (destroyed || material.uniforms.alpha === value) return;
      material.uniforms.alpha = value;
      ask();
    },
    /** Metres the surface rises, by a uniform scale about the Earth's centre. */
    setLift(value) {
      const next = Number(value) || 0;
      if (destroyed || next === lift) return;
      lift = next;
      primitive.modelMatrix = cesium.Matrix4.fromUniformScale(
        1 + lift / cesium.Ellipsoid.WGS84.maximumRadius,
      );
      ask();
    },
    /** Draw `next` inside `rect` (west, south, east, north in the full-extent
     * image's texture coordinates, 0–1); null clears it. In the same window only
     * the image changes, and Cesium keeps drawing the previous texture until
     * this one is uploaded. A different window applies once its image has
     * drawn; until then the full-extent image covers it. */
    setDetail(next, rect) {
      if (destroyed) return;
      if (!next) {
        if (detail === null) return;
        detailSource = null;
        detail = null;
        detailFrames = 0;
        pendingWindow = null;
        material.uniforms.detail = cesium.Material.DefaultImageId;
        setWindow(null);
        ask();
        return;
      }
      if (next !== detailSource) {
        detailSource = next;
        detail = widened(next);
        material.uniforms.detail = detail;
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
    /** Returns whether visibility changed. */
    setShow(value) {
      const show = Boolean(value);
      if (destroyed || primitive.show === show) return false;
      primitive.show = show;
      wake();
      ask();
      return true;
    },
    /** Whether what it was last given has drawn. */
    isDrawn: () => !destroyed && drawn(),
    /** Whether it needs frames until what it was given has drawn. */
    awake: () => awake && !destroyed,
    tick,
    getDiagnostics() {
      return {
        height,
        lift,
        ready: Boolean(primitive.ready),
        uploaded: uploaded(),
        show: primitive.show,
        alpha: material.uniforms.alpha,
        rendering: awake,
        // `uploaded` once the detail image has drawn; the window applies after.
        detail: { uploaded: detailDrawn(), window: appliedWindow() },
      };
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      awake = false;
      offRender?.();
      offRender = null;
      if (!primitives.isDestroyed?.() && primitives.contains(primitive))
        primitives.remove(primitive);
      if (!primitive.isDestroyed()) primitive.destroy();
      // Primitive.destroy leaves the material and its texture alive.
      if (!material.isDestroyed()) material.destroy();
      imageSource = null;
      image = null;
      detailSource = null;
      detail = null;
      pendingWindow = null;
      ask();
    },
  };
}

/** A rectangle's place inside another, in the outer one's texture coordinates. */
function placeIn(outer, inner) {
  const x = outer.east - outer.west;
  const y = outer.north - outer.south;
  return {
    west: (inner.west - outer.west) / x,
    south: (inner.south - outer.south) / y,
    east: (inner.east - outer.west) / x,
    north: (inner.north - outer.south) / y,
  };
}

/**
 * `source`, or a copy two pixels wide when it is one. The material reads a
 * width of 1 as Cesium's 1×1 default (nothing has arrived yet), so a one
 * pixel wide image would never draw. Doubling the column samples the same.
 */
function widened(source) {
  if (source?.width !== 1) return source;
  const canvas =
    typeof document !== 'undefined'
      ? document.createElement('canvas')
      : new OffscreenCanvas(2, source.height);
  canvas.width = 2;
  canvas.height = source.height;
  const context = canvas.getContext('2d');
  context.imageSmoothingEnabled = false;
  context.drawImage(source, 0, 0, 2, source.height);
  return canvas;
}

/** Whether `ref` is drawn as it is, with no decode first. */
const immediate = (ref) => Boolean(ref?.canvas);

/** An image reference decoded into something a material uploads. */
async function decode(ref) {
  if (ref?.atlas)
    throw new TypeError(
      `atlas ${ref.atlas} has no slot ${ref.slot} registered`,
    );
  const url = ref?.blob
    ? URL.createObjectURL(ref.blob)
    : ref?.svg
      ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(ref.svg)}`
      : String(ref);
  try {
    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.src = url;
    await image.decode();
    return image;
  } finally {
    if (ref?.blob) URL.revokeObjectURL(url);
  }
}

/**
 * The fields part of a Cesium draw port.
 * @param {{scene: object, report?: (error: unknown) => void,
 *   cesium?: object, resolveImage?: (ref: unknown) => unknown}} options
 *   `cesium` is for test doubles; `resolveImage` reads an atlas slot as the
 *   image it holds.
 * @returns {{field: (spec: object) => object, has: (id: string) => boolean,
 *   dispose: () => void}}
 */
export function createCesiumFields({
  scene,
  report = uncaught,
  cesium = Cesium,
  resolveImage = (ref) => ref,
}) {
  const fields = new Map();
  const live = () => !scene.isDestroyed?.();
  const requestRender = () => {
    if (live()) scene.requestRender();
  };
  function rasterShell(spec) {
    const id = spec.id;
    // The frame a change was put on the surface, so 'drawn' waits for the
    // render after it. Scenes without a frame state count this field's
    // renders.
    let renders = 0;
    const frameNumber = () => scene.frameState?.frameNumber ?? renders;
    let content = {
      image: spec.image,
      rectangle: { ...spec.rectangle },
      heightM: Number(spec.heightM) || 0,
      detail: spec.detail ? { ...spec.detail } : null,
    };
    let liftM = Number(spec.liftM) || 0;
    let alpha = spec.alpha ?? 1;
    let shown = true;
    let disposed = false;
    // The surface drawn, and one being built for a new rectangle or height.
    let drawing = null;
    let staged = null;
    // Each content change, so a late decode of an older one is dropped.
    let contentSeq = 0;
    let placedSeq = -1;
    // 'drawn' is owed for the latest change, put on the surface at `placedAt`.
    let owed = true;
    let placedAt = Infinity;
    let offRender = null;
    const drawnListeners = listenerList(report);

    const keyOf = (c) =>
      `${c.rectangle.west},${c.rectangle.south},${c.rectangle.east},${c.rectangle.north}|${c.heightM}`;

    function make(c) {
      const entry = { key: keyOf(c), rectangle: c.rectangle, surface: null };
      const { west, south, east, north } = c.rectangle;
      entry.surface = createShellSurface({
        scene,
        cesium,
        rectangle: cesium.Rectangle.fromDegrees(west, south, east, north),
        height: c.heightM,
        onSettled: () => settled(entry),
        onWake: () => watch(),
      });
      entry.surface.setLift(liftM);
      // Staged surfaces draw, invisibly, even while the field is hidden, so
      // the new content is ready when it shows.
      return entry;
    }
    function drop(entry) {
      entry?.surface.destroy();
      return null;
    }
    // A staged surface takes the drawn one's place once it has drawn.
    function settled(entry) {
      if (disposed) return;
      if (entry === staged) {
        drop(drawing);
        drawing = staged;
        staged = null;
        drawing.surface.setAlpha(alpha);
        drawing.surface.setShow(shown);
        // It has drawn already, invisibly, so it shows from the next frame on,
        // the frame the one it replaces stops: told now, so nothing comes
        // between the swap and 'drawn'.
        if (owed && shown && placedSeq === contentSeq) {
          owed = false;
          drawnListeners.fire();
          return;
        }
        placed();
        return;
      }
      // What it last applied (a detail window, say) draws in the next frame.
      if (entry === drawing) placed();
      else watch();
    }
    function placed() {
      placedAt = frameNumber();
      watch();
    }
    function put(entry, c, image, detailImage) {
      entry.surface.setImage(image);
      if (c.detail && detailImage)
        entry.surface.setDetail(
          detailImage,
          placeIn(entry.rectangle, c.detail.rectangle),
        );
      else entry.surface.setDetail(null);
    }
    /** Draw `c` with its images decoded. */
    function place(c, image, detailImage) {
      const key = keyOf(c);
      if (drawing?.key === key) {
        staged = drop(staged);
        put(drawing, c, image, detailImage);
        placed();
        return;
      }
      if (staged?.key !== key) {
        staged = drop(staged);
        staged = make(c);
        // Invisible until it takes the drawn one's place.
        staged.surface.setAlpha(0);
      }
      put(staged, c, image, detailImage);
      // Its own settling promotes it.
      watch();
    }
    function load(c) {
      const seq = (contentSeq += 1);
      const refs = [c.image, c.detail?.image].map((ref) =>
        ref == null ? ref : resolveImage(ref),
      );
      if (refs.every((ref) => ref == null || immediate(ref))) {
        placedSeq = seq;
        place(c, refs[0].canvas, refs[1]?.canvas ?? null);
        return;
      }
      // A stage of older content must not take the drawn one's place while
      // this decodes.
      staged = drop(staged);
      Promise.all(
        refs.map((ref) =>
          ref == null ? null : immediate(ref) ? ref.canvas : decode(ref),
        ),
      ).then(
        ([image, detailImage]) => {
          if (disposed || seq !== contentSeq || !live()) return;
          placedSeq = seq;
          place(c, image, detailImage);
        },
        (error) => {
          // What it drew stays.
          if (disposed || seq !== contentSeq) return;
          report(error);
          if (!busy()) unwatch();
        },
      );
    }

    // One listener runs the surfaces' frames and tells 'drawn'.
    const busy = () =>
      Boolean(drawing?.surface.awake() || staged?.surface.awake());
    function notify() {
      if (!owed || !shown || staged || placedSeq !== contentSeq || !drawing)
        return;
      if (!drawing.surface.isDrawn()) return;
      // A frame number that has moved on (it wraps) has drawn the change.
      if (frameNumber() === placedAt) {
        requestRender();
        return;
      }
      owed = false;
      drawnListeners.fire();
    }
    function tick() {
      renders += 1;
      for (const entry of [drawing, staged])
        if (entry?.surface.awake()) entry.surface.tick();
      if (!disposed) notify();
      if (disposed || (!busy() && !(owed && shown))) unwatch();
    }
    function watch() {
      if (disposed || (!(owed && shown) && !busy())) return;
      offRender ??= scene.postRender.addEventListener(tick);
      requestRender();
    }
    function unwatch() {
      offRender?.();
      offRender = null;
    }

    const handle = {
      id,
      get show() {
        return shown;
      },
      set show(value) {
        const next = Boolean(value);
        if (disposed || next === shown) return;
        shown = next;
        drawing?.surface.setShow(shown);
        // A stage in progress keeps building, so it is ready when shown.
        if (shown) watch();
        else if (!busy()) unwatch();
        requestRender();
      },
      update(patch = {}) {
        if (disposed) return;
        if (patch.kind !== undefined && patch.kind !== 'rasterShell')
          throw new TypeError('a field keeps its kind');
        const next = { ...content };
        let reload = false;
        if ('image' in patch && patch.image !== content.image) {
          next.image = patch.image;
          reload = true;
        }
        if (patch.rectangle && !sameEdges(patch.rectangle, content.rectangle)) {
          next.rectangle = { ...patch.rectangle };
          reload = true;
        }
        if ('heightM' in patch && Number(patch.heightM) !== content.heightM) {
          next.heightM = Number(patch.heightM) || 0;
          reload = true;
        }
        if ('detail' in patch) {
          const was = content.detail;
          const now = patch.detail ? { ...patch.detail } : null;
          if (
            (was === null) !== (now === null) ||
            (now &&
              (now.image !== was.image ||
                !sameEdges(now.rectangle, was.rectangle)))
          ) {
            next.detail = now;
            reload = true;
          }
        }
        if ('liftM' in patch) {
          liftM = Number(patch.liftM) || 0;
          drawing?.surface.setLift(liftM);
          staged?.surface.setLift(liftM);
        }
        if ('alpha' in patch) {
          alpha = patch.alpha ?? 1;
          drawing?.surface.setAlpha(alpha);
        }
        owed = true;
        content = next;
        if (reload) load(content);
        else placed();
        requestRender();
      },
      on(event, cb) {
        if (event !== 'drawn') return () => {};
        return drawnListeners.on(cb);
      },
      dispose() {
        if (disposed) return;
        disposed = true;
        unwatch();
        drawnListeners.clear();
        drawing = drop(drawing);
        staged = drop(staged);
        if (fields.get(id) === handle) fields.delete(id);
      },
    };
    fields.set(id, handle);
    load(content);
    return handle;
  }

  // Once the fields are disposed (their renderer destroyed), a field asked
  // for draws nothing and does nothing.
  let gone = false;
  const inert = (spec) => ({
    id: spec?.id,
    show: true,
    update() {},
    on: () => () => {},
    dispose() {},
  });

  return {
    field(spec) {
      if (gone) return inert(spec);
      if (fields.has(spec?.id))
        throw new Error(`a field with id ${spec.id} is live`);
      if (spec?.kind === 'rasterShell') return rasterShell(spec);
      if (spec?.kind === 'windStreamlines') {
        const handle = createWindStreamlines({
          scene,
          spec,
          report,
          cesium,
          onDispose: () => {
            if (fields.get(spec.id) === handle) fields.delete(spec.id);
          },
        });
        fields.set(spec.id, handle);
        return handle;
      }
      throw new TypeError(
        `the Cesium renderer draws no ${spec?.kind} fields yet`,
      );
    },
    has: (id) => fields.has(id),
    dispose() {
      gone = true;
      for (const handle of [...fields.values()]) handle.dispose();
    },
  };
}
