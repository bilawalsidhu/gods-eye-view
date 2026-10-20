import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source = readFileSync(
  new URL('./sdrAudioWorklet.js', import.meta.url),
  'utf8',
);
function rig(options = {}, rate = 48_000) {
  let Processor;
  const reports = [];
  vm.runInNewContext(source, {
    Float32Array,
    sampleRate: rate,
    AudioWorkletProcessor: class {
      constructor() {
        this.port = { postMessage: (m) => reports.push(m) };
      }
    },
    registerProcessor: (_name, implementation) => {
      Processor = implementation;
    },
  });
  const player = new Processor({ processorOptions: options });
  const send = (message) => player.port.onmessage({ data: message });
  const enable = (sessionId = 1) =>
    send({ type: 'session', sessionId, enabled: true });
  const samples = (array, sessionId = 1) =>
    send({ type: 'samples', samples: array, sessionId });
  const tick = (length = 128) => {
    const out = new Float32Array(length);
    assert.equal(player.process([], [[out]]), true);
    return out;
  };
  const snapshot = () => {
    send({ type: 'stats' });
    return reports.at(-1);
  };
  const conserve = () => {
    const s = snapshot();
    assert.equal(s.enqueued, s.consumed + s.dropped + s.cleared + s.queued);
    assert.equal(s.output, s.consumed + s.empty + s.waiting);
  };
  return { player, reports, send, enable, samples, tick, snapshot, conserve };
}

test('idle worklet does not emit periodic diagnostics or count picker silence', () => {
  const r = rig();
  r.send({ type: 'diagnostics', enabled: true });
  for (let i = 0; i < 1000; i++) assert.ok(r.tick().every((v) => v === 0));
  assert.equal(r.reports.length, 0);
  assert.equal(r.snapshot().output, 0);
  r.conserve();
});

test('disabled, stale-session and zero-length messages cannot enqueue or reactivate', () => {
  const r = rig({ prebufferFrames: 0 });
  r.samples(new Float32Array(128).fill(1));
  r.enable(2);
  for (let i = 0; i < 10_000; i++) r.samples(new Float32Array(0), 2);
  r.samples(new Float32Array(128).fill(1), 1);
  assert.equal(r.player.queue.length, 0);
  assert.equal(r.snapshot().active, false);
  assert.ok(r.tick().every((v) => v === 0));
  r.samples(new Float32Array(128).fill(1), 2);
  r.send({ type: 'session', sessionId: 2, enabled: false });
  r.samples(new Float32Array(128).fill(1), 2);
  assert.equal(r.player.queue.length, 0);
  assert.equal(r.snapshot().active, false);
  r.conserve();
});

test('new session clears old audio and stale disable cannot disable current session', () => {
  const r = rig({ prebufferFrames: 0 });
  r.enable(1);
  r.samples(new Float32Array(256).fill(1), 1);
  r.enable(2);
  r.samples(new Float32Array(256).fill(2), 2);
  r.send({ type: 'session', sessionId: 1, enabled: false });
  r.send({ type: 'volume', value: 1 });
  assert.ok(r.tick().every((v) => v === 2));
  assert.equal(r.snapshot().cleared, 256);
  r.conserve();
});

test('prebuffer waits for threshold then consumes real samples in order', () => {
  const r = rig({ prebufferFrames: 384, maxFrames: 1024 });
  r.enable();
  r.send({ type: 'volume', value: 1 });
  r.samples(Float32Array.from({ length: 256 }, (_, i) => i + 1));
  assert.ok(r.tick().every((v) => v === 0));
  assert.equal(r.snapshot().waiting, 128);
  r.samples(new Float32Array(256).fill(999));
  assert.deepEqual(
    [...r.tick()],
    Array.from({ length: 128 }, (_, i) => i + 1),
  );
  assert.equal(r.snapshot().empty, 0);
  r.conserve();
});

test('underrun zero-fills only missing frames and rebuffer waits before restarting', () => {
  const r = rig({ prebufferFrames: 256 });
  r.enable();
  r.samples(new Float32Array(256).fill(1));
  r.tick();
  r.tick();
  r.tick();
  assert.equal(r.snapshot().empty, 128);
  assert.equal(r.snapshot().underruns, 1);
  r.samples(new Float32Array(128).fill(1));
  assert.ok(r.tick().every((v) => v === 0));
  r.samples(new Float32Array(128).fill(1));
  assert.ok(r.tick().every((v) => v !== 0));
  assert.equal(r.snapshot().waiting, 128);
  r.conserve();
});

