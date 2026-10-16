import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeWeatherWarningSnapshot, warningLevel } from './records.js';
import { buildWarningCard, warningAnchorDegrees } from './cards.js';
import { createMetAlertsWarningSource } from './source.js';
import { createWeatherWarningsLayer } from './index.js';
import {
  avalancheRegionPolygons,
  groupNveWarnings,
  normalizeAvalancheWarnings,
  osloLocalMs,
  parseVarsomRing,
} from './nveRecords.js';
import { weatherWarningsProxy } from '../../../server/providers/weatherWarnings.js';
import { setLocale } from '../../i18n/index.js';

const ring = [
  [5.0, 60.0],
  [5.4, 60.0],
  [5.4, 60.4],
  [5.0, 60.0],
];

function feature(overrides = {}, properties = {}) {
  return {
    type: 'Feature',
    geometry: { type: 'Polygon', coordinates: [ring] },
    when: {
      interval: ['2026-10-09T20:00:00+00:00', '2026-10-11T12:00:00+00:00'],
    },
    properties: {
      id: '2.49.0.1.578.0.20261010070257.045',
      type: 'Update',
      awareness_level: '2; yellow; Moderate',
      riskMatrixColor: 'Yellow',
      event: 'gale',
      eventAwarenessName: 'Gale',
      area: 'Frøya - Rørvik',
      geographicDomain: 'marine',
      severity: 'Moderate',
      certainty: 'Likely',
      description: 'South-easterly strong gale 20 m/s.',
      instruction: 'Do not go out in small boats.',
      web: 'https://www.met.no/en/weather-and-climate/warnings',
      ...properties,
    },
    ...overrides,
  };
}

test('MetAlerts features normalize to warning rows', () => {
  const rows = normalizeWeatherWarningSnapshot({ features: [feature()] });
  assert.equal(rows.length, 1);
  const [row] = rows;
  assert.equal(row.stableId, '2.49.0.1.578.0.20261010070257.045');
  assert.equal(row.level, 'yellow');
  assert.equal(row.eventName, 'Gale');
  assert.equal(row.domain, 'marine');
  assert.equal(row.onset, Date.parse('2026-10-09T20:00:00Z'));
  assert.equal(row.expires, Date.parse('2026-10-11T12:00:00Z'));
  assert.deepEqual(row.polygons, [[ring]]);
});

test('awareness level falls back to the risk-matrix colour', () => {
  assert.equal(
    warningLevel({ awareness_level: '3; orange; Severe' }),
    'orange',
  );
  assert.equal(warningLevel({ riskMatrixColor: 'Red' }), 'red');
  assert.equal(warningLevel({ awareness_level: '1; green; Minor' }), null);
});

test('invalid, cancelled and duplicate warnings are skipped, not fatal', () => {
  const rows = normalizeWeatherWarningSnapshot({
    features: [
      feature(),
      feature({}, { id: 'cancelled', type: 'Cancel' }),
      feature({ geometry: null }, { id: 'no-geometry' }),
      feature({}, { id: 'no-level', awareness_level: '', riskMatrixColor: '' }),
      feature({}, { id: 'bad-link', web: 'javascript:alert(1)' }),
      feature(),
    ],
  });
  assert.deepEqual(
    rows.map((row) => row.stableId),
    ['2.49.0.1.578.0.20261010070257.045', 'bad-link'],
  );
  assert.equal(rows[1].web, null);
  assert.equal(normalizeWeatherWarningSnapshot({}), null);
});

test('the warning card summarizes level, area, validity and advice', () => {
  const [row] = normalizeWeatherWarningSnapshot({ features: [feature()] });
  const card = buildWarningCard(row, Date.parse('2026-10-10T12:00:00Z'));
  assert.equal(card.title, 'WARNING · Gale');
  assert.equal(card.accent, '#ffd60a');
  assert.equal(card.interactive, true);
  assert.deepEqual(card.details, [
    'yellow level · Frøya - Rørvik · sea',
    'in effect until Oct 11 12:00Z',
    'South-easterly strong gale 20 m/s.',
    'Do not go out in small boats.',
    'MET Norway ↗ · click card to open',
  ]);
  const upcoming = buildWarningCard(row, Date.parse('2026-10-09T12:00:00Z'));
  assert.equal(upcoming.details[1], 'from Oct 9 20:00Z to Oct 11 12:00Z');
});

