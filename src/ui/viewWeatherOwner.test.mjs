import assert from 'node:assert/strict';
import test from 'node:test';
import { createViewWeather } from './viewWeather.js';

const A = { lat: 35.71, lon: 139.81 };
const B = { lat: 35.89, lon: 139.81 };
const FAR = { lat: 45.71, lon: 139.81 };
const TOKYO = {
  temperatureC: 21.4,
  timeZone: 'Asia/Tokyo',
  utcOffsetSeconds: 32400,
};
const RECEIVED = Date.parse('2026-11-21T12:00:00Z');

function fixture(t) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const reads = [];
  const publications = [];
  let input = { center: A, moving: false, shown: true, mountId: 1 };
  let elapsed = 0;
  let visible = true;
  let visibilityListener = null;
  const owner = createViewWeather({
    read(lat, lon, { signal }) {
      const result = Promise.withResolvers();
      reads.push({ lat, lon, signal, ...result });
      return result.promise;
    },
    nowMonotonic: () => elapsed,
    now: () => RECEIVED + elapsed,
    isPageVisible: () => visible,
    onPageVisibility(listener) {
      visibilityListener = listener;
      return () => (visibilityListener = null);
    },
    readCurrentInput: () => input,
    publish: (state) => publications.push(state),
  });
  t.after(owner.stop);
  return {
    reads,
    publications,
    owner,
    get state() {
      return publications.at(-1);
    },
    get listening() {
      return visibilityListener !== null;
    },
    setInput(changes, { deliver = true } = {}) {
      input = { ...input, ...changes };
      if (deliver) owner.update(input);
    },
    setVisible(next) {
      visible = next;
      visibilityListener?.();
    },
    advance(ms) {
      elapsed += ms;
      t.mock.timers.tick(ms);
    },
    async finish(value) {
      reads.at(-1).resolve(value);
      await Promise.resolve();
    },
  };
}

test('same-cell failure retries count only visible Inspector time and a cancelled retry stays due', async (t) => {
  const f = fixture(t);
  f.setInput({});
  f.advance(400);
  await f.finish(null);
  assert.equal(f.state.failed, true);
  assert.equal(f.state.pending, false);

  f.advance(20_000);
  f.setInput({ shown: false });
  f.advance(300_000);
  f.setInput({ shown: true });
  f.advance(10_000);
  f.setVisible(false);
  f.advance(300_000);
  f.setVisible(true);
  f.advance(29_000);
  f.owner.pulse();
  f.advance(999);
  assert.equal(f.reads.length, 1);

  f.advance(1);
  f.owner.pulse();
  f.advance(400);
  assert.equal(f.reads.length, 2);
  assert.equal(f.state.pending, true);
  assert.equal(f.state.failed, true);

  f.setInput({ moving: true });
  assert.equal(f.reads[1].signal.aborted, true);
  assert.equal(f.state.pending, false);
  assert.equal(f.state.failed, true);
  await f.finish({ weather: TOKYO });
  assert.equal(f.state.reading, null);

  f.setInput({ moving: false });
  f.advance(400);
  assert.equal(f.reads.length, 3);
  await f.finish({ weather: TOKYO });
  assert.equal(f.state.reading, TOKYO);
  assert.equal(f.state.failed, false);
});

test('a completed deadline becomes due only on a visible pulse', async (t) => {
  const f = fixture(t);
  f.setInput({});
  f.advance(400);
  await f.finish(null);
  f.advance(59_600);
  f.owner.pulse();
  f.advance(500);

  f.setVisible(false);
  f.setInput({ moving: true });
  f.setInput({ moving: false });
  f.owner.pulse();
  f.advance(400);
  assert.equal(
    f.reads.length,
    1,
    'a background camera update cannot start a retry',
  );

  f.setVisible(true);
  f.advance(400);
  assert.equal(
    f.reads.length,
    1,
    'restoring visibility alone does not start a retry',
  );
  f.owner.pulse();
  f.advance(400);
  assert.equal(f.reads.length, 2);
});

