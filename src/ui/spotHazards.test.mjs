// src/ui/spotHazards.test.mjs — a picked card's Nearby keeps the natural
// hazards near the item from their public feeds (earthquakes, tropical
// storms, wildfire perimeters) also while those layers are off; satellite
// fire hits are asked for only while FIRMS is on. Over happy-dom.
import '../testSupport/registerDom.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPinia } from 'pinia';
import { createApp, h, nextTick, reactive } from 'vue';
import { setContextRadiusKm, CONTEXT_RADIUS_STEPS } from './contextRadius.js';
import {
  closeContextSearch,
  contextSearchOpen,
  contextSearchText,
} from './contextSearch.js';
import SpotConditions from './views/panels/SpotConditions.vue';
import { useOmnibarStore } from './stores/omnibar.js';
import { useEntityCardStore } from './stores/entityCard.js';

const HERE = { lat: 30.27, lon: -97.74 };
const issuedAt = new Date(Date.now() - 3600_000).toISOString();
const FEEDS = {
  'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson': {
    type: 'FeatureCollection',
    features: [
      {
        id: 'q1',
        type: 'Feature',
        properties: {
          mag: 4.6,
          place: '10 km N of Austin',
          time: Date.now() - 3 * 3600_000,
        },
        geometry: { type: 'Point', coordinates: [-97.7, 30.35, 5] },
      },
    ],
  },
  '/api/cyclones': {
    schemaVersion: 1,
    source: 'NOAA NHC / CPHC',
    attribution: 'NOAA/NWS',
    coverage: 'Atlantic',
    fetchedAt: Date.now(),
    stale: false,
    unavailable: false,
    reason: null,
    storms: [
      {
        id: 'al052026',
        name: 'Testa',
        classification: 'TS',
        basin: 'AL',
        position: { longitude: -96.9, latitude: 29.4 },
        positionAt: issuedAt,
        issuedAt,
        advisoryNumber: '3',
        windKt: 45,
        pressureHpa: 1000,
        movement: { directionDegrees: null, speedKt: null },
        advisoryUrl: 'https://www.nhc.noaa.gov/text/MIATCMAT5.shtml',
        outlookUrl: 'https://www.nhc.noaa.gov/gtwo.php?basin=atlc&fdays=7',
        geometryStatus: 'pending',
        geometryAdvisoryNumber: null,
        forecastPoints: [],
        track: null,
        cone: null,
      },
    ],
  },
  '/api/fire-perimeters': {
    rows: [
      {
        name: 'Ridge Fire',
        acres: 1200,
        containedPct: 40,
        polygons: [
          [
            [
              [-97.9, 30.1],
              [-97.8, 30.1],
              [-97.8, 30.2],
              [-97.9, 30.1],
            ],
          ],
        ],
      },
    ],
    stale: false,
    fetchedAt: Date.now(),
  },
  '/api/firms': {
    fires: [{ lat: 30.3, lon: -97.6 }],
  },
};

function fixture(t, { firmsOn, props = {}, feeds = FEEDS }) {
  const asked = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    asked.push(String(url));
    const body = await feeds[String(url)];
    if (body instanceof Response) return body.clone();
    return body ? Response.json(body) : new Response('', { status: 503 });
  };
  document.body.replaceChildren();
  const pinia = createPinia();
  // Every hazard layer is off; FIRMS only as asked.
  const firms = { id: 'local-firms', name: 'Active Fires', enabled: firmsOn };
  useOmnibarStore(pinia).connect({
    layers: () => [
      { id: 'earthquakes', name: 'Earthquakes', enabled: false },
      { id: 'weather-cyclones', name: 'Tropical Storms', enabled: false },
      { id: 'fire-perimeters', name: 'Fire Perimeters', enabled: false },
      firms,
    ],
  });
  // The data manager's layer changes, as the app's manager sends them.
  const listeners = new Set();
  const notifyLayers = () => {
    for (const listener of listeners) listener({ type: 'visibility' });
  };
  const flown = [];
  useOmnibarStore(pinia).connectRunner((name, args) =>
    flown.push([name, args]),
  );
  const manager = {
    layers: new Map(),
    isEnabled: () => false,
    getAll: () => [],
    subscribe: (listener) => (
      listeners.add(listener),
      () => listeners.delete(listener)
    ),
  };
  useEntityCardStore(pinia).connect({ dataManager: () => manager });
  const shown = reactive({
    lat: HERE.lat,
    lon: HERE.lon,
    excludeKey: 'flights:a1',
    ownLayer: 'flights',
    ...props,
  });
  const app = createApp({ render: () => h(SpotConditions, { ...shown }) }).use(
    pinia,
  );
  app.mount(document.body.appendChild(document.createElement('div')));
  t.after(() => {
    app.unmount();
    globalThis.fetch = realFetch;
    setContextRadiusKm(250);
  });
  return { asked, firms, shown, notifyLayers, flown };
}