test('the warning card follows the UI language', () => {
  const [row] = normalizeWeatherWarningSnapshot({ features: [feature()] });
  try {
    setLocale('es');
    const card = buildWarningCard(row, Date.parse('2026-10-10T12:00:00Z'));
    assert.equal(card.title, 'AVISO · Gale');
    assert.equal(card.details[0], 'nivel amarillo · Frøya - Rørvik · mar');
    assert.match(card.details[1], /^vigente hasta 11 oct\.? 12:00Z$/);
    assert.equal(card.accessibilityLabel, 'Abrir AVISO · Gale en MET Norway');
  } finally {
    setLocale('en');
  }
});

test('the card anchor sits on the largest polygon', () => {
  const small = [
    [10, 60],
    [10.1, 60],
    [10.1, 60.1],
    [10, 60],
  ];
  const anchor = warningAnchorDegrees([[small], [ring]]);
  assert.ok(Math.abs(anchor.lon - 5.2667) < 1e-3);
  assert.ok(Math.abs(anchor.lat - 60.1333) < 1e-3);
});

function proxyHandler(options) {
  let handler;
  weatherWarningsProxy(options).configureServer({
    middlewares: {
      use: (path, callback) => {
        assert.equal(path, '/api/weather-warnings');
        handler = callback;
      },
    },
  });
  return async (req) => {
    const result = { status: null, headers: null, body: null };
    await handler(req, {
      writeHead(status, headers) {
        result.status = status;
        result.headers = headers;
      },
      end(body) {
        result.body = JSON.parse(body);
      },
    });
    return result;
  };
}

const NOW = Date.parse('2025-10-04T12:00:00Z');
const floodRecord = (municipality, overrides = {}) => ({
  Id: '584680',
  ActivityLevel: '3',
  ValidFrom: '2025-10-04T07:00:00',
  ValidTo: '2025-10-05T06:59:00',
  MainText: 'Flood warning orange level for parts of Eastern Norway',
  ConsequenceText: 'May cause closed roads and bridges.',
  AdviceText: 'Avoid areas near rivers.',
  MunicipalityList: [municipality],
  ...overrides,
});
const varsomRegion = {
  Id: 3003,
  Name: 'Nordenskiöld Land',
  Polygon: ['78.0,15.0 78.2,15.0 78.2,15.5'],
};
const varsomSummary = [
  {
    Id: 3003,
    Name: 'Nordenskiöld Land',
    AvalancheWarningList: [
      {
        RegionName: 'Nordenskiöld Land',
        DangerLevel: '3',
        ValidFrom: '2025-10-04T00:00:00',
        ValidTo: '2025-10-04T23:59:59',
        MainText: 'Some avalanches may release naturally.',
      },
    ],
  },
];

/** Route the proxy's upstream requests to fixtures; `fail` names hosts that answer 503. */
function upstream({ fail = new Set() } = {}) {
  const requests = [];
  const fetchImpl = async (url, init) => {
    const href = String(url);
    requests.push({ href, userAgent: init.headers['User-Agent'] });
    if (fail.has(new URL(href).hostname))
      return new Response('down', { status: 503 });
    if (href.includes('metalerts'))
      return Response.json({ features: [feature()] });
    if (href.includes('/flood/'))
      return Response.json([
        floodRecord({ Id: '3446', Name: 'Gran' }),
        floodRecord({ Id: '3448', Name: 'Lunner' }),
        floodRecord(
          { Id: '0301', Name: 'Oslo' },
          { Id: 'green', ActivityLevel: '1' },
        ),
      ]);
    if (href.includes('/landslide/')) return Response.json([]);
    if (href.includes('/avalanche/') && href.includes('/Region/'))
      return Response.json([varsomRegion]);
    if (href.includes('/avalanche/')) return Response.json(varsomSummary);
    if (href.includes('kommuneinfo'))
      return Response.json({
        omrade: { type: 'MultiPolygon', coordinates: [[ring]] },
      });
    throw new Error(`unexpected upstream ${href}`);
  };
  return { requests, fetchImpl };
}

