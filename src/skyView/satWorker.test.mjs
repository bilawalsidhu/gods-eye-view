import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { inspect } from 'node:util';
import { RECORD_FIELDS, decodeFlags } from './satCore.js';
import { createSatWorkerHandler } from './satWorker.js';

const FIXTURE = readFileSync(
  new URL('./reference/satFixture200.tle', import.meta.url),
  'utf8',
);

function harness() {
  const out = [];
  const handle = createSatWorkerHandler((message, transfer) =>
    out.push({ message, transfer }),
  );
  return { out, handle };
}

test('worker error does not echo an untrusted sequence value', () => {
  const out = [];
  const handle = createSatWorkerHandler((message) => out.push({ message }), {
    engine: {
      tick() {
        throw new Error('synthetic failure');
      },
    },
  });
  handle({ type: 'tick', seq: 'SYNTHETIC_SECRETKEY123', timeMs: 0 });
  assert.equal(out.at(-1).message.type, 'error');
  assert.doesNotMatch(JSON.stringify(out.at(-1).message), /SECRETKEY123/);
  assert.equal(out.at(-1).message.seq, null);
});

test('tle -> catalog meta; observer; tick -> packed Float32Array, transferred', () => {
  const { out, handle } = harness();
  handle({ type: 'tle', path: 'active', text: FIXTURE });
  const catalog = out.at(-1).message;
  assert.equal(catalog.type, 'catalog');
  assert.equal(catalog.load.added, 200);
  // the JIT warm-up ran on the new entries and is reported, not hidden
  assert.ok(catalog.load.warmUp.calls > 0, 'warm-up ran');
  assert.ok(Number.isFinite(catalog.load.warmUp.durationMs));
  assert.equal(catalog.meta.length, 200);
  assert.deepEqual(Object.keys(catalog.meta[0]).sort(), [
    'epochMs',
    'group',
    'index',
    'klass',
    'name',
    'noradId',
    'objectId',
    'rcsM2',
    'set',
  ]);
  handle({ type: 'observer', latDeg: 29.7604, lonDeg: -95.3698 });
  assert.deepEqual(out.at(-1).message, { type: 'observer', ok: true });
  handle({
    type: 'tick',
    seq: 7,
    timeMs: Date.parse('2026-10-11T03:00:00Z'),
    sets: ['core', 'active', 'starlink'],
  });
  const { message, transfer } = out.at(-1);
  assert.equal(message.type, 'tick');
  assert.equal(message.seq, 7);
  assert.ok(message.records instanceof Float32Array);
  assert.equal(message.records.length, message.count * RECORD_FIELDS);
  assert.ok(message.count > 0);
  assert.deepEqual(transfer, [message.records.buffer]);
  assert.equal(message.age.total, 200);
  for (let o = 0; o < message.records.length; o += RECORD_FIELDS) {
    const index = message.records[o];
    assert.ok(Number.isInteger(index) && catalog.meta[index]);
    assert.ok(message.records[o + 2] > -2);
    assert.ok(message.records[o + 3] > 100, 'range km');
    assert.ok(Math.abs(message.records[o + 4]) < 12, 'range rate km/s');
    assert.ok(
      ['core', 'active', 'starlink'].includes(
        decodeFlags(message.records[o + 5]).set,
      ),
    );
  }
});

test('ticks for sets not asked are absent; bad messages answer with an error, never throw', () => {
  const { out, handle } = harness();
  handle({ type: 'tle', path: 'active', text: FIXTURE });
  handle({ type: 'observer', latDeg: 29.7604, lonDeg: -95.3698 });
  handle({
    type: 'tick',
    seq: 1,
    timeMs: Date.parse('2026-10-11T03:00:00Z'),
    sets: ['core'],
  });
  assert.equal(out.at(-1).message.count, 0, 'fixture has no core rows');
  handle({ type: 'observer', latDeg: 'x', lonDeg: 0 });
  assert.equal(out.at(-1).message.ok, false);
  handle({ type: 'nothing' });
  const broken = createSatWorkerHandler((m) => out.push({ message: m }), {
    engine: {
      tick() {
        throw new Error('boom');
      },
    },
  });
  broken({ type: 'tick', seq: 9, timeMs: 0 });
  assert.deepEqual(out.at(-1).message, {
    type: 'error',
    request: 'tick',
    seq: 9,
    message: 'worker request failed',
  });
});