const settle = async () => {
  for (let i = 0; i < 10; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await nextTick();
  }
};
const rows = () =>
  [...document.querySelectorAll('.spot-conditions__hazards li')].map(
    (row) => row.className,
  );

test('with the hazard layers off, a picked card still lists the quake, storm and fire perimeter near it, and asks nothing of FIRMS', async (t) => {
  const { asked } = fixture(t, { firmsOn: false });
  await settle();
  const detail = (kind) =>
    document.querySelector(
      `.spot-conditions__hazard--${kind} .spot-conditions__row-detail`,
    ).textContent;
  assert.match(detail('quake'), /10 km N of Austin · 3 h ago/);
  assert.match(detail('storm'), /1 h ago/);
  assert.doesNotMatch(
    detail('wildfire'),
    /ago/,
    'an undated report has no observation age',
  );
  assert.deepEqual(rows().sort(), [
    'spot-conditions__hazard--quake',
    'spot-conditions__hazard--storm',
    'spot-conditions__hazard--wildfire',
  ]);
  const text = document.querySelector('.spot-conditions__hazards').textContent;
  for (const name of [/M4\.6 earthquake/, /Tropical storm Testa/, /Ridge Fire/])
    assert.match(text, name);
  assert.equal(
    asked.some((url) => url.includes('/api/firms')),
    false,
    'no FIRMS request while its layer is off',
  );
});

test('a hazard at the card location shows zero distance without a direction', async (t) => {
  fixture(t, { firmsOn: false, props: { lat: 30.35, lon: -97.7 } });
  await settle();
  assert.equal(
    document
      .querySelector(
        '.spot-conditions__hazard--quake .spot-conditions__row-meta',
      )
      .textContent.trim(),
    '0.0 km',
  );
});

test('with FIRMS on, its satellite fire hits are listed too', async (t) => {
  const { asked } = fixture(t, { firmsOn: true });
  await settle();
  assert.ok(asked.some((url) => url.includes('/api/firms')));
  assert.ok(rows().includes('spot-conditions__hazard--hotspots'));
});

// The feed cache is shared and lasts five minutes; these tests move the
// clock past it where they need a fresh read.
let clockShift = 0;
const realNow = Date.now;
const shiftClock = (t, ms) => {
  clockShift += ms;
  Date.now = () => realNow() + clockShift;
  t.after(() => {
    Date.now = realNow;
  });
};
const firmsAsks = (asked) =>
  asked.filter((url) => url.includes('/api/firms')).length;

test('a successful read with nothing near shows no hazard block', async (t) => {
  shiftClock(t, 6 * 60_000);
  fixture(t, { firmsOn: true, props: { lat: -40, lon: 170 } });
  await settle();
  assert.equal(document.querySelector('.spot-conditions__hazards'), null);
});

