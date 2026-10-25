import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createRadioWikidataSource,
  extractRadioFacts,
  formatFrequency,
  formatPower,
  formatRadioDossier,
  isNearStation,
  isRadioEntity,
  radioNameScore,
  radioNamesMatch,
  radioSearchPhrase,
  radioSearchVariants,
  stationCallSigns,
  websiteHost,
} from './radioWikidata.js';

const item = (id) => ({
  mainsnak: { datavalue: { value: { id } } },
  rank: 'normal',
});
const qty = (amount, unit) => ({
  mainsnak: {
    datavalue: {
      value: {
        amount: `+${amount}`,
        unit: `http://www.wikidata.org/entity/${unit}`,
      },
    },
  },
  rank: 'normal',
});
const str = (value) => ({
  mainsnak: { datavalue: { value } },
  rank: 'normal',
});
const time = (iso) => ({
  mainsnak: {
    datavalue: { value: { time: `+${iso}T00:00:00Z`, precision: 9 } },
  },
  rank: 'normal',
});
const coords = (latitude, longitude) => ({
  mainsnak: { datavalue: { value: { latitude, longitude } } },
  rank: 'normal',
});
const named = (label, aliases = [], claims = {}) => ({
  labels: { en: { value: label } },
  aliases: { en: aliases.map((value) => ({ value })) },
  claims,
});

const KEXP = {
  id: 'Q761627',
  labels: { en: { value: 'KEXP' } },
  claims: {
    P31: [item('Q14350')],
    P415: [item('Q1199093')],
    P2317: [str('KEXP-FM')],
    P2144: [qty(90.3, 'Q732707')],
    P2109: [qty(4.7, 'Q3320608')],
    P1408: [item('Q5083')],
    P17: [item('Q30')],
    P127: [item('Q219563')],
    P571: [time('1972-01-01')],
    P856: [str('https://www.kexp.org/')],
    P154: [str('KEXP logo.svg')],
    P18: [str('KEXP building.jpg')],
    P625: [coords(47.62, -122.35)],
  },
};

test('station names reduce to search phrases, variants and call signs', () => {
  assert.equal(
    radioSearchPhrase('Radio Paradise Main Mix (EU) 320k AAC'),
    'Radio Paradise Main Mix',
  );
  assert.equal(
    radioSearchPhrase('Deutschlandfunk | DLF | MP3 128k'),
    'Deutschlandfunk',
  );
  assert.equal(radioSearchPhrase('KEXP 90.3 FM'), 'KEXP');
  assert.equal(radioSearchPhrase('WALM - Old Time Radio'), 'WALM');
  assert.deepEqual(radioSearchVariants('SomaFM Groove Salad'), [
    'SomaFM Groove Salad',
    'SomaFM Groove',
    'SomaFM',
  ]);
  assert.deepEqual(radioSearchVariants('Radio X 90s'), [
    'Radio X 90s',
    'Radio X',
  ]);
  assert.deepEqual(stationCallSigns('KEXP 90.3 FM'), [
    'KEXP-FM',
    'KEXP',
    'KEXP-AM',
  ]);
  assert.deepEqual(stationCallSigns('WNYC-FM'), ['WNYC-FM', 'WNYC']);
  assert.deepEqual(stationCallSigns('Kexp lowercase'), []);
  assert.deepEqual(stationCallSigns('BBC Radio 1'), []);
});

test('names match on distinctive words, preferring labels over former-name aliases', () => {
  assert.ok(
    radioNamesMatch(named('Radio Paradise'), 'Radio Paradise Main Mix'),
  );
  assert.ok(radioNamesMatch(named('3RRR'), '3RRR Melbourne'));
  assert.ok(!radioNamesMatch(named('Virgin Radio Chilled'), 'Virgin Radio UK'));
  assert.ok(
    !radioNamesMatch(
      named('Absolute Radio', ['Virgin Radio']),
      'Virgin Radio UK',
    ),
  );
  assert.ok(radioNamesMatch(named('WQHT', ['Hot 97']), 'Hot 97'));
  assert.ok(!radioNamesMatch(named('Radio FM'), 'Radio FM'));
  assert.ok(
    radioNameScore(named('Virgin Radio UK'), 'Virgin Radio UK') >
      radioNameScore(named('Virgin Radio'), 'Virgin Radio UK'),
  );
  assert.ok(
    radioNameScore(named('Virgin Radio'), 'Virgin Radio UK') >
      radioNameScore(named('Other', ['Virgin Radio UK']), 'Virgin Radio UK'),
  );
});

test('stations far from the marker are rejected', () => {
  assert.ok(isNearStation(KEXP, { lat: 47.6, lon: -122.3 }));
  assert.ok(!isNearStation(KEXP, { lat: 51.5, lon: -0.1 }));
  assert.ok(isNearStation({ claims: {} }, { lat: 51.5, lon: -0.1 }));
  assert.ok(isRadioEntity(KEXP));
  assert.ok(!isRadioEntity({ claims: { P31: [item('Q5')] } }));
});

