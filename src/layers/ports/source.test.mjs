import test from 'node:test';
import assert from 'node:assert/strict';
import { createPortsSource } from './source.js';

const record = (number) => ({
  id: `wpi:${number}`,
  wpiNumber: number,
  lat: 51.9,
  lon: 4.4,
  name: `Harbour ${number}`,
});

const snapshotBody = (extra = {}) => ({
  records: [record(1), record(2)],
  retrievedAt: 1_700_000_000_000,
  complete: true,
  partial: false,
  ...extra,
});

const sourceFor = (body) =>
  createPortsSource({
    fetchImpl: async () => new Response(JSON.stringify(body), { status: 200 }),
  });

test('skipped counts pass through the browser source, sanitised', async () => {
  const snap = await sourceFor(
    snapshotBody({
      skipped: {
        total: 4,
        duplicateId: 2,
        fractionalId: 2,
        malformedId: -1,
        invalidGeometry: 1.5,
        missingName: '3',
        unexpected: 99,
      },
    }),
  ).getSnapshot();
  assert.deepEqual(snap.skipped, {
    total: 4,
    duplicateId: 2,
    fractionalId: 2,
    malformedId: 0,
    invalidGeometry: 0,
    missingName: 0,
  });
  assert.equal(snap.records.length, 2);
});

test('a missing or non-object skipped field becomes all zeros', async () => {
  for (const skipped of [undefined, null, 'x', 7]) {
    const snap = await sourceFor(snapshotBody({ skipped })).getSnapshot();
    assert.equal(snap.skipped.total, 0);
    assert.equal(snap.skipped.duplicateId, 0);
  }
});

test('the source validator still rejects a fractional id', async () => {
  await assert.rejects(
    sourceFor(
      snapshotBody({
        records: [record(1), { ...record(2), id: 'wpi:2.5', wpiNumber: 2.5 }],
      }),
    ).getSnapshot(),
    /Malformed World Port Index snapshot/,
  );
});
