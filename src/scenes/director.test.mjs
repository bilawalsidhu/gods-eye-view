import { readSource } from '../testSupport/readSource.js';
// Director-level pins for scene playback.
//
// scenePolicy.test.mjs pins the pure decisions; these pin the wiring, which is
// where every regression in this file's history actually lived: the reconcile
// walking the whole registry, captured tracking params handing the camera back
// to the follow loop, a refused enable reported as success, STOP landing layer
// changes after the operator stopped, and a stale LOAD completing last.
//
// The cancellation pins matter twice over: checking a boolean AFTER an await
// only stops the NEXT step, so the awaited operation itself has to be
// cancellable — an AbortSignal for the data manager, a liveness predicate for
// the visual commit. Several of these assert exactly that plumbing.
import assert from 'node:assert/strict';
import { test, mock } from 'node:test';

import { SceneDirector } from './director.js';
import { SCENE_TRACKING_PARAM_KEYS } from './scenePolicy.js';
import { SCENE_RECIPES } from './recipes.js';

/** The layer registry as main.js builds it (src/main.js dataManager.register calls). */
const REGISTERED = [
  'flights', 'military', 'earthquakes', 'satellites', 'rocket-launches', 'traffic',
  'cctv', 'radio', 'bikeshare', 'ais-live-vessels', 'military-installations',
  'military-awareness', 'local-datacenters', 'local-dams',
  'telegeography-submarine-cables', 'local-firms',
];

/** Layers Space Missions permits while it isolates the globe (contextModePolicy). */
const SPACE_MISSIONS_ALLOWED = new Set(['rocket-launches', 'satellites', 'radio']);

const PROJECT_FIXTURE = {
  version: 3,
  scenes: [{
    id: 'scene-1',
    title: 'Fixture Scene',
    shots: [
      {
        id: 'shot-a',
        title: 'Shot A',
        durationSec: 0.2,
        holdSec: 0,
        camera: { lat: 10, lon: 20, alt: 500000, heading: 0, pitch: -40, roll: 0 },
        visual: { style: 'normal' },
        layers: { flights: { enabled: true } },
      },
      {
        id: 'shot-b',
        title: 'Shot B',
        durationSec: 0.2,
        holdSec: 0,
        camera: { lat: -30, lon: 140, alt: 900000, heading: 0, pitch: -40, roll: 0 },
        visual: { style: 'retro' },
        layers: { traffic: { enabled: true } },
      },
    ],
  }],
};

/**
 * The fixture project plus a second scene, so the panel tests have somewhere
 * to move the selection to (a dropdown and shot rows only differentiate once
 * there is a second target).
 */
const TWO_SCENE_PROJECT = {
  version: 3,
  scenes: [
    ...PROJECT_FIXTURE.scenes,
    {
      id: 'scene-2',
      title: 'Second Scene',
      shots: [{
        id: 'shot-c',
        title: 'Shot C',
        durationSec: 0.2,
        holdSec: 0,
        camera: { lat: 5, lon: 6, alt: 300000, heading: 0, pitch: -40, roll: 0 },
        visual: { style: 'normal' },
        layers: {},
      }],
    },
  ],
};

/** Stub the browser globals the director touches, headlessly. */
function installSceneRuntime(project = PROJECT_FIXTURE) {
  const originalDocument = globalThis.document;
  const originalLocalStorage = globalThis.localStorage;
  const noopClassList = { add() {}, remove() {}, toggle() {}, contains: () => false };

  globalThis.document = {
    getElementById: () => null,
    createElement: () => ({ classList: noopClassList, style: {}, appendChild() {}, remove() {} }),
    addEventListener() {},
    removeEventListener() {},
    body: { classList: noopClassList, appendChild() {} },
  };
  globalThis.localStorage = {
    getItem: () => JSON.stringify(project),
    setItem() {},
    removeItem() {},
  };

  return () => {
    globalThis.document = originalDocument;
    globalThis.localStorage = originalLocalStorage;
  };
}

/**
 * Data manager double recording every reconcile call the director makes.
 *
 * Models the real abort contract (src/data/manager.js): an aborted transition
 * is rolled back through the module's own disable() and answers false, so an
 * abort leaves NO half-applied layer — which is the whole point of passing the
 * signal rather than only checking a boolean afterwards.
 */
function fakeDataManager({ registered = REGISTERED, refuse = () => false } = {}) {
  const enabled = new Map();
  const setEnabledCalls = [];
  const setParamsCalls = [];
  const committed = [];
  return {
    setEnabledCalls,
    setParamsCalls,
    committed,
    getAll: () => registered.map((id) => ({ id, enabled: Boolean(enabled.get(id)) })),
    getLayerParams: () => null,
    async setEnabled(id, shouldEnable, { signal } = {}) {
      setEnabledCalls.push({ id, enabled: shouldEnable, signal });
      if (refuse(id, shouldEnable)) return false;
      // Yield once so a stop landing during the transition is observable.
      await Promise.resolve();
      if (signal?.aborted) return false;
      enabled.set(id, shouldEnable);
      committed.push({ id, enabled: shouldEnable });
      return true;
    },
    setLayerParams(id, params) {
      setParamsCalls.push({ id, params });
      return true;
    },
  };
}

/** Style manager double covering the camera, visual, and Context facades. */
function fakeStyleManager({ contextMode = null, exitFails = false } = {}) {
  const manager = {
    contextMode,
    contextExits: [],
    visualStates: [],
    visualCalls: [],
    runImmediateNavigation: (noun, navigate) => navigate(),
    applyVisualState: async (visual, options = {}) => {
      manager.visualStates.push(visual);
      manager.visualCalls.push({ visual, isCurrent: options.isCurrent });
      return true;
    },
    getCameraState: () => ({ lat: 0, lon: 0, alt: 1000, heading: 0, pitch: -40, roll: 0 }),
    getVisualState: () => ({ style: 'normal' }),
    setRecordingMode() {},
    getContextModeState: () => ({ mode: manager.contextMode, entering: null }),
    async setContextMode(mode) {
      manager.contextExits.push(mode);
      if (exitFails) return { ok: false, error: 'transition did not complete' };
      manager.contextMode = null;
      return { ok: true };
    },
  };
  return manager;
}

/** Cesium viewer double whose flights complete on the next microtask turn. */
function fakeViewer() {
  const flights = [];
  let cancelled = 0;
  return {
    flights,
    get cancelledFlights() { return cancelled; },
    camera: {
      flyTo(options) {
        flights.push(options);
        Promise.resolve().then(() => options.complete?.());
      },
      cancelFlight() { cancelled++; },
    },
  };
}

/** Yield enough turns for the director's pending awaits to advance. */
async function settle(turns = 8) {
  for (let i = 0; i < turns; i++) await Promise.resolve();
}

/**
 * Timer-backed poll for work that starts behind a click handler: the handler
 * drops the director's promise, and a run's shot sleeps are real timers, so
 * neither microtask turns nor an awaited call can observe the progress.
 */
async function waitFor(predicate, { budgetMs = 5000, stepMs = 20 } = {}) {
  const deadline = Date.now() + budgetMs;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'the awaited condition never held');
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
}

