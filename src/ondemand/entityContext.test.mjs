// Entity-chat context payload (docs/ENTITY_CHAT.md "Context payload").
// Pins the schema every consumer relies on: the key set and value types,
// the MGRS reference, the DATA LAYERS row text carried verbatim, the ≤ 10
// nearby cap, and the "no undefined / NaN anywhere" JSON-safety rule.
// Run with: node --test src/ondemand/entityContext.test.mjs
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  ENTITY_CONTEXT_SCHEMA,
  MAX_NEARBY,
  CONTEXT_BYTE_BUDGET,
  buildEntityContext,
  entitySystemInstruction,
  entitySystemPrompt,
  fitContextToBudget,
  kindForLayer,
  normalizeEntity,
  toMgrs,
  haversineKm,
  layerStatusText,
  describeToolCatalogue,
  describeWorkflow,
} from './entityContext.js';
import { LayerPanel } from '../ui/layerPanel.js';

const NOW = Date.parse('2026-09-18T12:00:00Z');
const AUSTIN = { lat: 30.2672, lon: -97.7431 };

/** Walk a value and collect every path holding undefined or NaN. */
function leaks(value, path = '$', out = []) {
  if (value === undefined) out.push(`${path}=undefined`);
  else if (typeof value === 'number' && Number.isNaN(value))
    out.push(`${path}=NaN`);
  else if (Array.isArray(value))
    value.forEach((item, i) => leaks(item, `${path}[${i}]`, out));
  else if (value && typeof value === 'object')
    for (const [k, v] of Object.entries(value)) leaks(v, `${path}.${k}`, out);
  return out;
}

function ring(count, radiusDeg, base = AUSTIN) {
  return Array.from({ length: count }, (_, i) => {
    const angle = (i / count) * 2 * Math.PI;
    return {
      id: `n${i}`,
      label: `N${i}`,
      latitude: base.lat + radiusDeg * (1 + i / count) * Math.cos(angle),
      longitude: base.lon + radiusDeg * (1 + i / count) * Math.sin(angle),
      altitudeM: 9000 + i,
      typeCode: 'B738',
      origin: 'AUS',
      destination: 'DEN',
    };
  });
}

const LAYERS = [
  {
    id: 'flights',
    name: 'Live Flights',
    source: 'OpenSky',
    enabled: true,
    lifecycleState: 'enabled',
    stats: {
      count: 812,
      lastUpdate: NOW - 12_000,
      source: 'OpenSky',
      providerStatus: 'live',
    },
  },
  {
    id: 'military',
    name: 'Military Flights',
    source: 'adsb.lol',
    enabled: true,
    lifecycleState: 'enabled',
    stats: { count: 14, lastUpdate: NOW - 40_000, source: 'adsb.lol', fallback: true },
  },
  {
    id: 'ais-live-vessels',
    name: 'Live AIS Vessels',
    source: 'AISStream',
    enabled: true,
    lifecycleState: 'enabled',
    stats: {
      count: 0,
      source: 'AIS demo replay',
      providerStatus: 'degraded',
      providerError: 'AISSTREAM_API_KEY missing — demo replay',
      lastUpdate: NOW - 5_000,
    },
  },
  {
    id: 'satellites',
    name: 'Satellites',
    source: 'CelesTrak',
    enabled: false,
    lifecycleState: 'disabled',
    stats: { count: 0, lastUpdate: null, source: 'CelesTrak' },
  },
  {
    id: 'earthquakes',
    name: 'Earthquakes',
    source: 'USGS',
    enabled: true,
    lifecycleState: 'enabled',
    stats: { count: 3, lastUpdate: NOW - 3_700_000, source: 'USGS', stale: true },
  },
];

