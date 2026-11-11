import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TARKTEE_IMAGES_URL,
  TARKTEE_LOCATIONS_URL,
  TARKTEE_MAX_CATALOG_BYTES,
} from '../../server/providers/cctv/constants.js';
import {
  loadTallinnSourcesFromCatalog,
  loadTarkteeSourcesFromDatex,
  parseTarkteeDatexImages,
  parseTarkteeDatexLocations,
} from '../../server/providers/cctv/sources.js';

/** Silence the loaders' progress and failure logging. */
function quiet(t) {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
}

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

test('Tarktee loader deduplicates cameras sharing an image number before the cap', async (t) => {
  quiet(t);
  const dupLocationsXml = `<?xml version="1.0" encoding="UTF-8"?>
<d2LogicalModel xmlns="http://datex2.eu/schema/2/2_0">
  <payloadPublication>
    <predefinedLocationContainer id="TRAFFIC_CAMERAS" version="0">
      <predefinedLocation id="loc-1" version="0">
        <predefinedLocationName><values><value lang="et">Tallinn Ringtee</value></values></predefinedLocationName>
        <location><pointByCoordinates><pointCoordinates><latitude>59.4370</latitude><longitude>24.7530</longitude></pointCoordinates></pointByCoordinates></location>
      </predefinedLocation>
      <predefinedLocation id="loc-2" version="0">
        <predefinedLocationName><values><value lang="et">Tallinn Ringtee duplicate</value></values></predefinedLocationName>
        <location><pointByCoordinates><pointCoordinates><latitude>59.4371</latitude><longitude>24.7531</longitude></pointCoordinates></pointByCoordinates></location>
      </predefinedLocation>
    </predefinedLocationContainer>
  </payloadPublication>
</d2LogicalModel>`;
  const dupImagesXml = `<?xml version="1.0" encoding="UTF-8"?>
<d2LogicalModel xmlns="http://datex2.eu/schema/2/2_0">
  <payloadPublication>
    <trafficView id="1"><linearTrafficView id="1"><linearPredefinedLocationReference id="loc-1"/><trafficViewRecord id="1-1"><urlLink><urlLinkAddress>https://tarktee.transpordiamet.ee/images/42/42_1.jpg</urlLinkAddress></urlLink></trafficViewRecord></linearTrafficView></trafficView>
    <trafficView id="2"><linearTrafficView id="2"><linearPredefinedLocationReference id="loc-2"/><trafficViewRecord id="2-1"><urlLink><urlLinkAddress>https://tarktee.transpordiamet.ee/images/42/42_2.jpg</urlLinkAddress></urlLink></trafficViewRecord></linearTrafficView></trafficView>
  </payloadPublication>
</d2LogicalModel>`;

  const seen = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    seen.push([String(url), init?.redirect]);
    const body =
      String(url) === TARKTEE_LOCATIONS_URL ? dupLocationsXml : dupImagesXml;
    return new Response(body, {
      status: 200,
      headers: { 'Content-Type': 'application/xml' },
    });
  });

  const cameras = await loadTarkteeSourcesFromDatex();
  assert.deepEqual(seen, [
    [TARKTEE_LOCATIONS_URL, 'manual'],
    [TARKTEE_IMAGES_URL, 'manual'],
  ]);
  assert.equal(cameras.length, 1);
  assert.equal(cameras[0].id, 'ee-tarktee-42');
  assert.equal(cameras[0].name, 'Tallinn Ringtee');
});

test('Tarktee loader refuses a redirect and cancels both response bodies', async (t) => {
  quiet(t);
  const cancelled = { locations: false, images: false };
  t.mock.method(globalThis, 'fetch', async (url) => {
    const isLocations = String(url) === TARKTEE_LOCATIONS_URL;
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('<xml/>'));
      },
      cancel() {
        if (isLocations) cancelled.locations = true;
        else cancelled.images = true;
      },
    });
    return new Response(body, {
      status: isLocations ? 302 : 200,
      headers: isLocations ? { location: 'https://evil.example/loc.xml' } : {},
    });
  });

  assert.deepEqual(await loadTarkteeSourcesFromDatex(), []);
  assert.equal(cancelled.locations, true, 'redirected body is cancelled');
  assert.equal(cancelled.images, true, 'sibling 200 body is also cancelled');
});

test('Tarktee loader cancels fulfilled bodies when either fetch rejects', async (t) => {
  for (const failedUrl of [TARKTEE_LOCATIONS_URL, TARKTEE_IMAGES_URL]) {
    for (const delayedSibling of [false, true]) {
      await t.test(
        `${failedUrl}, delayed sibling: ${delayedSibling}`,
        async (t) => {
          quiet(t);
          let cancelled = false;
          const response = new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode('<xml/>'));
              },
              cancel() {
                cancelled = true;
              },
            }),
          );
          t.mock.method(globalThis, 'fetch', async (url) => {
            if (String(url) === failedUrl) throw new TypeError('fetch failed');
            if (delayedSibling) await new Promise(setImmediate);
            return response;
          });

          try {
            assert.deepEqual(await loadTarkteeSourcesFromDatex(), []);
            assert.equal(
              cancelled,
              true,
              'fulfilled sibling body is cancelled',
            );
          } finally {
            await response.body.cancel();
          }
        },
      );
    }
  }
});

test('Tarktee loader cancels the sibling body when one feed fails or overflows the byte cap', async (t) => {
  quiet(t);
  let siblingCancelled = false;
  t.mock.method(globalThis, 'fetch', async (url) => {
    const isLocations = String(url) === TARKTEE_LOCATIONS_URL;
    if (isLocations) {
      return new Response('', { status: 503 });
    }
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(SAMPLE_IMAGES_XML));
      },
      cancel() {
        siblingCancelled = true;
      },
    });
    return new Response(body, { status: 200 });
  });

  assert.deepEqual(await loadTarkteeSourcesFromDatex(), []);
  assert.equal(
    siblingCancelled,
    true,
    'sibling 200 stream is cancelled on 503',
  );

  let overflowSiblingCancelled = false;
  t.mock.method(globalThis, 'fetch', async (url) => {
    const isLocations = String(url) === TARKTEE_LOCATIONS_URL;
    if (isLocations) {
      const padded =
        SAMPLE_LOCATIONS_XML + ' '.repeat(TARKTEE_MAX_CATALOG_BYTES);
      return new Response(padded, {
        status: 200,
        headers: { 'Content-Length': String(padded.length) },
      });
    }
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(SAMPLE_IMAGES_XML));
      },
      cancel() {
        overflowSiblingCancelled = true;
      },
    });
    return new Response(body, { status: 200 });
  });

  assert.deepEqual(await loadTarkteeSourcesFromDatex(), []);
  assert.equal(
    overflowSiblingCancelled,
    true,
    'sibling stream is cancelled when the other feed exceeds the byte cap',
  );
});

test('Tarktee DATEX requests wait 30 s, past the slow answers measured live', async (t) => {
  const timeouts = [];
  const timeout = AbortSignal.timeout;
  t.mock.method(AbortSignal, 'timeout', (ms) => {
    timeouts.push(ms);
    return timeout.call(AbortSignal, ms);
  });
  t.mock.method(console, 'log', () => {});
  t.mock.method(
    globalThis,
    'fetch',
    async (url) =>
      new Response(
        String(url).includes('roadCameraLocations')
          ? SAMPLE_LOCATIONS_XML
          : SAMPLE_IMAGES_XML,
      ),
  );
  const cameras = await loadTarkteeSourcesFromDatex();
  assert.deepEqual(timeouts, [30_000, 30_000]);
  assert.equal(cameras.length, 1);
});
