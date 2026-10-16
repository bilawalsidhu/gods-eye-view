import assert from 'node:assert/strict';
import test from 'node:test';
import {
  catalogForSurface,
  composeCatalog,
  coreTools,
  defineTool,
  ToolError,
} from '../index.js';

const conditions = {
  observedAt: '2026-10-01T19:15:00.000Z',
  temperatureC: 26.3,
  apparentTemperatureC: 32,
  precipitationMm: 0,
  cloudCoverPct: 100,
  windKph: 5.4,
  windDirectionDeg: 318,
  visibilityM: 15400,
  weatherCode: 3,
};
const weather = {
  calls: [],
  async getConditions(latitude, longitude) {
    this.calls.push([latitude, longitude]);
    return { status: 'ready', weather: conditions };
  },
};
const places = {
  resolve: async (name) =>
    name === 'Austin'
      ? {
          name: 'Austin, Texas',
          bounds: { west: -97.94, south: 30.1, east: -97.56, north: 30.52 },
        }
      : null,
};
const catalogWith = (services) =>
  composeCatalog({ tools: coreTools, services });

test('weather describes current conditions at a point or place', async () => {
  const catalog = catalogWith({ weather, places });
  const result = await catalog.call('get_weather', {
    location: { place: 'Austin' },
  });
  assert.equal(
    result.summary,
    'Weather at Austin, Texas: overcast, 26°C, wind 5 km/h.',
  );
  assert.deepEqual(result.data.weather, {
    observed_at: '2026-10-01T19:15:00.000Z',
    conditions: 'overcast',
    weather_code: 3,
    temperature_c: 26.3,
    feels_like_c: 32,
    precipitation_mm: 0,
    cloud_cover_pct: 100,
    wind_kph: 5.4,
    wind_direction_deg: 318,
    visibility_m: 15400,
  });
  const [latitude, longitude] = weather.calls.at(-1);
  assert.ok(Math.abs(latitude - 30.31) < 1e-9 && longitude === -97.75);
});

test('the regional brief returns place, weather and at most ten headlines', async () => {
  const regional = {
    async getBrief() {
      return {
        place: {
          label: 'Edwards Plateau',
          locality: null,
          region: 'Edwards Plateau',
          country: null,
          kind: 'natural',
        },
        weather: conditions,
        newsSource: 'Google News RSS',
        articles: Array.from({ length: 12 }, (_, index) => ({
          title: `Story ${index}`,
          url: `https://news.example/${index}`,
          domain: 'news.example',
          publishedAt: '2026-10-01T00:00:00Z',
        })),
      };
    },
  };
  const result = await catalogWith({ regional }).call('get_regional_brief', {
    location: { lat: 30.27, lon: -97.74 },
  });
  assert.equal(
    result.summary,
    'Edwards Plateau: overcast, 26°C, wind 5 km/h; 10 recent headlines.',
  );
  assert.equal(result.data.articles.length, 10);
  assert.deepEqual(result.data.articles[0], {
    title: 'Story 0',
    url: 'https://news.example/0',
    source: 'news.example',
    published_at: '2026-10-01T00:00:00Z',
  });
});

const storm = (id, name, latitude, longitude, windKt) => ({
  id,
  name,
  classification: 'Hurricane',
  basin: 'Atlantic',
  position: { latitude, longitude },
  positionAt: '2026-10-01T18:00:00.000Z',
  advisoryNumber: '12',
  issuedAt: '2026-10-01T15:00:00.000Z',
  windKt,
  pressureHpa: 980,
  movement: { towardDeg: 300, speedKt: 10 },
  advisoryUrl: 'https://www.nhc.noaa.gov/text/X.shtml',
});

