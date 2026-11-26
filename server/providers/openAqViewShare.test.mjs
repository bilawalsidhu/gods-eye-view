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

test('passes that bring nothing new come further apart', async () => {
  let clock = start;
  // Forty stations, none answering a reading.
  const far = Array.from({ length: 40 }, (_, i) => ({
    id: i + 1,
    lat: 8 + (i % 5) * 0.1,
    lon: 8 + Math.floor(i / 5) * 0.1,
  }));
  const { fetchImpl } = upstream(far, {
    clock: () => clock,
    answer: () => Response.json({ results: [] }),
  });
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
  // pass that brings nothing new doubles the wait, up to two minutes.
  assert.deepEqual(
    waits,
    [8000, 16_000, 32_000, 64_000, 120_000, 120_000, 120_000],
  );
});

test('a pass that brings a new reading anywhere in the view starts the wait over', async () => {
  let clock = start;
  // Every station goes quiet after the first pass; then the far ones,
  // more than 5° from the centre, answer again.
  let quiet = false;
  const stations = [
    ...Array.from({ length: 4 }, (_, i) => ({
      id: i + 1,
      lat: 0.1 * i,
      lon: 0,
    })),
    ...Array.from({ length: 20 }, (_, i) => ({
      id: i + 5,
      lat: 8,
      lon: 8 + 0.1 * i,
    })),
  ];
  const { fetchImpl } = upstream(stations, {
    clock: () => clock,
    answer: () => (quiet ? Response.json({ results: [] }) : null),
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
  quiet = true;
  clock = answer.retryAt + 1;
  answer = await source.getSnapshot({ view });
  assert.equal(answer.retryAt - clock, 16_000);
  clock = answer.retryAt + 1;
  answer = await source.getSnapshot({ view });
  assert.equal(answer.retryAt - clock, 32_000);
  // A far station's reading is progress too.
  quiet = false;
  clock = answer.retryAt + 1;
  answer = await source.getSnapshot({ view });
  assert.equal(answer.retryAt - clock, 8000);
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

/**
 * An OpenAQ stand-in for the AQI view: `stations` ({id, lat, lon}) each with
 * PM2.5, PM10, ozone, CO and NO2 sensors, every one answering hourly means
 * to the current hour (and NO2 a latest value). `paths` records what was
 * sent.
 */
function aqiUpstream(stations, { clock }) {
  const paths = [];
  const kinds = [
    ['pm25', 'µg/m³'],
    ['pm10', 'µg/m³'],
    ['o3', 'ppm'],
    ['co', 'ppm'],
    ['no2', 'ppb'],
  ];
  const fetchImpl = async (raw) => {
    const url = new URL(raw);
    paths.push(url.pathname + url.search);
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
            sensors: kinds.map(([name, units], k) => ({
              id: s.id * 10 + k,
              parameter: { name, units },
            })),
          })),
      });
    }
    const sensor = url.pathname.match(/sensors\/(\d+)\/hours/);
    if (sensor) {
      const [name, units] = kinds[Number(sensor[1]) % 10];
      const end = Math.floor(clock() / HOUR) * HOUR;
      return Response.json({
        results: Array.from({ length: 3 }, (_, i) => ({
          value: name === 'o3' ? 0.03 : name === 'co' ? 0.3 : 5,
          parameter: { name, units },
          flagInfo: { hasFlags: false },
          coverage: { percentCoverage: 100 },
          period: {
            interval: '01:00:00',
            datetimeFrom: { utc: iso(end - (3 - i) * HOUR) },
            datetimeTo: { utc: iso(end - (2 - i) * HOUR) },
          },
        })),
      });
    }
    const id = Number(url.pathname.split('/')[3]);
    return Response.json({
      results: [
        {
          locationsId: id,
          sensorsId: id * 10 + 4,
          value: 10,
          datetime: { utc: iso(clock()) },
        },
      ],
    });
  };
  return { paths, fetchImpl };
}

