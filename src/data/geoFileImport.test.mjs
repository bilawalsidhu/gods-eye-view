import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import * as Cesium from 'cesium';
import {
  GeoImportError,
  MAX_IMPORT_POSITIONS,
  countGeoJsonGeometry,
  countKmlGeometry,
  detachImportedTime,
  gpxToGeoJson,
  importFeatureName,
  scrubImportedEntities,
  stripGeoJsonStyleProperties,
  detectGeoFileFormat,
  importDisplayName,
  kmzImageType,
  kmzMainDocument,
  parseGeoJsonText,
  readZipEntries,
  resolveKmzPath,
} from './geoFileImport.js';

const bytes = (text) => new TextEncoder().encode(text);

/** A minimal zip writer: stored (0) or deflated (8) entries, optional flags. */
function zip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data, method = 8, flags = 0, size } of files) {
    const nameBytes = bytes(name);
    const body = method === 8 ? new Uint8Array(deflateRawSync(data)) : data;
    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(6, flags, true);
    lv.setUint16(8, method, true);
    lv.setUint32(18, body.length, true);
    lv.setUint32(22, size ?? data.length, true);
    lv.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    const central = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(8, flags, true);
    cv.setUint16(10, method, true);
    cv.setUint32(20, body.length, true);
    cv.setUint32(24, size ?? data.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    central.set(nameBytes, 46);
    locals.push(local, body);
    centrals.push(central);
    offset += local.length + body.length;
  }
  const dirSize = centrals.reduce((n, c) => n + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, dirSize, true);
  ev.setUint32(16, offset, true);
  const parts = [...locals, ...centrals, eocd];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

test('format comes from the extension, then from the first bytes', () => {
  assert.equal(detectGeoFileFormat('trail.GPX'), 'gpx');
  assert.equal(detectGeoFileFormat('farm.kml'), 'kml');
  assert.equal(detectGeoFileFormat('farm.kmz'), 'kmz');
  assert.equal(detectGeoFileFormat('parcels.geojson'), 'geojson');
  assert.equal(detectGeoFileFormat('parcels.json'), 'geojson');
  assert.equal(
    detectGeoFileFormat('export', bytes('﻿  {"type":"Feature"}')),
    'geojson',
  );
  assert.equal(
    detectGeoFileFormat(
      'export',
      bytes('<?xml version="1.0"?><kml xmlns="x">'),
    ),
    'kml',
  );
  assert.equal(
    detectGeoFileFormat(
      'export',
      bytes('<?xml version="1.0"?>\n<gpx version="1.1">'),
    ),
    'gpx',
  );
  assert.equal(
    detectGeoFileFormat('export', new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0])),
    'kmz',
  );
  assert.equal(detectGeoFileFormat('notes.txt', bytes('hello')), null);
  assert.equal(
    detectGeoFileFormat('image.png', new Uint8Array([0x89, 0x50, 0x4e, 0x47])),
    null,
  );
});

test('display names are printable and bounded', () => {
  assert.equal(importDisplayName('  hike\u0000.gpx '), 'hike.gpx');
  assert.equal(importDisplayName(''), 'Imported file');
  const long = importDisplayName(`${'x'.repeat(80)}.kml`);
  assert.equal(long.length, 58);
  assert.ok(long.endsWith('…'));
});

test('GeoJSON text must be a GeoJSON object', () => {
  assert.equal(
    parseGeoJsonText('{"type":"FeatureCollection","features":[]}').type,
    'FeatureCollection',
  );
  assert.equal(
    parseGeoJsonText('﻿{"type":"Point","coordinates":[0,0]}').type,
    'Point',
  );
  assert.throws(() => parseGeoJsonText('{nope'), GeoImportError);
  assert.throws(() => parseGeoJsonText('{"name":"not geo"}'), /not GeoJSON/);
  assert.throws(() => parseGeoJsonText('[1,2]'), /not GeoJSON/);
  assert.throws(
    () => parseGeoJsonText('{"type":"FeatureCollection"}'),
    /no features list/,
  );
});

test('a KMZ is read with stored and deflated entries, directories skipped', async () => {
  const kml = bytes('<kml><Document/></kml>');
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  const archive = zip([
    { name: 'files/', data: new Uint8Array(0), method: 0 },
    { name: 'doc.kml', data: kml },
    { name: 'files/icon.png', data: png, method: 0 },
  ]);
  const entries = await readZipEntries(archive);
  assert.deepEqual([...entries.keys()], ['doc.kml', 'files/icon.png']);
  assert.deepEqual(entries.get('doc.kml'), kml);
  assert.deepEqual(entries.get('files/icon.png'), png);
});

