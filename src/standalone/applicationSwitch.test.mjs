import { createFakeEngine } from '../globe/testing/fakeEngine.js';
// The standalone application is created once; an engine switch detaches and
// attaches only its engine-bound parts. A candidate that fails releases its
// renderer, and the working engine attaches again on the same parts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { retainsLayerSession } from '../app/layerSession.js';
import { createSceneHost } from '../app/sceneHost.js';
import { attachScenePart } from '../app/sceneParts.js';
import { createApplication } from '../app/application.js';
import { createEngineSwitch } from './engineSwitch.js';

function standalone({ failOpen = null, beforeOpen, beforeRelease, lifecycle = false, transition = null, failControls = false } = {}) {
  const source = readFileSync(
    new URL('./application.js', import.meta.url),
    'utf8',
  )
    .replace(/^import [^;]*;\n/gm, '')
    .replace(/^export /gm, '')
    .replace(/import\.meta\.env/g, '({}).env');
  const opened = [];
  const released = [];
  const context = vm.createContext({
    document: {
      getElementById: () => ({ querySelector: () => ({}) }),
    },
    console,
    resolveLocale: () => 'en',
    setLocale() {},
    getLocale: () => 'en',
    onLocaleChange: () => () => {},
    mountApplicationViews() {},
    applyDocumentLanguage() {},
    applyDocumentTranslations() {},
    CITY_POIS: [],
    createApplication: lifecycle ? createApplication : (options) => ({
      ...options,
      subscribe() {},
      getState: () => ({ status: 'ready' }),
    }),
    resolveEngineKind: () => 'cesium',
    engineOfChoice: (choice) => (choice === 'cesium' ? 'cesium' : 'navara'),
    createStandalonePlaceSearch: () => ({ kind: 'search' }),
    createStandaloneCatalog: ({ engineKind }) => ({ engineKind }),
    loadLayerRenderers: async () => {},
    createGoogleTokenSource: () => null,
    createStandaloneScene: async ({ engineKind, defer }) => {
      await beforeOpen?.(engineKind);
      if (failOpen === engineKind) throw new Error(`${engineKind} refused`);
      const engine = createFakeEngine({ kind: engineKind });
      engine.id = opened.length;
      opened.push(engine);
      defer(async () => {
        await beforeRelease?.(engine);
        released.push(engine);
      });
      return { viewer: null, engine, operations: { kind: 'operations' } };
    },
    createStandaloneControls: async ({ scene, defer }) => {
      await attachScenePart(scene, {
        name: 'controls',
        attachScene() {},
        detachScene() {},
      }, { defer });
      if (failControls) throw new Error('controls refused');
      return {};
    },
    createStandaloneData: () => ({}),
    createStandaloneTools: () => ({}),
    createSceneHost,
    retainsLayerSession,
    attachScenePart,
    AbortController,
    AbortSignal,
    DOMException,
  });
  vm.runInContext(source, context);
  const app = context.createStandaloneApplication({ transition });
  return { app, opened, released };
}

test('the application switches engines on the parts it registered once', async () => {
  const { app, opened, released } = standalone();
  const scene = await app.createScene({
    signal: new AbortController().signal,
    defer() {},
  });
  assert.equal(scene.engine.kind, 'cesium');
  const log = [];
  await scene.sceneHost.register({
    name: 'part',
    attachScene: (next) => log.push(`attach ${next.kind}`),
    detachScene: () => log.push('detach'),
  });
  await app.detachScene({ handoff: true });
  assert.equal(scene.engine, null, 'no globe between engines');
  assert.deepEqual(released, [opened[0]]);
  await app.attachScene('navara');
  assert.equal(scene.engine.kind, 'navara');
  assert.equal(scene.catalog.engineKind, 'navara');
  assert.deepEqual(log, ['attach cesium', 'detach', 'attach navara']);
  await assert.rejects(app.attachScene('cesium'), /detach it first/);
});

test('a failed candidate releases what it attached and the working engine attaches again', async () => {
  const { app, opened, released } = standalone();
  const scene = await app.createScene({
    signal: new AbortController().signal,
    defer() {},
  });
  const part = {
    name: 'part',
    attached: [],
    attachScene(next) {
      if (next.kind === 'navara') throw new Error('navara part failed');
      part.attached.push(next.engine);
    },
  };
  await scene.sceneHost.register(part);
  await app.detachScene({ handoff: true });
  await assert.rejects(app.attachScene('navara'), /navara part failed/);
  assert.equal(scene.engine, null);
  assert.equal(released.length, 2, 'the candidate renderer was released');
  assert.equal(released[1].kind, 'navara');
  await app.attachScene('cesium');
  assert.equal(scene.engine.kind, 'cesium');
  assert.deepEqual(
    part.attached.map(({ kind }) => kind),
    ['cesium', 'cesium'],
  );
  assert.equal(opened.length, 3);
});

