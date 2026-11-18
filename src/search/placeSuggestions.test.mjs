import assert from 'node:assert/strict';
import test from 'node:test';
import {
  citiesInRegion,
  createPlaceSuggester,
  inExtent,
  mayBePrivate,
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

test('nothing that may be private is sent to the place service', async () => {
  const sent = [];
  const service = createPlaceSuggester({
    endpoint: 'https://fixture.test/api/',
    fetchImpl: async (url) => {
      sent.push(url.searchParams.get('q'));
      return Response.json({ features: [] });
    },
  });
  for (const text of [
    'me@example.com',
    'sk-abc123',
    'AKIAIOSFODNN7EXAMPLE',
    'ghp_0123abcd',
    'xoxb-1234',
    'token a1b2c3d4e5f6g7',
  ])
    assert.deepEqual(await service.suggest(text), [], text);
  assert.equal(mayBePrivate('Saint Petersburg 2'), false);
  assert.equal(mayBePrivate('Bahnhofstrasse'), false);
  assert.deepEqual(sent, []);
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

test('cards, phones, IBANs, keys and passwords are private', () => {
  for (const text of [
    '4111 1111 1111 1111',
    '+1 (415) 555-0100',
    'SSN 123-45-6789',
    'GB29 NWBK 6016 1331 9268 19',
    'sk_live_51Habc',
    'rk_live_x',
    'pk_live_abc',
    'AIzaSyA0',
    'eyJhbGciOi',
    'password hunter2',
    // Digits of other scripts that would read as a spot once folded, and
    // password words split by format characters or curly apostrophes.
    '١٢٣٤, ٥٦٧٨',
    '१२३४ ५६७८',
    'parola d’ordine viola',
    'pass\u200bword: violet',
    'mot\u200b de passe violet',
    'me\u200b@example.com',
    '@elonmusk',
    'john.smith@',
    'my number is 555 0100 thanks',
    'john @ gmail.com',
    'door code 4421',
    'otp 482913',
    'verification code 482913',
    '2fa 482913',
    'card ending 4242',
    'my secret is swordfish',
    'passphrase correct horse battery',
    'mnemonic: abandon ability able',
    'john at example dot com',
    'the access code is 8842',
    'ping @jdoe',
    'pass: correcthorse',
    'pin 1234',
    // Full-width forms and digits of any script, and digits joined by
    // dots, underscores or commas.
    '４１１１ １１１１ １１１１ １１１１',
    'john＠example.com',
    'ｓｋ_live_abc',
    'my ｐａｓｓｗｏｒｄ is hunter',
    '１２３-４５-６７８９',
    '٤١١١ ١١١١ ١١١١ ١١١١',
    '४१११ ११११ ११११ ११११',
    '4111.1111.1111.1111',
    '4111_1111_1111_1111',
    '4111,1111,1111,1111',
    '123.45.6789',
    'what is 4111.1111.1111.1111',
  ])
    assert.equal(mayBePrivate(text), true, text);
  for (const text of [
    'Pin Oak, Texas',
    // An address with a spaced "@", and names the old rules caught.
    'flat 2 @ 10 Downing St',
    'Nanjampeta @ Chandambylu',
    'Sachsenhausen',
    'Eisenhammer',
    'Xoxocotla',
    'Santa Cruz Xoxocotlán',
    'Yanino-1',
    'Meguro Honmachi 2-chome',
    'Chak No. 656/G.B.',
    'Route-66',
    // Street addresses: a house number beside a postcode, CJK addresses
    // written without spaces, and postcodes as they are written.
    '北京市朝阳区建国路88号',
    '東京都港区六本木6丁目',
    '台北市信義區市府路45號',
    '渋谷区道玄坂2-1',
    '〒100-0001 東京都千代田区千代田1-1',
    'Washington DC 20500-0003',
    '1600 Pennsylvania Ave NW, Washington, DC 20500-0003',
    'São Paulo 01310-200',
    'Calle 100 # 19-61 Bogota',
    'ul. Nowy Świat 10, 00-950 Warszawa',
    'Drottninggatan 53, 111 21 Stockholm',
    'Mariahilfer Straße 120, 1070 Wien',
    'Rua Augusta 274, 1100-053 Lisboa',
    'Tverskaya 13 125009 Moscow',
    'Hauptstrasse 12 10115 Berlin',
    'Calle Mayor 10, 28013 Madrid',
    'Av Paulista 1578 01310-200',
    'Eyjafjallajökull',
    'Route 66',
    '30.27, -97.74',
    '30.2672, -97.7431',
    '14R PU 2090 4906',
    'New York 10001',
    'Passau',
  ])
    assert.equal(mayBePrivate(text), false, text);
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

test('a number named as a card or a phone stays private', () => {
  for (const line of [
    'card 4111 111111 thanks',
    'call 0207 946095 now',
    'phone 12 345678 home',
  ])
    assert.equal(mayBePrivate(line), true, line);
});

test('a UK postcode without its space is a place', () => {
  for (const line of ['EC1A1BB', 'W1A0AX', 'BT487NN'])
    assert.equal(mayBePrivate(line), false, line);
});

test('emails, keys and codes in other shapes stay private', () => {
  for (const line of [
    'john @Gmail.com',
    'John @EXAMPLE.COM',
    '030 12345',
    'Alice 12345-6789',
    'access_token=abcdef',
    'secret_key=abcdef',
    '"sk-abcdefghijklmnop"',
    '(ghp_abcdef)',
    'OTP: ABCDEF',
    'verification code ABCDEF',
    'PIN: A7B2',
  ])
    assert.equal(mayBePrivate(line), true, line);
  for (const line of [
    '10 Downing Street SW1A2AA, London',
    'Washington DC 20500-0003',
    'Pin Oak',
    'Gate Code Lane',
  ])
    assert.equal(mayBePrivate(line), false, line);
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

test('streets named for keys, tokens and codes, and ZIP+4 after a state, are places', () => {
  for (const line of [
    'Secret Key Lake',
    'Access Token Road',
    'Api Key Lane',
    'GATE CODE LANE',
    'SECURITY CODE PLAZA',
    'OTP Bank',
    'MFA BOSTON',
    'Auth Code ABCD Street',
    'California 90210-1234',
    'Austin Texas 78701-1234',
    'Cambridge MA. 02139-4307',
    '12, 10115 Berlin',
  ])
    assert.equal(mayBePrivate(line), false, line);
  for (const line of [
    'gate code: abcd',
    'PIN A7B2',
    'PIN is A7B2',
    'OTP-ABCDEF',
    'OTP – ABCDEF',
    'login code ab-12-cd',
    'auth_token=abc',
  ])
    assert.equal(mayBePrivate(line), true, line);
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