function fakeDataManager({ withMetaText = false } = {}) {
  const modules = new Map([
    ['flights', { module: { getAllPositions: () => ring(25, 0.3) } }],
    [
      'military',
      {
        module: {
          getAllPositions: () => [
            { id: 'ae1234', label: 'RCH123', latitude: 30.5, longitude: -97.9, altitudeM: 7000 },
          ],
        },
      },
    ],
    [
      'ais-live-vessels',
      {
        module: {
          getAllPositions: () => [
            { id: '366999999', label: 'TEXAS STAR', latitude: 29.9, longitude: -95.9 },
            { id: '367000001', label: 'FAR AWAY', latitude: 51.5, longitude: -0.1 },
          ],
        },
      },
    ],
    [
      'satellites',
      {
        module: {
          getAllPositions: () => [
            { id: 25544, label: 'ISS (ZARYA)', latitude: 33.1, longitude: -99.2, altitudeM: 418_000 },
          ],
        },
      },
    ],
  ]);
  const manager = { layers: modules, getAll: () => LAYERS.map((l) => ({ ...l })) };
  if (withMetaText)
    manager._buildMetaText = (layer) => `PANEL::${layer.id}::${layer.stats.count}`;
  return manager;
}

const VIEWER = {
  camera: {
    positionCartographic: {
      latitude: (30.4 * Math.PI) / 180,
      longitude: (-97.8 * Math.PI) / 180,
      height: 120_000,
    },
    computeViewRectangle: () => ({
      south: (29.0 * Math.PI) / 180,
      west: (-99.5 * Math.PI) / 180,
      north: (31.5 * Math.PI) / 180,
      east: (-96.0 * Math.PI) / 180,
    }),
  },
};

const TOOLS = {
  tools: [
    {
      id: 'ondemand-spatial-satellites',
      name: 'OnDemand Spatial Satellites (CelesTrak)',
      description: 'x',
      tools: [
        {
          name: 'list_satellites_in_scene',
          summary: 's',
          path: '/api/tools/list_satellites_in_scene',
          params: { lat: { type: 'number' }, lon: { type: 'number' }, radiusKm: { type: 'number' } },
        },
      ],
    },
  ],
};

const HEALTH = {
  ondemand: 'healthy',
  configured: true,
  config: {
    flowVersion: {
      configured: true,
      source: 'GODS_EYE_FLOW_VERSION',
      resolvedVia: 'alias',
      canonical: 'ONDEMAND_SPATIAL_FLOW_VERSION',
      alias: 'GODS_EYE_FLOW_VERSION',
    },
    spatialFlowId: { configured: true, source: 'default' },
  },
};

const AIRCRAFT = {
  icao24: 'a1b2c3',
  callsign: 'UAL1234',
  latitude: AUSTIN.lat,
  longitude: AUSTIN.lon,
  altitudeM: 10_668,
  velocityMps: 236.4,
  track: 271.6,
  registration: 'N12345',
  typeCode: 'B738',
  airline: 'United',
  onGround: false,
  lastContactEpochMs: NOW - 3_000,
  route: { origin: { code: 'AUS' }, destination: { code: 'SFO' } },
  position: { x: 1, y: 2, z: 3 },
  _scratch: 'never',
};

function build(overrides = {}) {
  return buildEntityContext({
    entity: AIRCRAFT,
    kind: 'aircraft',
    viewer: VIEWER,
    dataManager: fakeDataManager(),
    scene: { name: 'Austin, TX' },
    tools: TOOLS,
    health: HEALTH,
    now: NOW,
    sourceFeed: 'OpenSky',
    ...overrides,
  });
}

