import test from 'node:test';
import assert from 'node:assert/strict';
import { createLayerSession, retainsLayerSession } from './layerSession.js';
import { handOffSession, resumeSession } from '../standalone/engineSwitch.js';

test('a session retains layer intentions through handoff but never after page teardown', () => {
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
  };
  session.director = {
    suspendScene: () => calls.push('suspend'),
    resumeScene: () => calls.push('resume'),
  };
  assert.equal(retainsLayerSession(session), false);
  handOffSession(session, { addressLayerIds: ['flights'] });
  assert.equal(retainsLayerSession(session), true);
  assert.deepEqual(session.handoffLayers.get('flights'), {
    entry,
    enabled: true,
    durable: true,
  });
  resumeSession(session);
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