test('pending hazard feeds show Loading', async (t) => {
  shiftClock(t, 6 * 60_000);
  const reply = Promise.withResolvers();
  fixture(t, {
    firmsOn: false,
    feeds: Object.fromEntries(
      Object.keys(FEEDS).map((url) => [url, reply.promise]),
    ),
  });
  t.after(() => reply.resolve());
  await settle();
  const block = document.querySelector('.spot-conditions__hazards');
  assert.equal(block.querySelector('.spot-conditions__count').textContent, '…');
  assert.equal(
    block.querySelector('.spot-conditions__source').textContent,
    'Loading',
  );
});

test('failure of every requested hazard feed shows Unavailable', async (t) => {
  shiftClock(t, 6 * 60_000);
  fixture(t, { firmsOn: false, feeds: {} });
  await settle();
  const block = document.querySelector('.spot-conditions__hazards');
  const count = block.querySelector('.spot-conditions__count');
  assert.equal(count.textContent, '—');
  assert.equal(count.title, 'Unavailable');
  assert.match(block.textContent, /USGS: Unavailable/);
  assert.match(block.textContent, /NOAA NHC: Unavailable/);
  assert.match(block.textContent, /NIFC WFIGS: Unavailable/);
  assert.doesNotMatch(block.textContent, /NASA FIRMS/);
});

test('unavailable cyclone data and a missing FIRMS key are identified alongside healthy rows', async (t) => {
  shiftClock(t, 6 * 60_000);
  const { firms, notifyLayers } = fixture(t, {
    firmsOn: true,
    feeds: {
      ...FEEDS,
      '/api/cyclones': {
        ...FEEDS['/api/cyclones'],
        unavailable: true,
        storms: [],
      },
      '/api/firms': Response.json({ error: 'no_key' }, { status: 503 }),
    },
  });
  await settle();
  const credit = document.querySelector(
    '.spot-conditions__hazards .spot-conditions__source',
  );
  assert.match(credit.textContent, /USGS/);
  assert.doesNotMatch(credit.textContent, /USGS: Unavailable/);
  assert.match(credit.textContent, /NOAA NHC: Unavailable/);
  assert.match(credit.textContent, /NASA FIRMS: Unavailable/);
  assert.equal(rows().length, 2);
  firms.enabled = false;
  notifyLayers();
  await settle();
  assert.doesNotMatch(credit.textContent, /NASA FIRMS/);
});

test('FIRMS turned off is read live: a radius change asks nothing of FIRMS before the next poll', async (t) => {
  shiftClock(t, 6 * 60_000);
  const { asked, firms } = fixture(t, { firmsOn: true });
  await settle();
  const before = firmsAsks(asked);
  assert.ok(before >= 1, 'FIRMS asked while on');
  // Its cached snapshot expires, FIRMS goes off, the radius moves at once.
  shiftClock(t, 6 * 60_000);
  firms.enabled = false;
  setContextRadiusKm(CONTEXT_RADIUS_STEPS.find((km) => km !== 250));
  await settle();
  assert.equal(
    firmsAsks(asked),
    before,
    'no /api/firms request with FIRMS off',
  );
  assert.ok(
    !rows().includes('spot-conditions__hazard--hotspots'),
    'no fire-hit row with FIRMS off',
  );
});

test('hazards reuse cached feeds until the scheduled five-minute refresh reads them again', async (t) => {
  const ttl = 5 * 60_000;
  clockShift += ttl + 60_000;
  t.mock.timers.enable({
    apis: ['Date', 'setInterval'],
    now: realNow() + clockShift,
  });
  const { asked } = fixture(t, { firmsOn: false });
  await settle();
  const reads = () =>
    asked.filter((url) => url.includes('/api/cyclones')).length;
  assert.equal(reads(), 1);
  t.mock.timers.tick(ttl - 1);
  setContextRadiusKm(CONTEXT_RADIUS_STEPS.find((km) => km !== 250));
  await settle();
  assert.equal(reads(), 1, 'changing radius still uses the cached feed');
  t.mock.timers.tick(1);
  await settle();
  assert.equal(reads(), 2, 'the scheduled refresh fetches the expired feed');
  clockShift += ttl;
});

