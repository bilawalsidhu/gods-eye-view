import test from 'node:test';
import assert from 'node:assert/strict';
import { LayerLifecycle } from './lifecycle.js';
import { createFakeEngine } from '../globe/testing/fakeEngine.js';

// A layer module that records the second argument of every lifecycle call.
function recordingLayer(id) {
  const calls = [];
  const record = (name) => (_viewer, context) => {
    calls.push([name, context]);
    return true;
  };
  return {
    calls,
    module: {
      id,
      name: id,
      icon: '',
      source: 'test',
      init: record('init'),
      enable: record('enable'),
      update: record('update'),
      disable: record('disable'),
      destroy: record('destroy'),
    },
  };
}

test('every layer module call gets { signal, engine }, also with no viewer', async () => {
  const engine = createFakeEngine({ kind: 'navara' });
  const lifecycle = new LayerLifecycle(null, { engine });
  assert.equal(lifecycle.engine, engine);
  const layer = recordingLayer('probe');
  lifecycle.register(layer.module);
  lifecycle.finalizeRegistrations([
    { id: 'probe', disposition: 'enabled-only', token: 'z' },
  ]);
  await lifecycle.setEnabled('probe', true, { origin: 'user' });
  await lifecycle.setEnabled('probe', false, { origin: 'user' });
  await lifecycle.destroyAll();
  const names = layer.calls.map(([name]) => name);
  for (const name of ['init', 'enable', 'disable', 'destroy'])
    assert.ok(names.includes(name), `${name} was called: ${names}`);
  for (const [name, context] of layer.calls) {
    assert.equal(context?.engine, engine, `${name} got the engine`);
    assert.ok('signal' in context, `${name} got a signal slot`);
  }
});