test('a failed resume detaches and releases its candidate once before recovery', async () => {
  const { app, opened, released } = standalone();
  const scene = await app.createScene({ signal: new AbortController().signal, defer() {} });
  const detached = [];
  await scene.sceneHost.register({
    name: 'part',
    attachScene(next) { this.kind = next.kind; },
    detachScene(options) { detached.push([this.kind, options.handoff]); },
  });
  await app.detachScene({ handoff: true });
  await assert.rejects(app.attachScene('navara', {
    resume() {
      assert.equal(scene.engine, opened[1], 'resume sees the attached candidate');
      throw new Error('restore failed');
    },
  }), /restore failed/);
  assert.equal(scene.engine, null);
  assert.equal(scene.sceneHost.state(), 'detached');
  assert.deepEqual(detached, [['cesium', true], ['navara', true]]);
  assert.deepEqual(released, opened);
  await app.attachScene('cesium');
  assert.equal(scene.engine, opened[2]);
  assert.equal(released.length, 2);
});

test('page teardown during resume releases the candidate only once', async () => {
  const { app, opened, released } = standalone();
  const lifetime = new AbortController();
  const scene = await app.createScene({ signal: lifetime.signal, defer() {} });
  await app.detachScene({ handoff: true });
  let finishResume;
  let enteredResume;
  const entered = new Promise((resolve) => { enteredResume = resolve; });
  const pending = app.attachScene('navara', {
    resume: () => {
      enteredResume();
      return new Promise((resolve) => { finishResume = resolve; });
    },
  });
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  await entered;
  lifetime.abort();
  const leaving = app.detachScene({ handoff: false });
  finishResume();
  await Promise.all([leaving, rejected]);
  assert.equal(scene.engine, null);
  assert.deepEqual(released, opened);
});

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test('concurrent detach and attach wait for renderer release before acquiring the next', async () => {
  const releasing = deferred();
  const finishRelease = deferred();
  const { app, opened, released } = standalone({
    beforeRelease: async () => {
      releasing.resolve();
      await finishRelease.promise;
    },
  });
  const scene = await app.createScene({ signal: new AbortController().signal, defer() {} });
  const leaving = app.detachScene({ handoff: true });
  const entering = app.attachScene('navara');
  await releasing.promise;
  assert.equal(opened.length, 1);
  assert.equal(scene.engine, null);
  finishRelease.resolve();
  await Promise.all([leaving, entering]);
  assert.equal(scene.engine, opened[1]);
  assert.deepEqual(released, [opened[0]]);
});

test('a detach requested during renderer acquisition waits for attachment and resume', async () => {
  const opening = deferred();
  const finishOpen = deferred();
  const { app, opened, released } = standalone({
    beforeOpen: async (kind) => {
      if (kind === 'navara') {
        opening.resolve();
        await finishOpen.promise;
      }
    },
  });
  const scene = await app.createScene({ signal: new AbortController().signal, defer() {} });
  await app.detachScene();
  let resumed = false;
  const entering = app.attachScene('navara', { resume: () => { resumed = true; } });
  await opening.promise;
  const leaving = app.detachScene();
  finishOpen.resolve();
  await Promise.all([entering, leaving]);
  assert.equal(resumed, true);
  assert.equal(scene.engine, null);
  assert.deepEqual(released, opened);
});

test('the host completes one recovery before an outside attachment operation runs', async () => {
  const failedRelease = deferred();
  const finishRelease = deferred();
  const { app, opened, released } = standalone({
    beforeRelease: async (engine) => {
      if (engine.kind === 'navara') {
        failedRelease.resolve();
        await finishRelease.promise;
      }
    },
  });
  const scene = await app.createScene({ signal: new AbortController().signal, defer() {} });
  const failures = [];
  const switcher = createEngineSwitch({
    sceneHost: app.sceneHost,
    kind: 'cesium',
    requested: () => 'cesium',
    signal: new AbortController().signal,
    address: { select() {}, commit() {}, restore() {} },
    leave: (_from, _to, _change, transaction) => app.detachScene({ handoff: true }, transaction),
    enter: (kind, _attempt, transaction) => app.attachScene(kind, {
      transaction,
      resume() { if (kind === 'navara') throw new Error('restore refused'); },
    }),
    onFailure: (error, outcome) => failures.push([error.message, outcome]),
  });
  const switching = switcher.select('navara');
  await failedRelease.promise;
  const outside = app.detachScene();
  assert.equal(opened.length, 2);
  finishRelease.resolve();
  await Promise.all([switching, outside]);
  assert.deepEqual(opened.map(({ kind }) => kind), ['cesium', 'navara', 'cesium']);
  assert.deepEqual(released, opened);
  assert.deepEqual(failures, [['restore refused', { recovered: true, kind: 'cesium' }]]);
  assert.equal(scene.engine, null);
});

for (const failControls of [false, true]) {
  test(`replacement application ${failControls ? 'failure cleanup' : 'startup and teardown'} uses the enclosing host transaction`, async () => {
    const host = createSceneHost();
    let fixture;
    await host.run(async (transaction) => {
      fixture = standalone({ lifecycle: true, transition: transaction, failControls });
      if (failControls) {
        await assert.rejects(fixture.app.start(), /controls refused/);
        assert.equal(fixture.app.getState().status, 'failed');
      } else {
        const { scene } = await fixture.app.start();
        assert.equal(scene.engine, fixture.opened[0]);
        assert.equal(scene.transaction, null, 'startup does not retain the enclosing transaction');
      }
      await fixture.app.destroy(transaction);
    });
    assert.deepEqual(fixture.released, fixture.opened);
    assert.equal(fixture.app.sceneHost.state(), 'detached');
    assert.deepEqual(fixture.app.sceneHost.parts(), [], 'retired parts do not pin the old application');
  });
}
