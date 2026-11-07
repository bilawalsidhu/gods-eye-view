/**
 * @module render/cesium/ports
 * @description The Cesium renderer's contract ports, built over a Cesium
 * widget or viewer someone else made and configured: frame phases, the
 * draw sets, `setView` and the pose, picks and projection, credits,
 * quality and capture.
 * Building them puts the loop on demand (no holds yet, and no redraws for
 * scene time alone); nothing else in the scene changes until a call.
 *
 * The conformance renderer (`sceneRenderer.js`) and the application's
 * renderer (`appRenderer.js`) both use them, so what conformance
 * checks is what the application runs. Members a port does not have are
 * absent, never stubbed.
 */
import * as Cesium from 'cesium';
import { heightsFor } from '../../queries/heights.js';
import { createCesiumCamera } from './camera.js';
import { listenerList, toCartesian, uncaught } from './common.js';
import { createCesiumCredits } from './credits.js';
import { createCesiumEffects } from './effects.js';
import { createCesiumQuality } from './quality.js';
import {
  atEndOfTick,
  billboardLoadError,
  lastRenderTime,
  lastSeenCamera,
  renderPending,
} from './internals.js';

export { listenerList, toCartesian };

/** The contract's colour as Cesium's. */
export function toColor(color, alpha = 1) {
  if (color === undefined || color === null)
    return Cesium.Color.WHITE.withAlpha(alpha);
  const c =
    typeof color === 'string'
      ? Cesium.Color.fromCssColorString(color)
      : new Cesium.Color(color[0], color[1], color[2], color[3] ?? 1);
  return c.withAlpha(c.alpha * alpha);
}