describe('buildEntityContext — payload shape', () => {
  test('every documented key exists with the documented type', () => {
    const ctx = build();
    assert.equal(ctx.schema, ENTITY_CONTEXT_SCHEMA);
    assert.equal(ctx.generatedAtUtc, '2026-09-18T12:00:00.000Z');

    const { entity } = ctx;
    assert.equal(entity.kind, 'aircraft');
    assert.equal(entity.id, 'a1b2c3');
    assert.equal(entity.icao24, 'a1b2c3');
    assert.equal(entity.callsign, 'UAL1234');
    assert.equal(entity.lat, AUSTIN.lat);
    assert.equal(entity.lon, AUSTIN.lon);
    assert.equal(entity.altitudeM, 10_668);
    assert.equal(entity.speedMps, 236.4);
    assert.equal(entity.headingDeg, 272);
    assert.equal(entity.squawk, null);
    assert.equal(entity.sourceFeed, 'OpenSky');
    assert.equal(entity.observedAtUtc, '2026-09-18T11:59:57.000Z');
    assert.deepEqual(entity.route, { origin: 'AUS', destination: 'SFO' });
    assert.equal(typeof entity.raw, 'object');
    assert.equal(entity.raw.callsign, 'UAL1234');
    assert.equal('position' in entity.raw, false, 'Cesium positions are trimmed');
    assert.equal('_scratch' in entity.raw, false, 'private fields are trimmed');

    const { scene } = ctx;
    assert.equal(scene.name, 'Austin, TX');
    assert.deepEqual(scene.bbox, { lamin: 29, lomin: -99.5, lamax: 31.5, lomax: -96 });
    assert.deepEqual(scene.camera, { lat: 30.4, lon: -97.8, heightM: 120_000 });
    assert.equal(scene.coordinates.lat, AUSTIN.lat);
    assert.equal(scene.coordinates.lon, AUSTIN.lon);
    assert.equal(scene.coordinates.mgrs, '14R PU 2090 4906');

    assert.ok(Array.isArray(ctx.layers));
    assert.equal(ctx.layers.length, LAYERS.length, 'ALL layers are listed');
    for (const row of ctx.layers) {
      assert.equal(typeof row.id, 'string');
      assert.equal(typeof row.label, 'string');
      assert.equal(typeof row.enabled, 'boolean');
      assert.equal(typeof row.feedState, 'string');
      assert.equal(typeof row.statusText, 'string');
      assert.ok(row.source === null || typeof row.source === 'string');
      assert.ok(row.providerStatus === null || typeof row.providerStatus === 'string');
      assert.ok(row.providerError === null || typeof row.providerError === 'string');
      assert.equal(typeof row.count, 'number');
    }

    const { nearby } = ctx;
    assert.equal(typeof nearby.radiusKm, 'number');
    assert.ok(Array.isArray(nearby.aircraft));
    assert.ok(Array.isArray(nearby.vessels));
    assert.ok(Array.isArray(nearby.satellites));

    assert.ok(Array.isArray(ctx.tools.catalogue));
    assert.deepEqual(ctx.tools.catalogue, [
      {
        id: 'ondemand-spatial-satellites',
        name: 'OnDemand Spatial Satellites (CelesTrak)',
        tools: [
          {
            name: 'list_satellites_in_scene',
            path: '/api/tools/list_satellites_in_scene',
            params: ['lat', 'lon', 'radiusKm'],
          },
        ],
      },
    ]);
    assert.equal(ctx.tools.workflow.resolvedVia, 'alias');
    assert.equal(ctx.tools.workflow.versionSource, 'GODS_EYE_FLOW_VERSION');
    assert.equal(ctx.tools.workflow.idSource, 'default');
    assert.equal(ctx.tools.workflow.id, null, 'health reports names, not values');
    assert.equal(ctx.tools.workflow.versionLabel, null);
    assert.deepEqual(ctx.limits, {
      maxNearby: MAX_NEARBY,
      contextByteBudget: CONTEXT_BYTE_BUDGET,
    });
  });

  test('no undefined or NaN anywhere, even from a hostile record', () => {
    const ctx = build({
      entity: {
        ...AIRCRAFT,
        altitudeM: NaN,
        velocityMps: undefined,
        track: 'north',
        squawk: undefined,
        weird: Symbol('x'),
        fn() {},
      },
      health: null,
      tools: null,
      dataManager: { getAll: () => [{ id: 'x', stats: null }] },
      viewer: null,
    });
    assert.deepEqual(leaks(ctx), []);
    assert.equal(ctx.entity.altitudeM, null);
    assert.equal(ctx.entity.speedMps, null);
    assert.equal(ctx.entity.headingDeg, null);
    assert.equal(JSON.parse(JSON.stringify(ctx)).entity.altitudeM, null);
  });

  test('layer rows carry the exact DATA LAYERS row text', () => {
    // 1) the manager exposes _buildMetaText (src/data/manager.js) → used verbatim
    const withPanel = build({ dataManager: fakeDataManager({ withMetaText: true }) });
    assert.equal(withPanel.layers[0].statusText, 'PANEL::flights::812');
    assert.equal(withPanel.layers[2].statusText, 'PANEL::ais-live-vessels::0');

    // 2) without it, the same LayerPanel method is run directly
    const ctx = build();
    const host = { _timeAgo: (ts) => LayerPanel.prototype._timeAgo.call(null, ts) };
    for (const [index, layer] of LAYERS.entries()) {
      const expected = LayerPanel.prototype._buildMetaText.call(
        {
          _timeAgo(ts) {
            const diff = Math.floor((NOW - ts) / 1000);
            if (diff < 5) return 'just now';
            if (diff < 60) return `${diff}s ago`;
            if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
            return `${Math.floor(diff / 3600)}h ago`;
          },
        },
        layer,
      );
      assert.equal(ctx.layers[index].statusText, expected, layer.id);
    }
    assert.ok(host);
    assert.equal(ctx.layers[0].statusText, 'LIVE · OpenSky · 12s ago');
    assert.equal(ctx.layers[1].statusText, 'FALLBACK · adsb.lol · 40s ago');
    assert.equal(
      ctx.layers[2].statusText,
      'DEGRADED · AIS demo replay · AISSTREAM_API_KEY missing — demo replay',
    );
    assert.equal(ctx.layers[4].statusText, 'STALE · USGS · 1h ago');
    assert.equal(ctx.layers[0].feedState, 'nominal');
    assert.equal(ctx.layers[1].feedState, 'fallback');
    assert.equal(ctx.layers[2].feedState, 'degraded');
    assert.equal(ctx.layers[3].feedState, 'off', 'a disabled layer reads off');
    assert.equal(ctx.layers[4].feedState, 'stale');
    assert.equal(ctx.layers[2].providerStatus, 'degraded');
    assert.equal(ctx.layers[2].providerError, 'AISSTREAM_API_KEY missing — demo replay');
    assert.equal(ctx.layers[0].count, 812);
  });

  test('nearby lists are distance-sorted, exclude the subject and cap at 10', () => {
    const ctx = build();
    const { aircraft, vessels, satellites } = ctx.nearby;
    assert.equal(aircraft.length, MAX_NEARBY, '25 flights + 1 military → 10');
    for (let i = 1; i < aircraft.length; i += 1)
      assert.ok(aircraft[i - 1].distanceKm <= aircraft[i].distanceKm, 'sorted');
    assert.ok(aircraft.every((row) => row.id !== 'a1b2c3'), 'subject excluded');
    assert.ok(aircraft.some((row) => row.military === true), 'military merged in');
    assert.equal(aircraft.find((row) => !row.military).typeCode, 'B738');
    assert.equal(aircraft.find((row) => row.military).typeCode, null);
    assert.equal(typeof aircraft[0].bearingDeg, 'number');
    assert.deepEqual(
      vessels.map((row) => row.id),
      ['366999999'],
      'a vessel 8,000 km away is outside the radius',
    );
    assert.equal(satellites.length, 1);
    assert.equal(satellites[0].id, '25544');
    assert.equal(satellites[0].altitudeM, 418_000);
    assert.equal(ctx.nearby.satelliteSource, 'satellites-layer');
  });

  test('satellites overhead prefer the list_satellites_in_scene rows when supplied', () => {
    const ctx = build({
      satellitesOverhead: [
        { name: 'ISS (ZARYA)', noradId: 25544, lat: 31.0, lon: -98.0, altKm: 418.2, group: 'stations', elevationDeg: 62.1 },
        { name: 'HST', noradId: 20580, lat: 28.0, lon: -95.0, altKm: 540.0, group: 'visual', elevationDeg: 20.4 },
      ],
    });
    assert.equal(ctx.nearby.satelliteSource, 'list_satellites_in_scene');
    assert.deepEqual(
      ctx.nearby.satellites.map((row) => [row.id, row.group, row.elevationDeg, row.altitudeM]),
      [
        ['25544', 'stations', 62.1, 418_200],
        ['20580', 'visual', 20.4, 540_000],
      ],
    );
  });

  test('a subject satellite is excluded from the overhead list', () => {
    const ctx = build({
      kind: 'satellite',
      entity: { noradId: 25544, name: 'ISS (ZARYA)', latitude: 33.1, longitude: -99.2, altitudeM: 418_000 },
    });
    assert.equal(ctx.entity.kind, 'satellite');
    assert.equal(ctx.entity.noradId, '25544');
    assert.equal(ctx.nearby.satellites.length, 0);
  });

  test('vessel and satellite entities normalise their identity fields', () => {
    const vessel = normalizeEntity('vessel', {
      mmsi: '366999999',
      name: 'TEXAS STAR',
      lat: 29.3,
      lon: -94.8,
      speed: 12.4,
      course: 88,
      heading: 90,
      type: 'Tanker',
      destination: 'HOUSTON',
      lastPositionUtc: '2026-09-18T11:58:00Z',
    });
    assert.equal(vessel.id, '366999999');
    assert.equal(vessel.mmsi, '366999999');
    assert.equal(vessel.name, 'TEXAS STAR');
    assert.equal(vessel.speedKt, 12.4);
    assert.equal(vessel.speedMps, 6.4);
    assert.equal(vessel.headingDeg, 90);
    assert.equal(vessel.courseDeg, 88);
    assert.equal(vessel.altitudeM, 0);
    assert.equal(vessel.observedAtUtc, '2026-09-18T11:58:00.000Z');
    assert.deepEqual(leaks(vessel), []);

    const sat = normalizeEntity('satellite', { noradId: 25544, name: 'ISS', latitude: 1, longitude: 2, altitudeM: 418_000, velocityKms: 7.66 });
    assert.equal(sat.noradId, '25544');
    assert.equal(sat.speedMps, 7660);
    assert.deepEqual(leaks(sat), []);
  });

  test('the kind falls back to the selection-lane layer id', () => {
    assert.equal(kindForLayer('flights'), 'aircraft');
    assert.equal(kindForLayer('military'), 'aircraft');
    assert.equal(kindForLayer('ais-live-vessels'), 'vessel');
    assert.equal(kindForLayer('satellites'), 'satellite');
    assert.equal(kindForLayer('earthquakes'), null);
    const ctx = buildEntityContext({ entity: { layerId: 'ais-live-vessels', id: '1', lat: 0, lon: 0 } });
    assert.equal(ctx.entity.kind, 'vessel');
  });
});

