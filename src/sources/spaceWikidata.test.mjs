import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createSpaceWikidataSource,
  extractRocketFacts,
  extractSpacecraftFacts,
  formatRocketDossier,
  formatSpacecraftDossier,
  isMatchingMission,
  isRocketEntity,
  isSpacecraftEntity,
  namesMatch,
  rocketSearchPhrase,
  satelliteSearchPhrase,
} from './spaceWikidata.js';
import { formatDate, times } from './wikidataClient.js';

const item = (id, qualifiers) => ({
  mainsnak: { datavalue: { value: { id } } },
  rank: 'normal',
  ...(qualifiers ? { qualifiers } : {}),
});
const qty = (amount, unit) => ({
  mainsnak: {
    datavalue: {
      value: {
        amount: `+${amount}`,
        unit: unit === '1' ? '1' : `http://www.wikidata.org/entity/${unit}`,
      },
    },
  },
  rank: 'normal',
});
const time = (iso, precision = 11) => ({
  mainsnak: {
    datavalue: { value: { time: `+${iso}T00:00:00Z`, precision } },
  },
  rank: 'normal',
});
const str = (value) => ({
  mainsnak: { datavalue: { value } },
  rank: 'normal',
});

const ISS = {
  id: 'Q25271',
  labels: { en: { value: 'International Space Station' } },
  claims: {
    P31: [item('Q25956')],
    P137: [item('Q23548'), item('Q186447')],
    P619: [time('1998-11-20')],
    P375: [item('Q1756428')],
    P247: [str('1998-067A')],
    P377: [str('25544')],
    P2067: [qty(419725, 'Q11570')],
    P2043: [qty(66.4, 'Q11573')],
    P2049: [qty(94.5, 'Q11573')],
    P522: [item('Q663611')],
    P2244: [qty(409, 'Q828224')],
    P2243: [qty(422, 'Q828224')],
    P2045: [qty(51.6401, 'Q28390')],
    P2146: [qty(92.88, 'Q7727')],
    P1418: [qty(146495, '1')],
    P18: [str('ISS 2021.jpg')],
  },
};

const FALCON_9 = {
  id: 'Q249091',
  labels: { en: { value: 'Falcon 9' } },
  claims: {
    P31: [item('Q111722634')],
    P279: [item('Q30128'), item('Q22906832')],
    P176: [item('Q193701')],
    P495: [item('Q30')],
    P2048: [qty(70, 'Q11573')],
    // Wikidata's Falcon 9 diameter is stated in miles: dropped as a slip.
    P2386: [qty(3.7, 'Q253276')],
  },
};
const BLOCK_5 = {
  id: 'Q28450215',
  labels: { en: { value: 'Falcon 9 Block 5' } },
  claims: {
    P31: [item('Q110055303')],
    P279: [item('Q249091')],
    P176: [item('Q193701')],
    P527: [item('Q53214907'), item('Q19923939')],
    P606: [time('2018-05-11')],
    P18: [str('F9 B5.jpg')],
  },
};

const CREW_9 = {
  id: 'Q115651848',
  labels: { en: { value: 'SpaceX Crew-9' } },
  aliases: { en: [{ value: 'Crew-9' }] },
  claims: {
    P31: [item('Q752783')],
    P1029: [item('Q1'), item('Q2')],
    P619: [time('2024-09-28')],
    P247: [str('2024-178A')],
  },
};

test('search phrases strip catalog serials and Launch Library suffixes', () => {
  assert.equal(satelliteSearchPhrase('STARLINK-1007'), 'Starlink');
  assert.equal(satelliteSearchPhrase('NOAA 20 (JPSS-1)'), 'NOAA 20');
  assert.equal(satelliteSearchPhrase('ISS (ZARYA)'), 'ISS');
  assert.equal(satelliteSearchPhrase(''), '');
  assert.equal(
    rocketSearchPhrase('Falcon 9 Block 5 | Starlink Group 10-12'),
    'Falcon 9 Block 5',
  );
  assert.equal(
    rocketSearchPhrase('Soyuz 2.1b/Fregat-M'),
    'Soyuz 2.1b/Fregat-M',
  );
});

