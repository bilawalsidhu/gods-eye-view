import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeQldBushfireAlerts,
  normalizeNswRfsIncidents,
  fetchAuFireWarningRows,
} from './auFireWarnings.js';

const ring = [
  [148.8, -20.3],
  [148.9, -20.3],
  [148.9, -20.2],
  [148.8, -20.3],
];

// --- QLD QFES -----------------------------------------------------------

function qldFeature(overrides = {}) {
  return {
    geometry: { type: 'Polygon', coordinates: [ring] },
    properties: {
      UniqueID: 'WARN-10101',
      WarningTitle:
        'STAY INFORMED - Irvinebank (near Atherton) - fire as at 1:14pm',
      WarningLevel: 'Advice',
      CallToAction: 'Stay Informed',
      GroupedType: 'FIRE VEGETATION',
      EventType: 'Fire',
      ItemDateTimeLocal_ISO: '2026-10-14T13:15:08+10:00',
      WarningArea: 'Irvinebank',
    },
    ...overrides,
  };
}

test('QLD: a polygon warning yields one prefixed row with mapped fields', () => {
  const rows = normalizeQldBushfireAlerts({ features: [qldFeature()] });
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.stableId, 'qld:WARN-10101');
  assert.equal(row.state, 'QLD');
  assert.equal(row.complexity, 'Advice');
  assert.equal(row.behavior, 'Stay Informed');
  assert.equal(row.county, 'Irvinebank');
  assert.equal(row.category, 'FIRE VEGETATION');
  assert.equal(row.updatedTime, Date.parse('2026-10-14T13:15:08+10:00'));
  assert.equal(row.containedPct, null);
  assert.deepEqual(row.polygons, [[ring]]);
});

test('QLD: point-only advisory features are dropped', () => {
  const point = qldFeature({
    geometry: { type: 'Point', coordinates: [148.85, -20.25] },
  });
  assert.equal(normalizeQldBushfireAlerts({ features: [point] }).length, 0);
});

test('QLD: non-fire events are dropped', () => {
  const flood = qldFeature({
    properties: { EventType: 'Flood', UniqueID: 'WARN-20202' },
  });
  assert.equal(normalizeQldBushfireAlerts({ features: [flood] }).length, 0);
});

test('QLD: duplicate UniqueIDs dedupe to the first feature', () => {
  const rows = normalizeQldBushfireAlerts({
    features: [qldFeature(), qldFeature()],
  });
  assert.equal(rows.length, 1);
});

test('QLD: an unknown warning level is dropped', () => {
  const odd = qldFeature({
    properties: { WarningLevel: 'Curious Level', UniqueID: 'WARN-30303' },
  });
  assert.equal(normalizeQldBushfireAlerts({ features: [odd] }).length, 0);
});

test('QLD: a payload without a features array rejects the snapshot', () => {
  assert.equal(normalizeQldBushfireAlerts({}), null);
  assert.equal(normalizeQldBushfireAlerts(null), null);
});

test('QLD: the feed URL is the WAF-free PSBA origin, not the www front door', async () => {
  // The www.qfes.qld.gov.au path sits behind an Incapsula challenge that
  // rejects server-side fetches; pin the origin the www URL redirects to.
  const mod = await import('./auFireWarnings.js');
  assert.equal(mod.QLD_ALERTS_URL, 'https://publiccontent.gis.psba.qld.gov.au/content/Feeds/BushfireCurrentIncidents/bushfireAlert.json');
});

// --- NSW RFS ------------------------------------------------------------

function nswFeature(overrides = {}) {
  return {
    geometry: {
      type: 'GeometryCollection',
      geometries: [{ type: 'Polygon', coordinates: [ring] }],
    },
    properties: {
      title: 'Baffle Road ',
      guid: 'https://incidents.rfs.nsw.gov.au/api/v1/incidents/681307',
      pubDate: '14/10/2026 5:12:00 AM',
      category: 'Advice',
      description:
        'ALERT LEVEL: Advice <br />LOCATION: BAFFLE RD <br />COUNCIL AREA: Clarence Valley <br />STATUS: Under control <br />TYPE: Bush Fire <br />SIZE: 1,380 ha <br />RESPONSIBLE AGENCY: Rural Fire Service',
    },
    ...overrides,
  };
}

test('NSW: GeometryCollection polygons flatten into the row', () => {
  const rows = normalizeNswRfsIncidents({ features: [nswFeature()] });
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.stableId, 'nsw:https://incidents.rfs.nsw.gov.au/api/v1/incidents/681307');
  assert.equal(row.state, 'NSW');
  assert.deepEqual(row.polygons, [[ring]]);
});

test('NSW: size parses from the description and converts ha to acres', () => {
  const rows = normalizeNswRfsIncidents({ features: [nswFeature()] });
  assert.ok(Math.abs(rows[0].acres - 1380 * 2.47105) < 0.01);
});

test('NSW: status and council area parse from the description', () => {
  const rows = normalizeNswRfsIncidents({ features: [nswFeature()] });
  assert.equal(rows[0].behavior, 'Under control');
  assert.equal(rows[0].county, 'Clarence Valley');
});

test('NSW: pubDate parses 12-hour Sydney local time', () => {
  const rows = normalizeNswRfsIncidents({ features: [nswFeature()] });
  assert.equal(rows[0].updatedTime, Date.parse('2026-10-13T19:12:00+00:00'));
});

test('NSW: an unparseable pubDate yields null without dropping the row', () => {
  const odd = nswFeature({ properties: { ...nswFeature().properties, pubDate: 'soon' } });
  const rows = normalizeNswRfsIncidents({ features: [odd] });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].updatedTime, null);
});

test('NSW: features without polygons are dropped', () => {
  const bare = nswFeature({ geometry: null });
  assert.equal(normalizeNswRfsIncidents({ features: [bare] }).length, 0);
});

// --- Fetch helper ---------------------------------------------------------

function jsonResponse(payload) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

test('fetchAuFireWarningRows merges both feeds', async () => {
  const fetchImpl = async (url) => {
    if (url.includes('qfes')) return jsonResponse({ features: [qldFeature()] });
    if (url.includes('rfs')) return jsonResponse({ features: [nswFeature()] });
    throw new Error(`unexpected url ${url}`);
  };
  const rows = await fetchAuFireWarningRows({ fetchImpl });
  assert.equal(rows.length, 2);
  assert.ok(rows.some((row) => row.stableId.startsWith('qld:')));
  assert.ok(rows.some((row) => row.stableId.startsWith('nsw:')));
});

test('one AU feed failing degrades to the other feed only', async () => {
  const fetchImpl = async (url) => {
    if (url.includes('qfes')) throw new Error('network down');
    return jsonResponse({ features: [nswFeature()] });
  };
  const rows = await fetchAuFireWarningRows({ fetchImpl });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].state, 'NSW');
});

test('a failing feed still parses through the capped JSON reader', async () => {
  // readResponseJsonCapped consumes a Response-like object; a payload that is
  // JSON but not a feature collection contributes zero rows, not an error.
  const fetchImpl = async () => jsonResponse({ error: 'gateway' });
  const rows = await fetchAuFireWarningRows({ fetchImpl });
  assert.deepEqual(rows, []);
});
