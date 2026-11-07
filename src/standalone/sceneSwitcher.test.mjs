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
      resumeViewport() {
        log.push('viewport');
      },
    },
  };
  session.manager = {
    layers: new Map([['flights', entry]]),
    isEffectivelyEnabled: () => true,
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
  assert.equal(session.handoffLayers, null);
  assert.equal(session.restoringView, false);
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
  assert.equal(session.handoffLayers, null);
  assert.equal(switcher.state().busy, false);
});

test('a changed tracking target does not resume the outgoing cockpit', async () => {
  const { switcher, log } = fixture({ changeTarget: true });
  await switcher.select('navara');
  assert.equal(log.includes('cockpit'), false);
  assert.equal(log.includes('ir'), false);
});