test('entity guards separate rockets, spacecraft and mission names', () => {
  assert.ok(isRocketEntity(BLOCK_5));
  assert.ok(isRocketEntity(FALCON_9));
  assert.ok(!isRocketEntity(ISS));
  assert.ok(isSpacecraftEntity(ISS));
  assert.ok(isSpacecraftEntity(CREW_9));
  assert.ok(!isSpacecraftEntity(BLOCK_5), 'a rocket is not a spacecraft');
  assert.ok(!isSpacecraftEntity({ id: 'Q1', claims: { P31: [item('Q5')] } }));
  assert.ok(namesMatch(CREW_9, 'Crew-9'));
  assert.ok(!namesMatch(CREW_9, 'Starlink Group 10-12'));
  assert.ok(isMatchingMission(CREW_9, 'Crew-9', 2024));
  assert.ok(isMatchingMission(CREW_9, 'Crew-9', 2025));
  assert.ok(
    !isMatchingMission(CREW_9, 'Crew-9', 2030),
    'a reused name from an older mission is rejected',
  );
});

test('spacecraft facts format orbit, mass, size and status', () => {
  const facts = extractSpacecraftFacts(ISS);
  const labels = new Map([
    ['Q25956', 'space station'],
    ['Q23548', 'NASA'],
    ['Q186447', 'Roscosmos'],
    ['Q1756428', 'Proton-K'],
    ['Q663611', 'low Earth orbit'],
  ]);
  const lines = Object.fromEntries(
    formatSpacecraftDossier(facts, labels, { nowYear: 2026 }).map((l) => [
      l.label,
      l.value,
    ]),
  );
  assert.equal(lines.Type, 'Space station');
  assert.equal(lines.Operator, 'NASA, Roscosmos');
  assert.equal(lines.Launched, '20 Nov 1998');
  assert.equal(lines.Rocket, 'Proton-K');
  assert.equal(lines.COSPAR, '1998-067A');
  assert.equal(lines.Mass, '420 t (925,335 lb)');
  assert.equal(lines.Size, 'L 66.4 m · W 94.5 m');
  assert.equal(lines['Perigee × apogee'], '409 × 422 km');
  assert.equal(lines.Inclination, '51.64°');
  assert.equal(lines.Period, '92.9 min');
  assert.equal(lines.Orbits, '146,495');
  assert.equal(lines.Status, undefined);

  const decayed = formatSpacecraftDossier(
    extractSpacecraftFacts({
      id: 'Q2',
      claims: { P621: [time('2030-01-01', 8)] },
    }),
    new Map(),
    { nowYear: 2026 },
  );
  assert.deepEqual(decayed, [
    { label: 'Status', value: 'Re-entry expected 2030s' },
  ]);
});

test('rocket facts fill gaps from the family and drop unit slips', () => {
  const facts = extractRocketFacts(BLOCK_5, [FALCON_9]);
  assert.equal(facts.height, 70);
  assert.equal(facts.diameter, null, '3.7 miles is not a rocket diameter');
  assert.deepEqual(facts.ids, ['Q28450215', 'Q249091']);
  const labels = new Map([
    ['Q193701', 'SpaceX'],
    ['Q30', 'United States'],
    ['Q53214907', 'Falcon 9 booster'],
    ['Q19923939', 'Merlin 1D Vacuum'],
  ]);
  const lines = Object.fromEntries(
    formatRocketDossier(facts, labels, 436).map((l) => [l.label, l.value]),
  );
  assert.equal(lines.Type, 'Medium-lift launch vehicle · reusable');
  assert.equal(lines.Maker, 'SpaceX');
  assert.equal(lines.Origin, 'United States');
  assert.equal(lines.Height, '70.0 m (230 ft)');
  assert.equal(lines.Components, 'Falcon 9 booster, Merlin 1D Vacuum');
  assert.equal(lines['First flight'], '11 May 2018');
  assert.equal(lines.Payloads, '436 on Wikidata');
});

test('times and formatDate respect precision', () => {
  const entity = {
    claims: {
      P1: [time('1957-10-04'), time('1950-01-01', 9), time('1960-06-01', 10)],
    },
  };
  assert.deepEqual(times(entity, 'P1').map(formatDate), [
    '1950',
    '4 Oct 1957',
    'Jun 1960',
  ]);
});

