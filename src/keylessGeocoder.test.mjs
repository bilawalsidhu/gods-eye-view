// KEYLESS GEOCODER — the Photon adapter that keeps place search working
// without a Google key.
//
// The whole value of this module is that its output is INDISTINGUISHABLE to
// everything downstream: `geocodeNavigationMode` and the framing code must keep
// making the same decisions they make on a Google result. So these tests check
// the translation, not the network — three things that go wrong silently:
//
//   1. Photon's `extent` is [west, north, east, south]. Read as [w,s,e,n] it
//      yields an inverted-but-plausible box, and the camera frames nonsense.
//   2. Photon calls a national park `type: 'other'`. Dropped, a park geocodes
//      as a precise place and the camera lands on a random patch of grass —
//      the exact bug geocodeNavigationMode's area types exist to prevent.
//   3. A miss must be `null`, never a throw: both callers read null as
//      "not found" and a throw would surface as a broken search box.
//
// Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  geocodeKeyless,
  geocodeKeylessWithOutcome,
  normalizePhotonFeature,
  normalizeToponym,
  photonExtentToBounds,
  photonResultLabel,
  photonResultTypes,
  photonSearchUrl,
  selectPhotonFeature,
} from './keylessGeocoder.js';
import { geocodeNavigationMode } from './locations.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Photon's real answer for "Hanoi", trimmed to the fields we consume. */
const HANOI = {
  geometry: { type: 'Point', coordinates: [105.854041, 21.0283334] },
  properties: {
    osm_key: 'place',
    osm_value: 'city',
    type: 'city',
    name: 'Hà Nội',
    country: 'Việt Nam',
    countrycode: 'VN',
    extent: [105.2889615, 21.3854176, 106.0200407, 20.5645154],
  },
};

test('a city normalizes into the shape the Google path produces', () => {
  const result = normalizePhotonFeature(HANOI);

  assert.equal(result.lat, 21.0283334);
  assert.equal(result.lng, 105.854041);
  assert.equal(result.label, 'Hà Nội, Việt Nam');
  assert.deepEqual(result.types, ['locality']);
  assert.equal(geocodeNavigationMode(result.types), 'city-overview');
});

test('the extent is read as [west, north, east, south], not as [w,s,e,n]', () => {
  const bounds = photonExtentToBounds(HANOI.properties.extent);

  // Hanoi spans roughly 20.56..21.39 N and 105.29..106.02 E. A [w,s,e,n] read
  // would put north at 21.385 and south at 106.02 — a box that still has four
  // finite numbers and would frame the camera at nothing.
  assert.equal(bounds.southwest.lat, 20.5645154);
  assert.equal(bounds.northeast.lat, 21.3854176);
  assert.equal(bounds.southwest.lng, 105.2889615);
  assert.equal(bounds.northeast.lng, 106.0200407);
  assert.ok(bounds.northeast.lat > bounds.southwest.lat, 'north must exceed south');
  assert.ok(bounds.northeast.lng > bounds.southwest.lng, 'east must exceed west');
});

test('a malformed or out-of-range extent yields no bounds rather than a bad box', () => {
  assert.equal(photonExtentToBounds(undefined), null);
  assert.equal(photonExtentToBounds([1, 2, 3]), null);
  assert.equal(photonExtentToBounds([0, 95, 10, -95]), null, 'latitude past the pole');
  assert.equal(photonExtentToBounds([-200, 10, 10, 0]), null, 'longitude past the antimeridian');
});