/** Build a director over doubles, with the fixture project loaded. */
function makeDirector(options = {}) {
  const restore = installSceneRuntime(options.project);
  const viewer = fakeViewer();
  const styleManager = fakeStyleManager(options.style);
  const dataManager = fakeDataManager(options.data);
  const director = new SceneDirector(viewer, styleManager, dataManager);
  // Telemetry is only accumulated during a run; observable-failure assertions
  // need the accumulator without driving a whole run.
  director._activeRun = { events: [] };
  return { director, viewer, styleManager, dataManager, restore };
}

/** The layer map a shipped recipe declares, in normalized form. */
function recipeLayers(recipeId) {
  const recipe = SCENE_RECIPES.find((item) => item.id === recipeId);
  return Object.fromEntries(
    Object.entries(recipe.layers).map(([id, enabled]) => [id, { enabled }]),
  );
}

test('the director reconciles only the layers a shot declares', async () => {
  // Regression: _applyLayerStates walked the LIVE registry and forced every
  // undeclared layer off, tearing down CCTV/vessels/fires with no restore pass.
  // Pinned here rather than only on the helper, because the walk lived here.
  const { director, dataManager, restore } = makeDirector();
  try {
    await director._applyLayerStates({ flights: { enabled: true }, satellites: { enabled: false } });
    assert.deepEqual(
      dataManager.setEnabledCalls.map(({ id, enabled }) => ({ id, enabled })),
      [
        { id: 'flights', enabled: true },
        { id: 'satellites', enabled: false },
      ],
    );
  } finally {
    restore();
  }
});

test('a shot captured while tracking never re-establishes tracking on playback', async () => {
  // Two writers on the camera is the documented jitter failure mode: the scene
  // claims the camera, then a captured tracking id hands it straight back to
  // the follow loop. Playback drops those keys on the way to the layer.
  const { director, dataManager, restore } = makeDirector();
  try {
    await director._applyLayerStates({
      flights: { enabled: true, params: { models3d: true, selectedFlightsTrackingId: 'a835af' } },
      military: { enabled: true, params: { selectedMilitaryTrackingId: 'ae1460' } },
      satellites: { enabled: true, params: { catalog: 'dense', selectedSatTrackingId: 25544 } },
    });

    const pushed = Object.fromEntries(dataManager.setParamsCalls.map((call) => [call.id, call.params]));
    assert.deepEqual(pushed.flights, { models3d: true });
    assert.deepEqual(pushed.satellites, { catalog: 'dense' });
    // Nothing survived military's params, so nothing is pushed at all.
    assert.equal(Object.hasOwn(pushed, 'military'), false);
    for (const call of dataManager.setParamsCalls) {
      for (const key of SCENE_TRACKING_PARAM_KEYS) {
        assert.equal(Object.hasOwn(call.params, key), false, `${call.id} leaked ${key}`);
      }
    }
  } finally {
    restore();
  }
});

test('a dirty Space Missions state is exited before a recipe applies its layers', async () => {
  // Space Missions refuses every enable outside its own replay bundle. The old
  // full-registry walk dismantled it by accident; the sparse policy never does,
  // so all four Flights Radar enables were refused and reported as success.
  const style = { contextMode: 'space-missions' };
  const holder = {};
  const data = {
    refuse: (id, on) => on
      && holder.styleManager?.contextMode === 'space-missions'
      && !SPACE_MISSIONS_ALLOWED.has(id),
  };
  const { director, styleManager, dataManager, restore } = makeDirector({ style, data });
  holder.styleManager = styleManager;
  try {
    const result = await director._applyLayerStates(recipeLayers('flights-radar'));

    assert.deepEqual(styleManager.contextExits, ['off']);
    assert.equal(styleManager.contextMode, null);
    assert.deepEqual(result.refused, []);
    assert.ok(result.applied.includes('flights'));
    assert.deepEqual(
      dataManager.setEnabledCalls.filter((call) => call.enabled).map((call) => call.id),
      ['flights'],
    );
  } finally {
    restore();
  }
});

test('Orbital Watch does not compose over a Space Missions replay', async () => {
  // Orbital Watch declares satellites, which the guard permits — so nothing is
  // refused and a refusal-only check would pass while rocket-launches stayed
  // on screen. Playback leaves an isolating mode whether or not it refuses.
  const { director, styleManager, dataManager, restore } = makeDirector({
    style: { contextMode: 'space-missions' },
  });
  try {
    await director._applyLayerStates(recipeLayers('orbital-watch'));
    assert.deepEqual(styleManager.contextExits, ['off']);
    assert.equal(
      dataManager.setEnabledCalls.some((call) => call.id === 'rocket-launches'),
      false,
      'the recipe never declares rocket-launches; exiting the mode is what clears it',
    );
  } finally {
    restore();
  }
});

test('a non-isolating context mode is left alone', async () => {
  for (const contextMode of [null, 'flights']) {
    const { director, styleManager, restore } = makeDirector({ style: { contextMode } });
    try {
      await director._applyLayerStates({ flights: { enabled: true } });
      assert.deepEqual(styleManager.contextExits, [], `${contextMode} must not be exited`);
    } finally {
      restore();
    }
  }
});

test('a refused layer is reported, never counted as applied', async () => {
  const { director, dataManager, restore } = makeDirector({
    data: { refuse: (id) => id === 'flights' },
  });
  try {
    const result = await director._applyLayerStates({
      flights: { enabled: true, params: { models3d: true } },
      traffic: { enabled: false },
    });

    assert.deepEqual(result.refused, ['flights']);
    assert.deepEqual(result.applied, ['traffic']);
    // Params must not be pushed at a layer whose transition was vetoed.
    assert.deepEqual(dataManager.setParamsCalls, []);
    const refusals = director._activeRun.events.filter((event) => event.type === 'shot_layers_refused');
    assert.equal(refusals.length, 1);
    assert.deepEqual(refusals[0].payload, { layerIds: ['flights'] });
  } finally {
    restore();
  }
});

test('cancellation between two layers ends the reconcile where it stands', async () => {
  const { director, dataManager, restore } = makeDirector();
  const token = { cancelled: false };
  const inner = dataManager.setEnabled.bind(dataManager);
  dataManager.setEnabled = async (id, on) => {
    const settled = await inner(id, on);
    if (id === 'flights') token.cancelled = true;
    return settled;
  };
  try {
    const result = await director._applyLayerStates({
      flights: { enabled: true },
      satellites: { enabled: true },
      traffic: { enabled: true },
    }, token);

    assert.deepEqual(dataManager.setEnabledCalls.map((call) => call.id), ['flights']);
    assert.equal(result.cancelled, true);
  } finally {
    restore();
  }
});

test('STOP during a suspended visual transition lands no layer changes', async () => {
  // Repro shape from review: applyVisualState suspends (a map-stack switch),
  // STOP arrives, the visual resolves — and the shot's layer pass still ran.
  const { director, viewer, styleManager, dataManager, restore } = makeDirector();
  let releaseVisual;
  styleManager.applyVisualState = (visual) => {
    styleManager.visualStates.push(visual);
    return new Promise((resolve) => { releaseVisual = resolve; });
  };
  try {
    const run = director.startScene('scene-1', { single: true });
    await settle();
    assert.equal(styleManager.visualStates.length, 1, 'the run must be parked on the visual await');

    director.stopScene('Stopped (Esc)');
    releaseVisual();
    await run;

    assert.deepEqual(dataManager.setEnabledCalls, []);
    assert.deepEqual(viewer.flights, []);
    assert.equal(director.running, false);
  } finally {
    restore();
  }
});

