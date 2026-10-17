import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import * as Cesium from 'cesium';
import {
  GeoImportError,
  loadGeoFile,
  MAX_IMPORT_POSITIONS,
  MAX_IMPORT_ENTITIES,
  countGeoJsonGeometry,
  countKmlGeometry,
  deduplicateKmlStyles,
  detachImportedTime,
  gpxToGeoJson,
  importFeatureName,
  scrubImportedEntities,
  sanitizeKmlDocument,
  detectGeoFileFormat,
  importDisplayName,
  kmzImageResolver,
  kmzImageType,
  kmzMainDocument,
  parseGeoJsonText,
  readZipEntries,
  resolveKmzPath,
} from './geoFileImport.js';
import { createImportImageBudget, importImageSize } from './geoImportImages.js';

test('real loader grounds XYZ GeoJSON and strips loader-sensitive metadata before allocation', async () => {
  const previous = Cesium.PinBuilder.prototype.fromColor;
  Cesium.PinBuilder.prototype.fromColor = () => ({
    toDataURL: () => 'data:image/png;base64,local',
    tagName: 'CANVAS',
  });
  try {
    const object = {
      type: 'FeatureCollection',
      crs: { type: 'name', properties: { name: 'unsupported' } },
      features: [
        {
          type: 'Feature',
          id: 'kartaview-owned',
          properties: { name: 'Test', addProperty: 1, 'marker-symbol': 'rail' },
          geometry: { type: 'Point', coordinates: [1, 2, 999] },
        },
        {
          type: 'Feature',
          geometry: {
            type: 'Polygon',
            coordinates: [
              [
                [1, 2, 0],
                [2, 2, 0],
                [2, 3, 0],
                [1, 2, 0],
              ],
            ],
          },
        },
      ],
    };
    const loaded = await loadGeoFile(
      new File([JSON.stringify(object)], 'xyz.geojson'),
      {
        viewer: {
          scene: {
            frameState: { mode: Cesium.SceneMode.SCENE3D },
            primitives: new Cesium.PrimitiveCollection(),
            globe: { getHeight: () => 1234 },
          },
        },
      },
    );
    const [point, polygon] =
      loaded.dataSource.importedEntities || loaded.dataSource.entities.values;
    assert.notEqual(point.id, 'kartaview-owned');
    assert.equal(point.name, 'Test');
    assert.equal(point.properties, undefined);
    assert.equal(
      point.billboard.heightReference.getValue(),
      Cesium.HeightReference.NONE,
    );
    assert.equal(point.billboard.disableDepthTestDistance.getValue(), Infinity);
    assert.ok(
      Math.abs(
        Cesium.Cartographic.fromCartesian(
          point.position.getValue(Cesium.JulianDate.now()),
        ).height - 1234,
      ) < 1e-6,
    );
    assert.notEqual(polygon.polygon.perPositionHeight?.getValue(), true);
    assert.equal(loaded.dataSource.clock, undefined);
    assert.equal(
      loaded.dataSource.entities.values.length,
      1,
      'only polygon geometry remains in the per-frame entity collection',
    );
    assert.equal(loaded.dataSource.importedBillboards.length, 1);
    const update = Cesium.BillboardCollection.prototype.update;
    let passes = 0;
    Cesium.BillboardCollection.prototype.update = () => passes++;
    try {
      const collection = loaded.dataSource.importedBillboards;
      collection.update({ passes: { pick: true, offscreen: true } });
      assert.equal(passes, 0, 'height picks ignore imported markers');
      collection.update({ passes: { pick: true, offscreen: false } });
      collection.update({ passes: { render: true, offscreen: true } });
      assert.equal(passes, 2, 'ordinary picks and screenshots include markers');
    } finally {
      Cesium.BillboardCollection.prototype.update = update;
    }

    loaded.mount();
    loaded.dataSource.show = false;
    assert.equal(loaded.dataSource.importedBillboards.show, false);
    loaded.dataSource.show = true;
    await loaded.refreshGround();
    assert.equal(
      point.billboard.heightReference.getValue(),
      Cesium.HeightReference.NONE,
    );
    loaded.revoke();
    assert.ok(loaded.dataSource.importedBillboards.isDestroyed());
  } finally {
    Cesium.PinBuilder.prototype.fromColor = previous;
  }
});

