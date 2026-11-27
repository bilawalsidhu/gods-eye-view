import assert from 'node:assert/strict';
import test from 'node:test';
import {
  citiesInRegion,
  createPlaceSuggester,
  houseAddress,
  inExtent,
  resetPlaceSuggestions,
} from './placeSuggestions.js';

// The spacing, pause and cache are the tab's: each test starts clean.
test.beforeEach(() => resetPlaceSuggestions());

test('Photon suggestions keep distinct valid candidates and their region bounds', async () => {
  const texas = {
    geometry: { type: 'Point', coordinates: [-99, 31] },
    properties: {
      name: 'Texas',
      country: 'United States',
      countrycode: 'us',
      type: 'state',
      osm_value: 'administrative',
      extent: [-107, 37, -93, 25],
    },
  };
  const requested = [];
  const service = createPlaceSuggester({
    endpoint: 'https://fixture.test/api/',
    fetchImpl: async (url) => {
      requested.push(url);
      return Response.json({
        features: [
          texas,
          texas,
          {
            ...texas,
            geometry: { type: 'Point', coordinates: [-99, 131] },
          },
        ],
      });
    },
  });
  const expected = [
    {
      name: 'Texas',
      detail: 'United States',
      type: 'state',
      latitude: 31,
      longitude: -99,
      state: null,
      country: 'United States',
      countryCode: 'US',
      extent: [-107, 37, -93, 25],
    },
  ];
  assert.deepEqual(await service.suggest('  Texas  '), expected);
  assert.deepEqual(await service.suggest('texas'), expected);
  assert.deepEqual(await service.suggest('Tx'), []);
  assert.equal(requested.length, 1);
  assert.equal(requested[0].origin, 'https://fixture.test');
  assert.equal(requested[0].searchParams.get('q'), 'Texas');
});

test('a disabled or cancelled suggestion sends no request', async () => {
  const sent = [];
  const fetchImpl = async (url) => {
    sent.push(url.searchParams.get('q'));
    return Response.json({ features: [] });
  };
  const off = createPlaceSuggester({ endpoint: null, fetchImpl });
  assert.equal(off.enabled, false);
  assert.deepEqual(await off.suggest('Texas'), []);

  const service = createPlaceSuggester({ fetchImpl });
  await service.suggest('Texas');
  const abort = new AbortController();
  const waiting = service.suggest('Austin', { signal: abort.signal });
  abort.abort();
  await assert.rejects(waiting, { name: 'AbortError' });
  assert.deepEqual(sent, ['Texas']);
});

test('suggestions while typing keep their spacing to the place service', async () => {
  const sentAt = [];
  const service = createPlaceSuggester({
    endpoint: 'https://fixture.test/api/',
    fetchImpl: async () => {
      sentAt.push(performance.now());
      return Response.json({ features: [] });
    },
  });
  // Three different texts at once, as fast typing past the debounce sends.
  await Promise.all(['Aus', 'Aust', 'Austin'].map((q) => service.suggest(q)));
  assert.equal(sentAt.length, 3);
  for (let i = 1; i < sentAt.length; i++)
    assert.ok(
      sentAt[i] - sentAt[i - 1] >= 490,
      `request ${i} came ${Math.round(sentAt[i] - sentAt[i - 1])} ms after the one before`,
    );
});

test('a state lists only its own cities: Texas has no Mexican one', () => {
  const texas = { extent: [-106.65, 36.5, -93.51, 25.84], countryCode: 'US' };
  const cities = [
    { name: 'Houston', latitude: 29.76, longitude: -95.37, country: 'US' },
    { name: 'El Paso', latitude: 31.76, longitude: -106.49, country: 'US' },
    // Inside the Texas box, across the border.
    {
      name: 'Ciudad Juárez',
      latitude: 31.74,
      longitude: -106.49,
      country: 'MX',
    },
    { name: 'Reynosa', latitude: 26.09, longitude: -98.28, country: 'MX' },
    // In the US, outside Texas.
    { name: 'Denver', latitude: 39.74, longitude: -104.99, country: 'US' },
  ];
  assert.deepEqual(
    citiesInRegion(cities, texas).map((city) => city.name),
    ['Houston', 'El Paso'],
  );
  // A country without bounds still keeps only its own.
  assert.deepEqual(
    citiesInRegion(cities, { countryCode: 'MX' }).map((city) => city.name),
    ['Ciudad Juárez', 'Reynosa'],
  );
  // Fiji's extent runs across the antimeridian.
  assert.deepEqual(
    citiesInRegion(
      [
        { name: 'Labasa', latitude: -16.43, longitude: 179.38, country: 'FJ' },
        { name: 'Lakeba', latitude: -18.2, longitude: -178.8, country: 'FJ' },
      ],
      { extent: [177, -12, -178, -21], countryCode: 'FJ' },
    ).length,
    2,
  );
  assert.deepEqual(citiesInRegion(cities, {}), []);
});

test('two-character Han, Hangul and Kana names are looked up', async () => {
  const sent = [];
  const service = createPlaceSuggester({
    endpoint: 'https://fixture.test/api/',
    fetchImpl: async (url) => {
      sent.push(url.searchParams.get('q'));
      return Response.json({ features: [] });
    },
  });
  await service.suggest('東');
  await service.suggest('NY');
  await service.suggest('東京');
  assert.deepEqual(sent, ['東京']);
});