test('STOP between two layers lands no further layer changes', async () => {
  const { director, dataManager, restore } = makeDirector({
    project: {
      version: 3,
      scenes: [{
        id: 'scene-1',
        title: 'Fixture Scene',
        shots: [{
          id: 'shot-a',
          title: 'Shot A',
          durationSec: 0.2,
          holdSec: 0,
          camera: { lat: 10, lon: 20, alt: 500000, heading: 0, pitch: -40, roll: 0 },
          visual: { style: 'normal' },
          layers: { flights: { enabled: true }, satellites: { enabled: true }, traffic: { enabled: true } },
        }],
      }],
    },
  });
  const inner = dataManager.setEnabled.bind(dataManager);
  dataManager.setEnabled = async (id, on) => {
    const settled = await inner(id, on);
    if (id === 'flights') director.stopScene('Stopped (Esc)');
    return settled;
  };
  try {
    await director.startScene('scene-1', { single: true });
    assert.deepEqual(dataManager.setEnabledCalls.map((call) => call.id), ['flights']);
  } finally {
    restore();
  }
});

test('STOP aborts the layer transition in flight, not merely the next one', async () => {
  // Checking the token AFTER the await is a backstop, not the fix: by then an
  // un-aborted transition has already committed, and the pass returns without
  // its params — the layer left enabled carrying stale ones. The signal is
  // what actually stops the layer that is currently moving.
  const { director, dataManager, restore } = makeDirector({
    project: {
      version: 3,
      scenes: [{
        id: 'scene-1',
        title: 'Fixture Scene',
        shots: [{
          id: 'shot-a',
          title: 'Shot A',
          durationSec: 0.2,
          holdSec: 0,
          camera: { lat: 10, lon: 20, alt: 500000, heading: 0, pitch: -40, roll: 0 },
          visual: { style: 'normal' },
          layers: {
            flights: { enabled: true, params: { models3d: true } },
            satellites: { enabled: true },
          },
        }],
      }],
    },
  });
  const inner = dataManager.setEnabled.bind(dataManager);
  dataManager.setEnabled = (id, on, options) => {
    // STOP lands while the transition is in flight, before it can commit.
    if (id === 'flights') director.stopScene('Stopped (Esc)');
    return inner(id, on, options);
  };
  try {
    await director.startScene('scene-1', { single: true });

    assert.equal(dataManager.setEnabledCalls.length, 1, 'only the in-flight layer is touched');
    assert.ok(
      dataManager.setEnabledCalls[0].signal instanceof AbortSignal,
      'the run must hand its abort signal to every transition',
    );
    assert.equal(dataManager.setEnabledCalls[0].signal.aborted, true, 'STOP must abort that signal');
    assert.deepEqual(dataManager.committed, [], 'an aborted transition must not commit');
    assert.deepEqual(dataManager.setParamsCalls, [], 'no params for a layer that never moved');
  } finally {
    restore();
  }
});

test('a newer LOAD aborts the previous LOAD transition rather than disowning it', async () => {
  const { director, styleManager, dataManager, restore } = makeDirector();
  const gates = [];
  styleManager.applyVisualState = (visual, options = {}) => {
    styleManager.visualCalls.push({ visual, isCurrent: options.isCurrent });
    return new Promise((resolve) => { gates.push(resolve); });
  };
  try {
    const first = director.loadShot('scene-1', 'shot-a');
    await settle();
    const second = director.loadShot('scene-1', 'shot-b');
    gates[0]();
    gates[1]();
    await Promise.all([first, second]);

    // Only the newer LOAD reconciled, and it carried a live (unaborted) signal.
    assert.deepEqual(dataManager.setEnabledCalls.map((call) => call.id), ['traffic']);
    assert.ok(dataManager.setEnabledCalls[0].signal instanceof AbortSignal);
    assert.equal(dataManager.setEnabledCalls[0].signal.aborted, false);
  } finally {
    restore();
  }
});