test('real loader refuses empty files and malformed nested geometry before allocating entities', async () => {
  for (const object of [
    { type: 'Feature', geometry: null },
    {
      type: 'FeatureCollection',
      features: [{ geometry: { type: 'Point', coordinates: [1, 2] } }],
    },
    { type: 'Feature', geometry: { type: 'Topology', arcs: [] } },
    ...[
      [1, '2'],
      [Infinity, 0],
      [0, 91],
      [0, 0, 1e100],
    ].map((coordinates) => ({ type: 'Point', coordinates })),
  ])
    await assert.rejects(
      loadGeoFile(new File([JSON.stringify(object)], 'bad.geojson'), {
        viewer: {},
      }),
      GeoImportError,
    );
});

test('KML tracks retain their explicit altitude and ground lines are tessellated', () => {
  const track = xmlEl('Track', {}, [
    xmlEl('altitudeMode', {}, 'absolute'),
    xmlEl('coord', {}, '1 2 10000'),
    xmlEl('coord', {}, '2 3 10000'),
  ]);
  const line = xmlEl('LineString', {}, [xmlEl('coordinates', {}, '1,2 2,3')]);
  const ground = xmlEl('Track', {}, [
    xmlEl('coord', {}, '1 2 0'),
    xmlEl('coord', {}, '2 3 0'),
  ]);
  const root = xmlEl('kml', {}, [track, line, ground]);
  sanitizeKmlDocument(xmlDoc(root));
  assert.equal(
    root.childNodes[0].childNodes.find((n) => n.localName === 'altitudeMode')
      .textContent,
    'absolute',
  );
  assert.equal(
    root.childNodes[1].childNodes.find((n) => n.localName === 'tessellate')
      .textContent,
    '1',
  );
  assert.equal(
    root.childNodes[2].childNodes.find((n) => n.localName === 'tessellate')
      .textContent,
    '1',
  );
});

test('sanitizer normalizes styles, removes incomplete pairs and keeps colored overlays', () => {
  const local = xmlEl('styleUrl', {}, '  #s  ');
  const pair = xmlEl('Pair', {}, [
    xmlEl('key', {}, 'normal'),
    xmlEl('styleUrl', {}, 'https://example.invalid/s'),
  ]);
  const overlay = xmlEl('GroundOverlay', {}, [xmlEl('color', {}, 'ff00ff00')]);
  const hidden = xmlEl('visibility', {}, '0');
  const id = xmlEl('Placemark', { id: 'kartaview-123' });
  const root = xmlEl('kml', {}, [
    local,
    xmlEl('StyleMap', { id: 's' }, [pair]),
    overlay,
    hidden,
    id,
    xmlEl('toString'),
  ]);
  sanitizeKmlDocument(xmlDoc(root));
  assert.equal(local.textContent, '#s');
  assert.equal(pair.parentNode, null);
  assert.ok(root.childNodes.includes(overlay));
  assert.equal(hidden.parentNode, null);
  assert.equal(id.getAttribute('id'), null);
  assert.ok(!root.childNodes.some((n) => n.localName === 'toString'));
});

test('image budget rejects large decoded rasters before decoding and shares repeated images', () => {
  const png = (w, h) => {
    const b = new Uint8Array(24);
    const v = new DataView(b.buffer);
    v.setUint32(0, 0x89504e47);
    b.set([73, 72, 68, 82], 12);
    v.setUint32(16, w);
    v.setUint32(20, h);
    return b;
  };
  assert.deepEqual(importImageSize(png(4096, 4096)), [4096, 4096]);
  const charge = createImportImageBudget();
  charge('shared', png(4096, 4096));
  charge('shared', png(4096, 4096));
  assert.throws(() => charge('other', png(1, 1)), /limit/);
  assert.throws(
    () => createImportImageBudget()('huge', png(16384, 16384)),
    /limit/,
  );
});

