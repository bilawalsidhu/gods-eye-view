/**
 * @module render/cesium/sceneRenderer
 * @description The part of the Cesium renderer the reference scenes need,
 * through the contract's own members: a bare globe and sky, icons, points,
 * lines, shapes and models, `setView`, picks and projection, the frame
 * phases, pointer input, credits, effects, settling and capture. The
 * `/dev/conformance/` page draws the scenes with it to make and check the
 * visual references.
 *
 * Its ports are `ports.js`'s, which the application's renderer shares;
 * this factory adds the conformance widget, its fixed settings, the input
 * port (`input.js`, not yet the application's) and the bare-globe and sky
 * members.
 *
 * It is not yet the whole Cesium renderer: each later migration adds the
 * members its layer family needs, until it passes the whole suite.
 * Members it does not have are absent, never stubbed.
 */
import * as Cesium from 'cesium';
import { createCesiumInput } from './input.js';
import { onEngineWorkCompleted, renderPending } from './internals.js';
import { cesiumCapabilities, createCesiumPorts } from './ports.js';

export { toCartesian, toColor, toImage } from './ports.js';

/** Each renderer's pointer feed, for the conformance harness. */
const feeds = new WeakMap();

/**
 * Delivers one pointer event to a renderer this made, as its handler would.
 * @param {object} renderer
 * @returns {((type: string, x: number, y: number, extra?: object) => void) | null}
 */
export const pointerFeedOf = (renderer) => feeds.get(renderer) ?? null;

const SKY_DEFAULTS = Object.freeze({
  atmosphere: false,
  stars: false,
  milkyWay: 0,
  sun: false,
  moon: false,
  fog: false,
  lighting: false,
});

/**
 * @param {{container: HTMLElement, msaa?: number, capabilities?: Iterable<string>}} options
 *   `capabilities` limits the renderer to those it lists.
 * @returns {Promise<object>} A renderer with the members listed above.
 */
export async function createCesiumSceneRenderer({
  container,
  msaa = 4,
  capabilities: only,
}) {
  const credits = document.createElement('div');
  const widget = new Cesium.CesiumWidget(container, {
    baseLayer: false,
    terrainProvider: new Cesium.EllipsoidTerrainProvider(),
    skyBox: false,
    skyAtmosphere: false,
    requestRenderMode: true,
    maximumRenderTimeChange: Infinity,
    msaaSamples: msaa,
    creditContainer: credits,
    contextOptions: { webgl: { preserveDrawingBuffer: true } },
  });
  const scene = widget.scene;
  // A fixed time, so lighting is the same in every capture; `setTime`
  // moves it and it stays there.
  widget.clock.shouldAnimate = false;
  widget.clock.currentTime = Cesium.JulianDate.fromIso8601(
    '2026-06-21T18:00:00Z',
  );
  scene.globe.baseColor = Cesium.Color.fromCssColorString('#1c2a36');
  scene.backgroundColor = Cesium.Color.BLACK;
  scene.globe.showGroundAtmosphere = false;
  scene.fog.enabled = false;
  if (scene.sun) scene.sun.show = false;
  if (scene.moon) scene.moon.show = false;

  const sky = { ...SKY_DEFAULTS };
  const capabilities = new Set(cesiumCapabilities(scene, only));

  function applySky() {
    scene.globe.enableLighting = sky.lighting;
    scene.fog.enabled = sky.fog;
    if (scene.sun) scene.sun.show = sky.sun;
    if (scene.moon) scene.moon.show = sky.moon;
    scene.globe.showGroundAtmosphere = sky.atmosphere;
    scene.requestRender();
  }

  const ports = createCesiumPorts(widget, { capabilities });
  const input = createCesiumInput(widget, {
    query: ports.query,
    report: ports.report,
  });

  // --- Globe -----------------------------------------------------------------

  const globe = {
    async setBase(base) {
      if (
        base.photoreal ||
        (base.terrain && base.terrain.kind !== 'ellipsoid') ||
        base.imagery?.length
      )
        throw new Error('the scene renderer draws a bare globe only');
      return { photoreal: { route: 'none' }, imagery: [], settled: true };
    },
    setGlobeVisible(visible) {
      scene.globe.show = visible;
      scene.requestRender();
    },
    sky: {
      get: () => ({ ...sky }),
      set(settings) {
        Object.assign(sky, settings);
        applySky();
      },
    },
    isSettled: () => scene.globe.tilesLoaded,
  };

  // --- Renderer --------------------------------------------------------------

  let destroyed = false;
  // Idle watches in progress; destroy ends them rather than leave them
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
   * `'ended'` if the renderer is destroyed or `end` passes first. A draw while a hold keeps
   * the loop drawing every frame is the hold's, not the scene's own; `busy`
   * is asked at each tick's start, before Cesium decides whether it draws.
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
    const models = ports.modelSets;
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
        if (destroyed) return { state: 'failed', blockers: ['destroyed'] };
        // Bounded by the time left: a suspended loop draws nothing.
        const drawn = await ports
          .nextPostRender({ timeoutMs: Math.max(0, end - performance.now()) })
          .then(
            () => true,
            () => false,
          );
        if (destroyed) return { state: 'failed', blockers: ['destroyed'] };
        if (!drawn) break;
        if (models().some((r) => r.host.failed > 0))
          return { state: 'failed', blockers: ['models'] };
        const icons = ports.iconState();
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
      if (destroyed) return { state: 'failed', blockers: ['destroyed'] };
      const blockers = [];
      if (!scene.globe.tilesLoaded) blockers.push('globe');
      if (models().some((r) => r.host.loading > 0)) blockers.push('models');
      if (ports.iconState() !== 'settled') blockers.push('icons');
      if (busy) blockers.push('redraw');
      if (performance.now() - lastTick >= STALL_MS) blockers.push('frames');
      return { state: 'timeout', blockers };
    } finally {
      off();
      offTick();
    }

    /** Whether what is in view has loaded, nothing failing. */
    function loaded() {
      const icons = ports.iconState();
      return (
        scene.globe.tilesLoaded &&
        icons === 'settled' &&
        !models().some((r) => r.host.loading > 0 || r.host.failed > 0)
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

  const renderer = {
    id: 'cesium',
    contractVersion: '0',
    capabilities,
    canvas: scene.canvas,
    frame: ports.frame,
    globe,
    // A member of a capability left out is absent, not stubbed.
    draw: capabilities.has('models')
      ? ports.draw
      : Object.fromEntries(
          Object.entries(ports.draw).filter(([kind]) => kind !== 'models'),
        ),
    camera: ports.camera,
    query: ports.query,
    input: input.port,
    effects: ports.effects,
    quality: ports.quality,
    capture: ports.capture,
    credits: ports.credits,
    whenSettled,
    resize: () => widget.resize(),
    on: ports.on,
    destroy() {
      destroyed = true;
      for (const finish of [...watching]) finish('ended');
      input.dispose();
      ports.dispose();
      widget.destroy();
    },
  };
  feeds.set(renderer, input.feed);
  return renderer;
}