/** An image reference as something a billboard takes. */
export function toImage(image) {
  if (typeof image === 'string') return image;
  if (image?.svg)
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(image.svg)}`;
  if (image?.canvas) return image.canvas;
  throw new Error('the Cesium renderer takes URL, SVG and canvas images only');
}

const ANCHORS = {
  center: Cesium.VerticalOrigin.CENTER,
  bottom: Cesium.VerticalOrigin.BOTTOM,
  top: Cesium.VerticalOrigin.TOP,
};

const scratchPosition0 = new Cesium.Cartesian3();
const scratchPosition1 = new Cesium.Cartesian3();

/** Cesium's own test (`View.js`) for whether the camera moved. */
function cameraEqual(camera0, camera1, epsilon) {
  const maximumPositionComponent = Math.max(
    Cesium.Cartesian3.maximumComponent(
      Cesium.Cartesian3.abs(camera0.position, scratchPosition0),
    ),
    Cesium.Cartesian3.maximumComponent(
      Cesium.Cartesian3.abs(camera1.position, scratchPosition1),
    ),
  );
  const scalar = 1 / Math.max(1, maximumPositionComponent);
  Cesium.Cartesian3.multiplyByScalar(
    camera0.position,
    scalar,
    scratchPosition0,
  );
  Cesium.Cartesian3.multiplyByScalar(
    camera1.position,
    scalar,
    scratchPosition1,
  );
  return (
    Cesium.Cartesian3.equalsEpsilon(
      scratchPosition0,
      scratchPosition1,
      epsilon,
    ) &&
    Cesium.Cartesian3.equalsEpsilon(
      camera0.direction,
      camera1.direction,
      epsilon,
    ) &&
    Cesium.Cartesian3.equalsEpsilon(camera0.up, camera1.up, epsilon) &&
    Cesium.Cartesian3.equalsEpsilon(camera0.right, camera1.right, epsilon) &&
    Cesium.Matrix4.equalsEpsilon(
      camera0.transform,
      camera1.transform,
      epsilon,
    ) &&
    camera0.frustum.equalsEpsilon(camera1.frustum, epsilon)
  );
}

/**
 * What a Cesium scene can do, as contract capabilities; `only` limits them
 * to those it lists. Depth picks, height samples and ray casts all need
 * depth textures, which `sampleHeightSupported` and `pickPositionSupported`
 * report. Styles, bloom and sharpen are post-process stages every scene
 * runs.
 * @param {object} scene
 * @param {Iterable<string>} [only]
 * @returns {string[]}
 */
export function cesiumCapabilities(scene, only) {
  const all = ['models', 'styles', 'bloom', 'sharpen'];
  if (scene.pickPositionSupported) all.push('pickPosition');
  if (scene.sampleHeightSupported)
    all.push('sampleHeight', 'finestHeights', 'rayCast');
  const allowed = only && new Set(only);
  return all.filter((c) => !allowed || allowed.has(c));
}

/**
 * @param {object} widget A Cesium `CesiumWidget` or `Viewer`.
 * @param {{capabilities: ReadonlySet<string>}} options The renderer's
 *   capabilities, which gate the members that need them.
 */
export function createCesiumPorts(widget, { capabilities }) {
  const scene = widget.scene;
  const camera = scene.camera;
  const sets = new Map();

  // An error listener's own throw is uncaught, never reported again.
  const rendererListeners = {
    error: listenerList(uncaught),
    contextLost: listenerList(report),
    contextRestored: listenerList(report),
  };
  /** Hands a listener's throw to the renderer's `error` listeners. */
  function report(error) {
    if (rendererListeners.error.size === 0) uncaught(error);
    else rendererListeners.error.fire(error);
  }
  // Cesium cannot bring a lost context back, so it never sends
  // `contextRestored`.
  const contextLost = () => rendererListeners.contextLost.fire();
  scene.canvas?.addEventListener?.('webglcontextlost', contextLost);

  const frameListeners = {
    preUpdate: listenerList(report),
    preRender: listenerList(report),
    postRender: listenerList(report),
  };
  let frames = 0;
  let rendered = 0;
  // Every tick raises preUpdate, drawn or not; the phases of a tick share
  // its clock reading. The first tick counts from when the loop was made.
  let tickNow = performance.now();
  let dt = 0;
  // The preUpdate FrameTime of the tick under way: its `rendering` reads
  // live until the tick has drawn or not, then holds that answer.
  let liveTick = null;
  const settleTick = (drawn) => {
    if (liveTick)
      Object.defineProperty(liveTick, 'rendering', {
        value: drawn,
        enumerable: true,
      });
    liveTick = null;
  };
  const tick = () => {
    settleTick(false);
    // A tick that does not draw settles at its end; one that does, at
    // preRender, before this runs.
    atEndOfTick(scene, () => void settleTick(false));
    const now = performance.now();
    dt = (now - tickNow) / 1000;
    tickNow = now;
    frames += 1;
  };
  const onPhase = (phase) => (_scene, time) => {
    if (frameListeners[phase].size === 0) return;
    const t = {
      frame: frames,
      time: Cesium.JulianDate.toDate(
        time ?? widget.clock.currentTime,
      ).getTime(),
      now: tickNow,
      dt,
      rendering: true,
    };
    // At preUpdate, Cesium has not decided yet: this applies its test when
    // read, so it counts what earlier listeners did (a camera move, a
    // request, a hold) but not what later ones will.
    if (phase === 'preUpdate') {
      Object.defineProperty(t, 'rendering', {
        enumerable: true,
        configurable: true,
        get: () => willDraw(time),
      });
      liveTick = t;
    }
    frameListeners[phase].fire(t);
  };
  // Reasons given before a frame starts drawing are answered by it; one
  // given while it draws waits for the next, as Cesium's own request does.
  const pendingReasons = [];
  let answering = 0;
  const drawing = () => {
    settleTick(true);
    answering = pendingReasons.length;
  };
  const drew = () => {
    rendered += 1;
    pendingReasons.splice(0, answering);
    answering = 0;
  };
  let disposed = false;
  const removers = [
    scene.preUpdate.addEventListener(tick),
    scene.preUpdate.addEventListener(onPhase('preUpdate')),
    scene.preRender.addEventListener(drawing),
    scene.preRender.addEventListener(onPhase('preRender')),
    scene.postRender.addEventListener(drew),
    scene.postRender.addEventListener(onPhase('postRender')),
    scene.postRender.addEventListener(() => watchClamp()),
  ];

  /**
   * Whether this tick draws: the test `Scene.render` makes just after
   * `preUpdate`, made here so `preUpdate` can say. Not seen: a request made
   * in between, by a `camera.moveEnd` listener (Cesium raises it there); no
   * Core listener does that, and the answer is corrected at preRender.
   */
  function willDraw(time) {
    if (!scene.requestRenderMode || renderPending(scene)) return true;
    if (scene.mode === Cesium.SceneMode.MORPHING) return true;
    const seen = lastSeenCamera(scene);
    if (!seen || !cameraEqual(camera, seen, Cesium.Math.EPSILON15)) return true;
    const last = lastRenderTime(scene);
    const max = scene.maximumRenderTimeChange;
    return (
      last !== undefined &&
      max !== undefined &&
      Math.abs(
        Cesium.JulianDate.secondsDifference(
          last,
          time ?? Cesium.JulianDate.now(),
        ),
      ) > max
    );
  }

  // Holds keep the loop drawing every frame; counted per reason.
  const holds = new Map();
  function applyHolds() {
    const continuous = holds.size > 0;
    if (scene.requestRenderMode === !continuous) return;
    scene.requestRenderMode = !continuous;
  }
  // On demand means drawn when asked, held or the view changed: never
  // because scene time moved on by itself. With no holds yet, it starts so.
  scene.maximumRenderTimeChange = Infinity;
  scene.requestRenderMode = true;
  let suspended = false;
  let targetFps = widget.targetFrameRate > 0 ? widget.targetFrameRate : 0;

  // Pending one-shot renders; disposal settles them rather than leave them
  // attached to a scene that will not render again.
  const pendingRenders = new Set();
  /** Resolves after the next drawn frame; rejects after `timeoutMs`, if given. */
  function nextPostRender({ timeoutMs } = {}) {
    if (disposed) return Promise.resolve();
    return new Promise((resolve, reject) => {
      let timer;
      const settle = (error) => {
        off();
        clearTimeout(timer);
        pendingRenders.delete(done);
        if (error) reject(error);
        else resolve();
      };
      const done = () => settle();
      const off = scene.postRender.addEventListener(done);
      pendingRenders.add(done);
      if (timeoutMs !== undefined)
        timer = setTimeout(
          () => settle(new Error('renderOnce timed out')),
          timeoutMs,
        );
      scene.requestRender();
    });
  }

  const frame = {
    on(phase, cb) {
      const list = frameListeners[phase];
      if (!list) throw new TypeError(`Unknown frame phase: ${phase}`);
      return list.on(cb);
    },
    requestRender(reason = 'unspecified') {
      // During a draw the reasons it answers are spoken for: a reason given
      // again waits for the next frame.
      if (!pendingReasons.includes(reason, answering))
        pendingReasons.push(reason);
      scene.requestRender();
    },
    holdContinuous(reason) {
      holds.set(reason, (holds.get(reason) ?? 0) + 1);
      applyHolds();
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const left = holds.get(reason) - 1;
        if (left > 0) holds.set(reason, left);
        else holds.delete(reason);
        applyHolds();
        // What changed in the last held frame still gets drawn.
        if (holds.size === 0) scene.requestRender();
      };
    },
    /** Cesium can idle, so it draws on demand. */
    mode: () => 'demand',
    diagnostics: () => ({
      mode: 'demand',
      frames,
      rendered,
      pendingReasons: [...pendingReasons],
      holds: [...holds].flatMap(([reason, n]) => Array(n).fill(reason)),
      suspended,
      targetFps,
    }),
    suspend(hidden) {
      if (Boolean(hidden) === suspended) return;
      suspended = Boolean(hidden);
      // The loop's queued callback sees the flag and stops without a tick.
      // The latch stays as Cesium keeps it: a resume before that callback
      // runs keeps the one loop rather than start a second.
      widget.useDefaultRenderLoop = !suspended;
      if (!suspended) scene.requestRender();
    },
    // Draws even when nothing asked for a frame.
    renderNow: () => scene.forceRender(widget.clock.currentTime),
    renderOnce: (options) => nextPostRender(options),
    setTargetFps(fps) {
      targetFps = fps > 0 ? fps : 0;
      widget.targetFrameRate = targetFps || undefined;
    },
    /**
     * Moves the clock to `ms` and draws it. Whether the clock then runs on
     * is its owner's: the application's clock keeps running if it was (a
     * clock on Cesium's real-time step moves to its multiplier step, as
     * setting its time does in Cesium).
     */
    setTime(ms) {
      widget.clock.currentTime = Cesium.JulianDate.fromDate(new Date(ms));
      frame.requestRender('time');
    },
    time: () => Cesium.JulianDate.toDate(widget.clock.currentTime).getTime(),
  };

  // --- Draw ------------------------------------------------------------------

  function makeSet(kind, spec, build) {
    if (sets.has(spec.id)) throw new Error(`a set with id ${spec.id} is live`);
    const items = new Map();
    const listeners = { ready: listenerList(report) };
    const record = { kind, spec, items, listeners, host: null, pickIds: [] };
    // Each build records its items' pick ids, for height queries to see
    // through.
    const rebuild = () => {
      record.pickIds = [];
      build(record);
      setsVersion += 1;
    };
    record.rebuild = rebuild;
    const handle = {
      id: spec.id,
      set(list) {
        items.clear();
        for (const item of list) items.set(item.id, item);
        rebuild();
        scene.requestRender();
      },
      upsert(list) {
        for (const item of list) items.set(item.id, item);
        rebuild();
        scene.requestRender();
      },
      remove(ids) {
        for (const id of ids) items.delete(id);
        rebuild();
        scene.requestRender();
      },
      clear() {
        items.clear();
        rebuild();
        scene.requestRender();
      },
      setOptions(options) {
        Object.assign(spec, options);
        setsVersion += 1;
        if (record.host) record.host.show = spec.show !== false;
        scene.requestRender();
      },
      size: () => items.size,
      get show() {
        return spec.show !== false;
      },
      set show(value) {
        spec.show = value;
        if (record.host) record.host.show = value;
        scene.requestRender();
      },
      on(event, cb) {
        return listeners[event]?.on(cb) ?? (() => {});
      },
      dispose() {
        if (record.host && !record.host.isDestroyed?.())
          scene.primitives.remove(record.host);
        record.host = null;
        // A newer set under the same id is not this handle's to remove.
        if (sets.get(spec.id) === record) sets.delete(spec.id);
        setsVersion += 1;
        scene.requestRender();
      },
    };
    sets.set(spec.id, record);
    setsVersion += 1;
    return handle;
  }

  function pickId(record, item) {
    const id = {
      set: record.spec.id,
      id: item.id,
      meta: item.meta,
      lodGroup: item.lodGroup,
    };
    record.pickIds.push(id);
    return id;
  }

  function replaceHost(record, host) {
    if (record.host) scene.primitives.remove(record.host);
    record.host = host;
    host.show = record.spec.show !== false;
    scene.primitives.add(host);
  }

  // Atlases icons name images from, by id: `{atlas, slot}` reads the slot
  // when its set is built, and registering an atlas again rebuilds the icon
  // sets that drew from it.
  const atlases = new Map();

  /**
   * An icon's image: an atlas slot read through its atlas, or undefined
   * while its atlas or slot is not registered (it draws once it is).
   */
  function iconImage(record, image) {
    if (typeof image?.atlas !== 'string') return image;
    record.atlases.add(image.atlas);
    return atlases.get(image.atlas)?.[image.slot];
  }

  function buildIcons(record) {
    const host = new Cesium.BillboardCollection({ scene });
    record.atlases = new Set();
    for (const item of record.items.values()) {
      const image = iconImage(record, item.image);
      if (image === undefined) continue;
      // A generated image is one texture under its key, however many icons
      // draw it.
      const keyed = image?.canvas && typeof image.key === 'string';
      const position = toCartesian(item.pos);
      const options = {
        position,
        ...(keyed ? {} : { image: toImage(image) }),
        width: item.size[0] * (item.scale ?? 1),
        height: item.size[1] * (item.scale ?? 1),
        color: toColor(item.color, item.alpha ?? 1),
        verticalOrigin: ANCHORS[item.anchor ?? 'center'],
        disableDepthTestDistance: item.disableDepthTest ?? 0,
        show: item.show !== false,
        id: pickId(record, item),
      };
      if (item.rotationMode === 'screen') options.rotation = item.rotation ?? 0;
      if (item.rotationMode === 'course') {
        const enu = Cesium.Transforms.eastNorthUpToFixedFrame(position);
        options.alignedAxis = Cesium.Matrix4.multiplyByPointAsVector(
          enu,
          Cesium.Cartesian3.UNIT_Y,
          new Cesium.Cartesian3(),
        );
        options.rotation = -Cesium.Math.toRadians(item.course ?? 0);
      }
      const billboard = host.add(options);
      if (keyed) billboard.setImage(image.key, image.canvas);
    }
    replaceHost(record, host);
  }

  function buildPoints(record) {
    const host = new Cesium.PointPrimitiveCollection();
    for (const item of record.items.values())
      host.add({
        position: toCartesian(item.pos),
        pixelSize: item.pixelSize,
        color: toColor(item.color),
        outlineColor: toColor(item.outlineColor ?? [0, 0, 0, 0]),
        outlineWidth: item.outlineWidth ?? 0,
        disableDepthTestDistance: item.disableDepthTest ?? 0,
        show: item.show !== false,
        id: pickId(record, item),
      });
    replaceHost(record, host);
  }

  function lineMaterial(style) {
    switch (style.kind) {
      case 'solid':
        return Cesium.Material.fromType('Color', {
          color: toColor(style.color),
        });
      case 'glow':
        return Cesium.Material.fromType('PolylineGlow', {
          color: toColor(style.color),
          glowPower: style.power,
          taperPower: style.taper ?? 1,
        });
      case 'dash':
        return Cesium.Material.fromType('PolylineDash', {
          color: toColor(style.color),
          gapColor: toColor(style.gapColor ?? [0, 0, 0, 0]),
          dashLength: style.length,
          ...(style.pattern16 !== undefined
            ? { dashPattern: style.pattern16 }
            : {}),
        });
      case 'arrow':
        return Cesium.Material.fromType('PolylineArrow', {
          color: toColor(style.color),
        });
      default:
        throw new Error(`the Cesium renderer has no ${style.kind} lines`);
    }
  }

  function linePositions(item) {
    const flat = item.positions instanceof Float64Array;
    const points = [];
    const n = flat ? item.positions.length / 3 : item.positions.length;
    for (let i = 0; i < n; i++)
      points.push(
        flat
          ? new Cesium.Cartesian3(
              item.positions[i * 3],
              item.positions[i * 3 + 1],
              item.positions[i * 3 + 2],
            )
          : toCartesian(item.positions[i]),
      );
    if (item.mode !== 'geodesic') return points;
    const dense = [];
    for (let i = 0; i + 1 < points.length; i++) {
      const a = Cesium.Cartographic.fromCartesian(points[i]);
      const b = Cesium.Cartographic.fromCartesian(points[i + 1]);
      const geodesic = new Cesium.EllipsoidGeodesic(a, b);
      for (let k = 0; k < 64; k++) {
        const s = k / 64;
        const at = geodesic.interpolateUsingFraction(s);
        dense.push(
          Cesium.Cartesian3.fromRadians(
            at.longitude,
            at.latitude,
            a.height + (b.height - a.height) * s,
          ),
        );
      }
    }
    dense.push(points.at(-1));
    return dense;
  }

  function buildLines(record) {
    const host = new Cesium.PolylineCollection();
    for (const item of record.items.values()) {
      if (item.mode === 'draped')
        throw new Error('the Cesium renderer has no draped lines');
      host.add({
        positions: linePositions(item),
        width: item.widthPx,
        material: lineMaterial(item.style),
        show: item.show !== false,
        id: pickId(record, item),
      });
    }
    replaceHost(record, host);
  }

  const heightOf = (pos) =>
    'x' in pos
      ? Cesium.Cartographic.fromCartesian(toCartesian(pos)).height
      : (pos.height ?? 0);

  function shapeGeometry(item) {
    const g = item.geometry;
    const extrudedHeight = item.extrudeHeight;
    switch (g.kind) {
      case 'polygon': {
        const [outer, ...holes] = g.rings.map((ring) => ring.map(toCartesian));
        const hierarchy = new Cesium.PolygonHierarchy(
          outer,
          holes.map((h) => new Cesium.PolygonHierarchy(h)),
        );
        return {
          fill: new Cesium.PolygonGeometry({
            polygonHierarchy: hierarchy,
            height: g.perPositionHeight ? undefined : heightOf(g.rings[0][0]),
            extrudedHeight,
            perPositionHeight: g.perPositionHeight,
          }),
          ring: outer,
        };
      }
      case 'ellipse':
        return {
          fill: new Cesium.EllipseGeometry({
            center: toCartesian(g.center),
            semiMajorAxis: g.semiMajor,
            semiMinorAxis: g.semiMinor,
            rotation: g.rotation ?? 0,
            height: heightOf(g.center),
            extrudedHeight,
          }),
        };
      case 'rectangle':
        return {
          fill: new Cesium.RectangleGeometry({
            rectangle: Cesium.Rectangle.fromDegrees(
              g.rect.west,
              g.rect.south,
              g.rect.east,
              g.rect.north,
            ),
            height: g.height ?? 0,
            extrudedHeight,
          }),
        };
      case 'box': {
        const d = g.dimensions;
        return {
          fill: Cesium.BoxGeometry.fromDimensions({
            dimensions: new Cesium.Cartesian3(d.x, d.y, d.z),
          }),
          modelMatrix: Cesium.Transforms.eastNorthUpToFixedFrame(
            toCartesian(g.center),
          ),
        };
      }
      default:
        throw new Error(`the Cesium renderer has no ${g.kind} shapes`);
    }
  }

  function buildShapes(record) {
    const host = new Cesium.PrimitiveCollection();
    const outlines = new Cesium.PolylineCollection();
    for (const item of record.items.values()) {
      if (item.show === false) continue;
      if (
        item.fill &&
        typeof item.fill === 'object' &&
        !Array.isArray(item.fill)
      )
        throw new Error('the Cesium renderer fills shapes with colours only');
      const shape = shapeGeometry(item);
      const id = pickId(record, item);
      const solid =
        item.extrudeHeight !== undefined || item.geometry.kind === 'box';
      if (item.fill && !item.outlineOnly) {
        const color = toColor(item.fill);
        host.add(
          new Cesium.Primitive({
            geometryInstances: new Cesium.GeometryInstance({
              geometry: shape.fill,
              modelMatrix: shape.modelMatrix,
              attributes: {
                color: Cesium.ColorGeometryInstanceAttribute.fromColor(color),
              },
              id,
            }),
            appearance: new Cesium.PerInstanceColorAppearance({
              translucent: color.alpha < 1,
              closed: solid,
              // Flat shapes unlit: lit, their two triangles shade apart.
              flat: !solid,
            }),
            asynchronous: false,
          }),
        );
      }
      if (item.outline && shape.ring)
        outlines.add({
          positions: [...shape.ring, shape.ring[0]],
          width: item.outlineWidth ?? 1,
          material: Cesium.Material.fromType('Color', {
            color: toColor(item.outline),
          }),
          id,
        });
    }
    host.add(outlines);
    replaceHost(record, host);
  }

  function buildModels(record) {
    const host = new Cesium.PrimitiveCollection();
    replaceHost(record, host);
    // A model counts as loading until it is ready or fails, not when added;
    // each model settles once, and a failure is kept for `whenSettled`.
    host.loading = record.items.size;
    host.failed = 0;
    for (const item of record.items.values()) {
      let settled = false;
      const settle = (failed) => {
        if (settled) return;
        settled = true;
        host.loading -= 1;
        if (failed) host.failed += 1;
        scene.requestRender();
      };
      const o = item.orientation;
      const modelMatrix = Cesium.Transforms.headingPitchRollToFixedFrame(
        toCartesian(item.pos),
        new Cesium.HeadingPitchRoll(o.heading, o.pitch, o.roll),
      );
      Cesium.Model.fromGltfAsync({
        url: item.url,
        modelMatrix,
        scale: item.scale ?? 1,
        minimumPixelSize: item.minPixelSize ?? 0,
        // All textures before ready, so a settled capture is the whole model.
        incrementallyLoadTextures: false,
        id: pickId(record, item),
      }).then(
        (model) => {
          // Rebuilt, disposed, or the renderer is gone.
          if (record.host !== host || host.isDestroyed())
            return model.destroy();
          host.add(model);
          model.readyEvent.addEventListener(() => {
            settle(false);
            record.listeners.ready.fire(item.id);
          });
          model.errorEvent.addEventListener(() => settle(true));
          scene.requestRender();
        },
        () => settle(true),
      );
    }
  }

  /** The 3D tilesets in the scene, shown or not. */
  function tilesets() {
    const found = [];
    const primitives = scene.primitives;
    const n = primitives?.length ?? 0;
    for (let i = 0; i < n; i++) {
      const primitive = primitives.get(i);
      if (primitive instanceof Cesium.Cesium3DTileset) found.push(primitive);
    }
    return found;
  }

  /**
   * The Cesium port draws clamped items where it is given them; it does not
   * drape them onto 3D tiles yet, so over shown tiles it is `overlay`.
   * Terrain and the ellipsoid always take draped items.
   */
  const clampState = () =>
    tilesets().some((tileset) => tileset.show) ? 'overlay' : 'draped';
  const clampListeners = listenerList(report);
  // The state last told, while anyone listens; measured after each drawn
  // frame, when what the base holds can have changed.
  let toldClamp = null;
  function watchClamp() {
    if (clampListeners.size === 0) return;
    const state = clampState();
    if (state === toldClamp) return;
    toldClamp = state;
    clampListeners.fire(state);
  }

  const draw = {
    icons: (spec) => makeSet('icons', { ...spec }, buildIcons),
    points: (spec) => makeSet('points', { ...spec }, buildPoints),
    lines: (spec) => makeSet('lines', { ...spec }, buildLines),
    shapes: (spec) => makeSet('shapes', { ...spec }, buildShapes),
    models: (spec) => makeSet('models', { ...spec }, buildModels),
    clampState,
    on(event, cb) {
      if (event !== 'clampState') return () => {};
      if (clampListeners.size === 0) toldClamp = clampState();
      return clampListeners.on(cb);
    },
    atlas(id, images) {
      atlases.set(id, { ...images });
      let rebuilt = false;
      for (const record of [...sets.values()])
        if (record.kind === 'icons' && record.atlases?.has(id)) {
          record.rebuild();
          rebuilt = true;
        }
      if (rebuilt) scene.requestRender();
    },
  };

  const cameraPart = createCesiumCamera({ scene, camera, report, widget });
  const cameraPort = cameraPart.port;
  const effectsPart = createCesiumEffects(scene, {
    capabilities,
    frame,
    report,
  });

  const qualityPart = createCesiumQuality(widget, {
    frame,
    report,
    tickStarted: () => tickNow,
  });

  const creditsPart = createCesiumCredits({
    display: widget.creditDisplay,
    scene,
    report,
    requestRender: () => frame.requestRender('credits'),
  });

  // --- Query -----------------------------------------------------------------

  const screen = (x, y) => new Cesium.Cartesian2(x, y);
  const ecef = (c) => (c ? { x: c.x, y: c.y, z: c.z } : null);
  const finite = (p) =>
    Number.isFinite(p?.x) && Number.isFinite(p?.y) && Number.isFinite(p?.z);
  const cesiumRay = (ray) =>
    new Cesium.Ray(toCartesian(ray.origin), toCartesian(ray.direction));

  /** The live set and item a picked object belongs to, or null. */
  function ownerOf(picked) {
    const id = picked?.id;
    if (!id || typeof id.set !== 'string') return null;
    const record = sets.get(id.set);
    const item = record?.items.get(id.id);
    return record && item ? { record, item, id } : null;
  }

  const pickable = ({ record, item }) =>
    record.host?.show !== false &&
    record.spec.pickable !== false &&
    item.show !== false &&
    item.pickable !== false;

  function hitOf({ id }) {
    return {
      set: id.set,
      id: id.id,
      ...(id.meta === undefined ? {} : { meta: id.meta }),
      ...(id.lodGroup === undefined ? {} : { lodGroup: id.lodGroup }),
      surface: false,
    };
  }

  /** The globe (or ellipsoid) under a pixel, as a surface hit. */
  function surfaceHit(x, y) {
    const position = query.pickPosition(x, y) ?? query.pickEllipsoid(x, y);
    return position ? { set: '', id: '', surface: true, position } : null;
  }

  /**
   * The pickable draw-set items under a pixel, nearest first, once each (a
   * shape's fill and outline share one id). `untilForeign` stops at the first
   * thing that is not a draw-set item (a tile, the app's own primitives):
   * what is behind it is hidden.
   */
  function drill(x, y, { width = 3, height = 3, limit, untilForeign } = {}) {
    const hits = [];
    if (limit === 0) return hits;
    const seen = new Set();
    for (const picked of scene.drillPick(
      screen(x, y),
      undefined,
      width,
      height,
    )) {
      const owner = ownerOf(picked);
      if (!owner) {
        if (untilForeign) break;
        continue;
      }
      const key = `${owner.id.set}\u0000${owner.id.id}`;
      if (!pickable(owner) || seen.has(key)) continue;
      seen.add(key);
      hits.push(hitOf(owner));
      if (limit !== undefined && hits.length >= limit) break;
    }
    return hits;
  }

  // What height queries see through, by their items' pick ids: the sets not
  // drawn as ground, and the sets a caller excludes. Built once per change
  // to the sets, not per query.
  let setsVersion = 0;
  const seeThroughCache = new Map();
  let seeThroughVersion = -1;
  function seeThrough(exclude, { allSets = false } = {}) {
    if (seeThroughVersion !== setsVersion) {
      seeThroughCache.clear();
      seeThroughVersion = setsVersion;
    }
    const key = `${allSets}\u0000${exclude?.join('\u0000') ?? ''}`;
    let out = seeThroughCache.get(key);
    if (!out) {
      out = [];
      for (const record of sets.values())
        if (
          allSets ||
          !record.spec.includeInHeightQueries ||
          exclude?.includes(record.spec.id)
        )
          for (const id of record.pickIds) out.push(id);
      seeThroughCache.set(key, out);
    }
    return out;
  }

  /** Whether a set drawn as ground is in the scene, other than `exclude`. */
  const groundSets = (exclude) =>
    [...sets.values()].some(
      (record) =>
        record.spec.includeInHeightQueries &&
        record.host?.show !== false &&
        !exclude?.includes(record.spec.id),
    );

  const heights = () => heightsFor(scene);
  const can = (capability) => capabilities.has(capability);
  const globeShown = () => Boolean(scene.globe?.show);

  /**
   * `fn` with the globe hidden, so a pick or sample sees tiles and sets
   * alone. Synchronous: the globe is shown again before anything draws.
   */
  function withoutGlobe(fn) {
    if (!globeShown()) return fn();
    scene.globe.show = false;
    try {
      return fn();
    } finally {
      scene.globe.show = true;
    }
  }

  /** A height now from what is loaded, against the surface asked for. */
  function heightNow(point, against, excluded) {
    if (against === 'terrain')
      return heights().now(point, { against: 'terrain' });
    const sample = () => heights().now(point, { exclude: excluded });
    return against === 'tiles' ? withoutGlobe(sample) : sample();
  }

  const close = (a, b) => a !== null && b !== null && Math.abs(a - b) <= 0.01;
  const ellipsoidTerrain = () =>
    scene.terrainProvider instanceof Cesium.EllipsoidTerrainProvider;

  /**
   * Where a height came from, told apart by sampling again without the
   * ground sets and against the terrain alone.
   */
  function sourceOf(point, height, against, exclude) {
    const terrain = () => (ellipsoidTerrain() ? 'ellipsoid' : 'terrain');
    if (against === 'terrain') return terrain();
    if (groundSets(exclude)) {
      const bare = heightNow(
        point,
        against,
        seeThrough(exclude, { allSets: true }),
      );
      if (!close(bare, height)) return 'set';
    }
    if (against === 'tiles' || !globeShown()) return 'tiles';
    return close(heights().now(point, { against: 'terrain' }), height)
      ? terrain()
      : 'tiles';
  }

  const query = {
    pick(x, y, window = {}) {
      const owner = ownerOf(
        scene.pick(screen(x, y), window.width ?? 3, window.height ?? 3),
      );
      if (owner && pickable(owner)) return hitOf(owner);
      // Something unpickable is on top: the first pickable item under it,
      // unless something else hides it.
      if (owner) {
        const [under] = drill(x, y, {
          ...window,
          limit: 1,
          untilForeign: true,
        });
        if (under) return under;
      }
      return surfaceHit(x, y);
    },
    drillPick: (x, y, options = {}) =>
      drill(x, y, { ...options, untilForeign: false }),
    pickPosition(x, y) {
      if (!can('pickPosition') || !scene.pickPositionSupported) return null;
      return ecef(scene.pickPosition(screen(x, y)));
    },
    pickEllipsoid(x, y) {
      return ecef(camera.pickEllipsoid(screen(x, y)));
    },
    pickGlobe(ray) {
      return ecef(scene.globe?.pick(cesiumRay(ray), scene));
    },
    pickRay(x, y) {
      const ray = camera.getPickRay(screen(x, y));
      return { origin: ecef(ray.origin), direction: ecef(ray.direction) };
    },
    project(position) {
      const s = Cesium.SceneTransforms.worldToWindowCoordinates(
        scene,
        toCartesian(position),
      );
      return s ? { x: s.x, y: s.y } : null;
    },
    projectMany(source, out) {
      const p = new Cesium.Cartesian3();
      const s = new Cesium.Cartesian2();
      for (let i = 0, j = 0; i + 2 < source.length; i += 3, j += 2) {
        p.x = source[i];
        p.y = source[i + 1];
        p.z = source[i + 2];
        const w = Cesium.SceneTransforms.worldToWindowCoordinates(scene, p, s);
        out[j] = w ? w.x : NaN;
        out[j + 1] = w ? w.y : NaN;
      }
    },
    isOccluded(position) {
      const occluder = new Cesium.EllipsoidalOccluder(
        scene.globe?.ellipsoid ?? Cesium.Ellipsoid.WGS84,
        camera.positionWC,
      );
      return !occluder.isPointVisible(toCartesian(position));
    },
    sampleHeightNow(point, { against = 'surface', exclude } = {}) {
      if (!can('sampleHeight')) return null;
      return heightNow(point, against, seeThrough(exclude));
    },
    sampleHeightNowMany(points, out, { against = 'surface', exclude } = {}) {
      const excluded = can('sampleHeight') && seeThrough(exclude);
      const point = { lon: 0, lat: 0 };
      for (let i = 0; i < out.length; i++) {
        point.lon = points[i * 2];
        point.lat = points[i * 2 + 1];
        out[i] = excluded ? (heightNow(point, against, excluded) ?? NaN) : NaN;
      }
    },
    /**
     * Cesium streams the finest tiles for every sample, `mostDetailed` or
     * not. Against `tiles` it streams them, then samples them with the
     * globe hidden, which only a synchronous sample can do.
     */
    async sampleHeight(points, { against = 'surface', exclude } = {}) {
      if (!can('sampleHeight')) return points.map(() => null);
      const excluded = seeThrough(exclude);
      let found = await heights().batch(
        points,
        against === 'terrain' ? { against: 'terrain' } : { exclude: excluded },
      );
      if (against === 'tiles')
        found = points.map((point) => heightNow(point, 'tiles', excluded));
      const lod = can('finestHeights') ? 'finest' : 'visible';
      return found.map((height, i) =>
        height === null
          ? null
          : {
              height,
              confidence: 1,
              source: sourceOf(points[i], height, against, exclude),
              lod,
            },
      );
    },
    async clampToSurface(positions, options = {}) {
      const points = positions.map((p) => {
        const c =
          finite(p) && Cesium.Cartographic.fromCartesian(toCartesian(p));
        return c
          ? {
              lon: Cesium.Math.toDegrees(c.longitude),
              lat: Cesium.Math.toDegrees(c.latitude),
            }
          : null;
      });
      const samples = await query.sampleHeight(
        points.map((p) => p ?? { lon: NaN, lat: NaN }),
        options,
      );
      return samples.map((sample, i) =>
        sample && points[i]
          ? ecef(
              Cesium.Cartesian3.fromDegrees(
                points[i].lon,
                points[i].lat,
                sample.height,
              ),
            )
          : null,
      );
    },
    async rayCast(
      ray,
      { against = 'surface', exclude, maxDistance = Infinity } = {},
    ) {
      if (!can('rayCast')) return null;
      const r = cesiumRay(ray);
      let position;
      if (against === 'terrain') position = scene.globe?.pick(r, scene);
      else {
        const cast = () => scene.pickFromRay(r, seeThrough(exclude))?.position;
        position = against === 'tiles' ? withoutGlobe(cast) : cast();
      }
      if (!position) return null;
      return Cesium.Cartesian3.distance(r.origin, position) <= maxDistance
        ? ecef(position)
        : null;
    },
  };

  async function capture({ type = 'png' } = {}) {
    scene.render(widget.clock.currentTime);
    return new Promise((resolve) =>
      scene.canvas.toBlob(resolve, `image/${type}`),
    );
  }

  /** The live model sets, for a renderer's own `whenSettled`. */
  const modelSets = () =>
    [...sets.values()].filter((r) => r.kind === 'models' && r.host);

  /**
   * The shown icons' images, for `whenSettled`: `failed` when one could not
   * load, `loading` while one still is, otherwise `settled`.
   */
  function iconState() {
    let loading = false;
    for (const record of sets.values()) {
      const host = record.kind === 'icons' && record.host;
      if (!host || !host.show) continue;
      for (let i = 0; i < host.length; i++) {
        const billboard = host.get(i);
        if (!billboard.show || billboard.ready) continue;
        if (billboardLoadError(billboard)) return 'failed';
        loading = true;
      }
    }
    return loading ? 'loading' : 'settled';
  }

  return {
    /** The renderer's own events: `error`, `contextLost`, `contextRestored`. */
    on(event, cb) {
      return rendererListeners[event]?.on(cb) ?? (() => {});
    },
    report,
    frame,
    draw,
    camera: cameraPort,
    credits: creditsPart.port,
    query,
    effects: effectsPart.port,
    quality: qualityPart.port,
    capture,
    modelSets,
    iconState,
    nextPostRender,
    /** Detach from the scene; the widget's owner destroys the widget. */
    dispose() {
      disposed = true;
      // The tick under way is no longer seen through: it is not claimed.
      settleTick(false);
      for (const off of removers) off();
      scene.canvas?.removeEventListener?.('webglcontextlost', contextLost);
      // A listener that disposes the renderer stops the rest of its event.
      for (const list of Object.values(rendererListeners)) list.clear();
      for (const list of Object.values(frameListeners)) list.clear();
      clampListeners.clear();
      cameraPart.dispose();
      creditsPart.dispose();
      effectsPart.dispose();
      qualityPart.dispose();
      for (const done of [...pendingRenders]) done();
      // Late model loads find no host and destroy themselves.
      for (const record of sets.values()) record.host = null;
      sets.clear();
    },
  };
}
