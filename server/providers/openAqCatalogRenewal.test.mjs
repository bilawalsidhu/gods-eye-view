import test from 'node:test';
import assert from 'node:assert/strict';
import { createOpenAqAcquisition } from './openAq.js';
const start = Date.parse('2026-10-20T12:00:00Z');
const HOUR = 3600_000;
const iso = (t) => new Date(t).toISOString();

test('large viewport progress: a stationary 7,000-station view eventually checks every station', async () => {
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
  let best = 0,
    everComplete = false;
  const hourly = [];
  let nextReport = start + HOUR;
  while (clock < start + 10 * HOUR) {
    const snap = await source.getSnapshot({ view });
    best = Math.max(best, snap.checked);
    if (snap.eligible === N && snap.checked === N) everComplete = true;
    if (clock >= nextReport) {
      hourly.push(`${snap.checked}/${snap.eligible}`);
      nextReport += HOUR;
    }
    clock = Math.max(clock + 1000, (snap.retryAt ?? clock + 60_000) + 1);
  }
  console.log(
    'hourly checked/eligible:',
    hourly.join(' '),
    'requests:',
    requests,
  );
  assert.ok(
    everComplete,
    `best checked ${best} of ${N}; hourly ${hourly.join(' ')}`,
  );
});
