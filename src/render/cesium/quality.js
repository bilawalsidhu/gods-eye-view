/**
 * @module render/cesium/quality
 * @description The Cesium renderer's quality port
 * (`src/render/contract/quality.d.ts`) over a widget or viewer someone else
 * made and configured. It supports the settings Cesium has a knob for:
 *
 * - `pixelRatio`: the widget's `resolutionScale` at the browser's
 *   recommended resolution, which Cesium takes as one pixel per CSS pixel,
 *   so 0 (browser recommended) is a scale of 1.
 * - `msaa`: the scene's `msaaSamples` (0 is Cesium's 1, off), listed only
 *   when the context can multisample.
 * - `shadows`: the scene's shadow map, on or off.
 * - `tiles3dDetail` and `terrainDetail`: each 3D tileset's and the globe's
 *   `maximumScreenSpaceError`, as their own value at 1 and up to 8 times it
 *   at 0. While tile detail is lowered, a tileset added later is brought
 *   to it on the next drawn frame; an error is written only when it
 *   changes, since each write resets the tileset's memory-adjusted error.
 * - `targetFps`: the frame port's target frame rate, 0 for none.
 *
 * Building the port changes nothing in the scene; each setting is applied
 * when it is first set, and a detail set back to 1 hands each tileset and
 * the globe the error it had (or was given since). There is no GPU timing:
 * frame signals carry the CPU time of each drawn tick, from the tick's start
 * (before any frame listener) to the end of its draw.
 */
import * as Cesium from 'cesium';
import { listenerList } from './common.js';

const MSAA_OPTIONS = Object.freeze([0, 2, 4, 8]);
/** Screen-space error at detail 0, as a multiple of the error at detail 1. */
const COARSEST = 8;
const MAX_PIXEL_RATIO = 4;
const MAX_FPS = 240;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
/** `value` as a number in range, or null when it is not a number. */
const inRange = (value, min, max) => {
  const n = Number(value);
  return Number.isFinite(n) ? clamp(n, min, max) : null;
};

/** The screen-space error multiplier for a detail, 0..1. */
export const errorFactor = (detail) => COARSEST ** (1 - clamp(detail, 0, 1));

/**
 * The 3D tilesets in a primitive collection, nested collections included.
 * @param {object} collection
 * @param {(p: object) => boolean} isTileset
 * @param {(p: object) => boolean} isCollection
 * @param {object[]} [out]
 */
function tilesetsIn(collection, isTileset, isCollection, out = []) {
  for (let i = 0; i < collection.length; i++) {
    const primitive = collection.get(i);
    if (isTileset(primitive)) out.push(primitive);
    else if (isCollection(primitive))
      tilesetsIn(primitive, isTileset, isCollection, out);
  }
  return out;
}

/**
 * @param {object} widget A Cesium `CesiumWidget` or `Viewer`.
 * @param {{
 *   frame: import('../contract/frame').FramePort,
 *   report: (error: unknown) => void,
 *   isTileset?: (p: object) => boolean,
 *   isCollection?: (p: object) => boolean,
 *   limits?: {maximumTextureSize: number, maximumSamples: number},
 *   tickStarted?: () => number,
 * }} options `tickStarted` is when the tick under way started, on the
 *   `performance.now()` clock; without it the port times from its own
 *   preUpdate listener. Tests pass the predicates and limits; they default
 *   to Cesium's classes and context limits.
 * @returns {{port: import('../contract/quality').QualityPort,
 *   dispose: () => void}}
 */
