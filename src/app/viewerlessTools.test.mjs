import test from 'node:test';
import assert from 'node:assert/strict';
import { createApplicationTools } from './tools.js';
import { navaraModeNotice } from './navaraMode.js';
import {
  createLayerAvailability,
  createRendererRegistry,
} from './layers/renderers.js';
import { createFakeEngine } from '../globe/testing/fakeEngine.js';
import {
  _resetRenderGovernorForTest,
  holdContinuousRender,
  isRenderGovernorInstalled,
  releaseContinuousRender,
} from '../renderGovernor.js';

// The tools without a viewer (the experimental Navara engine); they load
// from src/app/navaraMode.js.
test('without a viewer the tools run the governor on the engine, show the notice, create no viewer tools and run voice on the engine', async (t) => {
  const saved = { window: globalThis.window, document: globalThis.document };
  const listeners = new Map();
  globalThis.window = {};
  globalThis.document = {
    hidden: false,
    addEventListener: (type, fn) => listeners.set(type, fn),
    removeEventListener: (type, fn) => {
      if (listeners.get(type) === fn) listeners.delete(type);
    },
  };
  t.after(() => {
    _resetRenderGovernorForTest();
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete globalThis[name];
      else globalThis[name] = value;
    }
  });
  // The voice pointer listens on the engine's canvas.
  const canvas = new EventTarget();
  const engine = createFakeEngine({ kind: 'navara', canvas });
  const notices = [];
  const chrome = [];
  const cleanups = [];
  let flushed = 0;
  const styleManager = {
    _showGlobalStatusNotice: (label, options) =>
      notices.push({ label, options }),
  };
  const dataManager = { layers: new Map(), getAll: () => [] };
  // Voice without DOM or provider: a control and session stand-in.
  const button = new EventTarget();
  button.setAttribute = () => {};
  let uiRemoved = 0;
  const voice = {
    createControl: () => ({
      update() {},
      on: () => () => {},
      remove: () => uiRemoved++,
    }),
    createCard: () => null,
    createSession: (hooks) => ({
      runner: (voice.runner = hooks.runner),
      async start() {},
      stop() {},
      sendText() {},
      sendMapEvent() {},
    }),
  };
  const tools = await createApplicationTools({
    scene: {
      viewer: null,
      engine,
      tileset: null,
      mapStackController: { kind: 'maps' },
      operations: { surface: { kind: 'surface' } },
    },
    voice,
    controls: { styleManager, weatherEffects: null, cockpitCloudEffects: null },
    data: { dataManager, presentation: { flushVisible: () => flushed++ } },
    loadingScreen: { kind: 'loading' },
    startChrome: (options) => {
      chrome.push(options);
      return () => {};
    },
    signal: new AbortController().signal,
    defer: (dispose) => cleanups.push(dispose),
  });
  assert.equal(tools.sceneDirector, null);
  assert.equal(tools.annotations, null);
  assert.ok(tools.voiceCommands, 'voice runs on the engine');
  assert.equal(window.__gevVoiceCommands, tools.voiceCommands);
  // The W1 tools drive the engine; the viewer-only ones refuse.
  const view = await voice.runner('get_current_view_state');
  assert.equal(view.ok, true);
  const scene = await voice.runner('control_scene', {
    action: 'list',
  });
  assert.equal(scene.ok, false);
  assert.equal(scene.code, 'UNAVAILABLE_ON_ENGINE');
  assert.equal(chrome.length, 1);
  assert.equal(chrome[0].initializeWelcome, null, 'no first-run welcome');
  assert.equal(chrome[0].styleManager, styleManager);
  const notice = navaraModeNotice(createLayerAvailability('navara'));
  assert.deepEqual(notices, [
    {
      label: notice.label,
      options: {
        state: 'retry',
        detail: notice.detail,
        persistent: true,
      },
    },
  ]);
  assert.match(
    `${notice.label}: ${notice.detail}`,
    /^Experimental Navara engine: no data layers on this engine yet; cockpit and director are unavailable$/i,
  );
  // With Navara renderers, the notice names the layers it shows.
  const registry = createRendererRegistry();
  registry.register('navara', { satellites: () => ({}), flights: () => ({}) });
  assert.equal(
    navaraModeNotice(createLayerAvailability('navara', { registry })).detail,
    'Data layers: Live Flights, Satellites; the other layers and director are unavailable',
  );
  // The governor drives the engine's continuous rendering.
  assert.equal(isRenderGovernorInstalled(engine), true);
  holdContinuousRender('qa');
  assert.equal(engine.render.isContinuous(), true);
  releaseContinuousRender('qa');
  assert.equal(engine.render.isContinuous(), false);
  const debug = window.__godsEyeView;
  assert.equal(debug.viewer, null);
  assert.equal(debug.engine, engine);
  assert.equal(debug.sceneDirector, null);
  assert.equal(debug.dataManager, dataManager);
  assert.equal(debug.voiceCommands, tools.voiceCommands);
  listeners.get('visibilitychange')();
  assert.equal(flushed, 1);
  while (cleanups.length) await cleanups.pop()();
  assert.equal(window.__godsEyeView, undefined);
  assert.equal(window.__gevVoiceCommands, undefined);
  assert.equal(uiRemoved, 1, 'the voice control is removed');
  assert.equal(listeners.size, 0);
});