test('overflow trims exact frames across a partially consumed head', () => {
  const r = rig({ prebufferFrames: 0, maxFrames: 1000 });
  r.enable();
  r.send({ type: 'volume', value: 1 });
  r.samples(Float32Array.from({ length: 768 }, (_, i) => i + 1));
  r.tick();
  r.samples(new Float32Array(768).fill(999));
  assert.equal(r.snapshot().dropped, 408);
  assert.equal(r.tick(1)[0], 537);
  assert.equal(r.snapshot().queued, 999);
  r.conserve();
});

test('clear counts intentional discarded audio separately and stops idle reporting', () => {
  const r = rig({ prebufferFrames: 0 });
  r.enable();
  r.send({ type: 'diagnostics', enabled: true });
  r.samples(new Float32Array(768).fill(1));
  r.tick();
  r.send({ type: 'clear' });
  const before = r.snapshot();
  assert.equal(before.cleared, 640);
  assert.equal(before.dropped, 0);
  const reports = r.reports.length;
  for (let i = 0; i < 750; i++) r.tick();
  assert.equal(r.reports.length, reports);
  assert.equal(r.snapshot().output, before.output);
  assert.equal(r.snapshot().waiting, before.waiting);
  r.conserve();
});

test('diagnostics are opt-in and paced by rendered frames rather than fixed quantum count', () => {
  const r = rig({ prebufferFrames: 0 });
  r.enable();
  for (let i = 0; i < 200; i++) {
    r.samples(new Float32Array(256).fill(1));
    r.tick(256);
  }
  assert.equal(r.reports.length, 0);
  r.send({ type: 'diagnostics', enabled: true });
  for (let i = 0; i < 188; i++) {
    r.samples(new Float32Array(256).fill(1));
    r.tick(256);
  }
  assert.equal(r.reports.length, 1);
  r.send({ type: 'diagnostics', enabled: false });
  for (let i = 0; i < 200; i++) {
    r.samples(new Float32Array(256).fill(1));
    r.tick(256);
  }
  assert.equal(r.reports.length, 1);
  r.conserve();
});

test('buffer options stay finite and bounded with prebuffer no greater than capacity', () => {
  for (const options of [
    { maxFrames: Infinity, prebufferFrames: NaN },
    { maxFrames: -1, prebufferFrames: 1e9 },
    { maxFrames: 1e12, prebufferFrames: -Infinity },
    { maxFrames: '100', prebufferFrames: '200' },
  ]) {
    const r = rig(options);
    assert.ok(Number.isInteger(r.player.maxFrames));
    assert.ok(r.player.maxFrames >= 1 && r.player.maxFrames <= 48_000);
    assert.ok(
      r.player.prebufferFrames >= 0 &&
        r.player.prebufferFrames <= r.player.maxFrames,
    );
  }
});

test('full-rate jitter is absorbed but sustained undersupply remains visible', () => {
  for (const rate of [48_000, 33_984]) {
    const r = rig();
    r.enable();
    const arrivals = [];
    for (let i = 0; i < Math.ceil((6 * rate) / 768); i++)
      arrivals.push(
        ((i * 768) / rate) * 1000 + (rate === 48_000 && i % 8 >= 4 ? 40 : 0),
      );
    arrivals.sort((a, b) => a - b);
    let index = 0;
    for (let frame = 0; frame < 6 * 48_000; frame += 128) {
      while (index < arrivals.length && arrivals[index] <= frame / 48) {
        r.samples(new Float32Array(768).fill(1));
        index++;
      }
      r.tick();
    }
    const s = r.snapshot();
    if (rate === 48_000) {
      assert.equal(s.empty, 0);
      assert.equal(s.underruns, 0);
    } else {
      assert.ok(s.underruns > 0);
      assert.ok(s.waiting + s.empty > 50_000);
    }
    r.conserve();
  }
});

test('late enable cannot roll back a newer session or revive a retired epoch', () => {
  const r = rig({ prebufferFrames: 0 });
  r.enable(2);
  r.enable(1);
  assert.equal(r.snapshot().sessionId, 2);
  r.send({ type: 'session', sessionId: 2, enabled: false });
  r.enable(2);
  r.samples(new Float32Array(128).fill(1), 2);
  assert.equal(r.snapshot().enqueued, 0);
  r.enable(3);
  r.samples(new Float32Array(128).fill(1), 3);
  assert.ok(r.tick().every((v) => v !== 0));
  r.conserve();
});
