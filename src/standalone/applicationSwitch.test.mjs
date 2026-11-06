// The standalone application is created once; an engine switch detaches and
// attaches only its engine-bound parts. A candidate that fails releases its
// renderer, and the working engine attaches again on the same parts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createSceneHost } from '../app/sceneHost.js';
import { attachScenePart } from '../app/sceneParts.js';

function standalone({ failOpen = null } = {}) {
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
    createApplication: (options) => ({
      ...options,
      subscribe() {},
      getState: () => ({ status: 'ready' }),
    }),
    resolveEngineKind: () => 'cesium',
    engineOfChoice: (choice) => (choice === 'cesium' ? 'cesium' : 'navara'),
    createStandalonePlaceSearch: () => ({ kind: 'search' }),
    createStandaloneCatalog: ({ engineKind }) => ({ engineKind }),
    createGoogleTokenSource: () => null,
    createStandaloneScene: async ({ engineKind, defer }) => {
      if (failOpen === engineKind) throw new Error(`${engineKind} refused`);
      const engine = { kind: engineKind, id: opened.length };
      opened.push(engine);
      defer(() => released.push(engine));
      return { viewer: null, engine, operations: { kind: 'operations' } };
    },
    createSceneHost,
    attachScenePart,
    AbortController,
    AbortSignal,
    DOMException,
  });
  vm.runInContext(source, context);
  const app = context.createStandaloneApplication({});
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