test('area features keep an area type so the camera frames them, not a rooftop', () => {
  // Every row is a real Photon answer, captured from the live service. The
  // lake rows are why: Photon tags water as `water=lake`, not `natural=water`,
  // and the guess cost a camera 26 m over Hoan Kiem Lake.
  const cases = [
    [{ type: 'other', osm_key: 'water', osm_value: 'lake' }, 'natural_feature', 'area-overview'],
    [{ type: 'other', osm_key: 'leisure', osm_value: 'park' }, 'park', 'area-overview'],
    [{ type: 'other', osm_key: 'place', osm_value: 'region' }, 'natural_feature', 'area-overview'],
    [{ type: 'other', osm_key: 'natural', osm_value: 'peak' }, 'natural_feature', 'area-overview'],
    [{ type: 'other', osm_key: 'waterway', osm_value: 'river' }, 'natural_feature', 'area-overview'],
    [{ type: 'house', osm_key: 'aeroway', osm_value: 'aerodrome' }, 'airport', 'area-overview'],
    [{ type: 'house', osm_key: 'amenity', osm_value: 'university' }, 'university', 'area-overview'],
    [{ type: 'street', osm_key: 'highway', osm_value: 'motorway' }, 'route', 'street-corridor'],
    [{ type: 'country', osm_key: 'place', osm_value: 'country' }, 'country', 'region-overview'],
    [{ type: 'state', osm_key: 'place', osm_value: 'state' }, 'administrative_area_level_1', 'region-overview'],
    [{ type: 'district', osm_key: 'place', osm_value: 'suburb' }, 'sublocality', 'neighborhood-close'],
  ];

  for (const [properties, expectedType, expectedMode] of cases) {
    const types = photonResultTypes(properties);
    assert.ok(
      types.includes(expectedType),
      `${properties.osm_key}=${properties.osm_value} must carry ${expectedType}, got ${JSON.stringify(types)}`,
    );
    assert.equal(geocodeNavigationMode(types), expectedMode);
  }
});

test('a tag rule wins over the coarse class — a town square is not a city', () => {
  // Photon reports Times Square and Quang truong Ba Dinh as place=square with
  // type: 'locality'. Falling through to the coarse class framed a plaza as if
  // it were a whole city.
  const square = { type: 'locality', osm_key: 'place', osm_value: 'square' };
  assert.deepEqual(photonResultTypes(square), []);
  assert.equal(geocodeNavigationMode(photonResultTypes(square)), 'precise-place');
});

test('an ordinary building stays a precise place', () => {
  const types = photonResultTypes({ type: 'house', osm_key: 'building', osm_value: 'yes' });
  assert.equal(geocodeNavigationMode(types), 'precise-place');
});

test('the label names the place, then only containers it does not already name', () => {
  assert.equal(
    photonResultLabel({ name: 'Hoàn Kiếm Lake', district: 'Hoàn Kiếm', city: 'Hà Nội', country: 'Việt Nam' }),
    'Hoàn Kiếm Lake, Hoàn Kiếm, Hà Nội, Việt Nam',
  );
  assert.equal(
    photonResultLabel({ name: 'Hà Nội', city: 'Hà Nội', country: 'Việt Nam' }),
    'Hà Nội, Việt Nam',
    'a city must not repeat its own name',
  );
});

test('the Google bias becomes a SOFT proximity bias, never a hard bbox', () => {
  const url = new URL(photonSearchUrl('Sixth Street', { bias: '30.2000,-97.8000|30.3000,-97.7000' }));

  assert.equal(url.searchParams.get('q'), 'Sixth Street');
  // Five, not one: proximity reorders the list, so the name actually asked for
  // can sit below a nearer near-miss and must still be reachable.
  assert.equal(url.searchParams.get('limit'), '5');
  assert.equal(url.searchParams.get('lat'), '30.25', 'centre of the biased rectangle');
  assert.equal(url.searchParams.get('lon'), '-97.75');

  // Measured against the live service: Photon's bbox FILTERS, Google's bounds
  // PREFERS. Sending the rectangle as a bbox makes every off-screen search
  // return features: [] — "Ho Guom, Ha Noi" while looking at Austin finds
  // nothing at all. This assertion is the guard against that regression.
  assert.equal(url.searchParams.get('bbox'), null, 'a bbox would filter out every off-screen place');
});

test('an absent or unparsable bias drops the bias instead of sending a broken one', () => {
  for (const bias of [undefined, 'nonsense', 'a,b|c,d']) {
    const url = new URL(photonSearchUrl('Hanoi', bias === undefined ? {} : { bias }));
    assert.equal(url.searchParams.get('lat'), null);
    assert.equal(url.searchParams.get('lon'), null);
    assert.equal(url.searchParams.get('bbox'), null);
  }
});

test('a network failure resolves to null — callers read null as not-found', async () => {
  const rejecting = () => Promise.reject(new Error('offline'));
  assert.equal(await geocodeKeyless('Hanoi', { fetchImpl: rejecting }), null);

  const notOk = () => Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
  assert.equal(await geocodeKeyless('somewhere else', { fetchImpl: notOk }), null);

  const empty = () => Promise.resolve({ ok: true, json: () => Promise.resolve({ features: [] }) });
  assert.equal(await geocodeKeyless('third distinct query', { fetchImpl: empty }), null);
});

