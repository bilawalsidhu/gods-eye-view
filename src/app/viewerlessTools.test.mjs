import test from 'node:test';
import assert from 'node:assert/strict';
import { createApplicationTools } from './tools.js';
import { NAVARA_MODE_NOTICE } from './navaraMode.js';
import { createFakeEngine } from '../globe/testing/fakeEngine.js';
import {
  _resetRenderGovernorForTest,
  holdContinuousRender,
  isRenderGovernorInstalled,
  releaseContinuousRender,
} from '../renderGovernor.js';

// The tools without a viewer (the experimental Navara engine); they load
// from src/app/navaraMode.js.
test('without a viewer the tools run the governor on the engine, show the notice and create no viewer tools', async (t) => {
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
  const engine = createFakeEngine({ kind: 'navara' });
  const notices = [];
  const chrome = [];
  const cleanups = [];
  let flushed = 0;
  const styleManager = {
    _showGlobalStatusNotice: (label, options) =>
      notices.push({ label, options }),
  };
  const dataManager = { layers: new Map() };
  const tools = await createApplicationTools({
    scene: {
      viewer: null,
      engine,
      tileset: null,
      mapStackController: { kind: 'maps' },
      operations: { surface: { kind: 'surface' } },
    },
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
  assert.deepEqual(tools, {
    sceneDirector: null,
    annotations: null,
    voiceCommands: null,
  });
  assert.equal(chrome.length, 1);
  assert.equal(chrome[0].initializeWelcome, null, 'no first-run welcome');
  assert.equal(chrome[0].styleManager, styleManager);
  assert.deepEqual(notices, [
    {
      label: NAVARA_MODE_NOTICE.label,
      options: {
        state: 'retry',
        detail: NAVARA_MODE_NOTICE.detail,
        persistent: true,
      },
    },
  ]);
  assert.match(
    `${NAVARA_MODE_NOTICE.label}: ${NAVARA_MODE_NOTICE.detail}`,
    /^Experimental Navara engine: layers, cockpit, director and voice are unavailable$/i,
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
  listeners.get('visibilitychange')();
  assert.equal(flushed, 1);
  while (cleanups.length) await cleanups.pop()();
  assert.equal(window.__godsEyeView, undefined);
  assert.equal(listeners.size, 0);
});