test('cyclones are listed strongest first and can be limited to an area', async () => {
  const cyclones = {
    async getSnapshot() {
      return {
        source: 'NOAA NHC / CPHC',
        coverage: 'Atlantic and eastern/central North Pacific',
        stale: false,
        unavailable: false,
        storms: [
          storm('a', 'Alpha', 25, -70, 65),
          storm('b', 'Beta', 15, -110, 120),
        ],
      };
    },
  };
  const all = await catalogWith({ cyclones }).call('get_cyclones', {});
  assert.equal(
    all.summary,
    '2 active tropical cyclones; strongest Beta at 120 kt.',
  );
  assert.deepEqual(
    all.data.storms.map((row) => row.id),
    ['b', 'a'],
  );
  const atlantic = await catalogWith({ cyclones }).call('get_cyclones', {
    area: { bbox: [-100, 0, -10, 50] },
  });
  assert.equal(
    atlantic.summary,
    '1 active tropical cyclone in the requested box; strongest Alpha at 65 kt.',
  );
  const down = { getSnapshot: async () => ({ unavailable: true, storms: [] }) };
  await assert.rejects(
    catalogWith({ cyclones: down }).call('get_cyclones', {}),
    (error) => error.code === 'unavailable',
  );
});

test('fire perimeters are placed by their outline and sorted by size', async () => {
  const ring = (lon, lat) => [
    [
      [lon, lat],
      [lon + 0.1, lat],
      [lon + 0.1, lat + 0.1],
      [lon, lat + 0.1],
    ],
  ];
  const perimeters = {
    async getSnapshot() {
      return [
        {
          stableId: 'small',
          name: 'Small Fire',
          acres: 120.4,
          containedPct: 80,
          state: 'US-CA',
          county: 'Kern',
          category: 'WF',
          cause: 'Human',
          behavior: null,
          personnel: 20,
          discoveredTime: Date.UTC(2026, 8, 1),
          updatedTime: null,
          polygons: [ring(-118.5, 35.2)],
        },
        {
          stableId: 'big',
          name: 'Big Fire',
          acres: 5000,
          containedPct: 10,
          polygons: [ring(-118.8, 35.4)],
        },
        {
          stableId: 'far',
          name: 'Far Fire',
          acres: 9000,
          polygons: [ring(-80, 30)],
        },
        { stableId: 'empty', name: 'No Outline', acres: 1, polygons: [] },
      ];
    },
  };
  const result = await catalogWith({ perimeters }).call('get_fire_perimeters', {
    area: { bbox: [-120, 34, -117, 36] },
  });
  assert.equal(
    result.summary,
    '2 mapped wildfire perimeters in the requested box.',
  );
  assert.deepEqual(
    result.data.rows.map((row) => row.id),
    ['big', 'small'],
  );
  assert.deepEqual(result.data.rows[1], {
    id: 'small',
    name: 'Small Fire',
    acres: 120,
    contained_pct: 80,
    state: 'US-CA',
    county: 'Kern',
    category: 'WF',
    cause: 'Human',
    behavior: null,
    personnel: 20,
    discovered: '2026-09-01T00:00:00.000Z',
    updated: null,
    lat: 35.25,
    lon: -118.45,
  });
});

test('terrain heights are returned in request order', async () => {
  const terrain = {
    async getHeights(points) {
      return points.map((point) => ({
        ...point,
        elevation: point.lat * 100,
        geoid: -30.04,
        ellipsoid: point.lat * 100 - 30.04,
      }));
    },
  };
  const one = await catalogWith({ terrain }).call('get_terrain_height', {
    points: [{ lat: 27.9881, lon: 86.925 }],
  });
  assert.equal(one.summary, 'Ground elevation is 2798.8 m at 27.9881, 86.925.');
  const many = await catalogWith({ terrain }).call('get_terrain_height', {
    points: [
      { lat: 1, lon: 1 },
      { lat: 2, lon: 2 },
    ],
  });
  assert.deepEqual(
    many.data.points.map((point) => point.elevation_m),
    [100, 200],
  );
  const short = { getHeights: async () => [] };
  await assert.rejects(
    catalogWith({ terrain: short }).call('get_terrain_height', {
      points: [{ lat: 1, lon: 1 }],
    }),
    (error) => error.code === 'malformed',
  );
  await assert.rejects(
    catalogWith({ terrain }).call('get_terrain_height', {
      points: Array(21).fill({ lat: 0, lon: 0 }),
    }),
    /at most 20 items/,
  );
});

