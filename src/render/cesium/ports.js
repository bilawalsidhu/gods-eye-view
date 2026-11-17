/**
 * @module render/cesium/ports
 * @description The Cesium renderer's contract ports, built over a Cesium
 * widget or viewer someone else made and configured: frame phases, the
 * globe, the draw sets, `setView` and the pose, picks and projection,
 * credits, quality and capture.
 * Building them puts the loop on demand (no holds yet, and no redraws for
 * scene time alone); nothing else in the scene changes until a call.
 *
 * The conformance renderer (`sceneRenderer.js`) and the application's
 * renderer (`appRenderer.js`) both use them, so what conformance
 * checks is what the application runs. Members a port does not have are
 * absent, never stubbed.
 */
import * as Cesium from 'cesium';
import { createCesiumCamera } from './camera.js';
import { createControlledCamera } from './controlledCamera.js';
import { listenerList, toCartesian, uncaught } from './common.js';
import { createCesiumCredits } from './credits.js';
import { createCesiumDraw } from './draw.js';
import { GPU_ICON_CAPABILITIES } from './gpuIcons.js';
import { createCesiumEffects } from './effects.js';
import { renderNow, willDraw } from './frame.js';
import { createCesiumGlobe } from './globe.js';
import { createCesiumQuery, queryCapabilities } from './query.js';
import { createCesiumQuality, gpuTimerOf } from './quality.js';
import { screenModulationSupported } from './screenModulation.js';
import {
  atEndOfTick,
  billboardLoadError,
  onEngineWorkCompleted,
  renderPending,
  trimGlobeTiles,
  webglContext,
} from './internals.js';

export { listenerList, toCartesian };
export { toColor, toImage } from './draw.js';

/**
 * What every Cesium globe does: photoreal tiles, terrain, imagery draped on
 * tiles, the split and main-thread tile hooks.
 */
const GLOBE_CAPABILITIES = [
  'photoreal',
  'terrain',
  'imageryOnTiles',
  'splitSwipe',
  'imageHooks',
  // Timed imagery: a layer a frame, prefetched unseen (`imagery.js`).
  'imageryFrames',
  'surfaceIdentity',
  'surfaceShading',
  // A MapLibre style's vector tiles, painted as imagery (`vectorBase.js`).
  'vectorBase',
  'globeVisibility',
];

/**
 * What a Cesium scene can do, as contract capabilities; `only` limits them
 * to those it lists. Depth picks, height samples and ray casts all need
 * depth textures, which `sampleHeightSupported` and `pickPositionSupported`
 * report. Styles, bloom and sharpen are post-process stages every scene
 * runs; the screen modulation runs on the Cesium version it was tested
 * against.
 * @param {object} scene
 * @param {Iterable<string>} [only]
 * @returns {string[]}
 */
export function cesiumCapabilities(scene, only) {
  const all = [
    'models',
    // Cesium scatters drawn models through the atmosphere wherever the
    // scene draws fog (its models' atmosphere stage).
    'modelAtmosphere',
    'quads',
    'meshes',
    // Raster shells; other field kinds are refused.
    'fields',
    'followFrame',
    // Cesium's AUTODETECT tracking frame (`follow.js`).
    'followAutodetect',
    'cameraChangeThreshold',
    // The zoom-out guard reads the scene's own controller and frame events.
    ...(scene?.screenSpaceCameraController && scene?.preRender
      ? ['keepEarthFramed']
      : []),
    ...GPU_ICON_CAPABILITIES,
    // Icon sets cluster on screen, on billboards and the GPU (`draw.js`).
    'cluster',
    'styles',
    'bloom',
    'sharpen',
    // The marker sweep's command swap is tested against one Cesium version.
    ...(screenModulationSupported() ? ['screenModulation'] : []),
    ...GLOBE_CAPABILITIES,
    ...queryCapabilities(scene),
    // Frame timing on the GPU, where the context has timer queries.
    ...(gpuTimerOf(webglContext(scene)) ? ['gpuTiming'] : []),
  ];
  const allowed = only && new Set(only);
  return all.filter(
    (c) =>
      (!allowed || allowed.has(c)) &&
      // Visibility reads back only from a globe that keeps it: a scene
      // made without one gives no reading.
      (c !== 'globeVisibility' || typeof scene?.globe?.show === 'boolean'),
  );
}

/** What `renderOnce` and `capture` reject with once the renderer is destroyed. */
const destroyedError = () => new Error('renderer destroyed');

