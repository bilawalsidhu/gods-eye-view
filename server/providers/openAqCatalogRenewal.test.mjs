import test from 'node:test';
import assert from 'node:assert/strict';
import { createOpenAqAcquisition } from './openAq.js';
const start = Date.parse('2026-10-20T12:00:00Z');
const HOUR = 3600_000;
const iso = (t) => new Date(t).toISOString();

test('large viewport progress: a stationary 7,000-station view keeps checking stations within its hourly share', async () => {
  let clock = start;
  const N = 7000;
  // Spread over the globe, away from the focus at 0,0 so no nearby pause applies.
  const raw = Array.from({ length: N }, (_, i) => ({
    id: i + 1,
    lon: -170 + ((i * 37) % 340) + 0.001 * (i % 97),
    lat: 10 + ((i * 13) % 50) + 0.001 * (i % 89),
  }));
  let requests = 0;
  const fetchImpl = async (u) => {
    requests++;
    const url = new URL(u);
    if (url.pathname === '/v3/locations') {
      const [w, s, e, n] = url.searchParams.get('bbox').split(',').map(Number);
      const page = Number(url.searchParams.get('page'));
      const all = raw.filter(
        (l) => l.lon >= w && l.lon <= e && l.lat >= s && l.lat <= n,
      );
      return Response.json({
        results: all.slice((page - 1) * 1000, page * 1000).map((l) => ({
          id: l.id,
          name: 'S' + l.id,
          country: { code: 'XX', name: 'X' },
          datetimeLast: { utc: iso(clock) },
          coordinates: { latitude: l.lat, longitude: l.lon },
          sensors: [
            { id: l.id * 10, parameter: { name: 'pm25', units: 'µg/m³' } },
          ],
        })),
      });
    }
    const id = Number(url.pathname.split('/')[3]);
    return Response.json({
      results: [
        {
          locationsId: id,
          sensorsId: id * 10,
          value: 5,
          datetime: { utc: iso(clock) },
        },
      ],
    });
  };
  const source = createOpenAqAcquisition({
    getKey: () => 'fixture',
    now: () => clock,
    fetchImpl,
  });
  const view = [-180, -90, 180, 90, 0, 0];
  // The most stations checked in each hour, and requests spent in it.
  const checkedByHour = [];
  const requestsByHour = [];
  let nextReport = start + HOUR;
  let requestsAtReport = 0;
  let checked = 0;
  while (clock < start + 10 * HOUR) {
    const snap = await source.getSnapshot({ view });
    checked = Math.max(checked, snap.checked);
    if (clock >= nextReport) {
      checkedByHour.push(checked);
      requestsByHour.push(requests - requestsAtReport);
      requestsAtReport = requests;
      nextReport += HOUR;
    }
    clock = Math.max(clock + 1000, (snap.retryAt ?? clock + 60_000) + 1);
  }
  // A view left open spends at most a quarter of the hourly budget (1800)...
  assert.ok(
    requestsByHour.every((count) => count <= 450),
    `requests by hour ${requestsByHour.join(' ')}`,
  );
  // ...and still checks more of its stations every hour. Its far stations
  // bring nothing near the centre, so its passes slow to one each 2 minutes.
  for (let i = 1; i < checkedByHour.length; i++)
    assert.ok(
      checkedByHour[i] > checkedByHour[i - 1],
      `checked by hour ${checkedByHour.join(' ')} requests ${requestsByHour.join(' ')}`,
    );
  assert.ok(checkedByHour.at(-1) >= 1000, `${checkedByHour.at(-1)}`);
});