test('an AQI view keeps to its share at every request, not only between stations', async () => {
  let clock = start;
  const near = Array.from({ length: 2000 }, (_, i) => ({
    id: i + 1,
    lat: (i % 40) * 0.05,
    lon: Math.floor(i / 40) * 0.05,
  }));
  const { paths, fetchImpl } = aqiUpstream(near, { clock: () => clock });
  const source = createOpenAqAcquisition({
    getKey: () => 'fixture',
    now: () => clock,
    fetchImpl,
  });
  const view = [-5, -5, 5, 5, 1, 1];
  while (clock < start + HOUR) {
    const answer = await source.getSnapshot({ view, mode: 'aqi' });
    clock = Math.max(clock + 1000, answer.retryAt + 1);
  }
  // Five requests a station: the share (450) is never passed.
  assert.ok(paths.length <= 450, `${paths.length} requests`);
  assert.ok(paths.length >= 440, `${paths.length} requests`);
});

test('a request the shared budget refuses locally does not count against the view', async () => {
  let clock = start;
  const near = Array.from({ length: 2000 }, (_, i) => ({
    id: i + 1,
    lat: (i % 40) * 0.05,
    lon: Math.floor(i / 40) * 0.05,
  }));
  const inner = upstream(near, { clock: () => clock });
  let sent = 0;
  // Every 50th answer says OpenAQ's window has no request left for 30 s:
  // the view's next request is refused here, before it is sent.
  const fetchImpl = async (raw, options) => {
    const res = await inner.fetchImpl(raw, options);
    if (++sent % 50) return res;
    return new Response(await res.text(), {
      status: res.status,
      headers: {
        'content-type': 'application/json',
        'x-ratelimit-remaining': '0',
        'x-ratelimit-reset': '30',
      },
    });
  };
  const source = createOpenAqAcquisition({
    getKey: () => 'fixture',
    now: () => clock,
    fetchImpl,
  });
  const view = [-5, -5, 5, 5, 1, 1];
  let refusals = 0;
  while (clock < start + HOUR) {
    const answer = await source.getSnapshot({ view });
    if (answer.stale) refusals++;
    clock = Math.max(clock + 1000, answer.retryAt + 1);
  }
  assert.ok(refusals >= 5, `${refusals} refusals`);
  // The refused requests cost the view nothing: it still sends its whole
  // share (450) to OpenAQ.
  assert.ok(sent >= 448 && sent <= 450, `${sent} requests`);
});

test('a wide AQI view settles on a stable set and keeps it fresh within its share', async () => {
  let clock = start;
  // Three thousand stations over the world, nearly all far from the centre.
  const world = Array.from({ length: 3000 }, (_, i) => ({
    id: i + 1,
    lat: -60 + ((i * 7) % 120) + 0.001 * (i % 89),
    lon: -170 + ((i * 37) % 340) + 0.001 * (i % 97),
  }));
  const { paths, fetchImpl } = aqiUpstream(world, { clock: () => clock });
  const source = createOpenAqAcquisition({
    getKey: () => 'fixture',
    now: () => clock,
    fetchImpl,
  });
  const view = [-180, -90, 180, 90, 0, 0];
  const shownByHour = [];
  const sentByHour = [];
  let shown = new Set();
  let sentAtReport = 0;
  let nextReport = start + HOUR;
  while (clock < start + 12 * HOUR) {
    if (clock >= nextReport) {
      shownByHour.push(shown);
      sentByHour.push(paths.length - sentAtReport);
      sentAtReport = paths.length;
      nextReport += HOUR;
    }
    const answer = await source.getSnapshot({ view, mode: 'aqi' });
    shown = new Set(answer.readings.map((r) => r.stationId));
    clock = Math.max(clock + 1000, (answer.retryAt ?? clock + 60_000) + 1);
  }
  const counts = shownByHour.map((set) => set.size);
  const report = `shown ${counts.join(' ')} sent ${sentByHour.join(' ')}`;
  // Every hour keeps to the view's share (450 of 1,800)...
  assert.ok(
    sentByHour.every((n) => n <= 450),
    report,
  );
  // ...the set grows past the stations near the centre, then holds: a
  // station once shown stays shown, its readings checked before they age.
  assert.ok(counts[3] > counts[0], report);
  assert.ok(counts.at(-1) >= 250, report);
  for (let h = 1; h < shownByHour.length; h++)
    for (const id of shownByHour[h - 1])
      assert.ok(
        shownByHour[h].has(id),
        `${id} dropped at hour ${h}; ${report}`,
      );
});