describe('helpers', () => {
  test('toMgrs matches the HUD spacing for Austin and is null outside the grid', () => {
    assert.equal(toMgrs(AUSTIN.lat, AUSTIN.lon), '14R PU 2090 4906');
    assert.equal(toMgrs(89, 0), null);
    assert.equal(toMgrs(NaN, 1), null);
  });

  test('haversineKm: Austin → Houston ≈ 235 km', () => {
    const km = haversineKm(AUSTIN.lat, AUSTIN.lon, 29.7604, -95.3698);
    assert.ok(km > 230 && km < 240, String(km));
  });

  test('layerStatusText survives a manager whose _buildMetaText throws', () => {
    const text = layerStatusText(LAYERS[0], {
      dataManager: {
        _buildMetaText() {
          throw new Error('no panel');
        },
      },
      now: NOW,
    });
    assert.equal(text, 'LIVE · OpenSky · 12s ago');
  });

  test('describeToolCatalogue accepts the envelope or the bare array and tolerates junk', () => {
    assert.deepEqual(describeToolCatalogue(null), []);
    assert.deepEqual(describeToolCatalogue({ tools: [null, 'x'] }), []);
    assert.deepEqual(describeToolCatalogue([{ id: 'p', name: 'P', tools: [{ name: 't' }] }]), [
      { id: 'p', name: 'P', tools: [{ name: 't', path: '/api/tools/t', params: [] }] },
    ]);
  });

  test('describeWorkflow never exposes anything but names unless the block carries values', () => {
    assert.deepEqual(describeWorkflow(undefined), {
      id: null,
      idSource: null,
      versionLabel: null,
      versionSource: null,
      resolvedVia: null,
      configured: false,
      ondemand: null,
    });
    const withValues = describeWorkflow({
      configured: true,
      ondemand: 'healthy',
      config: {
        spatialFlowId: { source: 'ONDEMAND_SPATIAL_FLOW_ID', id: '6aace534859f7b0abb53d99a' },
        flowVersion: { source: 'default', resolvedVia: 'default', value: '1' },
      },
    });
    assert.equal(withValues.id, '6aace534859f7b0abb53d99a');
    assert.equal(withValues.versionLabel, '1');
  });
});

