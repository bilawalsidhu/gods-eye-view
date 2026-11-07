import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isLikelySpainCoordinate,
  parseSpainDgtXml,
  spainCameraToSource,
  spainFrameUrl,
} from './spain.js';

function cameraBlock({
  id = '176130',
  type = 'camera',
  lat = 42.2624,
  lon = -3.9403,
  road = 'A-62',
  destination = 'BURGOS',
  province = 'BURGOS',
  kilometre = '25.3',
  url = 'https://etraffic.dgt.es/camarasEtraffic/176130.jpg',
  prefix = 'ns2',
  locPrefix = 'loc',
  fsePrefix = 'fse',
} = {}) {
  return `    <${prefix}:device xsi:type="${fsePrefix}:ExtendedDevice" id="${id}" version="2">
        <${prefix}:typeOfDevice>${type}</${prefix}:typeOfDevice>
        <${prefix}:pointLocation>
            <${locPrefix}:supplementaryPositionalDescription>
                <${locPrefix}:roadInformation>
                    <${locPrefix}:roadDestination>${destination}</${locPrefix}:roadDestination>
                    <${locPrefix}:roadName>${road}</${locPrefix}:roadName>
                </${locPrefix}:roadInformation>
            </${locPrefix}:supplementaryPositionalDescription>
            <${locPrefix}:pointCoordinates>
                <${locPrefix}:latitude>${lat}</${locPrefix}:latitude>
                <${locPrefix}:longitude>${lon}</${locPrefix}:longitude>
            </${locPrefix}:pointCoordinates>
            <lse:extendedTpegNonJunctionPoint>
                <lse:kilometerPoint>${kilometre}</lse:kilometerPoint>
                <lse:province>${province}</lse:province>
            </lse:extendedTpegNonJunctionPoint>
        </${prefix}:pointLocation>
        <${fsePrefix}:deviceUrl>${url}</${fsePrefix}:deviceUrl>
    </${prefix}:device>`;
}

function document(blocks) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<d2LogicalModel xmlns:d2="http://datex2.eu/schema/3/d2Payload" xmlns:ns2="http://datex2.eu/schema/3/common" xmlns:loc="http://datex2.eu/schema/3/locationReferencing" xmlns:fse="http://datex2.eu/schema/3/d2Payload">
  <payloadPublication>
${blocks.join('\n')}
  </payloadPublication>
</d2LogicalModel>`;
}

test('parses DGT device blocks whatever namespace prefixes they use', () => {
  const xml = document([
    cameraBlock(),
    cameraBlock({
      id: '91337',
      lat: 41.3874,
      lon: 2.1686,
      road: 'B-10',
      province: 'BARCELONA',
      kilometre: '12.0',
      url: 'https://etraffic.dgt.es/camarasEtraffic/91337.jpg',
      prefix: 'p',
      locPrefix: 'l',
      fsePrefix: 'f',
    }),
  ]);
  const rows = parseSpainDgtXml(xml);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], {
    deviceId: '176130',
    lat: 42.2624,
    lon: -3.9403,
    roadName: 'A-62',
    destination: 'BURGOS',
    province: 'BURGOS',
    kilometre: '25.3',
    frameUrl: 'https://etraffic.dgt.es/camarasEtraffic/176130.jpg',
  });
  assert.equal(rows[1].deviceId, '91337');
  assert.equal(rows[1].roadName, 'B-10');
});

test('skips devices that are not cameras', () => {
  const xml = document([
    cameraBlock({ id: '1' }),
    cameraBlock({ id: '2', type: 'vehicleDetection' }),
  ]);
  const rows = parseSpainDgtXml(xml);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].deviceId, '1');
});

test('only the published https DGT frame shape is accepted', () => {
  const good = 'https://etraffic.dgt.es/camarasEtraffic/176130.jpg';
  assert.equal(spainFrameUrl(good), good);
  assert.equal(
    spainFrameUrl('https://etraffic.dgt.es/camarasEtraffic/176130.jpg?x=1'),
    null,
  );
  assert.equal(
    spainFrameUrl('https://etraffic.dgt.es/camarasEtraffic/176130.png'),
    null,
  );
  assert.equal(spainFrameUrl('http://etraffic.dgt.es/camarasEtraffic/1.jpg'), null);
  assert.equal(spainFrameUrl('https://example.com/camarasEtraffic/1.jpg'), null);
  assert.equal(
    spainFrameUrl('https://etraffic.dgt.es:8443/camarasEtraffic/1.jpg'),
    null,
  );
  assert.equal(spainFrameUrl('https://user:pw@etraffic.dgt.es/camarasEtraffic/1.jpg'), null);
  assert.equal(spainFrameUrl(''), null);
});

test('a parsed row becomes one source with attribution and a low-confidence pose', () => {
  const [row] = parseSpainDgtXml(document([cameraBlock()]));
  const source = spainCameraToSource(row);
  assert.equal(source.id, 'es-dgt-176130');
  assert.equal(source.cityId, 'spain');
  assert.equal(source.city, 'Spain / España');
  assert.equal(source.provider, 'Dirección General de Tráfico (DGT)');
  assert.equal(source.feedType, 'image');
  assert.equal(source.url, 'https://etraffic.dgt.es/camarasEtraffic/176130.jpg');
  assert.equal(source.snapshotUrl, source.url);
  assert.equal(source.headingConfidence, 'low');
  assert.match(source.name, /A-62/);
  assert.match(source.name, /BURGOS/);
  assert.match(source.license, /CC BY/);
  assert.ok(source.code.length > 0);
});

test('cameras outside Spain and malformed IDs are dropped', () => {
  const [offMap] = parseSpainDgtXml(
    document([cameraBlock({ lat: 48.8566, lon: 2.3522 })]),
  );
  assert.equal(spainCameraToSource(offMap), null);

  const [noId] = parseSpainDgtXml(document([cameraBlock({ id: '' })]));
  assert.equal(spainCameraToSource(noId), null);

  assert.equal(isLikelySpainCoordinate(28.4636, -16.2518), true); // Tenerife
  assert.equal(isLikelySpainCoordinate(41.3874, 2.1686), true); // Barcelona
  assert.equal(isLikelySpainCoordinate(51.5, -0.12), false); // London
});

test('entities in names are decoded and never leak markup', () => {
  const [row] = parseSpainDgtXml(
    document([
      cameraBlock({ road: 'A&amp;B', destination: '&lt;MA&gt;', province: '' }),
    ]),
  );
  const source = spainCameraToSource(row);
  assert.match(source.name, /A&B/);
  assert.match(source.name, /<MA>/);
});
