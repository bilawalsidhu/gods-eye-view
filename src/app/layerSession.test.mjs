import { createSessionHandoff } from './sessionHandoff.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createLayerSession, retainsLayerSession } from './layerSession.js';
import { handOffSession, resumeSession } from '../standalone/engineSwitch.js';

test('a session retains layer intentions through handoff but never after page teardown', async () => {
  const session = createLayerSession();
  const other = createLayerSession();
  const calls = [];
  const entry = {
    module: {
      attachRenderer() {},
      resumeViewport: () => calls.push('viewport'),
    },
  };
  session.models.set('flights', entry.module);
  session.manager = {
    layers: new Map([['flights', entry]]),
    isEffectivelyEnabled: () => true,
    resumeScene: () => calls.push('viewport'),
  };
  session.director = {
    suspendScene: () => calls.push('suspend'),
    resumeScene: () => calls.push('resume'),
  };
  assert.equal(retainsLayerSession(session), false);
  session.handoff = createSessionHandoff(session, {
    addressLayerIds: ['flights'],
  });
  handOffSession(session);
  assert.equal(retainsLayerSession(session), true);
  assert.deepEqual(session.handoff.layers.get('flights'), {
    enabled: true,
    durable: true,
    visit: false,
  });
  await resumeSession(session);
  assert.deepEqual(calls, ['suspend', 'viewport', 'resume']);
  assert.equal(session.models.get('flights'), entry.module);
  assert.equal(other.models.size, 0);
  assert.notEqual(session.tools, other.tools);
  assert.notEqual(session.chrome, other.chrome);
  session.lifetime.abort();
  assert.equal(retainsLayerSession(session), false);
  assert.equal(other.lifetime.signal.aborted, false);
  assert.equal(retainsLayerSession(null), false);
});
