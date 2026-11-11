import { createFakeEngine } from '../globe/testing/fakeEngine.js';
// A candidate engine that fails after the shell attached to it (a later
// part: data, Cockpit clouds) must leave the shell detached, so the working
// engine attaches again.
import test from 'node:test';
import assert from 'node:assert/strict';
import { shellScenePart } from './shellPart.js';
import { createSceneHost } from './sceneHost.js';

/** A shell double with the real attach rule: one globe at a time. */
class FakeShell {
  constructor(engine) {
    this.engine = engine;
    this.attaches = [];
  }
  attachScene({ engine }) {
    if (this.engine)
      throw new Error('The shell is attached to a globe already');
    this.engine = engine;
    this.attaches.push(engine.kind);
  }
  async detachScene() {
    this.engine = null;
  }
}

test('a candidate failing in a later part leaves the shell ready for the working engine', async () => {
  const sceneHost = createSceneHost();
  const catalog = { get: (id) => ({ id }) };
  const cesium = {
    kind: 'cesium',
    viewer: null,
    engine: createFakeEngine({ kind: 'cesium' }),
    catalog,
  };
  await sceneHost.attach(cesium);
  const styleManager = new FakeShell(cesium.engine);
  await sceneHost.register(
    shellScenePart(styleManager, { builtOn: cesium, catalog }),
  );
  // The data part: it fails on Navara.
  await sceneHost.register({
    name: 'data',
    attachScene(next) {
      if (next.kind === 'navara') throw new Error('layer attachment failed');
    },
  });
  await sceneHost.detach({ handoff: true });
  assert.equal(styleManager.engine, null);
  const navara = {
    kind: 'navara',
    viewer: null,
    engine: createFakeEngine({ kind: 'navara' }),
    catalog,
  };
  await assert.rejects(sceneHost.attach(navara), /layer attachment failed/);
  assert.equal(styleManager.engine, null, 'the failed candidate let go');
  await sceneHost.attach(cesium);
  assert.equal(styleManager.engine.kind, 'cesium');
  assert.deepEqual(styleManager.attaches, ['navara', 'cesium']);
});