test('a KMZ that inflates past the limit is refused', async () => {
  const archive = zip([{ name: 'doc.kml', data: new Uint8Array(200_000) }]);
  await assert.rejects(
    readZipEntries(archive, { maxInflatedBytes: 100_000 }),
    /more than the import limit/,
  );
});

test('encrypted, damaged and non-zip archives are refused with a reason', async () => {
  await assert.rejects(
    readZipEntries(
      zip([{ name: 'doc.kml', data: bytes('<kml/>'), flags: 1, method: 0 }]),
    ),
    /encrypted/,
  );
  await assert.rejects(
    readZipEntries(bytes('not a zip at all, just text')),
    /not a readable zip/,
  );
  const truncated = zip([
    { name: 'doc.kml', data: bytes('<kml/>'), method: 0 },
  ]);
  const view = new DataView(truncated.buffer);
  view.setUint32(truncated.length - 6, 9999, true); // directory offset past the end
  await assert.rejects(readZipEntries(truncated), GeoImportError);
  await assert.rejects(
    readZipEntries(
      zip([{ name: 'doc.kml', data: bytes('<kml/>'), method: 12 }]),
    ),
    /compression method/,
  );
});

test('the main KML is doc.kml, else the shallowest .kml', () => {
  const e = (...names) => new Map(names.map((n) => [n, new Uint8Array(0)]));
  assert.equal(kmzMainDocument(e('a/b.kml', 'doc.kml')), 'doc.kml');
  assert.equal(
    kmzMainDocument(e('deep/x/z.kml', 'top.kml', 'images/a.png')),
    'top.kml',
  );
  assert.equal(kmzMainDocument(e('images/a.png')), null);
});

test('KMZ hrefs resolve only to entries inside the archive', () => {
  const entries = new Map([
    ['doc.kml', new Uint8Array(0)],
    ['files/icon one.png', new Uint8Array(0)],
    ['overlay.jpg', new Uint8Array(0)],
  ]);
  assert.equal(
    resolveKmzPath('files/icon%20one.png', 'doc.kml', entries),
    'files/icon one.png',
  );
  assert.equal(
    resolveKmzPath('./overlay.jpg', 'doc.kml', entries),
    'overlay.jpg',
  );
  assert.equal(
    resolveKmzPath('../overlay.jpg', 'files/sub.kml', entries),
    'overlay.jpg',
  );
  assert.equal(
    resolveKmzPath('https://example.com/overlay.jpg', 'doc.kml', entries),
    null,
  );
  assert.equal(
    resolveKmzPath('//example.com/overlay.jpg', 'doc.kml', entries),
    null,
  );
  assert.equal(resolveKmzPath('file:///etc/passwd', 'doc.kml', entries), null);
  assert.equal(resolveKmzPath('missing.png', 'doc.kml', entries), null);
  assert.equal(resolveKmzPath('%E0%A4%A', 'doc.kml', entries), null);
  assert.equal(kmzImageType('files/a.PNG'), 'image/png');
  assert.equal(kmzImageType('files/a.svg'), null);
});

/* ── a tiny element tree with the DOM surface the readers use ─────────── */
function xmlEl(localName, attrs = {}, kids = []) {
  const el = {
    nodeType: 1,
    localName,
    childNodes: [],
    getAttribute: (n) => (n in attrs ? String(attrs[n]) : null),
  };
  for (const k of typeof kids === 'string' ? [] : kids) el.childNodes.push(k);
  const text = typeof kids === 'string' ? kids : null;
  Object.defineProperty(el, 'textContent', {
    get: () => text ?? el.childNodes.map((c) => c.textContent).join(''),
  });
  return el;
}
const xmlDoc = (root) => ({
  documentElement: root,
  getElementsByTagName(name) {
    assert.equal(name, '*');
    const out = [];
    const walk = (el) => {
      out.push(el);
      el.childNodes.forEach(walk);
    };
    walk(root);
    return out;
  },
});
const trkpt = (lat, lon, time) =>
  xmlEl('trkpt', { lat, lon }, time ? [xmlEl('time', {}, time)] : []);

