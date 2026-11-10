import { readFileSync } from 'node:fs';
import sharp from 'sharp';
import { installAlprFixture } from '../fixtures/layers/alpr.mjs';
import { installCctvFixture } from '../fixtures/layers/cctv.mjs';
import { installCombinedFixture } from '../fixtures/layers/combined.mjs';
import { installRadioFixture } from '../fixtures/layers/radio.mjs';
import {
  installTransitFixture,
  TRANSIT_EPOCH,
} from '../fixtures/layers/transit.mjs';
import { firmsFixture } from '../fixtures/layers/firms.mjs';
import { wildlifeRoutes } from '../fixtures/wildlife.mjs';
import { serveFixtures, newFixture } from '../qa-street-level.mjs';
import { KV_LINE } from '../fixtures/street-level/kartaView.mjs';
import { trafficFixtureResponse } from '../traffic-fixtures.mjs';
import {
  satelliteFixture,
  SATELLITE_FIXTURE_EPOCH,
} from '../../src/bench/satelliteFixture.js';
import { launchFixture } from '../../src/bench/launchFixture.js';

// These are the feeds used by the strict switching scenarios. Feed timestamps
// stay fixed; wall time must advance for visibility throttles and fade-in.
export async function coldStartFixtures(origin, group) {
  const epoch =
    group === 'space'
      ? SATELLITE_FIXTURE_EPOCH
      : group === 'imagery'
        ? Date.parse('2026-10-29T12:00:00Z')
        : group === 'urban'
          ? TRANSIT_EPOCH
          : Date.now();
  const png = await sharp({
    create: { width: 256, height: 256, channels: 4, background: '#40506a' },
  })
    .png()
    .toBuffer();
  const json = (body) => ({
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
  const image = () => ({ contentType: 'image/png', body: png });
  const routes = [];
  const fixtures = [];
  const route = (pattern, respond) => routes.push({ pattern, respond });
  if (group === 'wildlife')
    routes.push(...wildlifeRoutes(origin, { now: () => epoch }).routes);
  if (group === 'open') {
    route('https://tiles.openseamap.org/*', image);
    route('https://www.opensnowmap.org/*', image);
  }
  if (group === 'cameras') fixtures.push('https://tiles.dontgetflocked.com/*');
  if (group === 'street')
    fixtures.push(
      '*://*.mapillary.com/*',
      'https://api.kartaview.org/*',
      'https://cdn.kartaview.org/*',
      '*://*.openstreetcam.org/*',
      'https://api.panoramax.xyz/*',
      'https://panoramax.openstreetmap.fr/*',
    );
  if (group === 'nepal') {
    route('https://i.ytimg.com/*', image);
    for (const pattern of [
      'https://www.youtube.com/iframe_api*',
      'https://connect.facebook.net/*',
    ])
      route(pattern, () => ({ contentType: 'text/javascript', body: '' }));
    for (const pattern of [
      'https://www.youtube-nocookie.com/*',
      'https://www.facebook.com/*',
    ])
      route(pattern, () => ({
        contentType: 'text/html',
        body: '<!doctype html><title>Fixture media</title>',
      }));
  }
  if (group === 'traffic') {
    for (const pattern of [
      'https://tiles.openfreemap.org/*',
      origin + '/api/tomtom/*',
    ])
      route(
        pattern,
        (req) =>
          trafficFixtureResponse({ url: () => req.url }) ??
          json({ hasKey: false }),
      );
  }
  if (group === 'imagery') {
    route('https://cmr.earthdata.nasa.gov/*', () =>
      json({
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
                      WestBoundingCoordinate: -98,
                      EastBoundingCoordinate: -97,
                      SouthBoundingCoordinate: 30,
                      NorthBoundingCoordinate: 31,
                    },
                  ],
                },
              },
            },
          },
        })),
      }),
    );
    route('https://*.earthdata.nasa.gov/*', image);
  }
  if (group === 'weather') {
    const times = ['2026-11-02T12:00:00.000Z', '2026-11-02T12:05:00.000Z'];
    route(origin + '/api/weather/*', (req) => {
      const url = new URL(req.url),
        product = url.searchParams.get('product');
      return url.pathname.endsWith('manifest')
        ? json({
            schemaVersion: 1,
            product,
            times,
            latest: times.at(-1),
            maxLevel: 6,
            tileSize: 256,
            tilingScheme: 'geographic',
            bounds: { west: -130, south: 20, east: -50, north: 60 },
            display: { credit: 'Weather fixture' },
          })
        : image();
    });
    route(origin + '/api/cyclones*', () =>
      json({
        schemaVersion: 1,
        source: 'NOAA fixture',
        attribution: 'NOAA fixture',
        coverage: 'Atlantic',
        fetchedAt: Date.parse(times[1]),
        stale: false,
        unavailable: false,
        reason: null,
        storms: [
          {
            id: 'al012026',
            name: 'Fixture storm',
            basin: 'AL',
            classification: 'TS',
            position: { longitude: -79.38, latitude: 43.65 },
            advisoryNumber: '10',
            issuedAt: times[1],
            positionAt: times[1],
            windKt: 40,
            pressureHpa: 1000,
            movement: { directionDegrees: 45, speedKt: 10 },
            advisoryUrl: null,
            outlookUrl: null,
            geometryStatus: 'current',
            geometryAdvisoryNumber: '10',
            track: {
              type: 'LineString',
              coordinates: [
                [-79.38, 43.65],
                [-79.31, 43.68],
              ],
            },
            cone: {
              type: 'Polygon',
              coordinates: [
                [
                  [-79.35, 43.63],
                  [-79.28, 43.63],
                  [-79.28, 43.7],
                  [-79.35, 43.63],
                ],
              ],
            },
            forecastPoints: [
              {
                tauHours: 24,
                position: { longitude: -79.31, latitude: 43.68 },
                windKt: 50,
                gustKt: 60,
              },
            ],
          },
        ],
      }),
    );
  }
  if (group === 'wind')
    route(origin + '/api/wind/*', (req) => {
      const url = new URL(req.url),
        model = url.searchParams.get('model'),
        kind = url.searchParams.get('overlay');
      if (url.pathname.endsWith('/manifest'))
        return json({
          model,
          overlay: kind ?? 'none',
          grid: { nx: 36, ny: 19, lo1: 0, la1: 90, dx: 10, dy: 10 },
          gridUrl: '/api/wind/grid/' + model + '-fixture.bin' + url.search,
          cycle: {
            validIso: '2026-11-02T12:00:00Z',
            runIso: '2026-11-02T06:00:00Z',
          },
          ...(kind
            ? {
                scalar: {
                  kind,
                  units: kind === 'temperature' ? '°C' : 'hPa',
                  level: '2 m above ground',
                },
              }
            : {}),
        });
      const count = 36 * 19,
        values = new Float32Array(count * (kind ? 3 : 2));
      values.fill(8, 0, count);
      values.fill(6, count, 2 * count);
      if (kind) values.fill(kind === 'temperature' ? 40 : 1020, 2 * count);
      return {
        contentType: 'application/octet-stream',
        body: Buffer.from(values.buffer),
      };
    });
  const groups =
    group === 'space'
      ? Object.fromEntries(
          [
            'stations',
            'visual',
            'gps-ops',
            'glo-ops',
            'galileo',
            'geo',
            'starlink',
            'resource',
            'weather',
            'planet',
            'sar',
            'science',
          ].map((id) => [id, satelliteFixture(id)]),
        )
      : {};
  const ghost =
    group === 'ghostmaps'
      ? [
          ...readFileSync(
            new URL('../fixtures/ghostmaps-scenes.kmz', import.meta.url),
          ),
        ]
      : [];
  const firms = firmsFixture();
  return {
    routes,
    fixtures,
    epoch,
    streetLongitude: KV_LINE.lon,
    async install(page) {
      if (group === 'urban') {
        await installCombinedFixture(page);
        const transit = await installTransitFixture(page);
        transit.setStep(9);
      }
      if (group === 'radio') await installRadioFixture(page);
      if (group === 'cameras') {
        await installCctvFixture(page);
        await installAlprFixture(page);
      }
      if (group === 'street')
        await serveFixtures(page, newFixture({ configured: true }));
      await page.evaluateOnNewDocument(installFeeds, {
        group,
        epoch,
        groups,
        ghost,
        launches: launchFixture(),
        firms,
      });
    },
  };
}