test('military installations need a bounded area and are nearest first', async () => {
  const requested = [];
  const options = [];
  let saturated = false;
  const installations = {
    async getMappedSites(box, { signal, ...rest } = {}) {
      requested.push(box);
      options.push(rest);
      return {
        saturated,
        source: 'OpenStreetMap',
        records: [
          {
            id: 'osm:1',
            kind: 'installation',
            class: 'base',
            name: 'Naval Base Point Loma',
            latitude: 32.6941,
            longitude: -117.2494,
          },
          {
            id: 'osm:2',
            kind: 'installation',
            class: 'airfield',
            name: 'North Island',
            latitude: 32.7,
            longitude: -117.2,
          },
        ],
      };
    },
  };
  const catalog = catalogWith({ installations });
  const result = await catalog.call('find_military_installations', {
    area: { lat: 32.7, lon: -117.2, radius_km: 20 },
  });
  assert.equal(
    result.summary,
    '2 mapped military installations in 20 km around 32.700, -117.200.',
  );
  assert.deepEqual(
    result.data.rows.map((row) => row.id),
    ['osm:2', 'osm:1'],
  );
  assert.equal(result.data.source, 'OpenStreetMap');
  assert.equal(result.data.complete, true);
  assert.ok(requested[0].north - requested[0].south < 1);
  assert.deepEqual(options[0], { exact: true, thinned: false });
  saturated = true;
  const partial = await catalog.call('find_military_installations', {
    area: { lat: 32.7, lon: -117.2, radius_km: 20 },
  });
  assert.equal(partial.data.complete, false);
  assert.match(
    partial.summary,
    /\(partial: the source returned only some sites\)\.$/,
  );
  await assert.rejects(
    catalog.call('find_military_installations', {
      area: { bbox: [-130, 20, -100, 50] },
    }),
    /at most 10° on each side/,
  );
});

test('map features name what is at a location and report an unconfigured server', async () => {
  const features = {
    async getAdministrativeAreas() {
      return [
        {
          id: 1,
          category: 'administrative',
          names: { primary: 'Texas' },
          level: 4,
          point: null,
        },
        {
          id: 2,
          category: 'administrative',
          names: { primary: 'Travis County', english: 'Travis County' },
          level: 6,
          point: null,
        },
        { id: 3, category: 'administrative', names: {}, level: 8, point: null },
      ];
    },
    getEnclosingAreas: async () => null,
    getMonuments: async () => ({
      unavailable: true,
      code: 'OVERPASS_NOT_CONFIGURED',
    }),
  };
  const catalog = catalogWith({ features });
  const result = await catalog.call('get_map_features', {
    location: { lat: 30.27, lon: -97.74 },
    kind: 'administrative_areas',
  });
  assert.equal(
    result.summary,
    '2 named features (administrative areas) at 30.2700, -97.7400.',
  );
  assert.deepEqual(
    result.data.rows.map((row) => [row.name, row.admin_level]),
    [
      ['Texas', 4],
      ['Travis County', 6],
    ],
  );
  await assert.rejects(
    catalog.call('get_map_features', {
      location: { lat: 30.27, lon: -97.74 },
      kind: 'monuments',
    }),
    (error) => error.code === 'unavailable' && /Overpass/.test(error.message),
  );
  await assert.rejects(
    catalog.call('get_map_features', {
      location: { lat: 30.27, lon: -97.74 },
      kind: 'named_places',
    }),
    (error) => error.code === 'retry_later',
  );
});