test('settle samples live eligibility and a late reply releases its attempt before a coalesced camera update', async (t) => {
  const f = fixture(t);
  f.setInput({});
  f.setInput({ moving: true }, { deliver: false });
  f.advance(400);
  assert.deepEqual(f.reads, []);
  assert.deepEqual(f.publications, []);

  f.setInput({ moving: false }, { deliver: false });
  f.owner.pulse();
  f.advance(400);
  assert.equal(f.state.pending, true);

  f.reads[0].resolve({ weather: TOKYO });
  f.setInput({ center: B }, { deliver: false });
  await Promise.resolve();
  assert.equal(f.reads[0].signal.aborted, true);
  assert.deepEqual(f.state, {
    reading: null,
    failed: false,
    zone: null,
    freshnessAt: null,
    pending: false,
  });

  f.setInput({ center: A }, { deliver: false });
  f.owner.pulse();
  f.advance(400);
  assert.equal(f.reads.length, 2);
  assert.equal(f.reads[1].lat, A.lat);

  const lastPublication = f.state;
  f.owner.stop();
  await f.finish({ weather: TOKYO });
  assert.equal(f.reads[1].signal.aborted, true);
  assert.equal(f.listening, false);
  assert.equal(f.state, lastPublication);
});

test('a refresh retains weather through a hide and a failed same-cell refresh keeps the verified zone', async (t) => {
  const f = fixture(t);
  f.setInput({});
  f.advance(400);
  const retrievedAt = '2026-11-21T10:00:00Z';
  await f.finish({ weather: TOKYO, retrievedAt });
  const zone = f.state.zone;
  assert.equal(f.state.freshnessAt, Date.parse(retrievedAt));

  f.setInput({ shown: false, mountId: null });
  f.setInput({ shown: true, mountId: 2 });
  f.advance(659_600);
  f.owner.pulse();
  f.advance(400);
  assert.equal(f.reads.length, 1);
  assert.equal(f.state.reading, TOKYO);
  assert.equal(f.state.zone, zone);

  f.owner.pulse();
  f.advance(400);
  assert.equal(f.reads.length, 2);
  assert.equal(f.state.pending, true);
  assert.equal(f.state.reading, TOKYO);
  await f.finish(null);
  assert.equal(f.state.failed, true);
  assert.equal(f.state.pending, false);
  assert.equal(f.state.reading, null);
  assert.equal(f.state.zone, zone);
});

test('a zone hint is local to its mount and a failed nearby request clears the borrowed zone', async (t) => {
  const f = fixture(t);
  f.setInput({});
  f.advance(400);
  const weather = { ...TOKYO, observedAt: '2026-11-21T08:00:00Z' };
  await f.finish({ weather, retrievedAt: '2026-11-21T11:59:00Z' });
  assert.equal(f.state.freshnessAt, Date.parse(weather.observedAt));
  assert.equal(f.state.zone.timeZone, TOKYO.timeZone);

  f.setInput({ center: B });
  f.advance(400);
  assert.equal(f.state.zone.timeZone, TOKYO.timeZone);
  assert.equal(f.state.reading, null);
  await f.finish(null);
  assert.equal(f.state.zone, null);

  f.setInput({ center: A });
  f.advance(400);
  await f.finish({ weather: TOKYO });
  assert.equal(f.state.freshnessAt, RECEIVED + 1200);
  f.setInput({ center: FAR, moving: true });
  assert.equal(f.state.zone, null);

  f.setInput({ center: A, moving: false });
  f.advance(400);
  await f.finish({ weather: TOKYO });
  f.setInput({ shown: false, mountId: null });
  f.setInput({ center: B, shown: true, mountId: 2 });
  f.advance(400);
  assert.equal(f.state.pending, true);
  assert.equal(f.state.zone, null);
});