function installFeeds({ group, epoch, groups, ghost, launches, firms }) {
  const RealDate = Date;
  const started = performance.now();
  const now = () =>
    group === 'space' ? epoch : epoch + performance.now() - started;
  globalThis.Date = class extends RealDate {
    constructor(...args) {
      super(...(args.length ? args : [now()]));
    }
    static now() {
      return Math.floor(now());
    }
  };
  // Mid-road starts keep the traffic population visible through birth fades
  // without random road-end recycling during the comparison.
  if (group === 'traffic') Math.random = () => 0.5;
  localStorage.setItem('gev:first-run-mission:v1', 'suppressed');
  window.__coldStartUnexpectedApi = [];
  const original = window.fetch.bind(window);
  const json = (body) => Promise.resolve(Response.json(body));
  const EventSource = window.EventSource;
  window.EventSource = class extends EventTarget {
    constructor(url, options) {
      super();
      if (!url.includes('/api/ghostmaps/events'))
        return new EventSource(url, options);
      this.readyState = 1;
    }
    close() {}
  };
  window.fetch = (input, options) => {
    const url = new URL(input.url ?? input, location.href),
      path = url.pathname;
    // The image fixture also needs the snapshot API's explicit pixel proof.
    if (
      group === 'imagery' &&
      url.hostname === 'wvs.earthdata.nasa.gov' &&
      path.startsWith('/api/v1/snapshot')
    )
      return original(input, options).then((response) =>
        response.ok
          ? new Response(response.body, {
              status: response.status,
              headers: {
                ...Object.fromEntries(response.headers),
                'Data-Present': 'true',
              },
            })
          : response,
      );
    if (path === '/api/flights')
      return json({
        time: epoch / 1000,
        states:
          group === 'aircraft'
            ? [
                [
                  '71be26',
                  'GEV123',
                  'Fixture',
                  epoch / 1000,
                  epoch / 1000,
                  -125.5779,
                  40.2539,
                  9700,
                  false,
                  0,
                  45,
                  0,
                  null,
                  9700,
                  null,
                  false,
                  0,
                ],
              ]
            : [],
      });
    if (path === '/api/military')
      return json({
        now: epoch,
        ac:
          group === 'aircraft'
            ? [
                {
                  hex: 'aaa052',
                  flight: 'GEVMIL',
                  lon: -125.58,
                  lat: 40.26,
                  alt_geom: 31825,
                  alt_baro: 31825,
                  gs: 0,
                  track: 45,
                  seen: 0,
                  seen_pos: 0,
                  dbFlags: 1,
                  type: 'adsb_icao',
                },
              ]
            : [],
      });
    if (path.startsWith('/api/flights/')) return json({ path: [] });
    if (path.startsWith('/api/adsbdb/')) return json({ response: {} });
    if (path === '/api/vessels')
      return json({
        status: 'live',
        rows: ['ground', 'contacts'].includes(group)
          ? [
              {
                mmsi: '123456789',
                name: 'Fixture Toronto',
                lat: 43.65,
                lon: -79.38,
                last_position_epoch: epoch / 1000,
              },
            ]
          : [],
      });
    if (path === '/api/vessels/track') return json({ samples: [] });
    if (path === '/api/local-receivers/aircraft')
      return json({
        configured: true,
        generatedAt: epoch,
        records: [
          {
            icao: 'abc123',
            callsign: 'LOCAL1',
            lat: 41.534,
            lon: -90.507,
            altitudeFt: 11000,
            groundSpeedKt: 0,
            trackDeg: 5,
            lastPositionAt: epoch,
            lastMessageAt: epoch,
            messageCount: 12,
            band: '1090',
            source: 'decoder',
          },
        ],
      });
    if (url.hostname === 'earthquake.usgs.gov')
      return json({
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            id: 'fixture-boston',
            geometry: { type: 'Point', coordinates: [-71.0605, 42.3554, 8] },
            properties: { mag: 4, time: epoch, place: 'Fixture Boston' },
          },
        ],
      });
    if (path === '/api/military-installations')
      return json({
        status: 'ok',
        elements:
          group === 'contacts'
            ? [
                {
                  type: 'way',
                  id: 424242,
                  tags: { military: 'naval_base', name: 'Fixture Harbour' },
                  center: { lat: 43.6725, lon: -79.33 },
                  geometry: [
                    [43.665, -79.345],
                    [43.665, -79.315],
                    [43.68, -79.315],
                    [43.68, -79.345],
                    [43.665, -79.345],
                  ].map(([lat, lon]) => ({ lat, lon })),
                },
              ]
            : [],
      });
    if (path.startsWith('/api/fire-perimeters/inciweb'))
      return json({ rows: [] });
    if (path === '/api/fire-perimeters')
      return json({
        rows: [
          {
            stableId: 'fire:fixture',
            name: 'Fixture Fire',
            acres: 500,
            containedPct: 40,
            polygons: [
              [
                [
                  [-79.47, 43.56],
                  [-79.29, 43.56],
                  [-79.29, 43.74],
                  [-79.47, 43.74],
                  [-79.47, 43.56],
                ],
              ],
            ],
          },
        ],
      });
    if (path === '/api/gnss-integrity')
      return json({
        ageMs: 0,
        rows: ['a1', 'a2', 'a3'].map((hex) => ({
          hex,
          lat: 43.65,
          lon: -79.38,
          nic: 0,
          nacp: 0,
          degraded: true,
          gpsLost: false,
        })),
      });
    if (url.hostname === 'api.weather.gc.ca')
      return json({
        type: 'FeatureCollection',
        features:
          group !== 'ground'
            ? []
            : [
                {
                  type: 'Feature',
                  ...(path.includes('aqhi-stations')
                    ? {
                        geometry: {
                          type: 'Point',
                          coordinates: [-79.38, 43.65],
                        },
                        properties: {
                          location_id: 'QA1',
                          location_name_en: 'Fixture Toronto',
                        },
                      }
                    : {
                        properties: {
                          location_id: 'QA1',
                          aqhi: 9,
                          observation_datetime: new Date().toISOString(),
                        },
                      }),
                },
              ],
      });
    if (path === '/api/drone-airspace')
      return json({
        rows: [
          {
            stableId: '310',
            name: 'Fixture Zone',
            typeCode: 'P',
            type: 'Prohibited',
            lowerAltitude: 'SFC',
            upperAltitude: '18,000 ft MSL',
            timesOfUse: 'CONTINUOUS',
            agency: null,
            city: 'WASHINGTON',
            state: 'DC',
            polygons: [
              [
                [
                  [-77.06, 38.88],
                  [-77, 38.88],
                  [-77, 38.92],
                  [-77.06, 38.92],
                  [-77.06, 38.88],
                ],
              ],
            ],
          },
        ],
        stale: false,
        fetchedAt: epoch,
      });
    if (path === '/api/overpass/status') return json({ configured: true });
    if (path.startsWith('/api/overpass/'))
      return json({
        elements: [
          {
            type: 'node',
            id: 1,
            lat: 38.9,
            lon: -77.03,
            tags: { name: 'Fixture Clinic', amenity: 'clinic' },
          },
        ],
      });
    if (path === '/api/ghostmaps/catalog')
      return json({
        commit: 'fixture',
        products: [
          { id: 'cip', version: 'fixture', title: 'Fixture', defaultOn: true },
        ],
      });
    if (path.startsWith('/api/ghostmaps/file/'))
      return Promise.resolve(new Response(new Uint8Array(ghost)));
    if (path.startsWith('/api/celestrak/'))
      return Promise.resolve(
        new Response(groups[path.split('/').pop()] ?? groups.stations),
      );
    if (path.startsWith('/api/celestrak-satcat/')) {
      const tle = groups[path.split('/').pop()];
      if (tle) {
        const lines = tle.trim().split('\n');
        const rows = [
          'OBJECT_NAME,NORAD_CAT_ID,OBJECT_TYPE,OPS_STATUS_CODE,OWNER',
        ];
        for (let i = 0; i < lines.length; i += 3)
          rows.push(`${lines[i]},${Number(lines[i + 1].slice(2, 7))},PAY,+,US`);
        return Promise.resolve(new Response(rows.join('\n')));
      }
    }
    if (path === '/api/launches') return json(launches);
    if (path === '/api/firms') return json(firms);
    if (path === '/api/route') {
      const [a, b] = url.searchParams
        .get('coords')
        .split(';')
        .map((point) => point.split(',').map(Number));
      const geometry = [a, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], b];
      return json({
        ok: true,
        geometry,
        distanceM: 9000,
        durationS: 800,
        steps: geometry.map(([lon, lat], i) => ({
          lon,
          lat,
          instruction: 'Route step ' + i,
          distanceM: 3000,
          durationS: 120,
        })),
      });
    }
    if (path === '/api/terrain/heights')
      return json({
        results: (url.searchParams.get('points') ?? '')
          .split(';')
          .map(() => ({ ellipsoid: 0 })),
      });
    // Same-origin proxies must not silently turn this into a live-feed test.
    // Delegate only routes answered by the fixtures above or the strict harness.
    if (url.origin === location.origin && path.startsWith('/api/')) {
      if (path === '/api/google/nearby-places') return json({ places: [] });
      if (path === '/api/setup/status') return json({ ready: true });
      if (/^\/api\/(firms|mapillary)\/status$/.test(path) && group !== 'street')
        return json({ hasKey: false, configured: false });
      if (path === '/api/tomtom/status' && group !== 'traffic')
        return json({ hasKey: false });
      const delegated = {
        urban: /^\/api\/(gbfs|transit)\//,
        cameras: /^\/api\/cctv\//,
        radio: /^\/api\/radio\//,
        street: /^\/api\/mapillary\//,
        weather: /^\/api\/(weather\/|cyclones)/,
        wind: /^\/api\/wind\//,
        traffic: /^\/api\/tomtom\//,
        wildlife: /^\/api\/(inaturalist|acartia)\//,
      }[group];
      if (
        !delegated?.test(path) &&
        ![
          '/api/openai/hud-summary/status',
          '/api/google/tiles-token',
          '/api/realtime/debug-log',
        ].includes(path)
      ) {
        window.__coldStartUnexpectedApi.push(path);
        return Promise.reject(new Error(`No cold-start fixture for ${path}`));
      }
    }
    return original(input, options);
  };
}