test('the proxy merges MET, NVE and Varsom warnings and identifies itself', async () => {
  const { requests, fetchImpl } = upstream();
  let clock = NOW;
  const handle = proxyHandler({ now: () => clock, fetchImpl });
  const first = await handle({ url: '/', method: 'GET' });
  assert.equal(first.status, 200);
  assert.deepEqual(first.body.errors, []);
  const bySource = Object.fromEntries(
    first.body.rows.map((row) => [row.source, row]),
  );
  assert.deepEqual(Object.keys(bySource).sort(), ['avalanche', 'flood', 'met']);
  assert.equal(bySource.flood.level, 'orange');
  assert.equal(bySource.flood.area, 'Gran, Lunner');
  assert.equal(
    bySource.flood.polygons.length,
    2,
    'one outline per municipality',
  );
  assert.equal(bySource.flood.onset, Date.parse('2025-10-04T05:00:00Z'));
  assert.equal(
    bySource.avalanche.eventName,
    'Avalanche danger 3 (considerable)',
  );
  assert.ok(
    requests.every((request) => /gods-eye-view/.test(request.userAgent)),
  );
  assert.ok(
    requests.some((request) =>
      request.href.startsWith(
        'https://api.met.no/weatherapi/metalerts/2.0/current.json',
      ),
    ),
  );
  const count = requests.length;
  clock = NOW + 60_000;
  await handle({ url: '/', method: 'GET' });
  assert.equal(requests.length, count, 'served from cache');
});

test('one failing provider leaves the others on the map', async () => {
  const { fetchImpl } = upstream({ fail: new Set(['api01.nve.no']) });
  const handle = proxyHandler({ now: () => NOW, fetchImpl });
  const result = await handle({ url: '/', method: 'GET' });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.errors, ['flood', 'landslide', 'avalanche']);
  assert.deepEqual(
    result.body.rows.map((row) => row.source),
    ['met'],
  );
});

test('the proxy serves the last good snapshot as stale when a provider fails', async () => {
  let clock = NOW;
  const fail = new Set();
  const { fetchImpl } = upstream({ fail });
  const handle = proxyHandler({ now: () => clock, fetchImpl });
  await handle({ url: '/', method: 'GET' });
  fail.add('api.met.no');
  clock = NOW + 600_000;
  const stale = await handle({ url: '/', method: 'GET' });
  assert.equal(stale.status, 200);
  assert.equal(stale.body.stale, true);
  assert.equal(stale.headers['X-Data-Stale'], 'true');
  assert.ok(stale.body.rows.some((row) => row.source === 'met'));
});

test('the proxy rejects other methods, paths and all-garbage upstreams', async () => {
  const handle = proxyHandler({
    fetchImpl: async () => Response.json({ nope: true }),
  });
  assert.equal((await handle({ url: '/', method: 'POST' })).status, 405);
  assert.equal((await handle({ url: '/other', method: 'GET' })).status, 404);
  const garbage = await handle({ url: '/', method: 'GET' });
  assert.equal(garbage.status, 502);
  assert.equal(garbage.body.error, 'weather_warnings_unavailable');
});

test('NVE wall-clock times are read in Norwegian time across DST', () => {
  assert.equal(
    osloLocalMs('2025-10-04T07:00:00'),
    Date.parse('2025-10-04T05:00:00Z'),
  );
  assert.equal(
    osloLocalMs('2026-02-10T00:00:00'),
    Date.parse('2026-02-09T23:00:00Z'),
  );
  assert.equal(
    osloLocalMs('2025-10-04T07:00:00+02:00'),
    Date.parse('2025-10-04T05:00:00Z'),
  );
  assert.equal(osloLocalMs('not a time'), null);
});