test('pending file reads can be cancelled without waiting for the loader timeout', async () => {
  const controller = new AbortController();
  const file = {
    name: 'waiting.geojson',
    size: 1,
    arrayBuffer: () => new Promise(() => {}),
  };
  const promise = loadGeoFile(file, { viewer: {}, signal: controller.signal });
  controller.abort(new Error('cancelled by teardown'));
  await assert.rejects(promise, /cancelled by teardown/);
});

test('a hidden coarse globe never seeds a mesh-clamp ray below the surface', async () => {
  const previous = Cesium.PinBuilder.prototype.fromColor;
  Cesium.PinBuilder.prototype.fromColor = () => ({
    tagName: 'CANVAS',
    toDataURL: () => 'data:image/png;base64,local',
  });
  const starts = [];
  try {
    for (const terrainProvider of [new Cesium.EllipsoidTerrainProvider(), {}]) {
      const viewer = {
        terrainProvider,
        camera: {
          positionCartographic: { height: 100000 },
          computeViewRectangle: () => Cesium.Rectangle.MAX_VALUE,
        },
        scene: {
          frameState: { mode: Cesium.SceneMode.SCENE3D },
          globe: { show: false, getHeight: () => -12311 },
          clampToHeightSupported: true,
          clampToHeightMostDetailed: async (points) =>
            points.map((p) => {
              const c = Cesium.Cartographic.fromCartesian(p);
              starts.push(c.height);
              return c.height < -9000
                ? undefined
                : Cesium.Cartesian3.fromRadians(c.longitude, c.latitude, 2000);
            }),
        },
      };
      const loaded = await loadGeoFile(
        new File(
          [JSON.stringify({ type: 'Point', coordinates: [1, 2] })],
          'surface.geojson',
        ),
        { viewer },
      );
      assert.ok(
        Math.abs(starts.at(-1)) < 1e-6,
        `ray started at ${starts.at(-1)}`,
      );
      assert.ok(
        Math.abs(
          Cesium.Cartographic.fromCartesian(
            loaded.dataSource.importedBillboards.get(0).position,
          ).height - 2000,
        ) < 1e-6,
      );
      const sampled = starts.length;
      viewer.camera.computeViewRectangle = () => undefined;
      await loaded.refreshGround();
      assert.equal(
        starts.length,
        sampled,
        'distant points do not start a detailed mesh sweep',
      );
      assert.ok(
        Math.abs(
          Cesium.Cartographic.fromCartesian(
            loaded.dataSource.importedBillboards.get(0).position,
          ).height - 2000,
        ) < 1e-6,
        'the last valid mesh height survives outside the camera footprint',
      );
      const point = loaded.dataSource.importedEntities[0];
      const other = new Cesium.Entity({ id: 'unrelated-aircraft' });
      viewer.trackedEntity = starts.length === 1 ? other : point;
      viewer.selectedEntity = point;
      loaded.revoke();
      assert.equal(viewer.selectedEntity, undefined);
      assert.equal(
        viewer.trackedEntity,
        starts.length === 1 ? other : undefined,
      );
    }
  } finally {
    Cesium.PinBuilder.prototype.fromColor = previous;
  }
});

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
    namespaceURI: 'http://www.opengis.net/kml/2.2',
    childNodes: [],
    getAttribute: (n) => (n in attrs ? String(attrs[n]) : null),
    get attributes() {
      return Object.entries(attrs);
    },
    setAttribute: (n, value) => {
      attrs[n] = value;
    },
    removeAttribute: (n) => {
      delete attrs[n];
    },
    cloneNode() {
      return xmlEl(
        localName,
        { ...attrs },
        text ?? el.childNodes.map((child) => child.cloneNode(true)),
      );
    },
    getElementsByTagName(name) {
      return xmlDoc(this).getElementsByTagName(name).slice(1);
    },
    appendChild(child) {
      child.parentNode?.removeChild(child);
      child.parentNode = this;
      this.childNodes.push(child);
    },
    replaceChild(next, previous) {
      const index = this.childNodes.indexOf(previous);
      assert.ok(index >= 0);
      next.parentNode?.removeChild(next);
      this.childNodes[index] = next;
      next.parentNode = this;
      previous.parentNode = null;
    },
    removeChild(child) {
      this.childNodes.splice(this.childNodes.indexOf(child), 1);
      child.parentNode = null;
    },
  };
  for (const k of typeof kids === 'string' ? [] : kids) {
    k.parentNode = el;
    el.childNodes.push(k);
  }
  let text = typeof kids === 'string' ? kids : null;
  Object.defineProperty(el, 'firstChild', {
    get: () => el.childNodes[0] || null,
  });
  Object.defineProperty(el, 'textContent', {
    get: () => text ?? el.childNodes.map((c) => c.textContent).join(''),
    set: (value) => {
      text = value;
      el.childNodes = [];
    },
  });
  return el;
}
const xmlDoc = (root) => ({
  documentElement: root,
  createElementNS: (_ns, name) => xmlEl(name),
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
const serializeStyle = (el) =>
  JSON.stringify({
    name: el.localName,
    attributes: el.attributes,
    text: el.childNodes.length ? null : el.textContent,
    children: el.childNodes.map(serializeStyle),
  });

test('repeated inline styles are shared without replacing their inherited styleUrl', () => {
  const style = () =>
    xmlEl('Style', {}, [xmlEl('IconStyle', {}, [xmlEl('scale', {}, '0.6')])]);
  const placemarks = Array.from({ length: 2100 }, () =>
    xmlEl('Placemark', {}, [xmlEl('styleUrl', {}, '#base'), style()]),
  );
  const doc = xmlDoc(
    xmlEl('kml', {}, [
      xmlEl('Document', {}, [
        xmlEl('Style', { id: 'gev-import-style-1' }, [xmlEl('LineStyle')]),
        ...placemarks,
      ]),
    ]),
  );
  assert.equal(countKmlGeometry(doc).over, 'links');
  assert.equal(deduplicateKmlStyles(doc, { serializeStyle }), 2100);
  assert.equal(countKmlGeometry(doc).over, '');
  const styles = doc
    .getElementsByTagName('*')
    .filter((el) => el.localName === 'Style');
  assert.equal(styles.length, 2);
  assert.equal(styles[1].getAttribute('id'), 'gev-import-style-2');
  for (const placemark of placemarks) {
    assert.equal(placemark.childNodes[0].textContent, '#base');
    assert.equal(placemark.childNodes[1].localName, 'StyleMap');
    assert.deepEqual(
      placemark.childNodes[1].childNodes.map((pair) =>
        pair.childNodes.map((el) => el.textContent),
      ),
      [
        ['normal', '#gev-import-style-2'],
        ['highlight', '#gev-import-style-2'],
      ],
    );
  }
});

test('identical named styles redirect existing references and Pair styles remain valid', () => {
  const style = (id) =>
    xmlEl('Style', id ? { id } : {}, [
      xmlEl('LineStyle', {}, [xmlEl('width', {}, '3')]),
    ]);
  const reference = xmlEl('styleUrl', {}, '#b');
  const pair = xmlEl('Pair', {}, [xmlEl('key', {}, 'normal'), style()]);
  const doc = xmlDoc(
    xmlEl('kml', {}, [
      style('a'),
      style('b'),
      xmlEl('StyleMap', { id: 'map' }, [pair]),
      xmlEl('Placemark', {}, [reference]),
    ]),
  );
  assert.equal(deduplicateKmlStyles(doc, { serializeStyle }), 3);
  assert.equal(doc.documentElement.firstChild.localName, 'Document');
  assert.equal(reference.textContent, '#gev-import-style-1');
  assert.equal(pair.childNodes[1].localName, 'styleUrl');
  assert.equal(pair.childNodes[1].textContent, '#gev-import-style-1');
  assert.equal(
    doc.getElementsByTagName('*').filter((el) => el.localName === 'Style')
      .length,
    1,
  );
});

test('random colors and ambiguous style IDs retain independent evaluations and precedence', () => {
  const random = () =>
    xmlEl('Style', {}, [
      xmlEl('IconStyle', {}, [xmlEl('colorMode', {}, 'random')]),
    ]);
  const named = (width) =>
    xmlEl('Style', { id: 'collision' }, [
      xmlEl('LineStyle', {}, [xmlEl('width', {}, width)]),
    ]);
  const original = [random(), random(), named('1'), named('1'), named('2')];
  const doc = xmlDoc(xmlEl('kml', {}, original));
  assert.equal(deduplicateKmlStyles(doc, { serializeStyle }), 0);
  assert.deepEqual(doc.documentElement.childNodes, original);
});

test('distinct style definitions and named StyleMaps still have a pre-loader budget', () => {
  const doc = xmlDoc(
    xmlEl(
      'kml',
      {},
      ['1', '2', '3'].map((width) =>
        xmlEl('Style', {}, [
          xmlEl('LineStyle', {}, [xmlEl('width', {}, width)]),
        ]),
      ),
    ),
  );
  assert.throws(
    () => deduplicateKmlStyles(doc, { serializeStyle, maxStyles: 2 }),
    GeoImportError,
  );
  const maps = xmlDoc(
    xmlEl('kml', {}, [
      xmlEl('StyleMap', { id: 'a' }),
      xmlEl('StyleMap', { id: 'b' }),
    ]),
  );
  assert.equal(countKmlGeometry(maps, { maxLinks: 1 }).over, 'links');
});

test('KML extended metadata is removed before the document reaches the loader', () => {
  const point = xmlEl('Point', {}, [xmlEl('coordinates', {}, '1,2,0')]);
  const metadata = xmlEl('ExtendedData', {}, [
    xmlEl('Data', { name: 'note' }, [xmlEl('value', {}, 'ordinary metadata')]),
  ]);
  const placemark = xmlEl('Placemark', {}, [metadata, point]);
  const doc = xmlDoc(xmlEl('kml', {}, [placemark]));
  assert.equal(sanitizeKmlDocument(doc).removed, 1);
  assert.deepEqual(placemark.childNodes, [point]);
  assert.equal(metadata.parentNode, null);
});
test('blocked icon sources fall back to local pins without changing intentional empty icons', () => {
  const blocked = xmlEl('Icon', {}, [
    xmlEl('href', {}, 'https://example.invalid/icon.png'),
  ]);
  const blank = xmlEl('Icon');
  const embedded = xmlEl('Icon', {}, [
    xmlEl('href', {}, 'data:image/png;base64,AAAA'),
  ]);
  const packed = xmlEl('Icon', {}, [xmlEl('href', {}, 'packed.png')]);
  const iconStyle = xmlEl('IconStyle', {}, [
    xmlEl('scale', {}, '0.3'),
    blocked,
  ]);
  const doc = xmlDoc(
    xmlEl('kml', {}, [
      xmlEl('Style', {}, [iconStyle]),
      ...[blank, embedded, packed].map((icon) =>
        xmlEl('Style', {}, [xmlEl('IconStyle', {}, [icon])]),
      ),
    ]),
  );
  assert.equal(
    sanitizeKmlDocument(doc, (href) =>
      href === 'packed.png' ? 'blob:local-image' : null,
    ).removed,
    1,
  );
  assert.equal(blocked.parentNode, null);
  assert.equal(iconStyle.childNodes[0].textContent, '0.3');
  assert.equal(blank.parentNode.localName, 'IconStyle');
  assert.equal(
    embedded.childNodes[0].textContent,
    'data:image/png;base64,AAAA',
  );
  assert.equal(packed.childNodes[0].textContent, 'blob:local-image');
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
    entities: 4,
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
      entities: 1,
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

test('multipart GeoJSON is refused before loading when it expands past the entity cap', () => {
  const parts = Array.from({ length: MAX_IMPORT_ENTITIES + 1 }, () => [1, 2]);
  for (const geometry of [
    { type: 'MultiPoint', coordinates: parts },
    {
      type: 'GeometryCollection',
      geometries: parts.map((coordinates) => ({ type: 'Point', coordinates })),
    },
    { type: 'MultiLineString', coordinates: parts.map((p) => [p, [2, 3]]) },
  ]) {
    const size = countGeoJsonGeometry({ type: 'Feature', geometry });
    assert.equal(size.over, 'entities');
  }
});

test('GPX points with missing or blank coordinates are skipped rather than placed at zero', () => {
  const doc = xmlDoc(
    xmlEl('gpx', {}, [
      xmlEl('wpt', { lon: 2 }),
      xmlEl('wpt', { lat: 1 }),
      xmlEl('wpt', { lat: '', lon: 2 }),
      xmlEl('wpt', { lat: 1, lon: ' ' }),
      xmlEl('wpt', { lat: 0, lon: 0 }),
    ]),
  );
  assert.equal(gpxToGeoJson(doc).features.length, 1);
  assert.deepEqual(gpxToGeoJson(doc).features[0].geometry.coordinates, [0, 0]);
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
    entities: 2,
    positions: 42,
    links: 0,
    over: '',
  });
  assert.equal(countKmlGeometry(doc, { maxPositions: 41 }).over, 'positions');
  assert.equal(countKmlGeometry(doc, { maxFeatures: 1 }).over, 'features');
});

test('KML vertex counting recognizes the Unicode whitespace Cesium accepts', () => {
  for (const separator of ['\u00a0', '\u2003', '\ufeff']) {
    const doc = xmlDoc(
      xmlEl('kml', {}, [
        xmlEl('Placemark', {}, [
          xmlEl('LineString', {}, [
            xmlEl('coordinates', {}, ['1,2', '3,4', '5,6'].join(separator)),
          ]),
        ]),
      ]),
    );
    assert.equal(countKmlGeometry(doc).positions, 3);
    assert.equal(countKmlGeometry(doc, { maxPositions: 2 }).over, 'positions');
  }
});

test('KML multipart geometries count every Cesium entity before loading', () => {
  const doc = xmlDoc(
    xmlEl('kml', {}, [
      xmlEl('Placemark', {}, [
        xmlEl('MultiGeometry', {}, [
          xmlEl('Point'),
          xmlEl('MultiGeometry', {}, [xmlEl('Point'), xmlEl('LineString')]),
          xmlEl('MultiTrack', {}, [xmlEl('Track'), xmlEl('Track')]),
        ]),
      ]),
      xmlEl('GroundOverlay'),
    ]),
  );
  assert.equal(countKmlGeometry(doc).entities, 9);
  assert.equal(countKmlGeometry(doc, { maxEntities: 8 }).over, 'entities');
  const oversized = xmlDoc(
    xmlEl('kml', {}, [
      xmlEl('Placemark', {}, [
        xmlEl(
          'MultiGeometry',
          {},
          Array.from({ length: MAX_IMPORT_ENTITIES }, () => xmlEl('Point')),
        ),
      ]),
    ]),
  );
  assert.equal(countKmlGeometry(oversized).over, 'entities');
});

test('KML folders contribute to the pre-loader entity budget', () => {
  const doc = xmlDoc(
    xmlEl('kml', {}, [
      xmlEl('Folder', {}, [xmlEl('Folder', {}, [xmlEl('Placemark')])]),
    ]),
  );
  assert.equal(countKmlGeometry(doc).entities, 3);
  assert.equal(countKmlGeometry(doc, { maxEntities: 2 }).over, 'entities');
});

test('KML style definitions and distinct icon links have their own limit', () => {
  const style = () =>
    xmlEl('Style', {}, [
      xmlEl('IconStyle', {}, [xmlEl('Icon', {}, [xmlEl('href', {}, 'a.png')])]),
    ]);
  const doc = xmlDoc(xmlEl('kml', {}, [style(), style(), style()]));
  assert.equal(countKmlGeometry(doc).links, 4);
  assert.equal(countKmlGeometry(doc, { maxLinks: 3 }).over, 'links');
  const distinct = xmlDoc(
    xmlEl(
      'kml',
      {},
      ['a.png', 'b.png', 'c.png'].map((href) => xmlEl('href', {}, href)),
    ),
  );
  assert.equal(countKmlGeometry(distinct, { maxLinks: 2 }).over, 'links');
});

test('a KMZ image gets one blob URL however many hrefs name it', () => {
  const entries = new Map([
    ['doc.kml', new Uint8Array(0)],
    ['a.png', new Uint8Array(8)],
    ['b.png', new Uint8Array(8)],
  ]);
  const made = [];
  const kept = [];
  const resolve = kmzImageResolver(
    entries,
    'doc.kml',
    (url) => kept.push(url),
    (blob) => {
      made.push(blob);
      return `blob:test/${made.length}`;
    },
  );
  for (let i = 0; i < 1000; i++) assert.equal(resolve('a.png'), 'blob:test/1');
  assert.equal(resolve('./b.png'), 'blob:test/2');
  assert.equal(resolve('a.png'), 'blob:test/1');
  assert.equal(resolve('https://example.com/a.png'), null);
  assert.equal(resolve('doc.kml'), null);
  assert.equal(made.length, 2);
  assert.deepEqual(kept, ['blob:test/1', 'blob:test/2']);
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

test('generated pin canvases are encoded once and shared without changing authored image URLs', () => {
  const ds = new Cesium.CustomDataSource('pins');
  let encoded = 0;
  const canvas = {
    tagName: 'CANVAS',
    toDataURL: () => {
      encoded++;
      return 'data:image/png;base64,shared-pin';
    },
  };
  for (let i = 0; i < 1000; i++)
    ds.entities.add({
      billboard: { image: canvas },
      label: { text: 'discard' },
      properties: { discard: true },
    });
  const authored = ds.entities.add({
    billboard: { image: 'blob:packed-image' },
  });
  const dynamicImage = new Cesium.CallbackProperty(() => canvas, false);
  const dynamic = ds.entities.add({ billboard: { image: dynamicImage } });
  let notifications = 0;
  ds.entities.collectionChanged.addEventListener(() => notifications++);
  scrubImportedEntities(ds);
  assert.equal(encoded, 1);
  assert.equal(
    notifications,
    1,
    'normalization publishes one complete collection change',
  );
  for (const e of ds.entities.values.slice(0, 1000))
    assert.equal(
      e.billboard.image.getValue(),
      'data:image/png;base64,shared-pin',
    );
  assert.equal(authored.billboard.image.getValue(), 'blob:packed-image');
  assert.equal(
    dynamic.billboard.image,
    dynamicImage,
    'time-dependent image properties stay intact',
  );
});

test('unused KML time and camera metadata is removed before loading without changing geometry', () => {
  const coordinates = xmlEl('coordinates', {}, '1,2,0 3,4,0');
  const placemark = xmlEl('Placemark', {}, [
    xmlEl('TimeSpan'),
    xmlEl('TimeStamp'),
    xmlEl('LookAt'),
    xmlEl('Camera'),
    xmlEl('LineString', {}, [coordinates]),
  ]);
  const doc = xmlDoc(xmlEl('kml', {}, [placemark]));
  sanitizeKmlDocument(doc);
  assert.deepEqual(
    placemark.childNodes.map((el) => el.localName),
    ['LineString'],
  );
  assert.equal(coordinates.textContent, '1,2,0 3,4,0');
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
  // KML tracks become their original static vertices before Cesium loading.
  const track = ds.entities.add({
    availability: span,
    polyline: {
      positions: Cesium.Cartesian3.fromDegreesArray([10, 10, 10.1, 10.1]),
      clampToGround: true,
    },
  });
  const recorded = track.polyline.positions;
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
  assert.equal(track.availability, undefined);
  assert.equal(track.polyline.positions, recorded);
  assert.equal(recorded.getValue(Cesium.JulianDate.now()).length, 2);
  assert.ok(track.polyline.clampToGround.getValue());
});