test('an extent across the antimeridian holds both of its sides', () => {
  const fiji = [177, -12, -178, -21];
  assert.equal(inExtent(fiji, { latitude: -16.4, longitude: 179.4 }), true);
  assert.equal(inExtent(fiji, { latitude: -18.2, longitude: -178.8 }), true);
  assert.equal(inExtent(fiji, { latitude: -18.2, longitude: 170 }), false);
  assert.equal(
    inExtent([-107, 37, -93, 25], { latitude: 31, longitude: -99 }),
    true,
  );
});

const answering = (calls, answer) => async (url) => {
  calls.push(String(url));
  if (answer instanceof Error) throw answer;
  return { ok: true, json: async () => ({ features: [] }) };
};

test('a failed or timed-out request pauses suggestions as a refusal does', async () => {
  const calls = [];
  const suggester = createPlaceSuggester({
    endpoint: 'https://photon.test/api/',
    fetchImpl: answering(calls, new TypeError('Failed to fetch')),
  });
  assert.deepEqual(await suggester.suggest('Paris'), []);
  assert.deepEqual(await suggester.suggest('Berlin'), []);
  assert.equal(calls.length, 1);
});

test('every suggester in the tab keeps one spacing and one pause', async () => {
  const calls = [];
  const options = {
    endpoint: 'https://photon.test/api/',
    fetchImpl: answering(calls),
  };
  const first = createPlaceSuggester(options);
  const second = createPlaceSuggester(options);
  const started = Date.now();
  await Promise.all([first.suggest('Paris'), second.suggest('Berlin')]);
  assert.equal(calls.length, 2);
  assert.ok(Date.now() - started >= 490);
});

test('two houses on one street are two suggestions, asked once', async () => {
  let sent = 0;
  const house = (number, lon) => ({
    geometry: { type: 'Point', coordinates: [lon, 51.5034] },
    properties: {
      street: 'Downing Street',
      housenumber: number,
      city: 'London',
      country: 'United Kingdom',
      countrycode: 'gb',
      osm_value: 'house',
    },
  });
  const service = createPlaceSuggester({
    endpoint: 'https://fixture.test/api/',
    fetchImpl: async () => {
      sent++;
      return Response.json({
        features: [house('10', -0.1276), house('12', -0.1277)],
      });
    },
  });
  const [first, second] = await Promise.all([
    service.suggest('Downing Street'),
    service.suggest('Downing Street'),
  ]);
  assert.deepEqual(
    first.map((place) => place.name),
    ['10 Downing Street', '12 Downing Street'],
  );
  assert.deepEqual(second, first);
  assert.equal(sent, 1);
});

test('the same text asked again while its request is out is sent once', async () => {
  let sent = 0;
  const service = createPlaceSuggester({
    endpoint: 'https://fixture.test/api/',
    fetchImpl: async () => {
      sent++;
      await new Promise((resolve) => setTimeout(resolve, 700));
      return Response.json({ features: [] });
    },
  });
  await Promise.all([service.suggest('Paris'), service.suggest('Paris')]);
  assert.equal(sent, 1);
});

test('a house is named by its number and street in the order its country writes them', async () => {
  assert.equal(
    houseAddress({
      houseNumber: '10',
      street: 'Downing Street',
      countryCode: 'gb',
    }),
    '10 Downing Street',
  );
  assert.equal(
    houseAddress({
      houseNumber: '12',
      street: 'Hauptstraße',
      countryCode: 'DE',
    }),
    'Hauptstraße 12',
  );
  assert.equal(houseAddress({ houseNumber: '12', street: '' }), '');
  // Without a street, a house's number and its locality name it, so two
  // houses in one hamlet stay two places, not the city twice.
  const house = (number) => ({
    geometry: { type: 'Point', coordinates: [11.2, 47.6] },
    properties: {
      housenumber: number,
      locality: 'Mittenwald Au',
      city: 'Mittenwald',
      country: 'Germany',
      countrycode: 'de',
      osm_value: 'house',
    },
  });
  const service = createPlaceSuggester({
    endpoint: 'https://fixture.test/api/',
    fetchImpl: async () =>
      Response.json({ features: [house('3'), house('5')] }),
  });
  assert.deepEqual(
    (await service.suggest('Mittenwald Au')).map((place) => place.name),
    ['Mittenwald Au 3', 'Mittenwald Au 5'],
  );
});

test('a line longer than a place name is never sent for suggestions', async () => {
  let sent = 0;
  const service = createPlaceSuggester({
    endpoint: 'https://fixture.test/api/',
    fetchImpl: async () => {
      sent++;
      return Response.json({ features: [] });
    },
  });
  assert.deepEqual(
    await service.suggest('one two three four five six seven eight nine'),
    [],
  );
  assert.equal(sent, 0);
  // An address has more words: as many as the Omnibar reads as a place.
  await service.suggest('350 Fifth Avenue, New York, NY 10118, United States');
  assert.equal(sent, 1);
  await service.suggest('1 2 3 4 5 6 7 8 9 10 11');
  assert.equal(sent, 1);
});