function fakeFetch(routes) {
  const calls = [];
  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    const params = Object.fromEntries(parsed.searchParams);
    calls.push(params);
    const body = routes(parsed.host, params);
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

const entitiesBody = (all, ids) => ({
  entities: Object.fromEntries(
    ids
      .split('|')
      .filter((id) => all[id])
      .map((id) => [id, all[id]]),
  ),
});

test('lookupSatellite matches by NORAD id and caches the answer', async () => {
  const { fetchImpl, calls } = fakeFetch((host, params) => {
    if (params.list === 'search') {
      assert.equal(params.srsearch, 'haswbstatement:P377=25544');
      return { query: { search: [{ title: 'Q25271' }] } };
    }
    if (params.action === 'wbgetentities')
      return entitiesBody(
        {
          Q25271: ISS,
          Q663611: { labels: { en: { value: 'low Earth orbit' } } },
        },
        params.ids,
      );
    throw new Error(`unexpected ${host}`);
  });
  const source = createSpaceWikidataSource({ fetchImpl, now: () => 0 });
  const result = await source.lookupSatellite({
    noradId: 25544,
    name: 'ISS (ZARYA)',
  });
  assert.equal(result.id, 'Q25271');
  assert.equal(result.title, 'International Space Station');
  assert.match(result.image.url, /Special:FilePath\/ISS_2021\.jpg/);
  assert.ok(result.lines.some((l) => l.value === 'low Earth orbit'));
  const before = calls.length;
  await source.lookupSatellite({ noradId: '25544' });
  assert.equal(calls.length, before, 'second lookup is cached');
  assert.equal(await source.lookupSatellite({ noradId: 'abc' }), null);
});

test('lookupSatellite falls back to a flagged constellation match by name', async () => {
  const STARLINK = {
    id: 'Q19867977',
    labels: { en: { value: 'Starlink' } },
    claims: { P31: [item('Q54806917')], P176: [item('Q193701')] },
  };
  const { fetchImpl } = fakeFetch((host, params) => {
    if (params.list === 'search') return { query: { search: [] } };
    if (host === 'en.wikipedia.org') {
      assert.equal(params.gsrsearch, 'Starlink satellite');
      return {
        query: {
          pages: [
            {
              title: 'List of Starlink launches',
              index: 1,
              pageprops: { wikibase_item: 'Q9' },
            },
            {
              title: 'Starlink',
              index: 2,
              pageprops: { wikibase_item: 'Q19867977' },
            },
          ],
        },
      };
    }
    return entitiesBody({ Q19867977: STARLINK }, params.ids);
  });
  const source = createSpaceWikidataSource({ fetchImpl });
  const result = await source.lookupSatellite({
    noradId: 44238,
    name: 'STARLINK-1007',
  });
  assert.equal(result.id, 'Q19867977');
  assert.match(
    result.lines[0].value,
    /Constellation \(no item for NORAD 44238\)/,
  );
});

test('lookupLaunch returns rocket and mission sections, rejecting mismatched missions', async () => {
  const all = {
    Q28450215: BLOCK_5,
    Q249091: FALCON_9,
    Q115651848: CREW_9,
    Q193701: { labels: { en: { value: 'SpaceX' } } },
  };
  const searched = [];
  const { fetchImpl } = fakeFetch((host, params) => {
    if (params.list === 'search') {
      assert.equal(
        params.srsearch,
        'haswbstatement:P375=Q28450215|P375=Q249091',
      );
      return { query: { search: [], searchinfo: { totalhits: 436 } } };
    }
    if (host === 'en.wikipedia.org') {
      searched.push(params.gsrsearch);
      const id = /rocket$/.test(params.gsrsearch) ? 'Q28450215' : 'Q115651848';
      return {
        query: {
          pages: [{ title: 'x', index: 1, pageprops: { wikibase_item: id } }],
        },
      };
    }
    return entitiesBody(all, params.ids);
  });
  const source = createSpaceWikidataSource({ fetchImpl });
  const result = await source.lookupLaunch({
    rocket: 'Falcon 9 Block 5',
    missionName: 'Crew-9',
    launchYear: 2024,
  });
  assert.deepEqual(searched, ['Falcon 9 Block 5 rocket', 'Crew-9']);
  assert.equal(result.title, 'SpaceX Crew-9');
  assert.equal(result.id, 'Q28450215, Q115651848');
  assert.deepEqual(
    result.lines.filter((l) => l.section).map((l) => l.section),
    ['Rocket · Falcon 9 Block 5', 'Mission · SpaceX Crew-9'],
  );
  assert.ok(result.lines.some((l) => l.label === 'Payloads'));

  const starlink = await source.lookupLaunch({
    rocket: 'Falcon 9 Block 5',
    missionName: 'Starlink Group 10-12',
    launchYear: 2025,
  });
  assert.equal(starlink.title, 'Falcon 9 Block 5');
  assert.ok(!starlink.lines.some((l) => /Mission/.test(l.section || '')));
});
