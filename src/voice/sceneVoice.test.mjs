import { createFakeEngine } from '../globe/testing/fakeEngine.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSceneVoice } from './gevRealtime.js';
import { createTestVoiceUi } from '../testSupport/voiceUi.mjs';

function fakeEngine(kind) {
  const canvas = new EventTarget();
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0 });
  return createFakeEngine({ kind, canvas, width: 0, height: 0 });
}

function fixture() {
  const previous = globalThis.window;
  globalThis.window = {};
  const lifetime = new AbortController();
  const adapter = { starts: 0, stops: [], events: [] };
  let runAction;
  const built = [];
  const voice = createSceneVoice({
    signal: lifetime.signal,
    createControl: () => createTestVoiceUi(),
    createCard: () => null,
    createReticle: () => null,
    createRunner: (scene) => {
      built.push(scene);
      return async (name) => ({ ok: true, action: name });
    },
    createSession(hooks) {
      runAction = hooks.runAction;
      return {
        async start() {
          adapter.starts++;
          hooks.emit({ type: 'state', state: 'listening' });
        },
        stop(options) {
          adapter.stops.push(options);
        },
        sendText() {},
        sendMapEvent(event) {
          adapter.events.push(event);
          return true;
        },
      };
    },
  });
  return {
    voice,
    adapter,
    built,
    lifetime,
    run: (...args) => runAction(...args),
    restore: () => {
      globalThis.window = previous;
    },
  };
}

test('an engine switch keeps the voice session and its transport', async () => {
  const f = fixture();
  try {
    const cesium = fakeEngine('cesium');
    f.voice.attachScene({ engine: cesium, viewer: {} });
    await f.voice.commands.start();
    assert.equal(f.adapter.starts, 1);
    assert.equal(f.voice.commands.pointer.element, cesium.host.canvas);
    assert.equal((await f.run('set_layer', {})).engine, 'cesium');

    f.voice.detachScene();
    assert.deepEqual(f.adapter.stops, [], 'a detach never stops the adapter');
    assert.equal(f.voice.commands.isActive(), true);
    assert.equal(f.voice.commands.pointer.element, null);
    // A call made between the engines waits for the next one.
    const pending = f.run('set_layer', {});
    const navara = fakeEngine('navara');
    f.voice.attachScene({ engine: navara, viewer: null });
    assert.equal((await pending).engine, 'navara');
    assert.equal(f.voice.commands.pointer.element, navara.host.canvas);
    assert.deepEqual(f.adapter.events, [
      { type: 'engine-changed', engine: 'navara' },
    ]);
    assert.equal(f.adapter.starts, 1);
    assert.equal(f.built.length, 2);
    assert.equal(f.built[1].engine, navara);

    f.lifetime.abort();
    assert.equal(f.adapter.stops.at(-1)?.removeUi, true);
  } finally {
    f.restore();
  }
});

test('annotation outline events reach the session from the attached engine only', async () => {
  const f = fixture();
  try {
    const listeners = new Set();
    const annotations = {
      onOutlineEvent(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    f.voice.attachScene({ engine: fakeEngine('cesium'), annotations });
    await f.voice.commands.start();
    for (const listener of listeners) listener({ status: 'resolved' });
    assert.deepEqual(f.adapter.events, [
      { type: 'map_annotation_outline', status: 'resolved' },
    ]);
    f.voice.detachScene();
    assert.equal(listeners.size, 0);
  } finally {
    f.restore();
  }
});

test('area handles outlive an engine attachment', () => {
  const f = fixture();
  try {
    f.voice.attachScene({ engine: fakeEngine('cesium') });
    const store = f.built[0].areaOptions?.store;
    assert.ok(store);
    const area = store.put({
      name: 'Area',
      source: 'drawn',
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [0, 0],
            [1, 0],
            [1, 1],
            [0, 0],
          ],
        ],
      },
    });
    f.voice.detachScene();
    f.voice.attachScene({ engine: fakeEngine('navara') });
    assert.equal(f.built[1].areaOptions.store.get(area.areaId), area);
  } finally {
    f.lifetime.abort();
    f.restore();
  }
});
