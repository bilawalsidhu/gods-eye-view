import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  loadTallinnSourcesFromCatalog,
  parseTarkteeDatexImages,
  parseTarkteeDatexLocations,
} from '../../server/providers/cctv/sources.js';

const SAMPLE_LOCATIONS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<d2LogicalModel xmlns="http://datex2.eu/schema/2/2_0">
  <payloadPublication>
    <predefinedLocationContainer id="TRAFFIC_CAMERAS" version="0">
      <predefinedLocation id="aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" version="0">
        <predefinedLocationName>
          <values><value lang="et">Test Site</value></values>
        </predefinedLocationName>
        <location>
          <pointByCoordinates>
            <pointCoordinates>
              <latitude>59.4370</latitude>
              <longitude>24.7530</longitude>
            </pointCoordinates>
          </pointByCoordinates>
        </location>
      </predefinedLocation>
    </predefinedLocationContainer>
  </payloadPublication>
</d2LogicalModel>`;

const SAMPLE_IMAGES_XML = `<?xml version="1.0" encoding="UTF-8"?>
<d2LogicalModel xmlns="http://datex2.eu/schema/2/2_0">
  <payloadPublication>
    <trafficView id="1">
      <linearTrafficView id="1">
        <linearPredefinedLocationReference targetClass="PredefinedLocation" id="aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" version="0"/>
        <trafficViewRecord id="1-1">
          <urlLink>
            <urlLinkAddress>https://tarktee.transpordiamet.ee/images/42/42_202608251542.jpg</urlLinkAddress>
            <urlLinkType>image</urlLinkType>
          </urlLink>
        </trafficViewRecord>
      </linearTrafficView>
    </trafficView>
  </payloadPublication>
</d2LogicalModel>`;

test('Tallinn catalog loads curated ristmikud stills only', () => {
  const cameras = loadTallinnSourcesFromCatalog();
  assert.ok(
    cameras.length >= 200,
    `expected a full Tallinn pack, got ${cameras.length}`,
  );
  for (const camera of cameras.slice(0, 25)) {
    assert.match(camera.id, /^tln-/);
    assert.equal(camera.cityId, 'tallinn');
    assert.equal(camera.feedType, 'image');
    assert.equal(camera.sourceKind, 'tallinn-ristmikud');
    assert.ok(camera.url.startsWith('https://ristmikud.tallinn.ee/'));
    assert.equal(camera.url, camera.snapshotUrl);
    assert.ok(Number.isFinite(camera.lat) && Number.isFinite(camera.lon));
  }
});

test('Tarktee DATEX parsers join location UUIDs to image URLs', () => {
  const locations = parseTarkteeDatexLocations(SAMPLE_LOCATIONS_XML);
  const images = parseTarkteeDatexImages(SAMPLE_IMAGES_XML);
  assert.equal(locations.size, 1);
  assert.equal(images.size, 1);
  const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  assert.equal(locations.get(id)?.name, 'Test Site');
  assert.equal(locations.get(id)?.lat, 59.437);
  assert.equal(locations.get(id)?.lon, 24.753);
  assert.equal(
    images.get(id),
    'https://tarktee.transpordiamet.ee/images/42/42_202608251542.jpg',
  );
});

test('Tarktee DATEX image parser rejects non-official hosts', () => {
  const xml = SAMPLE_IMAGES_XML.replace(
    'https://tarktee.transpordiamet.ee/images/42/42_202608251542.jpg',
    'https://evil.example/images/42/42.jpg',
  );
  const images = parseTarkteeDatexImages(xml);
  assert.equal(images.size, 0);
});