test('GPX keeps each track segment as its own line, names as text, no times', () => {
  const doc = xmlDoc(
    xmlEl('gpx', {}, [
      xmlEl('wpt', { lat: 37.77, lon: -122.49 }, [xmlEl('name', {}, 'Camp')]),
      xmlEl('wpt', { lat: 99, lon: 0 }), // out of range: skipped
      xmlEl('rte', {}, [
        xmlEl('name', {}, 'Route'),
        xmlEl('rtept', { lat: 1, lon: 2 }),
        xmlEl('rtept', { lat: 3, lon: 4 }),
      ]),
      xmlEl('trk', {}, [
        xmlEl('name', {}, 'Morning walk'),
        xmlEl('trkseg', {}, [
          trkpt(10, 20, '2024-05-01T10:00:00Z'),
          trkpt(10.1, 20.1, '2024-05-01T10:01:00Z'),
        ]),
        // A pause in the recording: a new segment, not a straight jump.
        xmlEl('trkseg', {}, [
          trkpt(11, 21, '2024-05-01T11:00:00Z'),
          trkpt(11.1, 21.1, '2024-05-01T11:01:00Z'),
          trkpt(11.2, 21.2, '2024-05-01T11:02:00Z'),
        ]),
        xmlEl('trkseg', {}, [trkpt(12, 22)]), // one point: not a line
      ]),
    ]),
  );
  const fc = gpxToGeoJson(doc);
  assert.deepEqual(
    fc.features.map((f) => [f.properties.name, f.geometry.type]),
    [
      ['Camp', 'Point'],
      ['Route', 'LineString'],
      ['Morning walk', 'MultiLineString'],
    ],
  );
  assert.deepEqual(fc.features[2].geometry.coordinates, [
    [
      [20, 10],
      [20.1, 10.1],
    ],
    [
      [21, 11],
      [21.1, 11.1],
      [21.2, 11.2],
    ],
  ]);
  assert.doesNotMatch(JSON.stringify(fc), /2024|time/);
  assert.throws(() => gpxToGeoJson(xmlDoc(xmlEl('kml'))), GeoImportError);
});

test('GPX past the point limit is refused while reading, before Cesium', () => {
  const seg = xmlEl(
    'trkseg',
    {},
    Array.from({ length: 30 }, (_, i) => trkpt(1 + i / 100, 2)),
  );
  const doc = xmlDoc(xmlEl('gpx', {}, [xmlEl('trk', {}, [seg])]));
  assert.throws(
    () => gpxToGeoJson(doc, { maxPositions: 20 }),
    (e) => e instanceof GeoImportError && /more than .* points/.test(e.message),
  );
  assert.throws(
    () =>
      gpxToGeoJson(
        xmlDoc(
          xmlEl('gpx', {}, [
            xmlEl('wpt', { lat: 1, lon: 1 }),
            xmlEl('wpt', { lat: 2, lon: 2 }),
          ]),
        ),
        { maxFeatures: 1 },
      ),
    /more than .* features/,
  );
});

test('GeoJSON features and vertices are counted before loading, without recursion', () => {
  const line = Array.from({ length: 50 }, (_, i) => [i / 10, 1]);
  const fc = {
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', geometry: { type: 'LineString', coordinates: line } },
      {
        type: 'Feature',
        geometry: {
          type: 'GeometryCollection',
          geometries: [
            { type: 'Point', coordinates: [1, 2] },
            {
              type: 'Polygon',
              coordinates: [
                [
                  [0, 0],
                  [1, 0],
                  [1, 1],
                  [0, 0],
                ],
              ],
            },
          ],
        },
      },
      { type: 'Feature', geometry: null },
    ],
  };
  assert.deepEqual(countGeoJsonGeometry(fc), {
    features: 3,
    positions: 55,
    over: '',
  });
  assert.equal(
    countGeoJsonGeometry(fc, { maxPositions: 54 }).over,
    'positions',
  );
  assert.equal(countGeoJsonGeometry(fc, { maxFeatures: 2 }).over, 'features');
  assert.deepEqual(
    countGeoJsonGeometry({ type: 'Point', coordinates: [1, 2] }),
    {
      features: 1,
      positions: 1,
      over: '',
    },
  );
  // A very long line is counted iteratively and stops at the limit.
  const huge = {
    type: 'LineString',
    coordinates: Array.from({ length: MAX_IMPORT_POSITIONS + 5 }, () => [0, 0]),
  };
  assert.equal(countGeoJsonGeometry(huge).over, 'positions');
});

