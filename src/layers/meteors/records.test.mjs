import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  parseGmnSummary,
  parseGmnTime,
  validateMeteorSnapshot,
} from './records.js';
import { createMeteorSource } from './source.js';

const fixture = readFileSync(
  new URL('./fixtures/gmn-example.txt', import.meta.url),
  'utf8',
);
function change(column, value) {
  const lines = fixture.trim().split('\n');
  const names = lines[1]
    .replace(/^#\s*/, '')
    .split(';')
    .map((s) => s.trim());
  const values = lines[4].split(';');
  values[names.indexOf(column)] = value;
  lines[4] = values.join(';');
  return lines.join('\n');
}
const envelope = () => ({
  ...parseGmnSummary(fixture),
  fetchedAt: Date.now(),
  stale: false,
});

test('real GMN row preserves UTC, WGS84 heights, speeds, shower and station evidence', () => {
  const result = parseGmnSummary(fixture);
  assert.equal(result.rejectedCount, 0);
  assert.equal(result.records.length, 1);
  const row = result.records[0];
  assert.equal(row.id, '20260914035549_wo5Pw');
  assert.equal(row.time, Date.parse('2026-09-14T03:55:49.744Z'));
  assert.equal(row.begin.heightKm, 95.0218);
  assert.equal(row.end.heightKm, 88.9275);
  assert.equal(row.speedKmS, 43.58558);
  assert.equal(row.shower, 'KLE');
  assert.deepEqual(row.stations, ['FR0003', 'FR0019']);
  assert.equal(result.timeTo, row.time + 1040);
});

test('UTC parsing rejects rollover dates and local/ambiguous times', () => {
  assert.equal(parseGmnTime('2026-02-30 12:00:00'), null);
  assert.equal(parseGmnTime('2026-09-14T03:55:49'), null);
  assert.equal(
    parseGmnTime('2026-09-14 03:55:49.1'),
    Date.parse('2026-09-14T03:55:49.100Z'),
  );
});

test('missing brightness or speed is unknown, never zero', () => {
  assert.equal(
    parseGmnSummary(change('Peak', 'None')).records[0].magnitude,
    null,
  );
  assert.equal(parseGmnSummary(change('Vavg', '')).records[0].speedKmS, null);
});

test('invalid locations, missing heights, nonpositive duration and one-camera tracks cannot render', () => {
  for (const [column, value] of [
    ['LatBeg', '91'],
    ['LonEnd', '181'],
    ['HtBeg', ''],
    ['HtEnd', '-1'],
    ['Duration', '0'],
    ['Num', '1'],
    ['Participating', '<script>'],
  ]) {
    assert.throws(() => parseGmnSummary(change(column, value)), /No valid GMN/);
  }
});

test('a malformed schema or HTML error cannot wipe a valid snapshot', () => {
  assert.throws(() => parseGmnSummary('<html>Unavailable</html>'), /header/);
  assert.throws(
    () => parseGmnSummary(fixture.replace('HtBeg', 'Unknown')),
    /column/,
  );
  assert.throws(
    () => parseGmnSummary(fixture.replace('UTC Time', 'Local time')),
    /units/,
  );
});

test('duplicates and rejected rows are counted without silently becoming additional meteors', () => {
  const lastLine = fixture.trim().split('\n').at(-1);
  const result = parseGmnSummary(`${fixture}${lastLine}\ncorrupt row\n`);
  assert.equal(result.records.length, 1);
  assert.equal(result.rejectedCount, 2);
});

test('valid empty batch remains distinct from malformed nonempty data', () => {
  const result = parseGmnSummary(
    fixture.trim().split('\n').slice(0, 4).join('\n'),
  );
  assert.equal(result.totalCount, 0);
  assert.equal(result.timeFrom, null);
});

test('source enforces cancellation through response parsing and rejects invalid envelopes', async () => {
  const controller = new AbortController();
  const source = createMeteorSource({
    fetchImpl: async () => {
      controller.abort();
      return Response.json(envelope());
    },
  });
  await assert.rejects(source.getSnapshot({ signal: controller.signal }), {
    name: 'AbortError',
  });
  const bad = envelope();
  bad.records[0].end.heightKm = null;
  assert.throws(() => validateMeteorSnapshot(bad), /Malformed/);
  await assert.rejects(
    createMeteorSource({
      fetchImpl: async () => new Response('no', { status: 503 }),
    }).getSnapshot(),
    /unavailable/,
  );
});

test('source reads a real portable snapshot without changing its evidence', async () => {
  const payload = envelope();
  const result = await createMeteorSource({
    fetchImpl: async () => Response.json(payload),
  }).getSnapshot();
  assert.deepEqual(result, payload);
});

test('the observation timeline must contain every event and use finite bounds', () => {
  for (const change of [
    { timeFrom: null },
    { timeTo: Infinity },
    { timeFrom: envelope().timeTo + 1 },
    { timeTo: envelope().timeTo - 1 },
  ])
    assert.throws(
      () => validateMeteorSnapshot({ ...envelope(), ...change }),
      /Malformed/,
    );
});