test('the situation brief combines available sections and marks failures', async () => {
  const services = {
    weather,
    earthquakes: {
      getSnapshot: async () => [
        {
          stableId: 'q',
          usgsId: 'us1',
          lat: 30.3,
          lon: -97.7,
          mag: 3.1,
          place: 'near Austin',
          time: 0,
          depthKm: 5,
        },
      ],
    },
    fires: { getSnapshot: async () => ({ keyRequired: true }) },
    cyclones: {
      getSnapshot: async () => {
        throw new Error('upstream down');
      },
    },
    places,
  };
  const result = await catalogWith(services).call('situation_brief', {
    area: { place: 'Austin' },
  });
  assert.equal(
    result.summary,
    'Situation in Austin, Texas: Weather at Austin, Texas: overcast, 26°C, wind 5 km/h. ' +
      '1 earthquake of M2.5+ in the last 24 hours in Austin, Texas; strongest M3.1 near Austin.',
  );
  assert.deepEqual(Object.keys(result.data.sections), [
    'weather',
    'earthquakes',
    'fires',
    'cyclones',
  ]);
  assert.deepEqual(result.data.sections.fires, {
    unavailable: true,
    reason: 'Fire detections need a NASA FIRMS key configured for this server',
  });
  assert.deepEqual(result.data.sections.cyclones, {
    unavailable: true,
    reason: 'unavailable right now',
  });
  assert.equal(result.data.sections.aircraft, undefined);
});

test('the HUD caption summarizes the brief through the summary service', async () => {
  const sent = [];
  const summary = {
    async summarize(context) {
      sent.push(context);
      return {
        ok: true,
        status: 200,
        data: { summary: 'Overcast skies over Austin', error: null },
      };
    },
  };
  const result = await catalogWith({ weather, summary, places }).call(
    'get_hud_caption',
    { area: { place: 'Austin' } },
  );
  assert.equal(result.summary, 'Overcast skies over Austin');
  assert.equal(sent[0].location, 'Austin, Texas');
  assert.deepEqual(sent[0].placeLabels, ['Austin, Texas']);
  assert.deepEqual(sent[0].enabledLayerLabels, ['Weather']);
  assert.equal(sent[0].feedProvenance.overall, 'nominal');
  assert.match(sent[0].observations[0], /^Weather at /);
  const failing = {
    summarize: async () => ({
      ok: false,
      status: 502,
      data: { summary: null },
    }),
  };
  await assert.rejects(
    catalogWith({ weather, summary: failing, places }).call('get_hud_caption', {
      area: { place: 'Austin' },
    }),
    (error) => error instanceof ToolError && error.code === 'unavailable',
  );
});