describe('entitySystemPrompt', () => {
  test('the instruction stays under 2 KB and names the entity, MGRS and rules', () => {
    const ctx = build();
    const instruction = entitySystemInstruction(ctx);
    assert.ok(new TextEncoder().encode(instruction).length <= 2048, `${instruction.length} chars`);
    assert.match(instruction, /OnDemand Spatial analyst/);
    assert.match(instruction, /UAL1234/);
    assert.match(instruction, /14R PU 2090 4906/);
    assert.match(instruction, /MapAction/);
    assert.match(instruction, /list_satellites_in_scene/);
    assert.match(instruction, /READY/);
  });

  test('the prompt carries the JSON context after CONTEXT_JSON: and fits the byte budget', () => {
    const ctx = build();
    const prompt = entitySystemPrompt(ctx);
    const [, json] = prompt.split('\nCONTEXT_JSON:\n');
    const parsed = JSON.parse(json);
    assert.equal(parsed.schema, ENTITY_CONTEXT_SCHEMA);
    assert.equal(parsed.entity.icao24, 'a1b2c3');
    assert.equal(parsed.layers.length, LAYERS.length);
    assert.ok(new TextEncoder().encode(prompt).length <= CONTEXT_BYTE_BUDGET);
  });

  test('fitContextToBudget trims raw → tool params → nearby → catalogue until it fits', () => {
    const ctx = build();
    ctx.entity.raw = { blob: 'x'.repeat(5000) };
    const fitted = fitContextToBudget(ctx, 3000);
    assert.deepEqual(fitted.entity.raw, {});
    assert.ok(new TextEncoder().encode(JSON.stringify(fitted)).length <= 3000 || fitted.layers.length < ctx.layers.length);
    assert.equal(ctx.entity.raw.blob.length, 5000, 'the input is not mutated');
    const huge = build();
    huge.layers = Array.from({ length: 400 }, (_, i) => ({ ...huge.layers[0], id: `l${i}`, enabled: i % 2 === 0, statusText: 'y'.repeat(100) }));
    const tight = entitySystemPrompt(huge, { maxBytes: 20_000 });
    assert.ok(new TextEncoder().encode(tight).length <= 32 * 1024, 'never exceeds the proxy query cap');
  });
});
