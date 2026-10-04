import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import {
  GeoImportError,
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