test('NVE records group per warning and keep yellow-or-higher in effect now', () => {
  const rows = groupNveWarnings(
    [
      floodRecord({ Id: '3446', Name: 'Gran' }),
      floodRecord({ Id: '3446', Name: 'Gran' }),
      floodRecord({ Id: '3448', Name: 'Lunner' }),
      floodRecord(
        { Id: '0301', Name: 'Oslo' },
        { Id: 'green', ActivityLevel: '1' },
      ),
      floodRecord(
        { Id: '5001', Name: 'Trondheim' },
        {
          Id: 'tomorrow',
          ValidFrom: '2025-10-05T07:00:00',
          ValidTo: '2025-10-06T06:59:00',
        },
      ),
      floodRecord({ Id: 'x', Name: 'Bad' }, { Id: 'bad-municipality' }),
    ],
    'flood',
    NOW,
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].stableId, 'nve-flood:584680');
  assert.deepEqual(rows[0].municipalities, ['3446', '3448']);
  assert.equal(rows[0].description, 'May cause closed roads and bridges.');
  assert.equal(groupNveWarnings({}, 'flood', NOW), null);
});

test('Varsom regions parse "lat,lon" rings and avalanche danger maps to levels', () => {
  assert.deepEqual(parseVarsomRing('78.0,15.0 78.2,15.0 78.2,15.5'), [
    [15, 78],
    [15, 78.2],
    [15.5, 78.2],
    [15, 78],
  ]);
  assert.equal(parseVarsomRing('78.0,15.0 nonsense'), null);
  const polygons = avalancheRegionPolygons([
    varsomRegion,
    { Id: 1, Polygon: [] },
  ]);
  assert.deepEqual([...polygons.keys()], [3003]);
  const [row] = normalizeAvalancheWarnings(varsomSummary, polygons, NOW);
  assert.equal(row.level, 'orange');
  assert.equal(row.area, 'Nordenskiöld Land');
  const low = structuredClone(varsomSummary);
  low[0].AvalancheWarningList[0].DangerLevel = '1';
  assert.deepEqual(normalizeAvalancheWarnings(low, polygons, NOW), []);
});

test('the browser source reads rows from the same-origin route', async () => {
  let requested;
  const source = createMetAlertsWarningSource({
    fetchImpl: async (url) => {
      requested = String(url);
      return Response.json({ rows: [{ stableId: 'a' }] });
    },
  });
  assert.deepEqual(await source.getSnapshot(), [{ stableId: 'a' }]);
  assert.equal(requested, '/api/weather-warnings');
  const broken = createMetAlertsWarningSource({
    fetchImpl: async () => Response.json({}),
  });
  await assert.rejects(broken.getSnapshot(), /Malformed/);
});

function harness(rows, { pick = () => null, cardHit = () => null } = {}) {
  const sources = [];
  const overlay = { entries: new Map(), visible: null };
  const clicks = { handler: null };
  const opened = [];
  const viewer = {
    scene: { pick },
    dataSources: {
      add: (value) => sources.push(value),
      remove: (value) => sources.splice(sources.indexOf(value), 1),
    },
  };
  const layer = createWeatherWarningsLayer({
    source: { getSnapshot: async () => rows },
    overlayHost: {
      setEntries: (id, entries) => overlay.entries.set(id, entries),
      setVisible: (id, visible) => {
        overlay.visible = visible;
      },
      clearSource: (id) => overlay.entries.delete(id),
      hitTest: (x, y, options) => cardHit(x, y, options),
    },
    screenSpaceEventHandlerFactory: () => ({
      setInputAction: (callback) => {
        clicks.handler = callback;
      },
      destroy: () => {
        clicks.handler = null;
      },
    }),
    picking: {
      resolvePickId: (picked) => picked?.id ?? null,
      isOwnedByOtherLayer: (layerId, id) => String(id).startsWith('other:'),
    },
    pointer: { isPointerFree: () => true },
    openExternal: (url) => opened.push(url),
  });
  layer.init(viewer);
  layer.enable();
  return { layer, sources, overlay, clicks, opened };
}