export function createCesiumQuality(
  widget,
  {
    frame,
    report,
    isTileset = (p) => p instanceof Cesium.Cesium3DTileset,
    isCollection = (p) => p instanceof Cesium.PrimitiveCollection,
    limits = Cesium.ContextLimits,
    tickStarted = null,
  },
) {
  const scene = widget.scene;
  let disposed = false;
  const gone = () => disposed || scene.isDestroyed?.() === true;

  /** The multisample counts the context can draw with; 0 is off. */
  const msaaOptions = () =>
    scene.msaaSupported
      ? MSAA_OPTIONS.filter((n) => n <= limits.maximumSamples)
      : [];

  // What the scene had before the port first changed it: the defaults.
  const builtFps = frame.diagnostics?.().targetFps ?? 0;
  let msaaAtBuild = null;
  let shadowsAtBuild = null;
  // Cesium clamps the count to the context's only when it is set.
  const toContractMsaa = (samples) =>
    samples > 1 ? Math.min(samples, limits.maximumSamples) : 0;
  const builtMsaa = () => msaaAtBuild ?? toContractMsaa(scene.msaaSamples);
  const builtShadows = () =>
    shadowsAtBuild ?? Boolean(scene.shadowMap?.enabled);

  let pixelRatio = 0;

  // Each detail and the errors it was applied over.
  const detail = { tiles: 1, terrain: 1 };
  /** Tileset (or the globe) → {own, applied}. */
  const errors = new Map();
  let offWatch = null;

  /** Brings `target`'s error to `factor` times its own. */
  function applyError(target, factor) {
    let entry = errors.get(target);
    const current = target.maximumScreenSpaceError;
    // A value someone set since is its own from then on.
    if (!entry || current !== entry.applied)
      entry = { own: current, applied: current };
    entry.applied = entry.own * factor;
    if (target.maximumScreenSpaceError !== entry.applied)
      target.maximumScreenSpaceError = entry.applied;
    errors.set(target, entry);
  }

  /** Hands `target` back its own error, unless someone set one since. */
  function restoreError(target) {
    const entry = errors.get(target);
    if (entry && target.maximumScreenSpaceError === entry.applied)
      target.maximumScreenSpaceError = entry.own;
    errors.delete(target);
  }

  /** Brings every tileset in the scene to the tile detail. */
  function applyTiles() {
    if (gone()) return;
    const tilesets = scene.primitives
      ? tilesetsIn(scene.primitives, isTileset, isCollection)
      : [];
    const live = new Set(tilesets);
    // One taken out of the scene gets its own error back.
    for (const target of [...errors.keys()])
      if (target === scene.globe) continue;
      else if (target.isDestroyed?.()) {
        errors.delete(target);
      } else if (!live.has(target)) restoreError(target);
    for (const tileset of tilesets)
      if (detail.tiles === 1) restoreError(tileset);
      else applyError(tileset, errorFactor(detail.tiles));
    // Tilesets come and go: while tile detail is lowered, each drawn frame
    // looks, before the tilesets update.
    const lowered = detail.tiles !== 1;
    if (lowered && !offWatch)
      offWatch = scene.preRender.addEventListener(applyTiles);
    else if (!lowered && offWatch) {
      offWatch();
      offWatch = null;
    }
  }

  function applyTerrain() {
    if (gone() || !scene.globe) return;
    if (detail.terrain === 1) restoreError(scene.globe);
    else applyError(scene.globe, errorFactor(detail.terrain));
  }

  function knobs() {
    const list = [
      {
        key: 'pixelRatio',
        kind: 'number',
        min: 0,
        max: MAX_PIXEL_RATIO,
        default: 0,
        cost: 1,
      },
    ];
    const msaa = msaaOptions();
    if (msaa.length > 1)
      list.push({
        key: 'msaa',
        kind: 'enum',
        options: msaa,
        default: builtMsaa(),
        cost: 0.4,
      });
    if (scene.shadowMap)
      list.push({
        key: 'shadows',
        kind: 'boolean',
        default: builtShadows(),
        cost: 0.6,
      });
    list.push(
      {
        key: 'tiles3dDetail',
        kind: 'number',
        min: 0,
        max: 1,
        default: 1,
        cost: 0.8,
        couples: ['lower detail lowers height accuracy'],
      },
      {
        key: 'terrainDetail',
        kind: 'number',
        min: 0,
        max: 1,
        default: 1,
        cost: 0.4,
        couples: ['lower detail lowers height accuracy'],
      },
      {
        key: 'targetFps',
        kind: 'number',
        min: 0,
        max: MAX_FPS,
        default: builtFps,
        cost: 0.2,
      },
    );
    return list;
  }

  const setters = {
    pixelRatio(value) {
      const ratio = inRange(value, 0, MAX_PIXEL_RATIO);
      if (ratio === null) return;
      pixelRatio = ratio;
      widget.useBrowserRecommendedResolution = true;
      widget.resolutionScale = ratio || 1;
    },
    msaa(value) {
      const options = msaaOptions();
      if (options.length <= 1) return false;
      msaaAtBuild ??= toContractMsaa(scene.msaaSamples);
      // The most samples the context has, up to the count asked for.
      const asked = inRange(value, 0, Infinity);
      if (asked === null) return;
      const samples = options.filter((n) => n <= asked).pop() ?? 0;
      scene.msaaSamples = samples || 1;
    },
    shadows(value) {
      if (!scene.shadowMap) return false;
      shadowsAtBuild ??= Boolean(scene.shadowMap.enabled);
      scene.shadowMap.enabled = Boolean(value);
    },
    tiles3dDetail(value) {
      detail.tiles = inRange(value, 0, 1) ?? detail.tiles;
      applyTiles();
    },
    terrainDetail(value) {
      detail.terrain = inRange(value, 0, 1) ?? detail.terrain;
      applyTerrain();
    },
    targetFps(value) {
      const fps = inRange(value, 0, MAX_FPS);
      if (fps !== null) frame.setTargetFps(fps);
    },
  };

  function get() {
    const settings = {
      pixelRatio,
      tiles3dDetail: detail.tiles,
      terrainDetail: detail.terrain,
      targetFps: frame.diagnostics?.().targetFps ?? 0,
    };
    if (scene.shadowMap) settings.shadows = Boolean(scene.shadowMap.enabled);
    if (msaaOptions().length > 1)
      settings.msaa = toContractMsaa(scene.msaaSamples);
    return settings;
  }

  function device() {
    return {
      backend: scene.context?.webgl2 ? 'webgl2' : 'webgl1',
      maxTextureSize: limits.maximumTextureSize,
      msaaSamples: scene.msaaSupported ? msaaOptions() : [0],
      gpuTimer: false,
    };
  }

  // --- Frame signals ---------------------------------------------------------

  const signalListeners = listenerList(report);
  let tickStart = 0;
  let requested = false;
  let mode = 'demand';
  const removers = [
    ...(tickStarted
      ? []
      : [
          scene.preUpdate.addEventListener(() => {
            tickStart = performance.now();
          }),
        ]),
    scene.preRender.addEventListener(() => {
      if (signalListeners.size === 0) return;
      const pending = frame.diagnostics?.().pendingReasons ?? [];
      requested = pending.length > 0;
      mode = scene.requestRenderMode ? 'demand' : 'continuous';
    }),
    scene.postRender.addEventListener(() => {
      if (signalListeners.size === 0) return;
      signalListeners.fire({
        cpuMs: performance.now() - (tickStarted ? tickStarted() : tickStart),
        pixelRatio: scene.pixelRatio ?? 1,
        width: scene.drawingBufferWidth ?? scene.canvas?.width ?? 0,
        height: scene.drawingBufferHeight ?? scene.canvas?.height ?? 0,
        mode,
        requested,
        holds: frame.diagnostics?.().holds ?? [],
      });
    }),
  ];

  const port = {
    knobs,
    get,
    set(settings) {
      const ignored = [];
      if (gone()) return Object.keys(settings ?? {});
      for (const [key, value] of Object.entries(settings ?? {})) {
        const apply = Object.hasOwn(setters, key) ? setters[key] : null;
        if (!apply || apply(value) === false) ignored.push(key);
      }
      frame.requestRender('quality');
      return ignored;
    },
    device,
    probe() {
      const nav = globalThis.navigator;
      const media = (query) => globalThis.matchMedia?.(query).matches === true;
      return {
        device: device(),
        browser: {
          devicePixelRatio: globalThis.devicePixelRatio ?? 1,
          screen: {
            width: globalThis.screen?.width ?? 0,
            height: globalThis.screen?.height ?? 0,
          },
          hardwareConcurrency: nav?.hardwareConcurrency,
          deviceMemory: nav?.deviceMemory,
          touchOnly:
            media('(pointer: coarse)') && !media('(any-pointer: fine)'),
        },
        knobs: knobs(),
      };
    },
    signals: {
      gpuTiming: 'none',
      on(event, cb) {
        if (event !== 'frame') return () => {};
        return signalListeners.on(cb);
      },
    },
  };

  return {
    port,
    /** Stops the signals and the detail watch; settings stay as set. */
    dispose() {
      if (disposed) return;
      disposed = true;
      signalListeners.clear();
      for (const off of removers) off();
      offWatch?.();
      offWatch = null;
    },
  };
}