/**
 * @param {object} widget A Cesium `CesiumWidget` or `Viewer`.
 * @param {{capabilities: ReadonlySet<string>, credentials?: object,
 *   cameraController?: import('../contract/camera').CameraControllerFactory,
 *   now?: () => number,
 *   date?: () => number}} options
 *   The renderer's capabilities, which gate the members that need them, and
 *   the credentials its globe loads photoreal tiles and world data with
 *   (`googleApiKey`, `googleTokens`, `worldDataToken`). `now` is the clock
 *   each tick reads (`performance.now` by default; a test's virtual one);
 *   `date`, the epoch ms a `live` motion clock reads (the system clock's by
 *   default). The loop's rate starts as the widget's own; once set, it is
 *   the lower of `setTargetFps`'s and the quality port's `targetFps` cap.
 *   With `cameraController`, the camera port is that controller's over
 *   Cesium's camera (`controlledCamera.js`); the ports then have
 *   `attachInput` and `suspendCamera`, which the renderer's input port is
 *   wired with.
 */
export function createCesiumPorts(
  widget,
  {
    capabilities,
    credentials = {},
    cameraController,
    now: clockNow = () => performance.now(),
    date = null,
  },
) {
  const scene = widget.scene;
  const camera = scene.camera;
  // Cesium's own tweens (its flights) step on the same clock as the ticks:
  // a scene's tweens read the system clock unless given a time.
  const tweens = scene.tweens;
  const updateTweens = tweens?.update;
  const clockedTweens = (time) =>
    updateTweens.call(tweens, time ?? clockNow() / 1000);
  if (updateTweens) tweens.update = clockedTweens;

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
  let tickNow = clockNow();
  let dt = 0;
  // The preUpdate FrameTime of the tick under way: its `rendering` reads
  // live until the tick has drawn or not, then holds that answer.
  let liveTick = null;
  // The time Cesium stamps the frame in `preUpdate` with, while it runs.
  let stampTime = null;
  const settleTick = (drawn) => {
    if (liveTick)
      Object.defineProperty(liveTick, 'rendering', {
        value: drawn,
        enumerable: true,
      });
    liveTick = null;
  };
  // The camera's `changed`, measured before any `preUpdate` listener moves
  // the camera, in a frame that had no clock tick to measure it at.
  let measureCameraChanged = null;
  const settleUndrawn = () => void settleTick(false);
  const tick = () => {
    measureCameraChanged?.();
    settleTick(false);
    // A tick that does not draw settles at its end; one that does, at
    // preRender, before this runs.
    atEndOfTick(scene, settleUndrawn);
    const now = clockNow();
    dt = (now - tickNow) / 1000;
    tickNow = now;
    frames += 1;
  };
  // A scene time as epoch ms, worked out again only when the time moves:
  // the phases of a frame, and the frames of a paused clock, share one.
  let msJulian = null;
  let msValue = 0;
  // What `setTime` reads a time through.
  const scratchDate = new Date(0);
  const scratchJulian = new Cesium.JulianDate();
  const msOf = (time) => {
    if (msJulian && Cesium.JulianDate.equals(msJulian, time)) return msValue;
    msValue = Cesium.JulianDate.toDate(time).getTime();
    msJulian = Cesium.JulianDate.clone(time, msJulian ?? undefined);
    return msValue;
  };
  const onPhase = (phase) => (_scene, time) => {
    if (frameListeners[phase].size === 0) return;
    const t = {
      frame: frames,
      time: msOf(time ?? widget.clock.currentTime),
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
        get: () => willDraw(scene, time),
      });
      liveTick = t;
      stampTime = time ?? null;
    }
    try {
      frameListeners[phase].fire(t);
    } finally {
      stampTime = null;
    }
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
  // The camera controller's steps, around the preUpdate listeners
  // (`cameraController` only).
  let controlled = null;
  const cameraTick = (time) => ({
    now: tickNow,
    time: msOf(time ?? widget.clock.currentTime),
  });
  const removers = [
    scene.preUpdate.addEventListener(tick),
    scene.preUpdate.addEventListener(
      (_scene, time) => void controlled?.before(cameraTick(time)),
    ),
    scene.preUpdate.addEventListener(onPhase('preUpdate')),
    scene.preUpdate.addEventListener(
      (_scene, time) => void controlled?.after(cameraTick(time)),
    ),
    scene.preRender.addEventListener(drawing),
    scene.preRender.addEventListener(onPhase('preRender')),
    scene.postRender.addEventListener(drew),
    scene.postRender.addEventListener(onPhase('postRender')),
    scene.preRender.addEventListener(() => drawPart.beforeRender()),
    scene.postRender.addEventListener(() => drawPart.afterRender()),
    scene.postRender.addEventListener(() => trimGlobeAfterDraw()),
  ];

  // Holds keep the loop drawing every frame; counted per reason.
  const holds = new Map();
  // Told when the first hold is taken and the last released.
  const heldListeners = listenerList(report);
  function applyHolds() {
    const continuous = holds.size > 0;
    if (scene.requestRenderMode === !continuous) return;
    scene.requestRenderMode = !continuous;
    heldListeners.fire(continuous);
  }
  // On demand means drawn when asked, held or the view changed: never
  // because scene time moved on by itself. With no holds yet, it starts so.
  scene.maximumRenderTimeChange = Infinity;
  scene.requestRenderMode = true;
  let suspended = false;
  // The rate `setTargetFps` asks for (the application's), and the quality
  // port's cap; the loop draws at the lower of those set.
  let targetFps = widget.targetFrameRate > 0 ? widget.targetFrameRate : 0;
  let qualityFps = 0;
  function applyRate() {
    const rate =
      targetFps > 0 && qualityFps > 0
        ? Math.min(targetFps, qualityFps)
        : targetFps || qualityFps;
    widget.targetFrameRate = rate || undefined;
  }

  // Pending one-shot renders; disposal rejects them rather than leave them
  // attached to a scene that will not render again.
  const pendingRenders = new Set();
  /**
   * Resolves after the next drawn frame; rejects after `timeoutMs`, if
   * given, and once the renderer is destroyed.
   */
  function nextPostRender({ timeoutMs } = {}) {
    if (disposed) return Promise.reject(destroyedError());
    return new Promise((resolve, reject) => {
      let timer;
      const settle = (error) => {
        off();
        clearTimeout(timer);
        pendingRenders.delete(settle);
        if (error) reject(error);
        else resolve();
      };
      const off = scene.postRender.addEventListener(() => settle());
      pendingRenders.add(settle);
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
    onHeldChange: (cb) => heldListeners.on(cb),
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
    // Draws even when nothing asked for a frame; throws when it fails.
    renderNow: (options) => renderNow(widget, options),
    renderOnce: (options) => nextPostRender(options),
    setTargetFps(fps) {
      targetFps = fps > 0 ? fps : 0;
      applyRate();
    },
    /**
     * Moves the clock to `ms` and draws it; in `preUpdate`, the frame under
     * way draws at it. Whether the clock then runs on
     * is its owner's: the application's clock keeps running if it was (a
     * clock on Cesium's real-time step moves to its multiplier step, as
     * setting its time does in Cesium).
     */
    setTime(ms) {
      const clock = widget.clock;
      scratchDate.setTime(ms);
      const time = Cesium.JulianDate.fromDate(scratchDate, scratchJulian);
      const changed = !Cesium.JulianDate.equals(clock.currentTime, time);
      // The clock keeps the time it is given; it ignores an equal one.
      if (changed) clock.currentTime = Cesium.JulianDate.clone(time);
      // In `preUpdate` the frame under way draws at it: Cesium stamps the
      // frame with this object next.
      if (stampTime) {
        Cesium.JulianDate.clone(time, stampTime);
        // Later preUpdate listeners read the frame's time from the tick.
        if (liveTick) liveTick.time = ms;
      } else if (changed) frame.requestRender('time');
    },
    time: () => msOf(widget.clock.currentTime),
  };

  // --- Draw ------------------------------------------------------------------

  const drawPart = createCesiumDraw({
    scene,
    report,
    capabilities,
    requestRender: (reason) => frame.requestRender(reason),
    date,
    now: clockNow,
  });
  const { port: draw, sets, tilesets } = drawPart;

  // --- Query -----------------------------------------------------------------

  const query = createCesiumQuery({
    scene,
    camera,
    draw: drawPart,
    capabilities,
  });

  if (cameraController)
    controlled = createControlledCamera({
      scene,
      controller: cameraController,
      query: {
        ...(capabilities.has('pickPosition')
          ? { pickPosition: (x, y) => query.pickPosition(x, y) }
          : {}),
        ...(typeof query.sampleHeightNow === 'function'
          ? { sampleHeightNow: (p, o) => query.sampleHeightNow(p, o) }
          : {}),
      },
      // Where the draw port draws an item, at the scene clock's time.
      ...(capabilities.has('motionSegments')
        ? {
            itemPosition: (item, aheadMs) =>
              drawPart.drawnPosition(item, aheadMs, widget.clock.currentTime),
          }
        : {}),
      requestRender: (reason) => frame.requestRender(reason),
      report,
      thresholds: capabilities.has('cameraChangeThreshold'),
      followFrame: capabilities.has('followFrame'),
    });
  const cameraPart = controlled
    ? { port: controlled.port, dispose: () => controlled.dispose() }
    : createCesiumCamera({
        scene,
        camera,
        report,
        widget,
        capabilities,
        now: clockNow,
        ...(capabilities.has('motionSegments')
          ? {
              itemPosition: (item, time) =>
                drawPart.drawnPosition(item, 0, time),
            }
          : {}),
      });
  const cameraPort = cameraPart.port;
  measureCameraChanged = cameraPart.measureChanged ?? null;
  const effectsPart = createCesiumEffects(scene, {
    capabilities,
    frame,
    report,
  });

  const qualityPart = createCesiumQuality(widget, {
    frame,
    report,
    tickStarted: () => tickNow,
    gl: capabilities.has('gpuTiming') ? webglContext(scene) : null,
    fpsCap: {
      get: () => qualityFps,
      set(fps) {
        qualityFps = fps > 0 ? fps : 0;
        applyRate();
      },
    },
  });

  const creditsPart = createCesiumCredits({
    display: widget.creditDisplay,
    scene,
    report,
    requestRender: () => frame.requestRender('credits'),
  });

  const globePart = createCesiumGlobe(widget, {
    capabilities,
    requestRender: (reason) => frame.requestRender(reason),
    report,
    credits: creditsPart.port,
    credentials,
  });

  /**
   * Whether the canvas still holds the last presented frame: a context that
   * keeps its drawing buffer, once a frame has drawn. Otherwise the frame is
   * drawn again to be read.
   */
  const frameKept = () =>
    rendered > 0 &&
    webglContext(scene)?.getContextAttributes?.()?.preserveDrawingBuffer ===
      true;

  /**
   * The last presented frame, encoded: `crop` in CSS pixels, `scale`
   * relative to the canvas's CSS size, `quality` for JPEG. Read from the
   * canvas as it is where it keeps that frame, so a capture draws nothing.
   */
  async function capture({ type = 'png', quality, crop, scale = 1 } = {}) {
    if (disposed) throw destroyedError();
    if (!frameKept()) scene.render(widget.clock.currentTime);
    const out = document.createElement('canvas').getContext('2d');
    copyFrame(out, crop, scale);
    return new Promise((resolve, reject) =>
      out.canvas.toBlob(
        (blob) => {
          out.canvas.width = out.canvas.height = 0;
          if (blob) resolve(blob);
          else reject(new Error('the frame could not be encoded'));
        },
        `image/${type}`,
        quality,
      ),
    );
  }

  // The 2D canvas frames are read through, made on the first read.
  let reader = null;

  /**
   * Draws the canvas's frame into the 2D context `into`, `crop` in CSS
   * pixels and `scale` relative to the canvas's CSS size, sized to it.
   * Returns whether there was a frame to draw.
   */
  function copyFrame(into, crop, scale = 1) {
    const canvas = scene.canvas;
    const cssWidth = canvas.clientWidth || canvas.width;
    const cssHeight = canvas.clientHeight || canvas.height;
    const rect = crop ?? { x: 0, y: 0, width: cssWidth, height: cssHeight };
    const width = Math.max(1, Math.round(rect.width * scale));
    const height = Math.max(1, Math.round(rect.height * scale));
    into.canvas.width = width;
    into.canvas.height = height;
    // A canvas with no size has drawn nothing: the copy is blank.
    if (!canvas.width || !canvas.height) return false;
    const sx = canvas.width / cssWidth;
    const sy = canvas.height / cssHeight;
    into.drawImage(
      canvas,
      rect.x * sx,
      rect.y * sy,
      rect.width * sx,
      rect.height * sy,
      0,
      0,
      width,
      height,
    );
    return true;
  }

  /**
   * The drawn frame's pixels, `crop` in CSS pixels and `scale` relative to
   * the canvas's CSS size. Read straight off the canvas: the application
   * and conformance widgets keep their drawing buffers, and a read right
   * after a draw sees it either way.
   */
  function readPixels({ crop, scale = 1 } = {}) {
    const made =
      reader ??
      document
        .createElement('canvas')
        .getContext('2d', { willReadFrequently: true });
    // Disposed ports keep nothing to free.
    if (!disposed) reader = made;
    copyFrame(made, crop, scale);
    return made.getImageData(0, 0, made.canvas.width, made.canvas.height);
  }

  // A release asked for whose globe trim waits for the next drawn frame.
  let trimGlobe = false;

  /**
   * Frees the tiles the last frame did not draw: each 3D tileset trims its
   * cache, and a shown globe its own after the next drawn frame. The reader
   * pixels are read through goes too.
   */
  function releaseUnused() {
    if (disposed) return;
    for (const tileset of tilesets()) tileset.trimLoadedTiles();
    if (scene.globe?.show) trimGlobe = true;
    if (reader) {
      reader.canvas.width = reader.canvas.height = 0;
      reader = null;
    }
    frame.requestRender('releaseUnused');
  }
  function trimGlobeAfterDraw() {
    if (!trimGlobe) return;
    trimGlobe = false;
    if (scene.globe?.show) trimGlobeTiles(scene.globe);
  }

  /** The live model sets, for `whenSettled`. */
  const modelSets = () =>
    [...sets.values()].filter((r) => r.kind === 'models' && r.host);

  /**
   * The shown icons' images, for `whenSettled`: `failed` when one could not
   * load, `loading` while one still is, otherwise `settled`.
   */
  function iconState() {
    let loading = false;
    for (const record of sets.values()) {
      // GPU icons read their images from the shared icon atlas.
      if (record.gpu) {
        if (!record.host?.show) continue;
        const state = record.gpu.imageState();
        if (state === 'failed') return 'failed';
        if (state === 'loading') loading = true;
        continue;
      }
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

  /** A hidden globe loads nothing, so it is never what is still loading. */
  const globeLoaded = () =>
    !scene.globe?.show || scene.globe.tilesLoaded !== false;
  /** Whether every shown 3D tileset has loaded what is in view. */
  const tilesLoaded = () =>
    tilesets().every((tileset) => !tileset.show || tileset.tilesLoaded);

  // --- Settling --------------------------------------------------------------

  // Idle watches in progress; disposal ends them rather than leave them
  // waiting on a scene that will not tick again.
  const watching = new Set();

  /** How long the loop must stay idle, drawing nothing, to be settled. */
  const IDLE_MS = 100;
  /** How long without a tick a loop counts as stopped. */
  const STALL_MS = 250;

  /**
   * Watches the loop, without asking for frames, for at least two whole
   * ticks and `IDLE_MS`. Resolves `'idle'` if in that time it drew nothing
   * of its own accord and `busy()` stayed false; `'busy'` as soon as it did;
   * `'ended'` if the ports are disposed or `end` passes first. A draw while
   * a hold keeps the loop drawing every frame is the hold's, not the
   * scene's own; `busy` is asked at each tick's start, before Cesium decides
   * whether it draws.
   * @param {number} end
   * @param {() => boolean} busy Whether work landed that will draw again.
   */
  function watchIdle(end, busy) {
    return new Promise((resolve) => {
      const from = performance.now();
      let ticks = 0;
      const offDraw = scene.postRender.addEventListener(() => {
        if (scene.requestRenderMode) finish('busy');
      });
      // Each preUpdate also ends the tick before it.
      const offTick = scene.preUpdate.addEventListener(() => {
        if (busy()) return finish('busy');
        ticks += 1;
        if (ticks > 2 && performance.now() - from >= IDLE_MS) finish('idle');
      });
      const timer = setTimeout(
        () => finish('ended'),
        Math.max(0, end - performance.now()),
      );
      watching.add(finish);
      function finish(outcome) {
        watching.delete(finish);
        offDraw();
        offTick();
        clearTimeout(timer);
        resolve(outcome);
      }
    });
  }

  async function whenSettled({ timeoutMs = 20000 } = {}) {
    const end = performance.now() + timeoutMs;
    // Cesium redraws on its own after each request or worker task it
    // completes (a terrain picker build after the camera moved, say), which
    // no loading flag shows; settled means that has stopped too. Every
    // scene in the page redraws for any completion, so another scene's work
    // keeps this one from settling: it is drawing.
    let completed = 0;
    // Whether the last look found the engine still at work.
    let busy = false;
    // When the loop last ticked: one that stopped (suspended, say) is named
    // in a timeout, not one that merely ran out of time mid-frame.
    let lastTick = performance.now();
    const offTick = scene.preUpdate.addEventListener(
      () => (lastTick = performance.now()),
    );
    const off = onEngineWorkCompleted(Cesium, () => (completed += 1));
    try {
      let quiet = 0;
      while (performance.now() < end) {
        completed = 0;
        if (disposed) return { state: 'failed', blockers: ['destroyed'] };
        // Bounded by the time left: a suspended loop draws nothing.
        const drawn = await nextPostRender({
          timeoutMs: Math.max(0, end - performance.now()),
        }).then(
          () => true,
          () => false,
        );
        if (disposed) return { state: 'failed', blockers: ['destroyed'] };
        if (!drawn) break;
        if (modelSets().some((r) => r.host.failed > 0))
          return { state: 'failed', blockers: ['models'] };
        const icons = iconState();
        if (icons === 'failed') return { state: 'failed', blockers: ['icons'] };
        quiet = loaded() && !idleBlocked() ? quiet + 1 : 0;
        if (quiet < 3) continue;
        // Then the loop left alone must draw nothing by itself for a while:
        // a worker's first task can take tens of milliseconds, and what is
        // in flight cannot be counted. Something that starts loading
        // meanwhile ends the watch too; the next pass sees it, or its
        // failure.
        const outcome = await watchIdle(end, () => !loaded() || idleBlocked());
        if (outcome === 'idle') return { state: 'settled', blockers: [] };
        if (outcome !== 'busy') break;
        // Work or a draw, unless it was something loading.
        busy = loaded();
        quiet = 0;
      }
      if (disposed) return { state: 'failed', blockers: ['destroyed'] };
      const blockers = [];
      if (!globeLoaded()) blockers.push('globe');
      if (!tilesLoaded()) blockers.push('tiles');
      if (modelSets().some((r) => r.host.loading > 0)) blockers.push('models');
      if (iconState() !== 'settled') blockers.push('icons');
      if (drawPart.building()) blockers.push('draw');
      if (busy) blockers.push('redraw');
      if (performance.now() - lastTick >= STALL_MS) blockers.push('frames');
      return { state: 'timeout', blockers };
    } finally {
      off();
      offTick();
    }

    /** Whether what is in view has loaded, nothing failing. */
    function loaded() {
      const icons = iconState();
      return (
        globeLoaded() &&
        tilesLoaded() &&
        icons === 'settled' &&
        !drawPart.building() &&
        !modelSets().some((r) => r.host.loading > 0 || r.host.failed > 0)
      );
    }

    /**
     * Work since the last look that will draw again, or a draw queued (one a
     * hold makes anyway is the hold's).
     */
    function idleBlocked() {
      busy = completed > 0 || (scene.requestRenderMode && renderPending(scene));
      completed = 0;
      return busy;
    }
  }

  return {
    /** The renderer's own events: `error`, `contextLost`, `contextRestored`. */
    on(event, cb) {
      return rendererListeners[event]?.on(cb) ?? (() => {});
    },
    report,
    frame,
    globe: globePart.port,
    draw,
    camera: cameraPort,
    ...(controlled
      ? {
          attachInput: (input) => controlled.attachInput(input),
          suspendCamera: (reason) => controlled.suspendCamera(reason),
        }
      : {}),
    credits: creditsPart.port,
    query,
    effects: effectsPart.port,
    quality: qualityPart.port,
    capture,
    readPixels,
    releaseUnused,
    whenSettled,
    /** Detach from the scene; the widget's owner destroys the widget. */
    dispose() {
      disposed = true;
      for (const finish of [...watching]) finish('ended');
      trimGlobe = false;
      if (reader) reader.canvas.width = reader.canvas.height = 0;
      reader = null;
      // The tick under way is no longer seen through: it is not claimed.
      settleTick(false);
      for (const off of removers) off();
      scene.canvas?.removeEventListener?.('webglcontextlost', contextLost);
      // Cesium's own tween clock back, unless another set wrapped it since.
      if (updateTweens && tweens.update === clockedTweens)
        tweens.update = updateTweens;
      // A listener that disposes the renderer stops the rest of its event.
      for (const list of Object.values(rendererListeners)) list.clear();
      for (const list of Object.values(frameListeners)) list.clear();
      heldListeners.clear();
      drawPart.dispose();
      cameraPart.dispose();
      creditsPart.dispose();
      effectsPart.dispose();
      globePart.dispose();
      qualityPart.dispose();
      for (const settle of [...pendingRenders]) settle(destroyedError());
    },
  };
}
