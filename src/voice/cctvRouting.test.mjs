import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { DataLayerManager } from '../data/manager.js';
import { CCTV_FOCUS_RESULT } from '../layers/cctv/index.js';
import { controlCctv, createGevActionRunner } from './gevActions.js';

const originalWindow = globalThis.window;
before(() => {
  globalThis.window ??= { clearTimeout, setTimeout, requestIdleCallback: null };
});
after(() => {
  if (originalWindow === undefined) delete globalThis.window;
  else globalThis.window = originalWindow;
});

function viewerFixture() {
  return {
    clock: { onTick: { addEventListener: () => () => {} } },
    scene: { canvas: { addEventListener() {}, removeEventListener() {} } },
    camera: { moveEnd: { addEventListener() {} } },
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function runnerFixture(t, dataManager, options = {}) {
  const runner = createGevActionRunner({
    viewer: viewerFixture(),
    styleManager: {},
    dataManager,
    ...options,
  });
  t.after(() => runner.dispose());
  return runner;
}

// Only the inert module's lifecycle completion is controlled. The manager's
// intent queue, cancellation, compensation, events, and runner are production.
async function lifecycleFixture(t, targetEnabled) {
  const viewer = viewerFixture();
  const manager = new DataLayerManager(viewer);
  const calls = [];
  const gates = [];
  const pending = [];
  let nextGate = null;
  let moduleEnabled = false;
  const phase = targetEnabled ? 'enable' : 'disable';
  const lifecycle = async (name, options = {}) => {
    calls.push(name);
    if (name === phase && nextGate) {
      const gate = nextGate;
      nextGate = null;
      gate.entered.resolve(options.signal);
      await gate.release.promise;
      if (gate.outcome instanceof Error) throw gate.outcome;
      if (gate.outcome === false) return false;
    }
    moduleEnabled = name === 'enable';
    return true;
  };
  manager.register({
    id: 'cctv',
    name: 'CCTV',
    source: 'test',
    updateInterval: -1,
    init: async () => true,
    enable: (_viewer, options) => lifecycle('enable', options),
    disable: (_viewer, options) => lifecycle('disable', options),
    update: async () => true,
    getStats: () => ({ count: 0, lastUpdate: 0 }),
  });
  if (!targetEnabled)
    assert.equal(await manager.setEnabled('cctv', true), true);
  calls.length = 0;
  const events = [];
  const unsubscribe = manager.subscribe((event) => events.push(event));
  const runner = runnerFixture(t, manager, { viewer });
  t.after(async () => {
    for (const gate of gates) gate.release.resolve();
    await Promise.allSettled(pending);
    unsubscribe();
    await manager.destroyAll();
  });
  return {
    manager,
    events,
    calls,
    get moduleEnabled() {
      return moduleEnabled;
    },
    gate(outcome = true) {
      const gate = { entered: deferred(), release: deferred(), outcome };
      gates.push(gate);
      nextGate = gate;
      return gate;
    },
    run(action, options = {}) {
      const work = runner('control_cctv', { action }, options);
      pending.push(work);
      return work;
    },
  };
}

function assertLifecycle(result, manager, enabled, uncertain = false) {
  assert.equal(result.action, 'control_cctv');
  assert.equal(result.layerId, 'cctv');
  assert.equal(result.enabled, enabled);
  assert.equal(result.lifecycleState, enabled ? 'enabled' : 'disabled');
  assert.equal(result.lifecycleUncertain, uncertain);
  assert.deepEqual(manager.getLayerLifecycleState('cctv'), {
    enabled,
    lifecycleState: result.lifecycleState,
    uncertain,
  });
}

const terminalTypes = new Set([
  'visibility',
  'visibility-cancelled',
  'visibility-failed',
  'visibility-blocked',
]);

for (const action of ['enable', 'disable']) {
  const targetEnabled = action === 'enable';
  for (const outcome of [
    'success',
    'false',
    'throw',
    'caller-abort',
    'resource-abort',
    'late-abort',
  ]) {
    test(
      `CCTV ${action}: ${outcome} preserves the manager outcome`,
      { timeout: 2000 },
      async (t) => {
        const h = await lifecycleFixture(t, targetEnabled);
        const controller = new AbortController();
        const failure =
          outcome === 'resource-abort'
            ? Object.assign(new Error('fixture resource ended'), {
                name: 'AbortError',
              })
            : outcome === 'throw'
              ? new Error('fixture lifecycle failed')
              : null;
        const gate = h.gate(failure || (outcome === 'false' ? false : true));
        let lateAbortObserved = false;
        if (outcome === 'late-abort') {
          t.after(
            h.manager.subscribe((event) => {
              if (event.type === 'visibility' && event.origin === 'voice') {
                lateAbortObserved = true;
                controller.abort();
              }
            }),
          );
        }
        let settled = false;
        // Uppercase exercises the existing case-insensitive action contract.
        const work = h.run(
          outcome === 'success' ? action.toUpperCase() : action,
          {
            signal: controller.signal,
            isCurrent: () => !controller.signal.aborted,
          },
        );
        void work.then(
          () => {
            settled = true;
          },
          () => {
            settled = true;
          },
        );
        const moduleSignal = await gate.entered.promise;
        assert.equal(
          settled,
          false,
          'the tool must wait for lifecycle completion',
        );
        if (outcome === 'caller-abort') {
          controller.abort();
          assert.ok(
            moduleSignal,
            'the manager must receive a lifecycle signal',
          );
          assert.equal(
            moduleSignal.aborted,
            true,
            'caller abort must reach the manager lifecycle',
          );
        }
        gate.release.resolve();
        const result = await work;
        const committed = outcome === 'success' || outcome === 'late-abort';
        const cancelled =
          outcome === 'caller-abort' || outcome === 'resource-abort';
        assert.equal(result.ok, committed);
        assert.equal(result.cancelled, cancelled ? true : undefined);
        assertLifecycle(
          result,
          h.manager,
          committed ? targetEnabled : !targetEnabled,
          !targetEnabled && (outcome === 'false' || outcome === 'throw'),
        );
        assert.equal(
          h.moduleEnabled,
          committed ? targetEnabled : !targetEnabled,
          'the module must match the committed or compensated manager state',
        );
        if (cancelled) {
          assert.equal(result.cancellationReason, outcome);
          assert.equal(result.phase, action);
          assert.equal(result.successorIntentEpoch, null);
          assert.equal(result.successorEnabled, null);
          assert.equal(result.successorOrigin, null);
        } else if (!committed) {
          assert.equal(result.error, `Could not ${action} the requested layer`);
        }
        const terminal = h.events.filter(
          (event) => event.origin === 'voice' && terminalTypes.has(event.type),
        );
        assert.equal(
          terminal.length,
          1,
          'each voice intent has one terminal manager event',
        );
        assert.equal(
          terminal[0].type,
          committed
            ? 'visibility'
            : cancelled
              ? 'visibility-cancelled'
              : 'visibility-failed',
        );
        if (outcome === 'resource-abort')
          assert.equal(controller.signal.aborted, false);
        if (outcome === 'late-abort') assert.equal(lateAbortObserved, true);
      },
    );
  }

  test(
    `CCTV ${action}: already-aborted caller cannot enter lifecycle work`,
    { timeout: 2000 },
    async (t) => {
      const h = await lifecycleFixture(t, targetEnabled);
      const controller = new AbortController();
      controller.abort();
      const result = await h.run(action, { signal: controller.signal });
      assert.equal(result.ok, false);
      assert.equal(result.cancelled, true);
      assert.equal(result.cancellationReason, 'caller-abort');
      assert.equal(result.phase, 'queued');
      assertLifecycle(result, h.manager, !targetEnabled);
      assert.equal(h.moduleEnabled, !targetEnabled);
      assert.deepEqual(h.calls, []);
      assert.equal(
        h.events.filter((event) => terminalTypes.has(event.type)).length,
        1,
      );
    },
  );
}

test(
  'CCTV toggles retain missing-module errors without calling visibility',
  { timeout: 2000 },
  async (t) => {
    for (const layers of [new Map(), new Map([['cctv', {}]])]) {
      const runner = runnerFixture(t, {
        layers,
        getAll: () => [],
        setEnabled: () =>
          assert.fail('missing CCTV must not dispatch visibility'),
      });
      for (const action of ['enable', 'disable']) {
        assert.deepEqual(await runner('control_cctv', { action }), {
          ok: false,
          action: 'control_cctv',
          error: 'CCTV layer unavailable',
        });
      }
    }
  },
);

test('exported controlCctv refuses toggles without calling the manager', async () => {
  const manager = {
    layers: new Map([['cctv', { module: {} }]]),
    setEnabled: () => assert.fail('direct helper must not change visibility'),
    isEnabled: () => assert.fail('direct toggle must not read enabled state'),
  };
  for (const action of ['ENABLE', 'disable']) {
    const result = await controlCctv(manager, { action });
    assert.equal(result.ok, false);
    assert.equal(result.action, 'control_cctv');
    assert.match(result.error, /set_layer_visibility/);
  }
});

test(
  'CCTV fallback managers report rejection, transitional state, and uncertainty',
  { timeout: 2000 },
  async (t) => {
    for (const enabled of [true, false]) {
      const action = enabled ? 'enable' : 'disable';
      for (const mode of [
        'rejection',
        'mismatch',
        'transitional',
        'uncertain',
      ]) {
        const actualEnabled =
          mode === 'rejection' || mode === 'mismatch' ? !enabled : enabled;
        const lifecycleState =
          mode === 'transitional'
            ? enabled
              ? 'enabling'
              : 'disabling'
            : actualEnabled
              ? 'enabled'
              : 'disabled';
        const manager = {
          layers: new Map([['cctv', { module: {} }]]),
          getAll: () => [{ id: 'cctv', name: 'CCTV' }],
          isEnabled: () => actualEnabled,
          getLayerLifecycleState: () => ({
            enabled: actualEnabled,
            lifecycleState,
            uncertain: mode === 'uncertain',
          }),
          async setEnabled() {
            if (mode === 'rejection') throw new Error('adapter rejected');
            return true;
          },
        };
        const runner = runnerFixture(t, manager);
        const result = await runner('control_cctv', { action });
        assert.equal(result.ok, false, `${action}: ${mode}`);
        assert.equal(result.action, 'control_cctv');
        assert.equal(result.enabled, actualEnabled);
        assert.equal(result.lifecycleState, lifecycleState);
        assert.equal(result.lifecycleUncertain, mode === 'uncertain');
        assert.equal(
          result.error,
          mode === 'rejection'
            ? 'adapter rejected'
            : `Could not ${action} the requested layer`,
        );
      }
    }
  },
);

test(
  'CCTV visibility composes only its outer speech envelope',
  { timeout: 2000 },
  async (t) => {
    let enabled = false;
    const calls = [];
    const runner = runnerFixture(
      t,
      {
        layers: new Map([['cctv', { module: {} }]]),
        getAll: () => [{ id: 'cctv', name: 'CCTV' }],
        isEnabled: () => enabled,
        async setEnabled(_id, value) {
          enabled = value;
          return true;
        },
      },
      {
        speechBuilders: {
          control_cctv(result, args) {
            calls.push(['cctv', result.action, args.action]);
            return {
              say: 'CCTV response',
              display: { title: 'CCTV', lines: [] },
            };
          },
          set_layer_visibility() {
            calls.push(['generic']);
            return { say: 'Layer response' };
          },
        },
      },
    );
    const result = await runner('control_cctv', { action: 'enable' });
    assert.equal(result.ok, true);
    assert.equal(result.action, 'control_cctv');
    assert.equal(result.say, 'CCTV response');
    assert.deepEqual(result.display, { title: 'CCTV', lines: [] });
    assert.deepEqual(calls, [['cctv', 'control_cctv', 'enable']]);
  },
);

test(
  'CCTV non-toggle actions retain camera navigation and durable coverage',
  { timeout: 2000 },
  async (t) => {
    const calls = [];
    const cameras = [
      { id: 'a', name: 'Camera A' },
      { id: 'b', name: 'Camera B' },
    ];
    let activeCameraId = 'a';
    let coverageMode = 'viewshed';
    const module = {
      getUIState: () => ({
        cameras,
        activeCameraId,
        activeCamera: cameras.find((camera) => camera.id === activeCameraId),
        coverageMode,
        showCoverage: coverageMode !== 'off',
      }),
      selectCamera(id) {
        calls.push(['select', id]);
        activeCameraId = id;
        return true;
      },
      cycleCamera(step) {
        calls.push(['cycle', step]);
        activeCameraId = step > 0 ? 'b' : 'a';
        return activeCameraId;
      },
      focusNearest(options) {
        calls.push(['nearest', options]);
        activeCameraId = 'a';
        return 'a';
      },
      focusCamera(id, duration) {
        calls.push(['focus', id, duration]);
        return CCTV_FOCUS_RESULT.TRACKING_HOLDS_VIEW;
      },
    };
    let superseded = 0;
    const runner = runnerFixture(
      t,
      {
        layers: new Map([['cctv', { module }]]),
        isEnabled: () => true,
        setEnabled: () =>
          assert.fail('non-toggle action must not dispatch visibility'),
        setLayerParams(id, params, options) {
          calls.push(['params', id, params, options]);
          coverageMode = params.coverageMode;
        },
      },
      {
        styleManager: {
          supersedeDeferredNavigation() {
            superseded += 1;
          },
        },
      },
    );
    for (const args of [
      { action: 'select', cameraQuery: 'Camera B' },
      { action: 'next' },
      { action: 'prev' },
      { action: 'nearest' },
      { action: 'focus' },
    ]) {
      const result = await runner('control_cctv', args);
      assert.equal(result.ok, false);
      assert.equal(result.action, 'control_cctv');
      assert.match(result.error, /tracking holds the view/);
    }
    const coverage = await runner('control_cctv', { action: 'coverage' });
    assert.equal(coverage.ok, true);
    assert.equal(coverage.coverageMode, 'off');
    assert.equal(superseded, 5, 'coverage must not acquire camera navigation');
    assert.deepEqual(calls, [
      ['select', 'b'],
      ['focus', 'b', 1.8],
      ['cycle', 1],
      ['focus', 'b', 1.8],
      ['cycle', -1],
      ['focus', 'a', 1.8],
      ['nearest', { focus: false }],
      ['focus', 'a', 1.8],
      ['focus', 'a', undefined],
      ['params', 'cctv', { coverageMode: 'off' }, { origin: 'voice' }],
    ]);
  },
);
