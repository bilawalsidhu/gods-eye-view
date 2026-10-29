import { cameras as alprCameras, cameraTile } from './alpr.mjs';
import { cameras as cctvCameras, cameraFrame } from './cctv.mjs';
import { stations as radioStations } from './radio.mjs';
import { earthquakePerformanceFixture } from './earthquakes.mjs';

export const COMBINED_EPOCH = Date.parse('2026-10-28T18:00:00Z');
export const COMBINED_ORIGIN = { lat: 42.3554, lon: -71.0605 };
const grid = (i, cols, spacing) => ({
  lat: COMBINED_ORIGIN.lat + (Math.floor(i / cols) - cols / 2) * spacing,
  lon: COMBINED_ORIGIN.lon + ((i % cols) - cols / 2) * spacing,
});
const radio = radioStations.map((r, i) => ({ ...r, ...grid(i, 28, 0.001) }));
const cctv = cctvCameras.map((r, i) => ({
  ...r,
  ...grid(i, 5, 0.002),
  cityId: 'boston',
  city: 'Boston',
  groundElevationM: 20,
}));
const alpr = alprCameras.map((r, i) => {
  const p = grid(i, 19, 0.001);
  return { ...r, latitude: p.lat, longitude: p.lon };
});
const bikes = Array.from({ length: 200 }, (_, i) => ({
  station_id: `w2-bike-${i}`,
  name: `W2 station ${i}`,
  capacity: 20,
  ...grid(i, 15, 0.0015),
}));
const earthquakes = earthquakePerformanceFixture(500);
earthquakes.features = earthquakes.features.map((r, i) => {
  const p = grid(i, 23, 0.002);
  return {
    ...r,
    properties: { ...r.properties, time: COMBINED_EPOCH - 3600000 },
    geometry:
      i < 5 ? { ...r.geometry, coordinates: [p.lon, p.lat, 5] } : r.geometry,
  };
});
const fires = Array.from({ length: 6000 }, (_, i) => ({
  ...grid(i, 78, 0.001),
  frp: 5 + (i % 120),
  confidence: ['low', 'nominal', 'high'][i % 3],
  brightness: 280 + (i % 90),
  daynight: i % 2 ? 'N' : 'D',
  acqDate: '2026-10-28',
  acqTime: '1730',
  instrument: 'VIIRS',
  satellite: 'NOAA-20',
}));
const elements = Array.from({ length: 20 }, (_, i) => {
  const p = grid(i, 5, 0.006),
    d = 0.0007;
  return {
    type: 'way',
    id: 980000 + i,
    center: p,
    tags: { military: 'airfield', name: `W2 facility ${i}` },
    bounds: {
      minlat: p.lat - d,
      minlon: p.lon - d,
      maxlat: p.lat + d,
      maxlon: p.lon + d,
    },
    geometry: [
      [p.lon - d, p.lat - d],
      [p.lon + d, p.lat - d],
      [p.lon + d, p.lat + d],
      [p.lon - d, p.lat + d],
      [p.lon - d, p.lat - d],
    ].map(([lon, lat]) => ({ lon, lat })),
  };
});
export const combinedPayloads = {
  radio,
  cctv,
  alpr,
  bikes,
  earthquakes,
  fires,
  elements,
};

