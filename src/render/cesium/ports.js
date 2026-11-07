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
import { listenerList, toCartesian, uncaught } from './common.js';
import { createCesiumCredits } from './credits.js';
import { createCesiumDraw } from './draw.js';
import { GPU_ICON_CAPABILITIES } from './gpuIcons.js';
import { createCesiumEffects } from './effects.js';
import { willDraw } from './frame.js';
import { createCesiumGlobe } from './globe.js';
import { createCesiumQuery, queryCapabilities } from './query.js';
import { createCesiumQuality } from './quality.js';
import {
  atEndOfTick,
  billboardLoadError,
  onEngineWorkCompleted,
  renderPending,
  trimGlobeTiles,
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
];

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
  const all = [
    'models',
    ...GPU_ICON_CAPABILITIES,
    'styles',
    'bloom',
    'sharpen',
    ...GLOBE_CAPABILITIES,
    ...queryCapabilities(scene),
  ];
  const allowed = only && new Set(only);
  return all.filter((c) => !allowed || allowed.has(c));
}

/**
 * @param {object} widget A Cesium `CesiumWidget` or `Viewer`.
 * @param {{capabilities: ReadonlySet<string>, credentials?: object}} options
 *   The renderer's capabilities, which gate the members that need them, and
 *   the credentials its globe loads photoreal tiles and world data with
 *   (`googleApiKey`, `googleTokens`, `worldDataToken`).
 */
export function createCesiumPorts(widget, { capabilities, credentials = {} }) {
  const scene = widget.scene;
  const camera = scene.camera;

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
        get: () => willDraw(scene, time),
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
    scene.preRender.addEventListener(() => drawPart.beforeRender()),
    scene.postRender.addEventListener(() => drawPart.afterRender()),
    scene.postRender.addEventListener(() => trimGlobeAfterDraw()),
  ];

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

  const drawPart = createCesiumDraw({ scene, report, capabilities });
  const { port: draw, sets, tilesets } = drawPart;

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

  const globePart = createCesiumGlobe(widget, {
    capabilities,
    requestRender: (reason) => frame.requestRender(reason),
    report,
    credits: creditsPart.port,
    credentials,
  });

  // --- Query -----------------------------------------------------------------

  const query = createCesiumQuery({
    scene,
    camera,
    draw: drawPart,
    capabilities,
  });

  async function capture({ type = 'png' } = {}) {
    scene.render(widget.clock.currentTime);
    return new Promise((resolve) =>
      scene.canvas.toBlob(resolve, `image/${type}`),
    );
  }

  // The 2D canvas frames are read through, made on the first read.
  let reader = null;

  /**
   * The drawn frame's pixels, `crop` in CSS pixels and `scale` relative to
   * the canvas's CSS size. Read straight off the canvas: the application
   * and conformance widgets keep their drawing buffers, and a read right
   * after a draw sees it either way.
   */
  function readPixels({ crop, scale = 1 } = {}) {
    const canvas = scene.canvas;
    const cssWidth = canvas.clientWidth || canvas.width;
    const cssHeight = canvas.clientHeight || canvas.height;
    const rect = crop ?? { x: 0, y: 0, width: cssWidth, height: cssHeight };
    const width = Math.max(1, Math.round(rect.width * scale));
    const height = Math.max(1, Math.round(rect.height * scale));
    const made =
      reader ??
      document
        .createElement('canvas')
        .getContext('2d', { willReadFrequently: true });
    // Disposed ports keep nothing to free.
    if (!disposed) reader = made;
    made.canvas.width = width;
    made.canvas.height = height;
    // A canvas with no size has drawn nothing: the read is blank.
    if (!canvas.width || !canvas.height)
      return made.getImageData(0, 0, width, height);
    const sx = canvas.width / cssWidth;
    const sy = canvas.height / cssHeight;
    made.drawImage(
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
    return made.getImageData(0, 0, width, height);
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
      // A listener that disposes the renderer stops the rest of its event.
      for (const list of Object.values(rendererListeners)) list.clear();
      for (const list of Object.values(frameListeners)) list.clear();
      drawPart.dispose();
      cameraPart.dispose();
      creditsPart.dispose();
      effectsPart.dispose();
      globePart.dispose();
      qualityPart.dispose();
      for (const done of [...pendingRenders]) done();
    },
  };
}