test('the layer draws warnings, selects one on click and opens MET', async () => {
  const rows = normalizeWeatherWarningSnapshot({
    features: [
      feature(),
      feature({}, { id: 'red-one', awareness_level: '4; red; Extreme' }),
    ],
  });
  const id = '2.49.0.1.578.0.20261010070257.045';
  let picked = { id: `weather-warning:${id}:0` };
  let hit = null;
  const h = harness(rows, { pick: () => picked, cardHit: () => hit });
  assert.equal(await h.layer.update(), true);
  assert.equal(h.layer.getStats().count, 2);
  assert.equal(h.sources[0].entities.values.length, 2);
  const legend = h.layer.getRowControls().legend;
  assert.deepEqual(
    legend.map((band) => band.count),
    [1, 0, 1],
  );

  h.clicks.handler({ position: { x: 1, y: 1 } });
  const [card] = h.overlay.entries.get('weather-warnings');
  assert.equal(card.id, `weather-warning-card:${id}`);

  hit = { entryId: card.id };
  h.clicks.handler({ position: { x: 1, y: 1 } });
  assert.deepEqual(h.opened, [
    'https://www.met.no/en/weather-and-climate/warnings',
  ]);

  hit = null;
  picked = { id: 'other:aircraft' };
  h.clicks.handler({ position: { x: 1, y: 1 } });
  assert.equal(h.overlay.entries.get('weather-warnings').length, 1);
  picked = null;
  h.clicks.handler({ position: { x: 1, y: 1 } });
  assert.equal(h.overlay.entries.get('weather-warnings').length, 0);

  const records = h.layer.getAnalystRecords();
  assert.equal(records.length, 2);
  assert.equal(records[1].level, 'red');
  assert.ok(Number.isFinite(records[0].lat));

  h.layer.disable();
  assert.equal(h.clicks.handler, null);
  h.layer.destroy();
  assert.equal(h.sources.length, 0);
});

test('a failed refresh reports an error without clearing the layer', async () => {
  const rows = normalizeWeatherWarningSnapshot({ features: [feature()] });
  let fail = false;
  const layer = createWeatherWarningsLayer({
    source: {
      getSnapshot: async () => {
        if (fail) throw new Error('MetAlerts HTTP 502');
        return rows;
      },
    },
  });
  layer.init({ dataSources: { add: () => {}, remove: () => {} } });
  layer.enable();
  assert.equal(await layer.update(), true);
  fail = true;
  assert.equal(await layer.update(), false);
  assert.equal(layer.getStats().count, 1);
  assert.equal(layer.getStats().error, 'MetAlerts HTTP 502');
  layer.destroy();
});

test('source chips hide a warning family on the map, in counts and queries', async () => {
  const [met] = normalizeWeatherWarningSnapshot({ features: [feature()] });
  const flood = {
    ...met,
    stableId: 'nve-flood:584680',
    source: 'flood',
    level: 'orange',
    eventName: 'Flood',
    web: 'https://www.varsom.no/en/flood-and-landslide-warning-service/',
  };
  let picked = { id: 'weather-warning:nve-flood:584680:0' };
  const h = harness([met, flood], { pick: () => picked });
  let repaints = 0;
  h.layer.setRowControlsListener(() => repaints++);
  await h.layer.update();
  const chips = () => h.layer.getRowControls().chips;
  assert.deepEqual(
    chips().map((chip) => [chip.label, chip.active]),
    [
      ['Weather 1', true],
      ['Flood 1', true],
      ['Landslide', true],
      ['Avalanche', true],
    ],
  );
  h.clicks.handler({ position: { x: 1, y: 1 } });
  const [card] = h.overlay.entries.get('weather-warnings');
  assert.match(card.details.at(-1), /^Varsom ↗/);

  chips()[1].onClick();
  assert.equal(chips()[1].active, false);
  assert.ok(repaints >= 2, 'refresh and toggle both repaint the row');
  const shown = h.sources[0].entities.values.filter((entity) => entity.show);
  assert.deepEqual(
    shown.map((entity) => entity.properties.source.getValue()),
    ['met'],
  );
  assert.equal(h.overlay.entries.get('weather-warnings').length, 0);
  assert.deepEqual(
    h.layer.getRowControls().legend.map((band) => band.count),
    [1, 0, 0],
  );
  assert.deepEqual(
    h.layer.getAnalystRecords().map((record) => record.source),
    ['met'],
  );

  // A refresh keeps the family hidden.
  picked = null;
  await h.layer.update();
  chips()[1].onClick();
  assert.equal(
    h.sources[0].entities.values.every((entity) => entity.show),
    true,
  );
  h.layer.destroy();
});