test('worker error diagnostics stay functional and omit exception secrets', () => {
  const secret = 'https://user:pass@host/?api_key=SECRETKEY123';
  const out = [];
  const broken = createSatWorkerHandler((message) => out.push(message), {
    engine: {
      tick() {
        const error = new Error(`tick exploded ${secret}`);
        error.name = secret;
        error.cause = new Error(secret);
        throw error;
      },
      loadGroup() {
        throw secret;
      },
    },
  });
  broken({ type: 'tick', seq: 4, timeMs: 0 });
  const tickError = out.at(-1);
  assert.equal(tickError.type, 'error');
  assert.equal(tickError.request, 'tick');
  assert.equal(tickError.seq, 4);
  assert.equal(tickError.message, 'worker request failed');
  assert.equal(JSON.stringify(tickError).includes('SECRETKEY123'), false);
  assert.equal(JSON.stringify(tickError).includes('pass@host'), false);

  broken({ type: 'tle', path: 'active', text: secret });
  const tleError = out.at(-1);
  assert.equal(tleError.request, 'tle');
  assert.equal(tleError.message, 'worker request failed');
  assert.equal(JSON.stringify(tleError).includes('SECRETKEY123'), false);

  const functional = createSatWorkerHandler((message) => out.push(message));
  functional({ type: 'passes', timeMs: Date.now() });
  assert.equal(out.at(-1).message, 'no observer');
  functional({ type: 'observer', latDeg: 29.7, lonDeg: -95.4 });
  functional({ type: 'passes', timeMs: secret });
  assert.equal(out.at(-1).request, 'passes');
  assert.equal(out.at(-1).message, 'bad time');
  assert.equal(JSON.stringify(out.at(-1)).includes('SECRETKEY123'), false);
});

test('a later pass-scan slice posts a fixed diagnostic, not the exception', () => {
  const secret = 'https://user:pass@host/?api_key=SECRETKEY123';
  const posted = [];
  let clocks = 0;
  const handle = createSatWorkerHandler((message) => posted.push(message), {
    schedule: (fn) => fn(),
    clock: () => {
      clocks += 1;
      if (clocks >= 3) throw new Error(`slice exploded ${secret}`);
      return 0;
    },
    sliceMs: 0,
  });
  handle({ type: 'tle', path: 'stations', text: FIXTURE });
  handle({ type: 'observer', latDeg: 29.7604, lonDeg: -95.3698 });
  handle({ type: 'passes', timeMs: Date.parse('2026-10-11T03:00:00Z') });
  const error = posted.find((message) => message.type === 'error');
  assert.ok(error, `no slice error in ${JSON.stringify(posted.at(-1))}`);
  assert.equal(error.request, 'passes');
  assert.equal(error.seq, null);
  assert.equal(error.message, 'worker request failed');
  assert.equal(JSON.stringify(error).includes('SECRETKEY123'), false);
  assert.equal(JSON.stringify(error).includes('pass@host'), false);
});

test('a catalog reply does not repeat an unrecognized TLE path or text', () => {
  const secret = 'https://user:pass@host/?api_key=SECRETKEY123';
  const out = [];
  const handle = createSatWorkerHandler((message) => out.push(message));
  handle({
    type: 'tle',
    path: secret,
    text: `SECRET ${secret}\nnot a tle\n${secret}`,
  });
  const catalog = out.at(-1);
  assert.equal(catalog.type, 'catalog');
  assert.equal(catalog.load.parsed, 0);
  const visible = inspect(catalog, { depth: 6 });
  assert.equal(visible.includes(secret), false, visible);
  assert.equal(visible.includes('SECRETKEY123'), false, visible);
  assert.equal(visible.includes('pass@host'), false, visible);
  handle({ type: 'tle', path: 'active', text: FIXTURE });
  assert.equal(out.at(-1).load.path, 'active');
});
