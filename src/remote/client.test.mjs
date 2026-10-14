import assert from 'node:assert/strict';
import test from 'node:test';
import { createRemoteControl } from './client.js';
import { normalizeRemoteView } from './protocol.js';

test('the default session subscribes, applies a view, and records it', async () => {
  const applied = [];
  class Source {
    constructor(url) {
      this.url = url;
      Source.latest = this;
    }
    close() {
      this.closed = true;
    }
  }
  const windowRef = {};
  const documentRef = fakeDocument();
  const stop = createRemoteControl({
    search: '?remote=studio',
    EventSource: Source,
    windowRef,
    documentRef,
    apply: async (view) => {
      applied.push(view);
      return { camera: 'point' };
    },
    now: () => 1000,
  });
  assert.equal(Source.latest.url, '/api/remote/stream?session=studio');
  assert.equal(windowRef.__gevRemote.status, 'connecting');
  assert.equal(documentRef.nodes[0].textContent, 'Remote · connecting');
  Source.latest.onopen();
  assert.equal(windowRef.__gevRemote.status, 'live');
  assert.equal(documentRef.nodes[0].textContent, 'Remote · live');
  Source.latest.onmessage({
    data: JSON.stringify({ view: { lat: 10, lon: 20, alt: 1000 } }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(applied.length, 1);
  assert.equal(applied[0].lat, 10);
  assert.equal(applied[0].alt, 1000);
  assert.equal(windowRef.__gevRemote.lastApplied.view.lon, 20);
  assert.equal(windowRef.__gevRemote.lastApplied.applied.camera, 'point');
  assert.equal(windowRef.__gevRemote.lastApplied.at, 1000);
  assert.equal(windowRef.__gevRemote.status, 'live');
  stop();
  assert.equal(windowRef.__gevRemote, undefined);
  assert.equal(Source.latest.closed, true);
  assert.equal(documentRef.nodes[0].removed, true);
});

test('a published share link is applied and recorded', async () => {
  const published = normalizeRemoteView({
    link:
      'https://maps.example/#v=2&lat=37.7561&lon=-122.4760&alt=4000' +
      '&heading=0&pitch=-35&roll=0&l=e&an=' +
      encodeURIComponent(
        JSON.stringify([
          {
            type: 'pin',
            latitude: 37.7561,
            longitude: -122.476,
            label: 'Here',
          },
        ]),
      ),
  });
  assert.equal(published.ok, true, published.error);
  const applied = [];
  class Source {
    constructor(url) {
      this.url = url;
      Source.latest = this;
    }
    close() {
      this.closed = true;
    }
  }
  const windowRef = {};
  const stop = createRemoteControl({
    search: '',
    EventSource: Source,
    windowRef,
    apply: async (view) => {
      applied.push(view);
      return { camera: 'point' };
    },
    now: () => 2000,
  });
  Source.latest.onopen();
  Source.latest.onmessage({
    data: JSON.stringify({ view: published.view }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(applied.length, 1);
  assert.equal(applied[0].lat, 37.7561);
  assert.equal(applied[0].alt, 4000);
  assert.equal(applied[0].linkAnnotations[0].label, 'Here');
  assert.equal(windowRef.__gevRemote.lastApplied.view.lon, -122.476);
  assert.equal(windowRef.__gevRemote.lastApplied.at, 2000);
  assert.equal(windowRef.__gevRemote.status, 'live');
  stop();
});

test('a bad event and a failed apply are logged without secrets', async () => {
  const warnings = [];
  const original = console.warn;
  console.warn = (message) => warnings.push(String(message));
  class Source {
    constructor() {
      Source.latest = this;
    }
    close() {}
  }
  const windowRef = {};
  const stop = createRemoteControl({
    search: '',
    EventSource: Source,
    windowRef,
    apply: async (view) => {
      if (view.lat === 1) throw new Error('Bearer secret-token fly failed');
      return { camera: 'point' };
    },
    now: () => 3000,
  });
  try {
    Source.latest.onopen();
    Source.latest.onmessage({ data: '{"view":' });
    Source.latest.onmessage({
      data: JSON.stringify({ view: { lat: 1, lon: 2, alt: 100 } }),
    });
    Source.latest.onmessage({
      data: JSON.stringify({ view: { lat: 3, lon: 4, alt: 100 } }),
    });
    await new Promise((resolve) => setImmediate(resolve));
    const logged = warnings.join('\n');
    assert.match(logged, /ignored event: invalid json/);
    assert.match(logged, /apply failed: bearer \[redacted\] fly failed/);
    assert.doesNotMatch(logged, /secret-token/);
    assert.equal(windowRef.__gevRemote.lastApplied.view.lat, 3);
    assert.equal(windowRef.__gevRemote.status, 'live');
  } finally {
    console.warn = original;
    stop();
  }
});

test('?remote=off does not open a stream', () => {
  let created = 0;
  const windowRef = {};
  const stop = createRemoteControl({
    search: '?remote=off',
    EventSource: class {
      constructor() {
        created += 1;
      }
    },
    windowRef,
    apply: async () => {},
  });
  assert.equal(created, 0);
  assert.equal(windowRef.__gevRemote.status, 'off');
  assert.equal(windowRef.__gevRemote.lastApplied, null);
  stop();
  assert.equal(windowRef.__gevRemote, undefined);
});

test('a stream error closes and schedules a reconnect', () => {
  const timers = [];
  class Source {
    constructor(url) {
      this.url = url;
      Source.latest = this;
    }
    close() {
      this.closed = true;
    }
  }
  const windowRef = {};
  const stop = createRemoteControl({
    search: '',
    EventSource: Source,
    windowRef,
    setTimer: (fn, ms) => {
      timers.push({ fn, ms });
      return timers.length;
    },
    clearTimer: (id) => {
      timers[id - 1].cleared = true;
    },
    apply: async () => {},
  });
  assert.equal(Source.latest.url, '/api/remote/stream?session=default');
  Source.latest.onerror();
  assert.equal(Source.latest.closed, true);
  assert.equal(windowRef.__gevRemote.status, 'reconnecting');
  assert.equal(timers[0].ms, 1000);
  stop();
  assert.equal(timers[0].cleared, true);
});

function fakeDocument() {
  const nodes = [];
  return {
    nodes,
    body: {
      appendChild(node) {
        nodes.push(node);
      },
    },
    createElement() {
      return {
        style: {},
        dataset: {},
        setAttribute() {},
        remove() {
          this.removed = true;
        },
      };
    },
  };
}