test('military awareness gathers contacts around a point and marks failures', async () => {
  const contact = (id, latitude, longitude) => ({
    id,
    reference: id,
    latitude,
    longitude,
    callsign: 'RCH123',
    baroAltitudeM: 9000,
    onGround: false,
    positionTimeMs: Date.UTC(2026, 0, 1),
  });
  const military = {
    getSnapshot: async () => ({
      records: [contact('ae1234', 32.8, -117.1), contact('ae9999', 40, -100)],
      complete: true,
      source: 'Military feed',
      freshness: 'current',
    }),
  };
  const aircraft = {
    getSnapshot: async () => {
      throw new Error('upstream down');
    },
  };
  const installations = {
    getMappedSites: async () => ({
      source: 'OpenStreetMap',
      records: [
        {
          id: 'osm:1',
          kind: 'installation',
          class: 'base',
          name: 'Naval Base Point Loma',
          latitude: 32.6941,
          longitude: -117.2494,
        },
      ],
    }),
  };
  const catalog = catalogWith({ military, aircraft, installations });
  const result = await catalog.call('military_awareness', {
    location: { lat: 32.7, lon: -117.2 },
    radius_km: 100,
  });
  assert.equal(
    result.summary,
    'Military awareness within 100 km of 32.7000, -117.2000: ' +
      '1 military aircraft in 100 km around 32.700, -117.200. ' +
      '1 mapped military installation in 100 km around 32.700, -117.200.',
  );
  assert.deepEqual(Object.keys(result.data.sections), [
    'military_aircraft',
    'aircraft',
    'installations',
  ]);
  assert.deepEqual(
    result.data.sections.military_aircraft.data.rows.map((row) => row.id),
    ['ae1234'],
  );
  assert.deepEqual(result.data.sections.aircraft, {
    unavailable: true,
    reason: 'unavailable right now',
  });
  assert.equal(result.data.radius_km, 100);
  const voice = catalogForSurface(catalog, 'voice');
  assert.equal(voice.get('aircraft_in_area'), undefined);
  assert.deepEqual(
    Object.keys(
      (
        await voice.call('military_awareness', {
          location: { lat: 32.7, lon: -117.2 },
          radius_km: 100,
        })
      ).data.sections,
    ),
    ['military_aircraft', 'aircraft', 'installations'],
  );
  assert.equal(
    (await catalog.call('military_awareness', { location: { lat: 0, lon: 0 } }))
      .data.radius_km,
    250,
  );
  await assert.rejects(
    catalog.call('military_awareness', {
      location: { lat: 0, lon: 0 },
      radius_km: 500,
    }),
    /radius_km/,
  );
});

test('composites reach their sections through the catalog', async () => {
  const replacement = defineTool({
    name: 'get_weather',
    title: 'Weather',
    description: 'Replaced weather.',
    inputSchema: {
      type: 'object',
      properties: { location: { type: 'object' } },
    },
    run: async () => ({ summary: 'Replaced weather.', data: {} }),
  });
  const seen = [];
  const catalog = composeCatalog({
    tools: [...coreTools, replacement],
    replace: ['get_weather'],
    services: { weather, places },
    interceptors: [
      (call, next) => {
        seen.push([call.tool.name, call.parent ?? null]);
        return next(call);
      },
    ],
  });
  const result = await catalog.call('situation_brief', {
    area: { place: 'Austin' },
  });
  assert.equal(result.data.sections.weather.summary, 'Replaced weather.');
  assert.deepEqual(seen, [
    ['situation_brief', null],
    ['get_weather', 'situation_brief'],
  ]);
});

test('the HUD caption context carries each section feed state', async () => {
  const sent = [];
  const summary = {
    async summarize(context) {
      sent.push(context);
      return {
        ok: true,
        status: 200,
        data: { summary: 'Austin aircraft STALE' },
      };
    },
  };
  const aircraft = {
    getSnapshot: async () => ({
      records: [],
      complete: true,
      source: 'Test feed',
      freshness: 'stale',
    }),
  };
  const cyclones = {
    getSnapshot: async () => {
      throw new Error('upstream down');
    },
  };
  await catalogWith({ weather, summary, places, aircraft, cyclones }).call(
    'get_hud_caption',
    { area: { place: 'Austin' } },
  );
  assert.deepEqual(
    sent[0].enabledLayers.map((layer) => [layer.id, layer.feedState]),
    [
      ['weather', 'nominal'],
      ['aircraft', 'stale'],
      ['cyclones', 'unavailable'],
    ],
  );
  assert.equal(sent[0].feedProvenance.overall, 'unavailable');
  assert.match(sent[0].feedProvenance.note, /Aircraft is STALE/);
});

