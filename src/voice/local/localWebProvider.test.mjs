import test from 'node:test';
import assert from 'node:assert/strict';

import { createVoiceSession } from '../session.js';
import {
  createLocalWebSessionLoader,
  localWebVoiceRequested,
} from './localWebProvider.js';

function delayedProvider() {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const created = [];
  const load = async () => {
    await gate;
    return {
      createLocalWebSession(hooks) {
        const calls = [];
        const adapter = {
          hooks,
          calls,
          local: { metrics: [] },
          start: async (options) => calls.push(['start', options]),
          stop: (options) => calls.push(['stop', options]),
          sendText: (text) => calls.push(['text', text]),
          bindControls: () => calls.push(['bind']),
          ignoreButtonClick: () => false,
        };
        created.push(adapter);
        return adapter;
      },
    };
  };
  return { load, release, created };
}

test('the loader exposes capabilities before the provider module arrives', async () => {
  const provider = delayedProvider();
  const loader = createLocalWebSessionLoader({}, { load: provider.load });
  assert.deepEqual(loader.capabilities, {
    costControls: false,
    pushToTalk: true,
    local: true,
  });
  assert.equal(loader.local, null);
  assert.equal(loader.ignoreButtonClick(), false);
  assert.equal(loader.sendMapEvent({}), false);
  loader.bindControls();
  assert.equal(loader.sendText('hello'), true);
  provider.release();
  const adapter = await loader.ready;
  await Promise.resolve();
  assert.deepEqual(adapter.calls, [['bind'], ['text', 'hello']]);
  assert.equal(loader.local, adapter.local);
});

test('a stop while the module loads cancels the pending start', async () => {
  const provider = delayedProvider();
  const loader = createLocalWebSessionLoader({}, { load: provider.load });
  const starting = loader.start({ pushToTalk: true });
  loader.stop();
  provider.release();
  await starting;
  const [adapter] = provider.created;
  assert.equal(
    adapter.calls.some(([name]) => name === 'start'),
    false,
  );
  await loader.start({ pushToTalk: false });
  assert.deepEqual(adapter.calls.at(-1), ['start', { pushToTalk: false }]);
});

test('removal while loading never constructs the provider and refuses starts', async () => {
  const provider = delayedProvider();
  const loader = createLocalWebSessionLoader({}, { load: provider.load });
  const starting = loader.start({});
  loader.bindControls();
  loader.stop({ removeUi: true });
  provider.release();
  await assert.rejects(starting, (error) => error.name === 'AbortError');
  assert.equal(await loader.ready, null);
  assert.equal(provider.created.length, 0);
  await assert.rejects(
    loader.start({}),
    (error) => error.name === 'AbortError',
  );
  assert.equal(loader.sendText('late'), false);
});

test('destroying the voice session while loading leaves nothing running', async () => {
  const provider = delayedProvider();
  const session = createVoiceSession({
    runner: async () => ({ ok: true }),
    createAdapter: (hooks) =>
      createLocalWebSessionLoader(hooks, { load: provider.load }),
  });
  const starting = session.start({ pushToTalk: false });
  session.destroy();
  provider.release();
  await starting;
  assert.equal(provider.created.length, 0);
  assert.equal(session.disposed, true);
  await assert.rejects(
    session.adapter.start({}),
    (error) => error.name === 'AbortError',
  );
});

test('a stopped session can start again once the module has loaded', async () => {
  const provider = delayedProvider();
  const session = createVoiceSession({
    runner: async () => ({ ok: true }),
    createAdapter: (hooks) =>
      createLocalWebSessionLoader(hooks, { load: provider.load }),
  });
  const starting = session.start({});
  session.stop();
  provider.release();
  await starting;
  const [adapter] = provider.created;
  assert.equal(adapter.calls.filter(([name]) => name === 'start').length, 0);
  await session.start({});
  assert.equal(adapter.calls.filter(([name]) => name === 'start').length, 1);
  session.destroy();
});

test('the real provider module satisfies the adapter contract without a UI', async () => {
  const loader = createLocalWebSessionLoader(
    { emit: () => {}, runAction: async () => ({ ok: true }), ui: null },
    { load: () => import('./localWebSession.js') },
  );
  const adapter = await loader.ready;
  for (const method of ['start', 'stop', 'sendText', 'sendMapEvent'])
    assert.equal(typeof adapter[method], 'function');
  assert.ok(loader.local?.store);
  loader.stop({ removeUi: true });
});

test('the provider is only requested by the URL flag', () => {
  assert.equal(localWebVoiceRequested('?voice=local-web&welcome=0'), true);
  assert.equal(localWebVoiceRequested('?welcome=0'), false);
});