test('an empty query never reaches the network', async () => {
  let calls = 0;
  const counting = () => { calls += 1; return Promise.reject(new Error('should not run')); };

  assert.equal(await geocodeKeyless('   ', { fetchImpl: counting }), null);
  assert.equal(await geocodeKeyless(null, { fetchImpl: counting }), null);
  assert.equal(calls, 0);
});

test('repeat queries are served from the memo, misses included', async () => {
  let calls = 0;
  const counting = () => {
    calls += 1;
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ features: [HANOI] }) });
  };

  const first = await geocodeKeyless('Ha Noi memo probe', { fetchImpl: counting });
  const second = await geocodeKeyless('Ha Noi memo probe', { fetchImpl: counting });
  assert.equal(calls, 1, 'the second lookup must not hit the network');
  assert.deepEqual(second, first);

  const missing = () => {
    calls += 1;
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ features: [] }) });
  };
  await geocodeKeyless('typo memo probe', { fetchImpl: missing });
  await geocodeKeyless('typo memo probe', { fetchImpl: missing });
  assert.equal(calls, 2, 'a miss must be memoized too, or a typo costs one request per keystroke');
});

test('a feature without usable coordinates is rejected', () => {
  assert.equal(normalizePhotonFeature(undefined), null);
  assert.equal(normalizePhotonFeature({ properties: { name: 'Nowhere' } }), null);
  assert.equal(normalizePhotonFeature({ geometry: { coordinates: [200, 10] } }), null);
  assert.equal(normalizePhotonFeature({ geometry: { coordinates: [10, 91] } }), null);
});

// ── Bias may choose among matches; it may not change what counts as one ──────

/** Photon's real answers for "Huế": Austin-biased, then unbiased. */
const HUTTO = {
  geometry: { type: 'Point', coordinates: [-97.6842, 30.5427] },
  properties: { osm_key: 'place', osm_value: 'town', type: 'city', name: 'Hutto', country: 'United States' },
};
const HUE = {
  geometry: { type: 'Point', coordinates: [107.5908, 16.4674] },
  properties: {
    osm_key: 'place', osm_value: 'city', type: 'city', name: 'Huế', country: 'Việt Nam',
    extent: [107.3763, 16.7739, 108.0518, 16.1276],
  },
};

/** Answers biased requests with `nearby`, unbiased ones with `anywhere`. */
function photonPair(nearby, anywhere) {
  const urls = [];
  const impl = (url) => {
    urls.push(url);
    const biased = new URL(url).searchParams.has('lat');
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ features: biased ? nearby : anywhere }) });
  };
  impl.urls = urls;
  return impl;
}

test('a biased near-miss is refused, and the unbiased answer is taken instead', async () => {
  // Measured from Austin against the live service: "Huế" scored Hutto, Texas
  // above the city, and "Hạ Long" scored Long Branch. Distance alone must not
  // outrank the name — three of twelve Vietnamese names crossed a continent.
  const fetchImpl = photonPair([HUTTO], [HUE]);

  const result = await geocodeKeyless('Huế', { bias: '30.20,-97.80|30.30,-97.70', fetchImpl });

  assert.equal(result.label.startsWith('Huế'), true, `got ${result.label}`);
  assert.equal(Math.round(result.lat), 16);
  assert.equal(fetchImpl.urls.length, 2, 'the refused bias costs exactly one extra request');
});

test('a biased match that leads with the name is taken without a second request', async () => {
  // The other half of the rule, and the reason bias exists at all: "Sixth
  // Street" over Austin must stay Austin's.
  const sixth = {
    geometry: { type: 'Point', coordinates: [-97.7431, 30.2672] },
    properties: { osm_key: 'highway', osm_value: 'residential', type: 'street', name: 'Sixth Street', country: 'United States' },
  };
  const fetchImpl = photonPair([sixth], [HUE]);

  const result = await geocodeKeyless('Sixth Street', { bias: '30.20,-97.80|30.30,-97.70', fetchImpl });

  assert.equal(result.label.startsWith('Sixth Street'), true);
  assert.equal(fetchImpl.urls.length, 1);
});