test('brief sections use a named place at its own point', async () => {
  const tokyo = {
    resolve: async () => ({
      name: 'Tokyo, Japan',
      point: { lat: 35.6769, lon: 139.7639 },
      bounds: { west: 135, south: 20, east: 155, north: 36 },
    }),
  };
  const queries = [];
  const aircraft = {
    getSnapshot: async (query) => {
      queries.push(query);
      return { records: [], complete: true, source: 'Test feed' };
    },
  };
  const result = await catalogWith({ weather, places: tokyo, aircraft }).call(
    'situation_brief',
    { area: { place: 'Tokyo' } },
  );
  assert.deepEqual(queries[0], { latitude: 35.6769, longitude: 139.7639 });
  assert.match(result.data.sections.aircraft.summary, /in Tokyo, Japan\.$/);
});

test('a fire perimeter enclosing the whole area is found', async () => {
  const perimeters = {
    getSnapshot: async () => [
      {
        stableId: 'big',
        name: 'Big Fire',
        acres: 250000,
        polygons: [
          [
            [
              [-122, 38],
              [-120, 38],
              [-120, 40],
              [-122, 40],
            ],
          ],
        ],
      },
    ],
  };
  const result = await catalogWith({ perimeters }).call('get_fire_perimeters', {
    area: { bbox: [-121.2, 38.9, -120.8, 39.1] },
  });
  assert.deepEqual(
    result.data.rows.map((row) => row.id),
    ['big'],
  );
});

test('stale weather and partial fire data reach answers and the HUD caption', async () => {
  const sent = [];
  const summary = {
    async summarize(context) {
      sent.push(context);
      return { ok: true, status: 200, data: { summary: 'Austin STALE' } };
    },
  };
  const staleWeather = {
    getConditions: async () => ({ status: 'stale', weather: conditions }),
  };
  const fires = {
    getSnapshot: async () => ({
      stale: false,
      fetchedAt: Date.UTC(2026, 0, 1),
      sources: [
        { source: 'VIIRS_NOAA20_NRT', ok: true },
        { source: 'VIIRS_SNPP_NRT', ok: false },
      ],
      fires: [],
    }),
  };
  const catalog = catalogWith({
    weather: staleWeather,
    summary,
    places,
    fires,
  });
  const weatherResult = await catalog.call('get_weather', {
    location: { place: 'Austin' },
  });
  assert.equal(weatherResult.data.stale, true);
  assert.match(weatherResult.summary, /\(data may be stale\)\.$/);
  const fireResult = await catalog.call('get_active_fires', {
    area: { place: 'Austin' },
  });
  assert.deepEqual(fireResult.data.missing_sources, ['VIIRS_SNPP_NRT']);
  assert.match(fireResult.summary, /\(no data from VIIRS_SNPP_NRT\)\.$/);
  await catalog.call('get_hud_caption', { area: { place: 'Austin' } });
  assert.deepEqual(
    sent[0].enabledLayers.map((layer) => [layer.id, layer.feedState]),
    [
      ['weather', 'stale'],
      ['fires', 'degraded'],
    ],
  );
});

test('installation names wait for the name pack, briefly', async (t) => {
  const site = (name) => ({
    id: 'osm:9',
    kind: 'installation',
    name,
    latitude: 30.31,
    longitude: -97.76,
  });
  const source = (enrichment) => ({
    getMappedSites: async () => ({
      source: 'OpenStreetMap tiles',
      records: [site('Military area')],
      enrichment,
    }),
  });
  const area = { lat: 30.31, lon: -97.76, radius_km: 5 };
  const named = await catalogWith({
    installations: source(
      Promise.resolve({
        source: 'OpenStreetMap tiles',
        records: [site('Camp Mabry')],
      }),
    ),
  }).call('find_military_installations', { area });
  assert.equal(named.data.rows[0].name, 'Camp Mabry');
  assert.equal(named.data.names_pending, false);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = catalogWith({
    installations: source(new Promise(() => {})),
  }).call('find_military_installations', { area });
  await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(5000);
  const slow = await pending;
  assert.equal(slow.data.rows[0].name, 'Military area');
  assert.equal(slow.data.names_pending, true);
  assert.match(slow.summary, /site names are still loading\)\.$/);
});
