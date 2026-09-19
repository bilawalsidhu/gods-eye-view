/**
 * src/voice/ondemand/index.js — wire the OnDemand turn-based voice pipeline
 * into a running OnDemand Spatial application (dev AND serverless builds).
 *
 * Called from src/main.js once `application.start()` resolves with the
 * component map (`{ scene, controls, data, tools }`); falls back to the
 * `window.__godsEyeView` debug handle for anything the map does not carry.
 * Installs the OD VOICE control beside the GEV MIC control, exposes a small
 * headless driving surface on `window.__odVoice`, and returns `dispose()`.
 *
 * Nothing here touches the existing OpenAI Realtime stack (src/voice/*): the
 * only shared piece is the MapAction runner it already created, reused
 * read-only for `mapActions` dispatch (created lazily from the same factory
 * when the debug handle has none).
 */

import { layerFeedState } from '../../data/feedState.js';
import { createTransport } from './transport.js';
import { createBrowserRecorder, createBrowserPlayer } from './audio.js';
import { createVoicePipeline } from './pipeline.js';
import { createOdVoiceUi, bindOdVoiceUi } from './ui.js';

const RAD_TO_DEG = 180 / Math.PI;

function safe(fn, fallback = null) {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

/** Resolve the scene handles from the component map or the debug global. */
export function resolveHandles(components = null, win = globalThis.window) {
  const debug = win?.__godsEyeView || {};
  return {
    viewer: components?.scene?.viewer ?? debug.viewer ?? null,
    styleManager:
      components?.controls?.styleManager ?? debug.styleManager ?? null,
    dataManager: components?.data?.dataManager ?? debug.dataManager ?? null,
    sceneDirector:
      components?.tools?.sceneDirector ?? debug.sceneDirector ?? null,
    annotations: components?.tools?.annotations ?? debug.annotations ?? null,
    voiceCommands:
      components?.tools?.voiceCommands ??
      debug.voiceCommands ??
      win?.__gevVoiceCommands ??
      null,
  };
}

/** Camera lat/lon/height (+ heading) without importing Cesium here. */
export function readCamera(viewer) {
  const cartographic = viewer?.camera?.positionCartographic;
  if (!cartographic) return null;
  const heading = viewer.camera.heading;
  return {
    lat: cartographic.latitude * RAD_TO_DEG,
    lon: cartographic.longitude * RAD_TO_DEG,
    heightM: cartographic.height,
    headingDeg: Number.isFinite(heading)
      ? (((heading * RAD_TO_DEG) % 360) + 360) % 360
      : null,
  };
}

/** Enabled layers + their feed state/reason, from dataManager.getAll() stats. */
export function readLayers(dataManager) {
  const rows = safe(() => dataManager?.getAll?.(), []) || [];
  return rows
    .filter((row) => row && row.showInTogglePanel !== false)
    .map((row) => {
      const stats = row.stats || {};
      const state = layerFeedState(stats);
      const reason =
        stats.error ||
        stats.lastError ||
        stats.statusMessage ||
        stats.status ||
        null;
      const layer = {
        id: row.id,
        name: row.name,
        enabled: Boolean(row.enabled),
        state,
      };
      if (state !== 'nominal' && reason) layer.reason = String(reason);
      if (Number.isFinite(stats.count)) layer.count = stats.count;
      return layer;
    });
}

function readLocality(doc) {
  const text = doc?.getElementById?.('location-mini-city')?.textContent || '';
  return (
    text
      .replace(/^[^A-Za-z0-9]*Location:\s*/i, '')
      .replace(/^--$/, '')
      .trim() || null
  );
}

function readSceneName(sceneDirector) {
  return safe(() => sceneDirector?._getSelectedScene?.()?.name ?? null, null);
}

/**
 * @param {{ components?: object, doc?: Document, win?: Window, transport?: object,
 *           recorder?: object, player?: object, pipelineOptions?: object }} [options]
 */
export function installOndemandVoice({
  components = null,
  doc = globalThis.document,
  win = globalThis.window,
  transport: transportOverride = null,
  recorder: recorderOverride = null,
  player: playerOverride = null,
  pipelineOptions = {},
} = {}) {
  if (!doc || !win) return null;
  const handles = resolveHandles(components, win);
  const { viewer, dataManager, sceneDirector } = handles;

  const transport =
    transportOverride ||
    createTransport({
      storage: safe(() => win.localStorage, null),
    });
  const recorder = recorderOverride || createBrowserRecorder();
  const player = playerOverride || createBrowserPlayer();

  let runnerPromise = null;
  const resolveRunner = () => {
    const existing = resolveHandles(components, win).voiceCommands?.runner;
    if (typeof existing === 'function') return Promise.resolve(existing);
    if (!runnerPromise) {
      runnerPromise = import('../gevActions.js')
        .then(({ createGevActionRunner }) => {
          const live = resolveHandles(components, win);
          if (!live.viewer || !live.dataManager)
            throw new Error('scene not ready for MapActions');
          return createGevActionRunner({
            viewer: live.viewer,
            styleManager: live.styleManager,
            dataManager: live.dataManager,
            sceneDirector: live.sceneDirector,
            annotations: live.annotations,
          });
        })
        .catch((error) => {
          runnerPromise = null;
          throw error;
        });
    }
    return runnerPromise;
  };

  const pipeline = createVoicePipeline({
    transport,
    recorder,
    player,
    setLayerEnabled: dataManager
      ? async (layerId, enabled) => {
          if (dataManager.layers && !dataManager.layers.has(layerId))
            throw new Error(`Layer ${layerId} is not registered in this scene`);
          return dataManager.setEnabled(layerId, enabled, { origin: 'voice' });
        }
      : null,
    runMapAction: async (name, args, options) => {
      const runner = await resolveRunner();
      return runner(name, args, { signal: options?.signal });
    },
    sceneContext: () => ({
      camera: readCamera(viewer || resolveHandles(components, win).viewer),
      scene: readSceneName(sceneDirector),
      locality: readLocality(doc),
      layers: readLayers(dataManager),
    }),
    toolsCatalogue: () => transport.tools(),
    ...pipelineOptions,
  });

  const ui = createOdVoiceUi({ doc });
  const unbind = bindOdVoiceUi(ui, pipeline, { doc });

  const api = {
    pipeline,
    ui,
    press: () => pipeline.press(),
    submitText: (text, options) => pipeline.submitText(text, options),
    cancel: () => pipeline.cancel(),
    getState: () => pipeline.getState(),
    getDetail: () => pipeline.getDetail(),
    getHistory: () => pipeline.getHistory(),
    setMode: (mode) => pipeline.setMode(mode),
    subscribe: (listener) => pipeline.subscribe(listener),
    /** Proxy probes for verification (never returns a key). */
    health: () => transport.health(),
    hasKey: () => transport.hasKey(),
    dispose,
  };
  win.__odVoice = api;

  function dispose() {
    unbind();
    pipeline.dispose();
    if (win.__odVoice === api) delete win.__odVoice;
  }
  return api;
}
