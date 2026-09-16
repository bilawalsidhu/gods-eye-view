import test from 'node:test';
import assert from 'node:assert/strict';
import { createAprsIsSource } from './index.js';

const response = (payload, headers = {}, status = 200) =>
  Response.json(payload, { headers, status });

test('APRS source normalizes beacons and AIS rows and forwards the viewport', async () => {
  const calls = [];
  const source = createAprsIsSource({
    origin: () => 'http://example.test',
    fetchImpl: async (url) => {
      calls.push(String(url));
      if (String(url).includes('/track?'))
        return response({
          samples: [{ lat: 30, lon: -97, t: 1_700_000_000 }],
          source: 'APRS-IS',
        });
      return response({
        status: 'live',
        rows: [
          {
            input_identifier: 'SHIP',
            reference: 'aprs:SHIP',
            name: 'SHIP',
            lat: 49.0583,
            lon: -72.0292,
            course: 90,
            speed: 6,
            last_position_epoch: 1_700_000_000,
            telemetry: {
              sequence: 1,
              analog: [1, 2, 3, 4, 5],
              digitalBits: '10101010',
            },
          },
          {
            mmsi: '367533950',
            input_identifier: '367533950',
            reference: 'mmsi:367533950',
            lat: 37.8,
            lon: -122.3,
            last_position_epoch: 1_700_000_000,
          },
        ],
      });
    },
  });

  const snapshot = await source.getSnapshot({
    maxRows: 25,
    viewport: { west: -10, south: -20, east: 10, north: 20 },
  });
  assert.match(calls[0], /maxRows=25/);
  assert.match(calls[0], /west=-10/);
  assert.match(calls[0], /south=-20/);
  assert.match(calls[0], /east=10/);
  assert.match(calls[0], /north=20/);
  assert.equal(snapshot.records.length, 2);

  const beacon = snapshot.records[0];
  assert.equal(beacon.id, 'SHIP');
  assert.equal(beacon.reference, 'aprs:SHIP');
  assert.ok(Math.abs(beacon.latitude - 49.0583) < 1e-6);
  assert.equal(beacon.telemetry.sequence, 1);
  assert.deepEqual(beacon.telemetry.analog, [1, 2, 3, 4, 5]);

  const ais = snapshot.records[1];
  assert.equal(ais.id, '367533950');
  assert.equal(ais.reference, 'mmsi:367533950');
  assert.equal(ais.telemetry, null);

  const track = await source.getTrack('aprs:SHIP');
  assert.match(calls[1], /\/api\/aprs-live\/track\?reference=aprs%3ASHIP/);
  assert.equal(track.records.length, 1);
  assert.ok(Math.abs(track.records[0].latitude - 30) < 1e-6);
  assert.equal(track.records[0].observedAtMs, 1_700_000_000_000);
});
