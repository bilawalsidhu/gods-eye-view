import assert from 'node:assert/strict';
import test from 'node:test';
import {
  citiesInRegion,
  createPlaceSuggester,
  houseAddress,
  inExtent,
  mayBePrivate,
  onlyNumbersLookPrivate,
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
    'meet at Central Park [12:30:00]',
    '10 Main St 123456 A Block',
    'show every plane over london then show every ship near boston please',
    'SECURITY CODE PLAZA',
    'OTP Bank',
    'Auth Code ABCD Street',
    'California 90210-1234',
    'Austin Texas 78701-1234',
    'Cambridge MA. 02139-4307',
    '12, 10115 Berlin',
  ])
    assert.equal(mayBePrivate(line), false, line);
  // All in capitals, a name cannot be told from a code: "MFA BOSTON" is
  // kept back with "OTP ABCDEF".
  for (const line of [
    'MFA BOSTON',
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

test('spelled-out emails, addresses, phrases, codes and short phone numbers stay private', () => {
  for (const line of [
    'john(at)gmail.com',
    'john[at]gmail[dot]com',
    'john at gmail dot de',
    '10.0.0.1',
    'abandon ability able about above absent absorb abstract absurd abuse access accident',
    'Abandon ability able about above absent absorb abstract absurd abuse access accident acid',
    'license ABC1234',
    'passport X1234567',
    'plate 7ABC123',
    'otp ABCDEF',
    'verification code abcdef',
    'cvv abc',
    'Bearer abcdef',
    'Bearer Abcdefgh',
    'Authorization: Bearer Xyz',
    'glpat-abcdef123456',
    'hf_abcdefghijk',
    'SG.abcdefghij.klmnopqrstuv',
    'https://x.com/?code=abcdef',
    'code 4821',
    'garage code 4821',
    'lockbox 4821',
    'the code to my door is 4821',
    'AB 12 34 56 C',
    'my id is AB12345',
    'ssn ending 1234',
    'ssn last four 1234',
    'SSN ends in 6789',
    'otp ABCDEF, thanks',
    'pin AbCd, thanks',
    'otp ABCDEF thanks!!',
    'verification code ABCDEF thanks a lot',
    'otp ABCDEF cheers',
    'otp ab12cd - thanks',
    'gate code aBcD - thanks,',
    'gate code aBcD – thanks',
    '"abandon ability able about above absent absorb abstract absurd abuse access accident"',
    '“abandon ability able about above absent absorb abstract absurd abuse access accident”',
    '«abandon ability able about above absent absorb abstract absurd abuse access accident»',
    '»abandon ability able about above absent absorb abstract absurd abuse access accident«',
    'abandon-ability-able-about-above-absent-absorb-abstract-absurd-abuse-access-accident',
    '#1 abandon #2 ability #3 able #4 about #5 above #6 absent #7 absorb #8 abstract #9 absurd #10 abuse #11 access #12 accident',
    '(1) abandon (2) ability (3) able (4) about (5) above (6) absent (7) absorb (8) abstract (9) absurd (10) abuse (11) access (12) accident',
    'gate code aBcD - thanks',
    'abandon ability able about above absent absorb abstract absurd abuse access accident.',
    'abandon, ability, able, about, above, absent, absorb, abstract, absurd, abuse, access, accident',
    '1. abandon 2. ability 3. able 4. about 5. above 6. absent 7. absorb 8. abstract 9. absurd 10. abuse 11. access 12. accident',
    'my seed is abandon ability able about above absent absorb abstract absurd abuse access accident',
    'My ID 12345',
    'john at gmail .com',
    'john at gmail punto com',
    'john.doe at example period com',
    'j o h n @ g m a i l . c o m',
    'ssn is 123456',
    'ssn: xxx-xx-1234',
    'Bearer: island',
    'Bearer=lake',
    'OTP ABCDEF',
    'CVV ABC',
    'Verification code ABC',
    'PIN ABCD',
    'passport:123456',
    'ID:12345',
    'abandon please abandon abandon abandon abandon abandon abandon abandon abandon abandon abstract',
    'find abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon',
    'lockbox number 4821',
    'lockbox is 4821',
    'ab 12 34 56 c',
    'https://[::1]/',
    'my, ID 12345',
    'ssn 1',
    'cvv BANK',
    'PIN ABCD thanks',
    'OTP ABCDEF now',
    'AB123456C',
    'ssn 123',
    'Jo 12345-6789',
    'Joe 1234 12345 thanks',
    'Mo 0171 12345',
  ])
    assert.equal(mayBePrivate(line), true, line);
  // A phone's three and four digits are not offered as an address.
  assert.equal(onlyNumbersLookPrivate('is 555 0100 thanks'), false);
});

test('places that only looked private are looked up', () => {
  for (const line of [
    'Akiak',
    'Bearer Island',
    'SSN Station',
    'Bearer Island, Canada',
    'bearer island',
    'Washington DC  20500-0003',
    '東京都千代田区100-0001',
    'Security Code Plaza',
    'Idaho Falls',
    'meet at 12:30:45',
    'Llanfairpwllgwyngyllgogerychwyrndrobwllllantysiliogogogoch',
    'llanfairpwllgwyngyll',
    'Boise ID 83702',
    'Boise, ID 83702',
    'Hayden ID 83835-1234',
    'mfa boston',
    'otp bank',
    'security code plaza',
    'zip code 90210',
    'area code 415',
    'Settipalle @ K.Bandarlapalle',
    'boise ID 83702',
    "Coeur d'Alene ID 83814",
    'meet at West Point tomorrow',
    'OTP Bank',
    'GATE CODE LANE',
    // Lists of places, though every word is on the BIP39 list.
    'coffee, bar, hotel, museum, park, beach, hospital, school, market, bridge, tower, airport',
    '1. beach 2. park 3. museum 4. zoo 5. bridge 6. tower 7. market 8. castle 9. island 10. lake 11. river 12. canyon',
    'show only bus, train, car, truck, ship, boat traffic over city bridge today',
    'museum, gallery, library, palace, square, alley, canal, garden, hill, cave, farm, field',
    'find any good cheap fresh food open now near this area today',
    // Questions for the assistant, however many short words they have.
    'can you tell where the most flights are going over texas today',
    'are there any storms near florida right now that might cause delays',
    'OTP Bank',
    // A long request is not a recovery phrase.
    'show flights over texas near austin with altitude above thirty thousand feet please',
    'show fires near austin then show flights above texas with labels please',
  ])
    assert.equal(mayBePrivate(line), false, line);
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

test('codes, phones, tokens, emails and addresses in further shapes stay private', () => {
  for (const line of [
    // A phone's three and four digits after a name, as a postcode can't be
    // told from it ("Shibuya 150-0002" is refused for that).
    'Alice 555-0100',
    'Shibuya 150-0002',
    `${Array(23).fill('abandon').join(' ')} art`,
    'Bearer Abcdefghijklmnopqrstuvwxyz',
    'Bearer Island bearer abcdef',
    'verification code Abc',
    'verification code ABC',
    'verification code abc thanks',
    'PIN aBcD',
    'gate code aBcD',
    'john at gmail.com',
    'john at gmail (dot) com',
    'john at gmail [dot] com',
    'john at gmail dot technology',
    'passport number 123456',
    'passport no. 123456',
    'ID AB123',
    '::1',
    'fe80::1',
    '2001:db8:0:0:0:0:2:1',
  ])
    assert.equal(mayBePrivate(line), true, line);
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

test('a long line is read quickly', () => {
  for (const line of [
    ...['a-', 'a.', '1-', 'a ', '//[a:'].map((unit) => unit.repeat(10000)),
    `otp a${'-'.repeat(20000)}!x`,
    `gate code a${'-'.repeat(20000)}!x`,
    `${','.repeat(20000)}!x`,
    `bearer x${','.repeat(20000)}z`,
  ]) {
    const started = performance.now();
    mayBePrivate(line);
    assert.ok(performance.now() - started < 1000, line.slice(0, 12));
  }
});
