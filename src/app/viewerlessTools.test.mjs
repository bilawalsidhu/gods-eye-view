import test from 'node:test';
import assert from 'node:assert/strict';
import { createApplicationTools } from './tools.js';
import { navaraModeNotice } from './navaraMode.js';
import { LAYER_MANIFEST } from './layers/renderers.js';
import { createFakeEngine } from '../globe/testing/fakeEngine.js';
import {
  renderGovernorFor,
  holdContinuousRender,
  releaseContinuousRender,
} from '../renderGovernor.js';

// The tools on an engine without a viewer (the experimental Navara engine):
// the same tree, with Navara's tool backend (src/app/navaraMode.js).
test('without a viewer the tools run the governor on the engine, show the notice, create no viewer tools and run voice on the engine', async (t) => {
  const saved = {
    window: globalThis.window,
    document: globalThis.document,
    localStorage: globalThis.localStorage,
    location: globalThis.location,
  };
  const listeners = new Map();
  globalThis.window = {};
  // A link that carries an annotation, drawn once the view restores.
  const linked = encodeURIComponent(
    JSON.stringify([{ type: 'pin', target: 'Austin' }]),
  );
  globalThis.location = { search: '', hash: `#v=2&lat=1&lon=2&an=${linked}` };
  let restored;
  const initialRestorePromise = new Promise((resolve) => (restored = resolve));
  globalThis.localStorage = {
    getItem: () => null,
    setItem() {},
    removeItem() {},
  };
  globalThis.document = {
    hidden: false,
    getElementById: () => null,
    querySelector: () => null,
    body: {
      classList: {
        add() {},
        remove() {},
        toggle() {},
        contains() {
          return false;
        },
      },
      appendChild() {},
    },
    addEventListener: (type, fn) => listeners.set(type, fn),
    removeEventListener: (type, fn) => {
      if (listeners.get(type) === fn) listeners.delete(type);
    },
  };
  t.after(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete globalThis[name];
      else globalThis[name] = value;
    }
  });
  // The voice pointer listens on the engine's canvas.
  const canvas = new EventTarget();
  const engine = createFakeEngine({ kind: 'navara', canvas });
  // Navara's extension without its view: no annotation board.
  engine.extensions = { navara: { alignDaylightToRestoredView() {} } };
  const notices = [];
  const chrome = [];
  const cleanups = [];
  let flushed = 0;
  const styleManager = {
    initialRestorePromise,
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
  assert.ok(tools.sceneDirector);
  const ran = [];
  tools.voiceCommands.runner = async (name, args) => {
    ran.push([name, args]);
    return { ok: true };
  };
  restored();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(
    ran,
    [['annotate_map', { annotations: [{ type: 'pin', target: 'Austin' }] }]],
    "the link's annotations are drawn on this engine too",
  );
  assert.equal(tools.annotations, null);
  assert.ok(tools.voiceCommands, 'voice runs on the engine');
  assert.equal(window.__gevVoiceCommands, tools.voiceCommands);
  // View queries use the engine, and scene commands use the shared Director.
  const view = await voice.runner('get_current_view_state');
  assert.equal(view.ok, true);
  const scene = await voice.runner('control_scene', {
    action: 'list',
  });
  assert.equal(scene.ok, true);
  assert.equal(chrome.length, 1);
  assert.equal(chrome[0].initializeWelcome, null, 'no first-run welcome');
  assert.equal(chrome[0].styleManager, styleManager);
  const notice = navaraModeNotice();
  assert.match(notice.detail, /^Data layers: Bhote Koshi Flood, /);
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
  const none = navaraModeNotice({});
  assert.match(
    `${none.label}: ${none.detail}`,
    /^Experimental Navara engine: no registered data layers$/i,
  );
  // The notice names the layers the engine shows, in catalog order.
  const manifest = {
    satellites: LAYER_MANIFEST.satellites,
    flights: LAYER_MANIFEST.flights,
  };
  assert.equal(
    navaraModeNotice(manifest).detail,
    'Data layers: Live Flights, Satellites',
  );
  // The governor drives the engine's continuous rendering.
  assert.equal(
    renderGovernorFor(engine).getRenderGovernorDiagnostics().installed,
    true,
  );
  holdContinuousRender('qa', engine);
  assert.equal(engine.render.isContinuous(), true);
  releaseContinuousRender('qa', engine);
  assert.equal(engine.render.isContinuous(), false);
  const debug = window.__godsEyeView;
  assert.equal(debug.viewer, null);
  assert.equal(debug.engine, engine);
  assert.equal(debug.sceneDirector, tools.sceneDirector);
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