test('frequencies, power and websites format for display', () => {
  assert.equal(formatFrequency(90300), '90.3 MHz');
  assert.equal(formatFrequency(100000), '100.0 MHz');
  assert.equal(formatFrequency(1010), '1,010 kHz');
  assert.equal(formatFrequency(0), null);
  assert.equal(formatPower(4.7), '4.7 kW');
  assert.equal(formatPower(0.25), '250 W');
  assert.equal(formatPower(0), null);
  assert.equal(websiteHost('https://www.kexp.org/'), 'kexp.org');
  assert.equal(websiteHost('not a url'), null);
});

test('station facts become dossier lines with a logo preferred', () => {
  const facts = extractRadioFacts(KEXP);
  assert.equal(facts.image, 'KEXP logo.svg');
  assert.ok(facts.imageIsLogo);
  assert.deepEqual(facts.frequencies, [90300]);
  const labels = new Map([
    ['Q14350', 'radio station'],
    ['Q1199093', 'variety'],
    ['Q5083', 'Seattle'],
    ['Q30', 'United States'],
    ['Q219563', 'University of Washington'],
  ]);
  const lines = Object.fromEntries(
    formatRadioDossier(facts, labels).map((l) => [l.label, l.value]),
  );
  assert.deepEqual(lines, {
    Type: 'Radio station',
    Format: 'Variety',
    'Call sign': 'KEXP-FM',
    Frequency: '90.3 MHz',
    Power: '4.7 kW',
    'Licensed to': 'Seattle',
    Country: 'United States',
    Owner: 'University of Washington',
    'On air since': '1972',
    Website: 'kexp.org',
  });
});

function fakeFetch(routes) {
  const calls = [];
  const fetchImpl = async (url) => {
    const params = Object.fromEntries(new URL(url).searchParams);
    calls.push(params);
    const body = routes(params);
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify(body),
      json: async () => body,
    };
  };
  return { fetchImpl, calls };
}

const search = (...ids) => ({
  query: {
    search: ids.map((title) => ({ title })),
    searchinfo: { totalhits: ids.length },
  },
});
const entities = (all, ids) => ({
  entities: Object.fromEntries(
    ids
      .split('|')
      .filter((id) => all[id])
      .map((id) => [id, all[id]]),
  ),
});

test('lookupStation resolves US stations by call sign and caches', async () => {
  const { fetchImpl, calls } = fakeFetch((params) => {
    if (params.list === 'search') {
      assert.equal(
        params.srsearch,
        'haswbstatement:P2317=KEXP-FM|P2317=KEXP|P2317=KEXP-AM',
      );
      return search('Q761627');
    }
    return entities({ Q761627: KEXP }, params.ids);
  });
  const source = createRadioWikidataSource({ fetchImpl, now: () => 0 });
  const station = {
    name: 'KEXP 90.3 FM',
    countryCode: 'us',
    lat: 47.6,
    lon: -122.3,
  };
  const result = await source.lookupStation(station);
  assert.equal(result.id, 'Q761627');
  assert.equal(result.title, 'KEXP');
  assert.ok(result.image.logo);
  assert.match(result.image.url, /KEXP/);
  assert.ok(result.lines.some((l) => l.value === '90.3 MHz'));
  const before = calls.length;
  await source.lookupStation(station);
  assert.equal(calls.length, before, 'second lookup is cached');
  assert.equal(await source.lookupStation({ name: '  ' }), null);
});

test('lookupStation searches by name in the station country and picks the best label', async () => {
  const ABSOLUTE = {
    id: 'Q4590187',
    ...named('Absolute Radio', ['Virgin Radio'], { P31: [item('Q14350')] }),
  };
  const VIRGIN = {
    id: 'Q15221293',
    ...named('Virgin Radio UK', [], { P31: [item('Q14350')] }),
  };
  const queries = [];
  const { fetchImpl } = fakeFetch((params) => {
    if (params.list === 'search') {
      queries.push(params.srsearch);
      if (params.srsearch === 'haswbstatement:P297=GB') return search('Q145');
      return search('Q4590187', 'Q15221293');
    }
    return entities({ Q4590187: ABSOLUTE, Q15221293: VIRGIN }, params.ids);
  });
  const source = createRadioWikidataSource({ fetchImpl });
  const result = await source.lookupStation({
    name: 'Virgin Radio UK',
    countryCode: 'GB',
    lat: 51.5,
    lon: -0.1,
  });
  assert.equal(result.id, 'Q15221293');
  assert.match(queries[1], /^Virgin Radio UK haswbstatement:P31=Q14350\|/);
  assert.match(queries[1], / haswbstatement:P17=Q145$/);
});

test('generic names are not looked up', async () => {
  const { fetchImpl, calls } = fakeFetch(() => search());
  const source = createRadioWikidataSource({ fetchImpl });
  assert.equal(await source.lookupStation({ name: 'Radio FM 128k' }), null);
  assert.equal(calls.length, 0);
});