test('KML placemarks and coordinate tuples are counted before loading', () => {
  const coords = (n) =>
    xmlEl(
      'coordinates',
      {},
      Array.from({ length: n }, (_, i) => `${i},1,0`).join('\n  '),
    );
  const doc = xmlDoc(
    xmlEl('kml', {}, [
      xmlEl('Placemark', {}, [xmlEl('LineString', {}, [coords(40)])]),
      xmlEl('Placemark', {}, [
        xmlEl('Track', {}, [
          xmlEl('coord', {}, '1 2 0'),
          xmlEl('coord', {}, '1 3 0'),
        ]),
      ]),
    ]),
  );
  assert.deepEqual(countKmlGeometry(doc), {
    features: 2,
    positions: 42,
    over: '',
  });
  assert.equal(countKmlGeometry(doc, { maxPositions: 41 }).over, 'positions');
  assert.equal(countKmlGeometry(doc, { maxFeatures: 1 }).over, 'features');
});

test('simplestyle is dropped: no icon fetched, the row color is what draws', () => {
  const fc = {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: {
          'marker-symbol': 'rail',
          'marker-color': '#f00',
          stroke: '#0f0',
          'stroke-width': 9,
          fill: '#00f',
          'fill-opacity': 1,
          name: 'x',
        },
        geometry: null,
      },
      { type: 'Feature', properties: null, geometry: null },
    ],
  };
  stripGeoJsonStyleProperties(fc);
  assert.deepEqual(fc.features[0].properties, { name: 'x' });
});

test('imported entities keep only a short plain-text name: no description, label or properties', () => {
  const ds = new Cesium.CustomDataSource('t');
  const e = ds.entities.add({
    name: 'Trail\u0007 <b>head</b>\n' + 'x'.repeat(300),
    description: '<img src="https://example.invalid/x.png" onerror="alert(1)">',
    label: { text: 'Trail head' },
    properties: { note: '<script>alert(1)</script>' },
    position: Cesium.Cartesian3.fromDegrees(1, 2),
  });
  e.kml = { extendedData: { note: { value: '<iframe src=//x>' } } };
  ds.entities.add({ name: 42, position: Cesium.Cartesian3.fromDegrees(1, 2) });
  assert.equal(scrubImportedEntities(ds), 2);
  assert.equal(e.description, undefined);
  assert.equal(e.label, undefined);
  assert.equal(e.properties, undefined);
  assert.equal(e.kml, undefined);
  assert.ok(e.name.startsWith('Trail <b>head</b> x'));
  assert.ok(e.name.length <= 120 && !/[\u0000-\u001f]/.test(e.name));
  assert.equal(ds.entities.values[1].name, undefined);
  assert.equal(importFeatureName('   '), undefined);
});

test('a dated import exposes no clock and draws for all time', () => {
  // A data source with its own clock, as KmlDataSource has for a dated file.
  class DatedSource extends Cesium.CustomDataSource {
    get clock() {
      return this._testClock;
    }
  }
  const ds = new DatedSource('dated');
  ds._testClock = new Cesium.DataSourceClock();
  const start = Cesium.JulianDate.fromIso8601('2020-01-01T00:00:00Z');
  const stop = Cesium.JulianDate.fromIso8601('2020-01-01T01:00:00Z');
  const span = new Cesium.TimeIntervalCollection([
    new Cesium.TimeInterval({ start, stop }),
  ]);
  const track = new Cesium.SampledPositionProperty();
  track.addSample(start, Cesium.Cartesian3.fromDegrees(10, 10));
  track.addSample(stop, Cesium.Cartesian3.fromDegrees(10.1, 10.1));
  const mover = ds.entities.add({
    availability: span,
    position: track,
    path: {},
    billboard: {},
  });
  const pin = ds.entities.add({
    availability: span,
    position: Cesium.Cartesian3.fromDegrees(1, 1),
  });
  assert.ok(ds.clock);
  detachImportedTime(ds);
  assert.equal(ds.clock, undefined);
  // The viewer reads `clock` from every added source; setting it is ignored.
  ds.clock = new Cesium.DataSourceClock();
  assert.equal(ds.clock, undefined);
  assert.equal(pin.availability, undefined);
  assert.ok(pin.isAvailable(Cesium.JulianDate.now()));
  // The moving marker became the line it travels, visible now.
  assert.equal(mover.availability, undefined);
  assert.equal(mover.position, undefined);
  assert.equal(mover.path, undefined);
  assert.equal(mover.billboard, undefined);
  const line = mover.polyline.positions.getValue(Cesium.JulianDate.now());
  assert.ok(line.length > 100);
  assert.ok(mover.polyline.clampToGround.getValue());
});
