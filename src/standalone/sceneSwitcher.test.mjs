import { createFakeEngine } from '../globe/testing/fakeEngine.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSceneSwitcher } from './sceneSwitcher.js';
import { createLayerSession } from '../app/layerSession.js';

function fixture({ failResume = false, changeTarget = false } = {}) {
  const session = createLayerSession();
  const log = [];
  let current = 'first';
  let address = 'first';
  const target = { id: 'track', layerId: 'flights' };
  const style = {
    initialRestorePromise: Promise.resolve(),
    getCockpitState: () => ({
      active: true,
      subject: target,
      visionMode: 'ir',
    }),
    getAircraftTrackingTarget: () =>
      changeTarget ? { ...target, id: 'other' } : target,
    controlCockpit: () => {
      log.push('cockpit');
      return { ok: true };
    },
    cockpitView: { setVisionMode: (mode) => log.push(mode) },
    shareLinkManager: {
      currentLayerState: () => ({ enabledLayerIds: ['flights'] }),
      resumeNavigation: () => log.push('navigation'),
    },
  };
  const entry = {
    module: {
      attachRenderer() {},
      trackById: () => true,
      resumeViewport() {
        log.push('viewport');
      },
    },
  };
  session.manager = {
    layers: new Map([['flights', entry]]),
    isEffectivelyEnabled: () => true,
    resumeScene: () => entry.module.resumeViewport(),
  };
  session.director = {
    suspendScene: () => log.push('suspend-director'),
    resumeScene: () => {
      log.push('resume-director');
      if (failResume && current === 'navara') throw new Error('resume failed');
    },
  };
  const app = {
    getState: () => ({ status: 'ready' }),
    getComponents: () => ({
      scene: { engine: current ? { kind: current } : null },
      controls: { styleManager: style },
    }),
    async detachScene({ handoff }) {
      log.push(['detach', current, handoff]);
      current = null;
    },
    async attachScene(kind, { resume }) {
      current = kind;
      log.push(['attach', kind]);
      try {
        await resume();
      } catch (error) {
        log.push(['release', kind]);
        current = null;
        throw error;
      }
    },
  };
  const switcher = createSceneSwitcher({
    kind: 'first',
    requested: () => address,
    layerSession: session,
    getApplication: () => app,
    renderers: { retain: (kind) => log.push(['park', kind]) },
    address: {
      select: () => 'old-entry',
      commit: (token, kind) => {
        address = kind;
        log.push(['commit', token, kind]);
      },
      restore: (kind) => {
        address = kind;
      },
    },
    onSettled: () => log.push('settled'),
    onFailure: (error, { recovered }) =>
      log.push(['failure', error.message, recovered]),
  });
  return { switcher, session, log, current: () => current };
}

test('a scene switch parks once, resumes the session and cockpit, then returns navigation', async () => {
  const { switcher, session, log, current } = fixture();
  await switcher.select('navara');
  assert.equal(current(), 'navara');
  assert.equal(session.handoff, null);
  await session.viewRestored;
  assert.deepEqual(log, [
    'suspend-director',
    ['park', 'first'],
    ['detach', 'first', true],
    ['attach', 'navara'],
    'viewport',
    'resume-director',
    'cockpit',
    'ir',
    ['commit', 'old-entry', 'navara'],
    'settled',
    'navigation',
  ]);
});

test('resume failure has one candidate release and one rollback on the retained session', async () => {
  const { switcher, session, log, current } = fixture({ failResume: true });
  await switcher.select('navara');
  assert.equal(current(), 'first');
  assert.deepEqual(log.filter(Array.isArray), [
    ['park', 'first'],
    ['detach', 'first', true],
    ['attach', 'navara'],
    ['release', 'navara'],
    ['attach', 'first'],
    ['failure', 'resume failed', true],
  ]);
  assert.equal(session.handoff, null);
  assert.equal(switcher.state().busy, false);
});

test('a changed tracking target does not resume the outgoing cockpit', async () => {
  const { switcher, log } = fixture({ changeTarget: true });
  await switcher.select('navara');
  assert.equal(log.includes('cockpit'), false);
  assert.equal(log.includes('ir'), false);
});

test('the restored camera precedes retained follow and replay', async () => {
  const { LayerLifecycle } = await import('../data/lifecycle.js');
  const session = createLayerSession();
  const log = [];
  let restoreCamera;
  const restored = new Promise((resolve) => {
    restoreCamera = resolve;
  });
  const layers = ['follow', 'replay'].map((id) => ({
    id,
    name: id,
    icon: '',
    source: 'test',
    init() {},
    enable() {},
    disable() {},
    update() {},
    destroy() {},
    attachRenderer() {
      log.push(`attach:${id}`);
    },
    detachRenderer() {},
    cameraOwner: {
      suspend() {
        log.push(`suspend:${id}`);
      },
      resume() {
        log.push(`resume:${id}`);
      },
    },
  }));
  const catalog = {
    layers,
    metadata: layers.map(({ id }) => ({
      id,
      token: id,
      disposition: 'enabled-only',
    })),
  };
  const manager = new LayerLifecycle(null);
  session.manager = manager;
  await manager.bindCatalog({ kind: 'first' }, catalog);
  for (const layer of layers) await manager.setEnabled(layer.id, true);
  let current = 'first';
  let attached;
  const attachment = new Promise((resolve) => {
    attached = resolve;
  });
  const style = {
    initialRestorePromise: restored,
    getCockpitState: () => null,
    getAircraftTrackingTarget: () => null,
  };
  const app = {
    getState: () => ({ status: 'ready' }),
    getComponents: () => ({
      scene: { engine: createFakeEngine({ kind: current }) },
      controls: { styleManager: style },
    }),
    async detachScene() {
      await manager.detachScene();
    },
    async attachScene(kind, { resume }) {
      current = kind;
      await manager.bindCatalog({ kind }, catalog, {
        viewRestored: session.viewRestored,
      });
      attached();
      await resume();
    },
  };
  const switcher = createSceneSwitcher({
    kind: 'first',
    requested: () => current,
    layerSession: session,
    getApplication: () => app,
    renderers: { retain() {} },
    address: { select() {}, commit() {}, restore() {} },
  });
  const switching = switcher.select('navara');
  await attachment;
  assert.deepEqual(log, [
    'suspend:follow',
    'suspend:replay',
    'attach:follow',
    'attach:replay',
  ]);
  log.push('camera-restored');
  restoreCamera();
  await switching;
  assert.deepEqual(log.slice(-3), [
    'camera-restored',
    'resume:follow',
    'resume:replay',
  ]);
  await manager.destroyAll();
});