test('a satellite card warns of hazards within the Context radius, not just its swath', async (t) => {
  fixture(t, { firmsOn: false, props: { swathKm: 4, ownLayer: 'satellites' } });
  await settle();
  assert.ok(
    rows().includes('spot-conditions__hazard--quake'),
    'the quake about 10 km off',
  );
});

test('a card that stays put reads its hazards again after a correction of more than 1 km', async (t) => {
  const { shown } = fixture(t, { firmsOn: false, props: { settleKm: 1 } });
  await settle();
  const metaOf = () =>
    document.querySelector(
      '.spot-conditions__hazard--quake .spot-conditions__row-meta',
    )?.textContent;
  const first = metaOf();
  shown.lat = HERE.lat + 0.05;
  await new Promise((resolve) => setTimeout(resolve, 400));
  await settle();
  assert.notEqual(
    metaOf(),
    first,
    'the distance follows the 5.5 km correction',
  );
});

test('the hazard rows credit their feeds in the card', async (t) => {
  fixture(t, { firmsOn: false });
  await settle();
  const credit = document.querySelector(
    '.spot-conditions__hazards .spot-conditions__source',
  );
  assert.ok(credit, 'a source line under the hazards');
  for (const name of ['USGS', 'NOAA NHC', 'NIFC WFIGS'])
    assert.match(credit.textContent, new RegExp(name));
  assert.doesNotMatch(credit.textContent, /NASA FIRMS/);
});

test('turning FIRMS off or on changes its rows at once, and a stale row does nothing', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const { firms, notifyLayers, flown } = fixture(t, { firmsOn: true });
  await settle();
  const hotspot = () =>
    document.querySelector('.spot-conditions__hazard--hotspots button');
  assert.ok(hotspot(), 'fire hits listed with FIRMS on');
  const stale = hotspot();
  // FIRMS goes off; the layer change arrives, the 4 s poll does not.
  firms.enabled = false;
  notifyLayers();
  await settle();
  assert.equal(hotspot(), null, 'the row goes at once');
  stale.click();
  await settle();
  assert.deepEqual(flown, [], 'a row kept from before does nothing');
  // And back on: the row returns without waiting for the poll.
  firms.enabled = true;
  notifyLayers();
  await settle();
  assert.ok(hotspot(), 'the row returns at once');
  hotspot().click();
  const [[action, args]] = flown;
  assert.equal(action, 'fly_to_location');
  assert.ok(Number.isFinite(args.latitude) && Number.isFinite(args.longitude));
  assert.equal(
    args.query,
    undefined,
    'coordinate flight keeps the selected card',
  );
});

test('the hazard heading counts results beyond the five displayed rows', async (t) => {
  shiftClock(t, 6 * 60_000);
  const feed = Object.keys(FEEDS).find((url) =>
    url.includes('earthquake.usgs.gov'),
  );
  const [quake] = FEEDS[feed].features;
  fixture(t, {
    firmsOn: false,
    feeds: {
      ...FEEDS,
      [feed]: {
        ...FEEDS[feed],
        features: Array.from({ length: 13 }, (_, index) => ({
          ...quake,
          id: `q${index}`,
          properties: { ...quake.properties, place: `Near Austin ${index}` },
          geometry: {
            type: 'Point',
            coordinates: [-97.7 + index * 0.01, 30.35, 5],
          },
        })),
      },
    },
  });
  await settle();
  assert.equal(rows().length, 5);
  assert.equal(
    document.querySelector('.spot-conditions__hazards .spot-conditions__count')
      ?.textContent,
    '15',
  );
  t.after(closeContextSearch);
  contextSearchOpen.value = true;
  contextSearchText.value = 'Near Austin';
  await nextTick();
  assert.equal(rows().length, 12);
  assert.equal(
    document.querySelector('.spot-conditions__hazards .spot-conditions__count')
      ?.textContent,
    '13',
  );
});