test('a name is matched at its head, so a street that merely contains it loses', () => {
  const road = { properties: { name: 'Nguyen Hue Road' } };
  const city = { properties: { name: 'Huế' } };

  assert.equal(selectPhotonFeature([road, city], 'hue'), city);
  // Relaxing to substring is a second choice only, never a first one.
  assert.equal(selectPhotonFeature([road], 'hue'), null);
  assert.equal(selectPhotonFeature([road], 'hue', { allowContains: true }), road);
  assert.equal(selectPhotonFeature([city], ''), null);
  assert.equal(selectPhotonFeature(undefined, 'hue'), null);
});

test('a "place, region" query is matched on the place, not the region', async () => {
  const lake = {
    geometry: { type: 'Point', coordinates: [105.8524, 21.0287] },
    properties: { osm_key: 'natural', osm_value: 'water', water: 'lake', name: 'Hoàn Kiếm Lake', country: 'Việt Nam' },
  };
  const street = { geometry: { type: 'Point', coordinates: [105.85, 21.03] }, properties: { name: 'Hoan Kiem District Road' } };
  const fetchImpl = photonPair([], [street, lake]);

  const result = await geocodeKeyless('Hoan Kiem Lake, Hanoi', { fetchImpl });

  assert.equal(result.label.startsWith('Hoàn Kiếm Lake'), true, `got ${result.label}`);
});

test('accents and punctuation do not change what a name compares as', () => {
  assert.equal(normalizeToponym('Huế'), 'hue');
  assert.equal(normalizeToponym('Hạ Long Bay'), 'ha long bay');
  assert.equal(normalizeToponym("  St. John's-Ravenscourt  "), 'st john s ravenscourt');
  assert.equal(normalizeToponym(undefined), '');
});

// ── The seam inventory ───────────────────────────────────────────────────────
//
// A fallback is only worth having where the app actually geocodes, and the app
// geocodes in more than one place: the LOCATION search box, the Radio layer's
// "near <place>" lookup, and the annotation resolver. Fixing one and leaving
// the others is the failure this pins — the first version of this work fixed
// the search box alone, so a keyless install still threw on "play radio near
// Hanoi" while the search box beside it worked.
//
// It reads the source rather than the behaviour on purpose. The defect is not
// that a particular function is wrong; it is that a NEW call site can be added
// without one, and no behavioural test of the existing three would notice.

test('forward geocoding is composed once and consumers do not call a source directly', () => {
  for (const file of ['locations.js', 'annotations/annotationResolver.js', 'voice/gevActions.js']) {
    const source = fs.readFileSync(path.join(ROOT, 'src', file), 'utf8');
    assert.match(source, /placeSearch\.geocode\(/);
    assert.doesNotMatch(source, /geocodeKeyless|geocode\/json\?address/);
  }
  const setup = fs.readFileSync(path.join(ROOT, 'src/standalone/placeSearch.js'), 'utf8');
  assert.match(setup, /createGoogleGeocoder/);
  assert.match(setup, /createPhotonGeocoder/);
});

test('a missing key is never a thrown error on the client', () => {
  // It was one, in the Radio layer: a keyless install surfaced "play radio near
  // Hanoi" as a failed voice turn rather than as a station it could not place.
  for (const file of ['locations.js', 'annotations/annotationResolver.js', 'voice/gevActions.js']) {
    const body = fs.readFileSync(path.join(ROOT, 'src', file), 'utf8');
    assert.doesNotMatch(body, /throw new Error\([^)]*No Google Maps API key/, `${file} throws on a missing key`);
  }
});

// ── The shape the three call sites share ─────────────────────────────────────

test('the normalized result carries the canonical name its callers need', () => {
  // Two consumers want different halves of one answer: the search box shows
  // `label`, while the annotation resolver matches OSM features on `name`
  // alone — a canonical name beats a parsed label there, because "Hà Nội,
  // Việt Nam" would let the country token win the footprint scoring.
  const result = normalizePhotonFeature(HANOI);

  assert.equal(result.name, 'Hà Nội');
  assert.equal(result.label.startsWith('Hà Nội'), true);
  assert.equal(result.label.includes(result.name), true, 'the label is built from the name, not beside it');
});

test('a feature with no name yields an empty string, never undefined', () => {
  const bare = { geometry: { type: 'Point', coordinates: [105.85, 21.03] }, properties: { osm_key: 'place', osm_value: 'city' } };
  const result = normalizePhotonFeature(bare);

  assert.equal(result.name, '');
  assert.equal(typeof result.label, 'string');
});

test("Photon's own country name stays inside the label — it is not a field", () => {
  // Photon answers in the feature's LANGUAGE: this fixture is the live service's
  // real reply for "Hanoi", and it says "Việt Nam", not "Vietnam". Tokyo answers
  // "日本", Moscow "Россия". Re-exporting that as a `country` field invites a
  // consumer to match on it, and the one consumer that would — the Radio
  // layer's `normalizeRadioCountryInput` — fails CLOSED on a name it cannot
  // map, turning "radio near Ha Long" into an empty station list. The composed
  // label is the only honest use for a localized country name.
  assert.equal(HANOI.properties.country, 'Việt Nam');
  const result = normalizePhotonFeature(HANOI);

  assert.equal('country' in result, false, 'a localized country name must not become a matchable field');
  assert.match(result.label, /Việt Nam$/);
});

// ── An answer and a silence are not the same miss ────────────────────────────
//
// Both arrive as `null`, and remembering the wrong one is the defect this app
// has already had to repair once: the Overpass disk cache persisted refusals
// with normal data TTLs, so an install that hit a bad minute kept serving the
// refusal for a month. A geocoder that memoises a network blip does the same
// thing for a session — every later keystroke replays it without asking.

test('an unanswered request is never memoized, so the next attempt really retries', async () => {
  let attempts = 0;
  const offline = () => { attempts += 1; return Promise.reject(new Error('offline')); };
  const online = () => {
    attempts += 1;
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ features: [HANOI] }) });
  };

  assert.equal(await geocodeKeyless('blip probe', { fetchImpl: offline }), null);
  assert.equal(attempts, 1);

  const recovered = await geocodeKeyless('blip probe', { fetchImpl: online });
  assert.equal(attempts, 2, 'the retry must reach the network, not a memoized blip');
  assert.equal(recovered.name, 'Hà Nội');
});

