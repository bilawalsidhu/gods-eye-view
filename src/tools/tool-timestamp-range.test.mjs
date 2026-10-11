import test from 'node:test';
import assert from 'node:assert/strict';
import { isoTime } from './results.js';
import { getBikeShare } from './queries/mobility.js';
test('out-of-range finite timestamps are unknown rather than throwing', async () => {
  for (const value of [1e30, -1e30, NaN, Infinity, null])
    assert.equal(isoTime(value), null);
  assert.equal(isoTime(0), '1970-01-01T00:00:00.000Z');
  assert.equal(isoTime(8640000000000000), '+275760-09-13T00:00:00.000Z');
  const station = {
    station_id: 's1',
    name: 'Fixture',
    lat: 0,
    lon: 0,
    capacity: 4,
  };
  const result = await getBikeShare.run(
    { area: { bbox: [-1, -1, 1, 1] } },
    {
      services: {
        bikeshare: {
          systems: [
            {
              id: 'fixture',
              city: 'Fixture',
              centerLat: 0,
              centerLon: 0,
              loadRadiusKm: 30,
              stationInformationUrl: 'information',
              stationStatusUrl: 'status',
            },
          ],
          async getStations(url) {
            return {
              data: {
                stations:
                  url === 'information'
                    ? [station]
                    : [
                        {
                          station_id: 's1',
                          last_reported: 1e30,
                          num_bikes_available: 2,
                        },
                      ],
              },
            };
          },
        },
      },
    },
  );
  assert.equal(result.data.returned, 1);
  assert.equal(result.data.rows[0].last_reported, null);
});
