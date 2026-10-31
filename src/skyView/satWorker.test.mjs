import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
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
    message: 'boom',
  });
});