test('an HTTP refusal counts as silence, not as "no such place"', async () => {
  let attempts = 0;
  const refusing = () => {
    attempts += 1;
    return Promise.resolve({ ok: false, status: 429, json: () => Promise.resolve({}) });
  };

  await geocodeKeyless('throttle probe', { fetchImpl: refusing });
  await geocodeKeyless('throttle probe', { fetchImpl: refusing });
  assert.equal(attempts, 2, 'a 429 must not be remembered as a verdict');
});

test('the outcome reports which of the two a null result was', async () => {
  const answeredMiss = () => Promise.resolve({ ok: true, json: () => Promise.resolve({ features: [] }) });
  const failure = () => Promise.reject(new Error('offline'));
  const hit = () => Promise.resolve({ ok: true, json: () => Promise.resolve({ features: [HANOI] }) });

  assert.deepEqual(
    await geocodeKeylessWithOutcome('outcome probe a', { fetchImpl: answeredMiss }),
    { place: null, answered: true },
  );
  assert.deepEqual(
    await geocodeKeylessWithOutcome('outcome probe b', { fetchImpl: failure }),
    { place: null, answered: false },
  );

  const found = await geocodeKeylessWithOutcome('outcome probe c', { fetchImpl: hit });
  assert.equal(found.answered, true);
  assert.equal(found.place.name, 'Hà Nội');

  // A memo hit is by definition an answer — only answers are stored.
  assert.deepEqual(
    await geocodeKeylessWithOutcome('outcome probe a', { fetchImpl: failure }),
    { place: null, answered: true },
  );
});

test('a biased pass that never answered leaves the whole lookup unanswered', async () => {
  // The unbiased retry can report an honest empty while the biased request that
  // preceded it timed out. The lookup as a whole still rests on a request that
  // never came back, so its null is not a verdict.
  const urls = [];
  const halfDown = (url) => {
    urls.push(url);
    return new URL(url).searchParams.has('lat')
      ? Promise.reject(new Error('timeout'))
      : Promise.resolve({ ok: true, json: () => Promise.resolve({ features: [] }) });
  };

  const outcome = await geocodeKeylessWithOutcome('half-down probe', {
    bias: '30.20,-97.80|30.30,-97.70', fetchImpl: halfDown,
  });
  assert.deepEqual(outcome, { place: null, answered: false });
  assert.equal(urls.length, 2);
});