test('applyVisualState gates the map-stack switch on both sides of its await', () => {
  // The other half of the contract, and the half these doubles cannot see.
  // ui.js cannot be imported here (its mgrs dependency is CJS), so this pins
  // the structure the way the repo pins other cross-module shape
  // (cockpitMarkup.test.mjs), while qa-shots/scenes-audit.mjs proves the
  // BEHAVIOUR against the real StyleManager in a browser.
  //
  // Gating only the post-await uniform commit is not enough: the stack switch
  // is ITSELF a mutation. The controller invalidates a switch only when
  // another setStack() arrives, and a winning state that omits `mapStack`
  // never issues one — every normalized scene shot omits it — so a stale
  // switch would otherwise stand on the globe.
  const source = readSource('../ui.js', import.meta.url);
  const method = source.match(/\n {2}async applyVisualState\([\s\S]*?\n {2}\}\n/);
  assert.ok(method, 'applyVisualState is missing from ui.js');
  assert.match(method[0], /async applyVisualState\(state = \{\}, \{ isCurrent = null \} = \{\}\)/);

  const mapStackBlock = method[0].match(/if \(state\.mapStack\) \{[\s\S]*?\n {4}\}/);
  assert.ok(mapStackBlock, 'the map-stack block is missing from applyVisualState');
  const block = mapStackBlock[0];

  // Before: an already-superseded caller must not start the switch at all.
  assert.match(
    block,
    /if \(superseded\(\)\) return false;\s*const stackBefore =/,
    'the switch must be skipped outright when the caller is already superseded',
  );
  // After: supersession that landed DURING the switch must put the globe back.
  assert.match(
    block,
    /await this\._setMapStack\(state\.mapStack[\s\S]*?if \(superseded\(\)\) \{[\s\S]*?await this\._setMapStack\(stackBefore/,
    'a switch superseded mid-flight must be reverted to the stack the winner inherited',
  );
  // And only what is still ours — a newer switch owns the globe, never revert it.
  assert.match(block, /getSwitchGeneration/, 'the revert must consult the switch generation');
  assert.match(
    block,
    /if \(globeIsStillOurs && stackBefore && landed !== stackBefore\) \{\s*await this\._setMapStack\(stackBefore/,
    'the revert must be guarded by the generation check and the stack that actually landed',
  );
});

test('a superseded LOAD is refused its visual commit', async () => {
  // applyVisualState suspends on a map-stack switch and writes its shader
  // uniforms AFTER that await. A stale LOAD resuming there would commit the
  // look of a shot the operator has already moved past, so the director hands
  // it a liveness predicate that is false by the time it would commit.
  const { director, styleManager, restore } = makeDirector();
  const gates = [];
  styleManager.applyVisualState = (visual, options = {}) => {
    styleManager.visualCalls.push({ visual, isCurrent: options.isCurrent });
    return new Promise((resolve) => { gates.push(resolve); });
  };
  try {
    const first = director.loadShot('scene-1', 'shot-a');
    const second = director.loadShot('scene-1', 'shot-b');
    gates[1]();
    await settle();
    gates[0]();
    await Promise.all([first, second]);

    const [stale, live] = styleManager.visualCalls;
    assert.equal(typeof stale.isCurrent, 'function', 'the visual call must carry a liveness predicate');
    assert.equal(stale.isCurrent(), false, 'the superseded LOAD must be refused its commit');
    assert.equal(live.isCurrent(), true, 'the live LOAD must still be allowed to commit');
  } finally {
    restore();
  }
});

test('a run refuses the visual commit of a shot cancelled mid-transition', async () => {
  const { director, styleManager, restore } = makeDirector();
  let releaseVisual;
  styleManager.applyVisualState = (visual, options = {}) => {
    styleManager.visualCalls.push({ visual, isCurrent: options.isCurrent });
    return new Promise((resolve) => { releaseVisual = resolve; });
  };
  const run = director.startScene('scene-1', { single: true });
  try {
    await settle();
    const call = styleManager.visualCalls[0];
    assert.equal(typeof call.isCurrent, 'function', 'the visual call must carry a liveness predicate');
    assert.equal(call.isCurrent(), true, 'live while the run owns the shot');

    director.stopScene('Stopped (Esc)');
    assert.equal(call.isCurrent(), false, 'STOP must revoke the pending commit');
  } finally {
    // Always let the run finish: _finishRun() owns the progress interval, so a
    // failed assertion that skipped this would leave a live timer behind and
    // hang the suite instead of reporting.
    director.stopScene('cleanup');
    releaseVisual?.();
    await run;
    restore();
  }
});

test('the newest LOAD wins when two loads race', async () => {
  // Both loads suspend on their visual await; the OLDER one resolves second.
  // Without a generation it completes last and overwrites the newer intent.
  const { director, viewer, styleManager, dataManager, restore } = makeDirector();
  const gates = [];
  styleManager.applyVisualState = (visual) => {
    styleManager.visualStates.push(visual);
    return new Promise((resolve) => { gates.push(resolve); });
  };
  try {
    const first = director.loadShot('scene-1', 'shot-a');
    const second = director.loadShot('scene-1', 'shot-b');
    assert.equal(gates.length, 2);

    gates[1]();
    await settle();
    gates[0]();
    await Promise.all([first, second]);

    assert.deepEqual(
      dataManager.setEnabledCalls.map(({ id, enabled }) => ({ id, enabled })),
      [{ id: 'traffic', enabled: true }],
    );
    assert.equal(viewer.flights.length, 1);
    assert.equal(director._selectedShotId, 'shot-b');
  } finally {
    restore();
  }
});

test('a scene run supersedes a LOAD still suspended on its visual await', async () => {
  const { director, styleManager, dataManager, restore } = makeDirector();
  let releaseLoadVisual;
  let calls = 0;
  styleManager.applyVisualState = (visual) => {
    styleManager.visualStates.push(visual);
    if (++calls === 1) return new Promise((resolve) => { releaseLoadVisual = resolve; });
    return Promise.resolve();
  };
  try {
    const load = director.loadShot('scene-1', 'shot-a');
    await settle();
    const run = director.startScene('scene-1', { single: true });
    releaseLoadVisual();
    await Promise.all([load, run]);

    // Only the run's own shots reconciled; the stale LOAD's flights never did.
    assert.deepEqual(
      dataManager.setEnabledCalls.map((call) => call.id),
      ['flights', 'traffic'],
    );
  } finally {
    restore();
  }
});

// ── Panel DOM + project storage ─────────────────────────────────────────────
//
// Everything above runs the director headless (getElementById → null), which
// is the mode production's late-mount used to hit. The rest of the class only
// exists when the scene panel is mounted: the shot editor, capture, import/
// export, and the localStorage persistence contract. These tests mount a full
// fake panel, including a <dialog> stand-in that lets the real promptDialog /
// confirmDialog promises resolve without a browser.

const PANEL_IDS = [
  'scene-panel', 'scene-select', 'scene-new-btn', 'scene-delete-btn',
  'scene-capture-btn', 'scene-update-shot-btn', 'scene-shot-list',
  'scene-start-btn', 'scene-stop-btn', 'scene-next-btn', 'scene-export-btn',
  'scene-import-btn', 'scene-import-file', 'scene-download-btn',
  'scene-status', 'scene-progress-fill', 'scene-runtime', 'toast',
];

/** The returnValue promptDialog/confirmDialog treat as "confirmed". */
const CONFIRM_SENTINEL = '__gev_confirm__';

/** Element stand-in covering everything the panel and dialogs touch. */
function makeFakeElement(tag) {
  const classes = new Set();
  const listeners = {};
  const children = [];
  const element = {
    tagName: tag,
    className: '',
    textContent: '',
    value: '',
    id: '',
    htmlFor: '',
    type: '',
    method: '',
    returnValue: '',
    autocomplete: '',
    spellcheck: false,
    disabled: false,
    style: {},
    children,
    classList: {
      add: (name) => classes.add(name),
      remove: (name) => classes.delete(name),
      toggle(name, force) {
        const next = force === undefined ? !classes.has(name) : Boolean(force);
        if (next) classes.add(name);
        else classes.delete(name);
        return next;
      },
      contains: (name) => classes.has(name),
    },
    append(...kids) { children.push(...kids); },
    appendChild(kid) { children.push(kid); return kid; },
    remove() {},
    click() {
      for (const handler of listeners.click || []) handler({ preventDefault() {} });
    },
    setAttribute() {},
    select() {},
    addEventListener(type, handler) { (listeners[type] ||= []).push(handler); },
    removeEventListener() {},
    dispatch(type, arg) {
      for (const handler of listeners[type] || []) handler(arg);
      return Boolean(listeners[type]?.length);
    },
    showModal() { /* presence is all promptDialog needs */ },
    handlers: listeners,
  };
  Object.defineProperty(element, 'innerHTML', {
    get() { return ''; },
    set() { children.length = 0; },
  });
  return element;
}

/**
 * Panel-mounted runtime: full element map, dialog-capable createElement, and
 * an in-memory localStorage whose writes are recorded (and can be forced to
 * fail, the private-browsing / quota-exceeded path).
 */
function installPanelRuntime(project = PROJECT_FIXTURE) {
  const originalDocument = globalThis.document;
  const originalLocalStorage = globalThis.localStorage;
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;

  const elements = new Map(PANEL_IDS.map((id) => [id, makeFakeElement('div')]));
  const created = [];
  const dialogs = [];
  const objectURLs = [];
  const store = new Map();
  const storage = {
    fail: false,
    setCalls: [],
  };

  globalThis.document = {
    getElementById: (id) => elements.get(id) ?? null,
    createElement: (tag) => {
      const element = makeFakeElement(tag);
      created.push(element);
      if (tag === 'dialog') dialogs.push(element);
      return element;
    },
    addEventListener() {},
    removeEventListener() {},
    body: {
      classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
      append() {},
      appendChild() {},
    },
  };
  globalThis.localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : project === null ? null : JSON.stringify(project)),
    setItem(key, value) {
      storage.setCalls.push(key);
      if (storage.fail) throw new Error('QuotaExceededError');
      store.set(key, value);
    },
    removeItem: (key) => store.delete(key),
  };
  URL.createObjectURL = (blob) => {
    objectURLs.push(blob);
    return 'blob:fake';
  };
  URL.revokeObjectURL = () => {};

  return {
    elements,
    created,
    dialogs,
    objectURLs,
    storage,
    el: (id) => elements.get(id),
    /** Resolve the most recent dialog: confirm (sentinel) or cancel (''). */
    settleDialog(confirmed) {
      const dialog = dialogs.at(-1);
      assert.ok(dialog, 'a dialog was opened');
      dialog.returnValue = confirmed ? CONFIRM_SENTINEL : '';
      dialog.dispatch('close');
    },
    restore() {
      globalThis.document = originalDocument;
      globalThis.localStorage = originalLocalStorage;
      URL.createObjectURL = originalCreate;
      URL.revokeObjectURL = originalRevoke;
    },
  };
}

/** Director over the panel runtime, with fixture project preloaded. */
function makePanelDirector(options = {}) {
  const env = installPanelRuntime(options.project);
  const viewer = fakeViewer();
  const styleManager = fakeStyleManager(options.style);
  const dataManager = fakeDataManager(options.data);
  const director = new SceneDirector(viewer, styleManager, dataManager);
  return { director, viewer, styleManager, dataManager, env };
}

test('a mounted director seeds the recipe project and renders the panel', () => {
  const { director, env } = makePanelDirector({ project: null });
  try {
    // project: null → localStorage.getItem returns null → createDefaultProject
    assert.equal(director._project.scenes.length, SCENE_RECIPES.length);
    const first = director._project.scenes[0];
    assert.equal(first.shots.length, SCENE_RECIPES[0].cameraPath.length);
    const shot = first.shots[0];
    assert.equal(shot.title, 'Shot 1');
    assert.equal(shot.visual.style, SCENE_RECIPES[0].style);
    assert.ok(shot.durationSec >= 0.2);
    assert.equal(shot.visual.hud.visible, SCENE_RECIPES[0].ui.hudMode !== 'off');
    assert.equal(shot.visual.detection.density, 35);
    assert.equal(env.el('scene-status').textContent, 'Ready');
    assert.equal(env.el('scene-progress-fill').textContent, '0%');
    assert.deepEqual(
      env.el('scene-select').children.map((option) => option.value),
      director._project.scenes.map((scene) => scene.id),
    );
  } finally {
    env.restore();
  }
});

test('captureShot snapshots camera, visual, and layer state into a normalized shot', () => {
  const { director, dataManager, env } = makePanelDirector({
    data: { registered: ['flights', 'cctv'] },
  });
  try {
    dataManager.getLayerParams = (id) => (id === 'flights' ? { models3d: true } : null);
    dataManager.getAll = () => [
      { id: 'flights', enabled: true },
      { id: 'cctv', enabled: false },
    ];
    const scene = director._getSelectedScene();
    assert.equal(scene.shots.length, 2);

    director.captureShot();

    assert.equal(scene.shots.length, 3, 'the shot was appended');
    const shot = scene.shots.at(-1);
    assert.equal(director._selectedShotId, shot.id);
    assert.equal(shot.durationSec, 4, 'default shot duration');
    assert.equal(shot.holdSec, 0.9, 'default hold');
    assert.deepEqual(shot.camera, { lat: 0, lon: 0, alt: 1000, heading: 0, pitch: -40, roll: 0 });
    assert.deepEqual(shot.layers, {
      flights: { enabled: true, params: { models3d: true } },
      // normalizeShot writes the params key even when absent.
      cctv: { enabled: false, params: undefined },
    });
    assert.equal(env.storage.setCalls.length, 1, 'the capture was persisted');
    assert.equal(env.el('scene-status').textContent, 'Captured: Fixture Scene / Shot 3');
  } finally {
    env.restore();
  }
});

test('captureShot without a camera reports why and touches nothing', () => {
  const { director, env } = makePanelDirector();
  try {
    director.styleManager.getCameraState = () => null;
    const before = director._getSelectedScene().shots.length;
    director.captureShot();
    assert.equal(env.el('scene-status').textContent, 'Cannot capture shot: camera not ready');
    assert.equal(director._getSelectedScene().shots.length, before);
    assert.equal(env.storage.setCalls.length, 0);
  } finally {
    env.restore();
  }
});

test('updateSelectedShot overwrites the selected shot in place', () => {
  const { director, env } = makePanelDirector();
  try {
    director.styleManager.getCameraState = () => ({ lat: 1, lon: 2, alt: 3, heading: 4, pitch: 5, roll: 6 });
    const shot = director._getSelectedScene().shots[0];
    director.updateSelectedShot();
    assert.deepEqual(shot.camera, { lat: 1, lon: 2, alt: 3, heading: 4, pitch: 5, roll: 6 });
    assert.equal(env.el('scene-status').textContent, 'Updated: Fixture Scene / Shot A');
  } finally {
    env.restore();
  }
});

test('updateSelectedShot with no shot selected says so', () => {
  const { director, env } = makePanelDirector();
  try {
    director._selectedShotId = null;
    director.updateSelectedShot();
    assert.equal(env.el('scene-status').textContent, 'Select a shot first');
  } finally {
    env.restore();
  }
});

test('_createScene appends and selects a named scene on confirm', async () => {
  const { director, env } = makePanelDirector({ project: null });
  try {
    const before = director._project.scenes.length;
    const creating = director._createScene();
    await settle();
    env.settleDialog(true);
    await creating;

    assert.equal(director._project.scenes.length, before + 1);
    const scene = director._project.scenes.at(-1);
    assert.equal(director._selectedSceneId, scene.id);
    assert.equal(director._selectedShotId, null, 'a new scene has no shots to select');
    assert.deepEqual(
      env.el('scene-select').children.map((option) => option.value),
      director._project.scenes.map((item) => item.id),
      'the dropdown was rebuilt with the new scene',
    );
  } finally {
    env.restore();
  }
});

test('_createScene cancelled adds nothing', async () => {
  const { director, env } = makePanelDirector({ project: null });
  try {
    const before = director._project.scenes.length;
    const creating = director._createScene();
    await settle();
    env.settleDialog(false);
    await creating;
    assert.equal(director._project.scenes.length, before);
  } finally {
    env.restore();
  }
});

test('deleting the last scene restores the default recipe project', async () => {
  const { director, env } = makePanelDirector();
  try {
    director._project.scenes = [director._project.scenes[0]]; // one custom scene
    const deleting = director._deleteSelectedScene();
    await settle();
    env.settleDialog(true);
    await deleting;

    assert.deepEqual(
      director._project.scenes.map((scene) => scene.id),
      SCENE_RECIPES.map((recipe) => recipe.id),
      'an empty project falls back to the shipped recipes',
    );
    assert.equal(director._selectedSceneId, director._project.scenes[0].id);
  } finally {
    env.restore();
  }
});

test('declining the scene delete confirmation changes nothing', async () => {
  const { director, env } = makePanelDirector();
  try {
    const before = [...director._project.scenes];
    const deleting = director._deleteSelectedScene();
    await settle();
    env.settleDialog(false);
    await deleting;
    assert.deepEqual(director._project.scenes, before);
    assert.equal(env.storage.setCalls.length, 0);
  } finally {
    env.restore();
  }
});

test('deleteShot removes after confirm and reselects, declines keep it', async () => {
  const { director, env } = makePanelDirector();
  try {
    // Decline first: the shot list is untouched and nothing is persisted.
    let deleting = director.deleteShot('scene-1', 'shot-a');
    await settle();
    env.settleDialog(false);
    await deleting;
    assert.equal(director._getShot('scene-1', 'shot-a').shot.title, 'Shot A');

    deleting = director.deleteShot('scene-1', 'shot-a');
    await settle();
    env.settleDialog(true);
    await deleting;
    const scene = director._getSelectedScene();
    assert.equal(scene.shots.length, 1);
    assert.equal(director._selectedShotId, scene.shots[0].id);

    // Unknown ids are a silent no-op, not a crash.
    await director.deleteShot('scene-x', 'shot-x');
  } finally {
    env.restore();
  }
});

test('a failed localStorage write toasts, warns, and keeps the memory project', async () => {
  const { director, env } = makePanelDirector();
  const warn = mock.method(console, 'warn');
  try {
    env.storage.fail = true;
    const creating = director._createScene();
    await settle();
    env.settleDialog(true);
    await creating;

    assert.ok(
      warn.mock.calls.some((call) => call.arguments.map(String).join(' ').includes('Could not persist project')),
      'the persistence failure is logged',
    );
    assert.equal(env.el('toast').textContent, 'Scene not saved — browser storage unavailable');
    assert.ok(env.el('toast').classList.contains('visible'));
    assert.equal(env.el('scene-status').textContent, 'Scene not saved — browser storage unavailable');
    // The in-memory project is still usable this session.
    assert.equal(director._project.scenes.length, 2, 'the fixture scene plus the new one');
  } finally {
    warn.mock.restore();
    env.restore();
  }
});

test('exportProject downloads the serialized project', async () => {
  const { director, env } = makePanelDirector();
  try {
    director.exportProject();
    assert.equal(env.objectURLs.length, 1);
    const payload = JSON.parse(await env.objectURLs[0].text());
    assert.equal(payload.version, 3);
    assert.deepEqual(payload.scenes.map((scene) => scene.id), ['scene-1']);
  } finally {
    env.restore();
  }
});

test('downloadLastRunMetadata gates on an archived run', () => {
  const { director, env } = makePanelDirector();
  try {
    director.downloadLastRunMetadata();
    assert.equal(env.objectURLs.length, 0, 'nothing to download before a run');

    director._lastRunJson = '{"wasCancelled":false}';
    director.downloadLastRunMetadata();
    assert.equal(env.objectURLs.length, 1);
  } finally {
    env.restore();
  }
});

test('importProjectFile replaces the project and reports invalid JSON', async () => {
  const { director, env } = makePanelDirector();
  try {
    const replacement = {
      version: 3,
      scenes: [{
        id: 'imported',
        title: 'Imported',
        shots: [PROJECT_FIXTURE.scenes[0].shots[0]],
      }],
    };
    await director.importProjectFile({ text: async () => JSON.stringify(replacement), name: 'tour.json' });
    assert.deepEqual(director.listScenes(), [{ id: 'imported', title: 'Imported', shots: 1 }]);
    assert.equal(director._selectedSceneId, 'imported');
    assert.equal(env.el('scene-status').textContent, 'Imported tour.json');

    await director.importProjectFile({ text: async () => '{not json', name: 'broken.json' });
    assert.equal(env.el('scene-status').textContent, 'Import failed (invalid JSON)');
    assert.equal(director._selectedSceneId, 'imported', 'a failed import keeps the current project');
  } finally {
    env.restore();
  }
});

test('voice read-back helpers report scenes, lookup, and status', () => {
  const { director, env } = makePanelDirector();
  try {
    assert.deepEqual(director.listScenes(), [{ id: 'scene-1', title: 'Fixture Scene', shots: 2 }]);
    assert.equal(director.findSceneByQuery('scene-1').title, 'Fixture Scene', 'by id');
    assert.equal(director.findSceneByQuery('FIXTURE SCENE').id, 'scene-1', 'by exact title, any case');
    assert.equal(director.findSceneByQuery('fixture').id, 'scene-1', 'by title substring');
    assert.equal(director.findSceneByQuery('nope'), null);
    assert.equal(director.findSceneByQuery('  '), null, 'blank queries find nothing');

    const status = director.getPlaybackStatus();
    assert.equal(status.running, false);
    assert.equal(status.selectedSceneId, 'scene-1');
    assert.equal(status.sceneCount, 1);
  } finally {
    env.restore();
  }
});

test('runNextScene steps through the shot list and wraps to the start', async () => {
  const { director, env } = makePanelDirector();
  try {
    assert.equal(director._selectedShotId, 'shot-a');
    await director.runNextScene();
    assert.equal(director._selectedShotId, 'shot-b');
    await director.runNextScene();
    assert.equal(director._selectedShotId, 'shot-a', 'the queue wraps');

    director._running = true;
    await director.runNextScene();
    assert.equal(director._selectedShotId, 'shot-a', 'stepping is blocked during a run');
  } finally {
    director._running = false;
    env.restore();
  }
});

test('Escape stops a running scene; other keys do not', () => {
  const { director, viewer, env } = makePanelDirector();
  try {
    director._running = true;
    director._runAbort = new AbortController();
    director._runToken = { cancelled: false, signal: director._runAbort.signal };

    director._onKeyDown({ key: 'Enter' });
    assert.equal(director._runToken.cancelled, false, 'an unrelated key is ignored');

    const before = viewer.cancelledFlights;
    director._onKeyDown({ key: 'Escape' });
    assert.equal(director._runToken.cancelled, true);
    assert.equal(director._runAbort.signal.aborted, true);
    assert.equal(viewer.cancelledFlights, before + 1, 'the in-flight camera flight is cancelled');
  } finally {
    director._running = false;
    director._runToken = null;
    env.restore();
  }
});

test('panel controls and progress reflect and clamp run state', () => {
  const { director, env } = makePanelDirector();
  try {
    director._setButtons(true);
    assert.equal(env.el('scene-start-btn').disabled, true);
    assert.equal(env.el('scene-stop-btn').disabled, false);
    assert.ok(env.el('scene-panel').classList.contains('running'));
    director._setButtons(false);
    assert.equal(env.el('scene-start-btn').disabled, false);
    assert.equal(env.el('scene-stop-btn').disabled, true);

    director._setProgress(2);
    assert.equal(env.el('scene-progress-fill').textContent, '100%', 'progress clamps high');
    assert.equal(env.el('scene-progress-fill').style.width, '100%');
    director._setProgress(-1);
    assert.equal(env.el('scene-progress-fill').textContent, '0%', 'progress clamps low');
    director._setProgress(0.425);
    assert.equal(env.el('scene-progress-fill').textContent, '43%');

    director._updateRuntime('Fixture Scene · Shot A');
    assert.equal(env.el('scene-runtime').textContent, 'Fixture Scene · Shot A');
    assert.ok(env.el('scene-runtime').classList.contains('active'));
    director._updateRuntime('');
    assert.ok(!env.el('scene-runtime').classList.contains('active'));
  } finally {
    env.restore();
  }
});

test('a full run flies every shot, logs telemetry, and archives the run', async () => {
  const { director, viewer, styleManager, env } = makePanelDirector();
  try {
    const result = await director.startScene('scene-1');
    assert.equal(result.started, true, 'the run reports its own start');
    assert.equal(result.shots, 2);

    assert.equal(viewer.flights.length, 2, 'one camera flight per shot');
    assert.equal(styleManager.visualStates.length, 2, 'one visual state per shot');
    assert.equal(director._running, false);
    assert.ok(director._lastRun, 'telemetry archived');
    assert.equal(director._lastRun.wasCancelled, false);
    assert.equal(director._lastRunJson.length > 0, true);
    const types = director._lastRun.events.map((event) => event.type);
    assert.deepEqual(
      types.filter((type) => type === 'shot_start'),
      ['shot_start', 'shot_start'],
    );
    assert.ok(types.includes('scene_run_complete'));
  } finally {
    env.restore();
  }
});

test('a refused context-mode exit is reported, not swallowed', async () => {
  const { director, styleManager, restore } = makeDirector({
    style: { contextMode: 'space-missions', exitFails: true },
  });
  const warn = mock.method(console, 'warn');
  try {
    const exited = await director._exitIsolatingContextMode();
    assert.equal(exited, false, 'a failed exit is reported as false');
    assert.deepEqual(styleManager.contextExits, ['off'], 'the exit was still attempted');
    assert.ok(
      warn.mock.calls.some((call) => call.arguments.map(String).join(' ').includes('Could not exit space-missions')),
      'the failure is logged',
    );
    assert.ok(
      director._activeRun.events.some((event) => event.type === 'context_mode_exit_failed'),
      'the failure lands in telemetry',
    );
  } finally {
    warn.mock.restore();
    restore();
  }
});

test('a run that throws mid-shot reports the error and still finalizes', async () => {
  const { director, env } = makePanelDirector();
  try {
    director.styleManager.applyVisualState = async () => {
      throw new Error('boom');
    };
    await director.startScene('scene-1');
    assert.equal(director._running, false, 'the run still unwinds');
    assert.ok(director._lastRun, 'telemetry archived through the error path');
    assert.deepEqual(
      director._lastRun.events.map((event) => event.type).filter((type) => type === 'scene_run_error'),
      ['scene_run_error'],
    );
  } finally {
    env.restore();
  }
});


test('run refusals are reported, and a held shot keeps the ticker alive', async () => {
  const HELD_PROJECT = {
    version: 3,
    scenes: [{
      id: 'held',
      title: 'Held Scene',
      shots: [{
        id: 'held-shot',
        title: 'Held Shot',
        durationSec: 0.2,
        holdSec: 0.25,
        camera: { lat: 10, lon: 20, alt: 500000, heading: 0, pitch: -40, roll: 0 },
        visual: { style: 'normal' },
        layers: {},
      }],
    }],
  };
  const { director, env } = makePanelDirector({ project: HELD_PROJECT });

  // Refusals first: already running, then no shots, then camera unavailable.
  director._running = true;
  assert.deepEqual(await director.startScene('held'), { started: false, reason: 'already-running' });
  director._running = false;
  director._project.scenes[0].shots = [];
  assert.deepEqual(await director.startScene('held'), { started: false, reason: 'no-shots' });
  assert.equal(env.el('scene-status').textContent, 'No shots to run');

  // Restore the shot, refuse ownership, then run for real: the hold keeps the
  // process alive long enough for the progress ticker to fire and for the
  // cancellable sleep to poll at least once.
  director._project.scenes[0].shots = [HELD_PROJECT.scenes[0].shots[0]];
  director.styleManager.runImmediateNavigation = () => false;
  assert.deepEqual(
    await director.startScene('held', { single: true }),
    { started: false, reason: 'camera-unavailable' },
    'the navigation policy can refuse the run outright',
  );
  assert.equal(env.el('scene-status').textContent, 'Camera unavailable — exit cockpit first');
  director.styleManager.runImmediateNavigation = (noun, navigate) => navigate();
  const startedAt = Date.now();
  const result = await director.startScene('held', { single: true });
  assert.equal(result.started, true);
  assert.ok(Date.now() - startedAt >= 250, 'the hold was actually awaited');
  assert.equal(env.el('scene-status').textContent, 'Scene run complete');
});

// ── Panel wiring ────────────────────────────────────────────────────────────
//
// The listeners _initUI registers are the only path an operator has into
// everything above, and they are the lines a refactor can drop silently: a
// removed listener still leaves the method working for every test that calls
// it directly. Each of these drives the real element through the fake DOM
// rather than calling the method, so a dropped listener fails here.

test('a corrupt localStorage entry falls back to the shipped recipes', () => {
  const env = installPanelRuntime(null);
  globalThis.localStorage.getItem = () => '{"version":3,"scenes":[{'; // a truncated write
  try {
    const director = new SceneDirector(fakeViewer(), fakeStyleManager(), fakeDataManager());
    assert.deepEqual(
      director._project.scenes.map((scene) => scene.id),
      SCENE_RECIPES.map((recipe) => recipe.id),
      'the unreadable project was replaced by the seeded recipes',
    );
    assert.equal(env.el('scene-status').textContent, 'Ready', 'the panel still mounted');
  } finally {
    env.restore();
  }
});

test('a project whose scenes array is empty normalizes back to the recipes', () => {
  const { director, env } = makePanelDirector({ project: { version: 3, scenes: [] } });
  try {
    assert.deepEqual(
      director._project.scenes.map((scene) => scene.id),
      SCENE_RECIPES.map((recipe) => recipe.id),
      'an empty project is not stored as an empty project',
    );
    assert.equal(director._selectedSceneId, director._project.scenes[0].id);
  } finally {
    env.restore();
  }
});

test('picking a scene in the dropdown selects that scene and its first shot', () => {
  const { director, env } = makePanelDirector({ project: TWO_SCENE_PROJECT });
  try {
    const select = env.el('scene-select');
    select.value = 'scene-2';
    assert.equal(select.dispatch('change'), true, 'the change listener is wired');
    assert.equal(director._selectedSceneId, 'scene-2');
    assert.equal(director._selectedShotId, 'shot-c', 'the scene\'s first shot became the selection');

    const rows = env.el('scene-shot-list').children;
    assert.equal(rows.length, 1, 'the list was rebuilt for the newly selected scene');
    assert.equal(rows[0].children[0].children[0].textContent, 'Shot C');
    assert.equal(rows[0].classList.contains('active'), true, 'the new selection is marked active');
  } finally {
    env.restore();
  }
});

test('a scene id that no longer exists falls back to the first scene', () => {
  const { director, env } = makePanelDirector({ project: TWO_SCENE_PROJECT });
  try {
    director._selectedSceneId = 'scene-deleted';
    director._renderSceneSelect();
    assert.equal(director._selectedSceneId, 'scene-1');
    assert.equal(env.el('scene-select').value, 'scene-1', 'the dropdown shows the recovered selection');
  } finally {
    env.restore();
  }
});

test('a shot id that no longer exists falls back to the first shot', () => {
  const { director, env } = makePanelDirector();
  try {
    director._selectedShotId = 'shot-deleted';
    director._renderShotList();
    assert.equal(director._selectedShotId, 'shot-a');
    assert.equal(
      env.el('scene-shot-list').children[0].classList.contains('active'), true,
      'the recovered selection is the row marked active',
    );
  } finally {
    env.restore();
  }
});

test('clicking a shot row selects it and moves the active mark', () => {
  const { director, env } = makePanelDirector();
  try {
    const labelB = env.el('scene-shot-list').children[1].children[0].children[0];
    assert.equal(labelB.tagName, 'button', 'shot selection is a real button, not a clickable div');
    labelB.dispatch('click');
    assert.equal(director._selectedShotId, 'shot-b');

    const rows = env.el('scene-shot-list').children;
    assert.equal(rows[1].classList.contains('active'), true);
    assert.equal(rows[0].classList.contains('active'), false, 'the previous selection lost its mark');
  } finally {
    env.restore();
  }
});

test('double-clicking a shot row renames it through the prompt dialog', async () => {
  const { director, env } = makePanelDirector();
  const rowLabel = (index) => env.el('scene-shot-list').children[index].children[0].children[0];
  try {
    rowLabel(0).dispatch('dblclick');
    const dialog = env.dialogs.at(-1);
    assert.equal(dialog.className, 'gev-prompt-dialog', 'the rename prompt opened');
    const input = dialog.children[1].children[1];
    assert.equal(input.value, 'Shot A', 'the prompt starts from the current title');
    input.value = '  Renamed A  ';
    env.settleDialog(true);
    await settle();

    assert.equal(director._getShot('scene-1', 'shot-a').shot.title, 'Renamed A', 'the entry is trimmed');
    assert.equal(rowLabel(0).textContent, 'Renamed A', 'the list was rebuilt with the new title');
    assert.ok(env.storage.setCalls.length > 0, 'the rename was persisted');

    // A whitespace-only entry is not a rename.
    rowLabel(0).dispatch('dblclick');
    env.dialogs.at(-1).children[1].children[1].value = '   ';
    env.settleDialog(true);
    await settle();
    assert.equal(director._getShot('scene-1', 'shot-a').shot.title, 'Renamed A', 'a blank entry keeps the title');
  } finally {
    env.restore();
  }
});

test('the LOAD row button loads that shot', async () => {
  const { director, viewer, env } = makePanelDirector();
  try {
    env.el('scene-shot-list').children[1].children[0].children[1].children[0].dispatch('click');
    await waitFor(() => viewer.flights.length === 1);
    assert.equal(director._selectedShotId, 'shot-b', 'the loaded shot became the selection');
    assert.equal(env.el('scene-status').textContent, 'Loaded: Fixture Scene / Shot B');
  } finally {
    env.restore();
  }
});

test('the DEL row button confirms once and removes the shot', async () => {
  const { director, env } = makePanelDirector();
  try {
    env.el('scene-shot-list').children[0].children[0].children[1].children[1].dispatch('click');
    await settle();
    env.settleDialog(true);
    await waitFor(() => director._project.scenes[0].shots.length === 1);

    assert.equal(director._selectedShotId, 'shot-b', 'the selection moved to the surviving shot');
    assert.equal(env.el('scene-shot-list').children.length, 1, 'the list was rebuilt without it');
    assert.ok(env.storage.setCalls.length > 0, 'the removal was persisted');
  } finally {
    env.restore();
  }
});

test('the START button runs the selected scene to completion', async () => {
  const { director, viewer, env } = makePanelDirector();
  try {
    assert.equal(env.el('scene-start-btn').dispatch('click'), true, 'the click listener is wired');
    await waitFor(() => director._running === false);

    assert.equal(viewer.flights.length, 2, 'both fixture shots flew');
    assert.equal(env.el('scene-status').textContent, 'Scene run complete');
    assert.ok(director._lastRun, 'the run was archived');
  } finally {
    env.restore();
  }
});

test('the STOP button cancels the live run and its in-flight camera flight', () => {
  const { director, viewer, env } = makePanelDirector();
  try {
    director._running = true;
    director._runAbort = new AbortController();
    director._runToken = { cancelled: false, signal: director._runAbort.signal };
    const before = viewer.cancelledFlights;

    env.el('scene-stop-btn').dispatch('click');

    assert.equal(director._runToken.cancelled, true);
    assert.equal(director._runAbort.signal.aborted, true);
    assert.equal(viewer.cancelledFlights, before + 1, 'the camera flight was cancelled');
    assert.equal(env.el('scene-status').textContent, 'Stopped', 'the button reports its own reason');
  } finally {
    director._running = false;
    director._runToken = null;
    env.restore();
  }
});

test('the NEXT button loads the following shot', async () => {
  const { director, env } = makePanelDirector();
  try {
    env.el('scene-next-btn').dispatch('click');
    // The selection is reserved up front, before the load's awaits; the status
    // only lands once the shot has actually been applied, so wait on that.
    await waitFor(() => env.el('scene-status').textContent === 'Loaded: Fixture Scene / Shot B');
    assert.equal(director._selectedShotId, 'shot-b');
  } finally {
    env.restore();
  }
});

test('the EXPORT button serializes the live project', async () => {
  const { director, env } = makePanelDirector();
  try {
    director._project.scenes[0].title = 'Renamed On Purpose';
    env.el('scene-export-btn').dispatch('click');
    assert.equal(env.objectURLs.length, 1, 'the download was staged');
    const payload = JSON.parse(await env.objectURLs[0].text());
    assert.equal(payload.scenes[0].title, 'Renamed On Purpose', 'the blob mirrors the live project');
  } finally {
    env.restore();
  }
});

test('the IMPORT button opens the hidden file input', () => {
  const { env } = makePanelDirector();
  try {
    const fileInput = env.el('scene-import-file');
    let opened = 0;
    fileInput.click = () => { opened += 1; };
    env.el('scene-import-btn').dispatch('click');
    assert.equal(opened, 1, 'the file picker was handed the click');
  } finally {
    env.restore();
  }
});

test('picking an import file replaces the project and resets the input', async () => {
  const { director, env } = makePanelDirector();
  const fileInput = env.el('scene-import-file');
  try {
    // A picker that closed without a file must not touch the project.
    fileInput.dispatch('change');
    await settle(2);
    assert.deepEqual(
      director.listScenes(),
      [{ id: 'scene-1', title: 'Fixture Scene', shots: 2 }],
      'a change with no file selected is a no-op',
    );

    fileInput.files = [{
      name: 'changed.json',
      text: async () => JSON.stringify({
        version: 3,
        scenes: [{
          id: 'via-change',
          title: 'Via Change',
          shots: [PROJECT_FIXTURE.scenes[0].shots[0]],
        }],
      }),
    }];
    fileInput.dispatch('change');
    await waitFor(
      () => fileInput.value === '' && env.el('scene-status').textContent === 'Imported changed.json',
    );

    assert.deepEqual(director.listScenes(), [{ id: 'via-change', title: 'Via Change', shots: 1 }]);
    assert.equal(director._selectedSceneId, 'via-change');
  } finally {
    env.restore();
  }
});

test('the DOWNLOAD button offers only an archived run', () => {
  const { director, env } = makePanelDirector();
  try {
    env.el('scene-download-btn').dispatch('click');
    assert.equal(env.objectURLs.length, 0, 'nothing is staged before a run has been archived');

    director._lastRunJson = '{"wasCancelled":false}';
    env.el('scene-download-btn').dispatch('click');
    assert.equal(env.objectURLs.length, 1);
  } finally {
    env.restore();
  }
});