/** One source transport fixture, shared unchanged by both engines. */
export async function installCombinedFixture(
  page,
  { denseQuakes = false } = {},
) {
  const quakePayload = denseQuakes
    ? {
        ...earthquakes,
        features: earthquakes.features.map((r, i) => {
          const p = grid(i, 23, 0.002);
          return {
            ...r,
            geometry: { ...r.geometry, coordinates: [p.lon, p.lat, 5] },
          };
        }),
      }
    : earthquakes;
  const frame = await cameraFrame(),
    requests = [];
  const session = await page.createCDPSession();
  await session.send('Fetch.enable', {
    patterns: [
      ...['127.0.0.1', 'localhost'].map((host) => ({
        urlPattern: `http://${host}:*/api/*`,
      })),
      { urlPattern: 'https://earthquake.usgs.gov/*all_day.geojson' },
      { urlPattern: 'https://tiles.dontgetflocked.com/*' },
      { urlPattern: '*://*.earthdata.nasa.gov/*' },
    ],
  });
  let disposed = false;
  session.on('Fetch.requestPaused', async (event) => {
    try {
      const u = new URL(event.request.url);
      let body,
        type = 'application/json';
      const p = u.pathname;
      if (u.hostname === 'earthquake.usgs.gov') body = quakePayload;
      else if (u.hostname === 'tiles.dontgetflocked.com') {
        if (p.endsWith('.json'))
          body = {
            tiles: [
              'https://tiles.dontgetflocked.com/cameras-us-hourly/{z}/{x}/{y}.mvt',
            ],
            bounds: [-160, 17, -64, 59],
          };
        else {
          const m = p.match(/\/(\d+)\/(\d+)\/(\d+)\.mvt$/);
          body = m
            ? cameraTile(...m.slice(1).map(Number), alpr)
            : Buffer.alloc(0);
          type = 'application/x-protobuf';
        }
      } else if (u.hostname === 'cmr.earthdata.nasa.gov')
        body = {
          hits: 2,
          items: ['2026-10-28', '2026-10-27'].map((day) => ({
            umm: {
              TemporalExtent: {
                RangeDateTime: { BeginningDateTime: `${day}T12:00:00Z` },
              },
              AdditionalAttributes: [{ Name: 'CLOUD_COVERAGE', Values: ['0'] }],
              SpatialExtent: {
                HorizontalSpatialDomain: {
                  Geometry: {
                    BoundingRectangles: [
                      {
                        WestBoundingCoordinate: -72,
                        EastBoundingCoordinate: -70,
                        SouthBoundingCoordinate: 41,
                        NorthBoundingCoordinate: 43,
                      },
                    ],
                  },
                },
              },
            },
          })),
        };
      else if (u.hostname.endsWith('.earthdata.nasa.gov')) {
        body = frame;
        type = 'image/png';
      } else if (p === '/api/firms')
        body = { fires, fetchedAt: COMBINED_EPOCH - 120000, stale: false };
      else if (p === '/api/radio/stations')
        body = {
          stations: radio,
          updatedAt: new Date(COMBINED_EPOCH).toISOString(),
          stale: false,
          degraded: false,
          acceptedGeneration: 1,
          catalogInstance: 'w2-combined-fixture',
        };
      else if (p.startsWith('/api/gbfs/'))
        body = {
          version: '3.0',
          data: {
            stations: decodeURIComponent(u.href).includes('station_information')
              ? bikes
              : bikes.map(({ station_id }) => ({
                  station_id,
                  num_bikes_available: 7,
                  num_docks_available: 13,
                  is_renting: true,
                  is_returning: true,
                })),
          },
        };
      else if (p === '/api/military-installations')
        body = {
          status: 'ready',
          retrievedAt: new Date(COMBINED_EPOCH).toISOString(),
          saturated: false,
          elements,
        };
      else if (p === '/api/cctv/sources') body = { sources: cctv };
      else if (p === '/api/cctv/health')
        body = {
          cameras: cctv.map(({ id }) => ({
            id,
            status: 'online',
            sourceKind: 'image',
            updatedAt: COMBINED_EPOCH,
          })),
        };
      else if (p.startsWith('/api/cctv/frame/')) {
        body = frame;
        type = 'image/png';
      } else if (p.startsWith('/api/transit/'))
        body = {
          fetchedAt: COMBINED_EPOCH,
          vehicles: [],
          fixes: [],
          epochs: [],
        };
      else if (p === '/api/flights') body = { states: [] };
      else if (p === '/api/military') body = { ac: [] };
      else if (p === '/api/vessels') body = { connected: false, vessels: [] };
      else if (p === '/api/google/nearby-places') body = { places: [] };
      else if (p === '/api/setup/status') body = { ready: true };
      else if (p === '/api/openai/hud-summary')
        body = { summary: 'W2 performance fixture' };
      else if (p === '/api/terrain/heights')
        body = {
          results: (u.searchParams.get('points') || '')
            .split(';')
            .filter(Boolean)
            .map((point) => {
              const [lon, lat] = point.split(',').map(Number);
              return { lon, lat, elevation: 20, geoid: 0, ellipsoid: 20 };
            }),
        };
      if (body === undefined) {
        await session.send('Fetch.continueRequest', {
          requestId: event.requestId,
        });
        return;
      }
      requests.push(p);
      await session.send('Fetch.fulfillRequest', {
        requestId: event.requestId,
        responseCode: 200,
        responseHeaders: [
          { name: 'Content-Type', value: type },
          { name: 'Access-Control-Allow-Origin', value: '*' },
          { name: 'Access-Control-Expose-Headers', value: 'Data-Present' },
          { name: 'Data-Present', value: 'true' },
        ],
        body: (Buffer.isBuffer(body)
          ? body
          : Buffer.from(JSON.stringify(body))
        ).toString('base64'),
      });
    } catch (error) {
      if (
        !disposed &&
        !page.isClosed() &&
        !String(error.message).includes('Invalid InterceptionId')
      )
        page.emit('pageerror', error);
    }
  });
  return {
    requests,
    async dispose() {
      disposed = true;
      await session.detach();
    },
  };
}
