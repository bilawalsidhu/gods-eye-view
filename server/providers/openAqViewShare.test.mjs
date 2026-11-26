import test from 'node:test';
import assert from 'node:assert/strict';
import { createOpenAqAcquisition } from './openAq.js';

const start = Date.parse('2026-10-20T12:00:00Z');
const HOUR = 3600_000;
const iso = (t) => new Date(t).toISOString();

/**
 * An OpenAQ stand-in with `stations` ({id, lat, lon}) measuring PM2.5, each
 * answering its latest value, or `answer(id)` (a Response) when it gives one.
 */
function upstream(stations, { clock, answer = () => null } = {}) {
  const paths = [];
  const fetchImpl = async (raw) => {
    const url = new URL(raw);
    paths.push(url.pathname);
    if (url.pathname === '/v3/locations') {
      const [w, so, e, n] = url.searchParams.get('bbox').split(',').map(Number);
      const page = Number(url.searchParams.get('page'));
      return Response.json({
        results: stations
          .filter((s) => s.lon >= w && s.lon <= e && s.lat >= so && s.lat <= n)
          .slice((page - 1) * 1000, page * 1000)
          .map((s) => ({
            id: s.id,
            name: `S${s.id}`,
            country: { code: 'XX', name: 'X' },
            datetimeLast: { utc: iso(clock()) },
            coordinates: { latitude: s.lat, longitude: s.lon },
            isMonitor: true,
            sensors: [
              { id: s.id * 10, parameter: { name: 'pm25', units: 'µg/m³' } },
            ],
          })),
      });
    }
    const id = Number(url.pathname.split('/')[3]);
    return (
      answer(id) ??
      Response.json({
        results: [
          {
            locationsId: id,
            sensorsId: id * 10,
            value: 5,
            datetime: { utc: iso(clock()) },
          },
        ],
      })
    );
  };
  return { paths, fetchImpl };
}

test('passes that bring nothing near the view centre come further apart', async () => {
  let clock = start;
  // Forty stations, all far (more than 5°) from the centre at 0, 0.
  const far = Array.from({ length: 40 }, (_, i) => ({
    id: i + 1,
    lat: 8 + (i % 5) * 0.1,
    lon: 8 + Math.floor(i / 5) * 0.1,
  }));
  const { fetchImpl } = upstream(far, { clock: () => clock });
  const source = createOpenAqAcquisition({
    getKey: () => 'fixture',
    now: () => clock,
    fetchImpl,
  });
  const view = [-10, -10, 10, 10, 0, 0];
  const waits = [];
  for (let i = 0; i < 7; i++) {
    const answer = await source.getSnapshot({ view });
    waits.push(answer.retryAt - clock);
    clock = answer.retryAt + 1;
  }
  // The first answer waits 8 s for the rest of the catalog; after it, each
  // pass that brings nothing near the centre doubles the wait, up to two
  // minutes.
  assert.deepEqual(
    waits,
    [8000, 16_000, 32_000, 64_000, 120_000, 120_000, 120_000],
  );
});

test('a pass that brings a reading near the centre starts the wait over', async () => {
  let clock = start;
  // Near stations go quiet after the first pass; far ones keep answering.
  let nearQuiet = false;
  const stations = [
    ...Array.from({ length: 4 }, (_, i) => ({
      id: i + 1,
      lat: 0.1 * i,
      lon: 0,
    })),
    ...Array.from({ length: 12 }, (_, i) => ({
      id: i + 5,
      lat: 8,
      lon: 8 + 0.1 * i,
    })),
  ];
  const { fetchImpl } = upstream(stations, {
    clock: () => clock,
    answer: (id) =>
      id <= 4 && nearQuiet ? Response.json({ results: [] }) : null,
  });
  const source = createOpenAqAcquisition({
    getKey: () => 'fixture',
    now: () => clock,
    fetchImpl,
  });
  const view = [-10, -10, 10, 10, 0, 0];
  // The nearest four first: they arrive, so the next pass is 8 s on.
  let answer = await source.getSnapshot({ view });
  assert.equal(answer.retryAt - clock, 8000);
  nearQuiet = true;
  clock = answer.retryAt + 1;
  answer = await source.getSnapshot({ view });
  assert.equal(answer.retryAt - clock, 16_000);
  clock = answer.retryAt + 1;
  answer = await source.getSnapshot({ view });
  assert.equal(answer.retryAt - clock, 32_000);
});

test('one view spends at most a quarter of the hourly budget; others keep theirs', async () => {
  let clock = start;
  // Two thousand stations around the centre, every one answering: the view
  // would ask every 8 s.
  const near = Array.from({ length: 2000 }, (_, i) => ({
    id: i + 1,
    lat: (i % 40) * 0.05,
    lon: Math.floor(i / 40) * 0.05,
  }));
  const { paths, fetchImpl } = upstream(near, { clock: () => clock });
  const source = createOpenAqAcquisition({
    getKey: () => 'fixture',
    now: () => clock,
    fetchImpl,
  });
  const view = [-5, -5, 5, 5, 1, 1];
  while (clock < start + HOUR) {
    const answer = await source.getSnapshot({ view });
    clock = Math.max(clock + 1000, answer.retryAt + 1);
  }
  const spent = paths.length;
  assert.ok(spent <= 450, `${spent} requests`);
  assert.ok(spent >= 400, `${spent} requests`);
  // A second view is still served from the budget left.
  const before = paths.length;
  const other = await source.getSnapshot({ view: [-6, -5, 5, 5, 1, 1] });
  assert.ok(paths.length > before);
  assert.ok(other.readings.length > 0);
});

test('a 403 on one station fails that station; only a refusal naming the key refuses it', async () => {
  let clock = start;
  const stations = [1, 2, 3].map((id) => ({ id, lat: 0.1 * id, lon: 0 }));
  let refusal = null;
  const { paths, fetchImpl } = upstream(stations, {
    clock: () => clock,
    answer: (id) =>
      refusal
        ? new Response(refusal, { status: 403 })
        : id === 2
          ? Response.json({ detail: 'Forbidden' }, { status: 403 })
          : null,
  });
  const source = createOpenAqAcquisition({
    getKey: () => 'fixture',
    now: () => clock,
    fetchImpl,
  });
  const view = [-10, -10, 10, 10, 0, 0];
  const answer = await source.getSnapshot({ view });
  // Station 2's 403 is that station's failure: the others are read.
  assert.deepEqual(answer.readings.map((r) => r.stationId).sort(), ['1', '3']);
  // OpenAQ's answer for a blocked or invalid key refuses the key itself.
  refusal = JSON.stringify({ detail: 'Invalid API key' });
  clock += 21 * 60_000;
  await assert.rejects(
    source.getSnapshot({ view: [-9, -10, 10, 10, 0, 0] }),
    (e) => e.status === 403,
  );
  const sent = paths.length;
  await assert.rejects(
    source.getSnapshot({ view: [-8, -10, 10, 10, 0, 0] }),
    (e) => e.status === 403 && e.message === 'OpenAQ key rejected',
  );
  assert.equal(paths.length, sent);
});
