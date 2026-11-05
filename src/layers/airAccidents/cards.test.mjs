import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cardLink,
  describeAirAccident,
  formatRegistration,
  nameText,
  sourceText,
} from './cards.js';
import { CENIPA_REPORTS_URL } from './records.js';
import { markerPixelSize } from './index.js';

const RECORD = {
  id: 'cenipa:86202',
  source: 'cenipa',
  kind: 'accident',
  lat: -29.37,
  lon: -50.83,
  date: '2024-12-22',
  time: '12:15',
  city: 'GRAMADO',
  state: 'RS',
  aerodrome: 'NCAD',
  approximate: false,
  fatalities: 10,
  injuries: null,
  aircraft: [
    {
      registration: 'PRNDN',
      maker: 'PIPER AIRCRAFT',
      model: 'PA-42-1000',
      icaoType: 'PAY4',
      phase: 'DECOLAGEM',
      operation: 'PRIVADA',
      damage: 'DESTRUÍDA',
      year: 1981,
    },
  ],
  events: [{ label: 'PERDA DE CONTROLE EM VOO', icao: 'LOC-I' }],
  investigation: 'finished',
  report: 'A-001/CENIPA/2025',
  name: null,
  url: null,
};

test('CENIPA capitals read as titles; marks get their prefix hyphen', () => {
  assert.equal(
    sourceText('PERDA DE CONTROLE EM VOO'),
    'Perda de controle em voo',
  );
  assert.equal(sourceText('OPERAÇÕES NO SOLO'), 'Operações no solo');
  assert.equal(sourceText('Already mixed'), 'Already mixed');
  assert.equal(
    sourceText('PROCEDIMENTO DE APROXIMAÇÃO IFR'),
    'Procedimento de aproximação IFR',
  );
  assert.equal(nameText('SÃO JOSÉ DOS CAMPOS'), 'São José dos Campos');
  assert.equal(formatRegistration('PRNDN'), 'PR-NDN');
  assert.equal(formatRegistration('N123AB'), 'N123AB');
});

test('the card carries the technical facts and the report link', () => {
  const { title, details, link } = describeAirAccident(RECORD);
  assert.equal(title, 'Accident · PR-NDN · PA-42-1000');
  const text = details.join('\n');
  // Deaths lead the card; CENIPA's time is UTC.
  assert.equal(details[0], 'Fatalities: 10');
  assert.match(text, /12:15 UTC · Gramado\/RS · NCAD/);
  assert.match(
    text,
    /Aircraft: PR-NDN · Piper Aircraft PA-42-1000 \(PAY4\) · built in 1981/,
  );
  assert.match(text, /Flight phase: Decolagem/);
  assert.match(text, /Damage: Destruída/);
  assert.match(text, /Fatalities: 10/);
  assert.match(text, /final report A-001\/CENIPA\/2025/);
  assert.match(text, /Source: CENIPA \(Brazil\)/);
  assert.equal(link, CENIPA_REPORTS_URL);
});

test('an article wins over the report page; no report, no link', () => {
  assert.equal(
    cardLink({ ...RECORD, url: 'https://en.wikipedia.org/wiki/X' }),
    'https://en.wikipedia.org/wiki/X',
  );
  assert.equal(cardLink({ ...RECORD, report: null }), null);
  const named = describeAirAccident({
    ...RECORD,
    name: 'Voepass Flight 2283',
    approximate: true,
  });
  assert.equal(named.title, 'Accident · Voepass Flight 2283');
  assert.ok(named.details.some((line) => /Approximate position/.test(line)));
});

test('markers grow with the death toll, within bounds', () => {
  assert.equal(markerPixelSize(null), 6);
  assert.equal(markerPixelSize(0), 6);
  assert.ok(markerPixelSize(10) > markerPixelSize(1));
  assert.equal(markerPixelSize(5000), 14);
});

test('a collision lists each aircraft; Wikidata adds flight, route and ASN', () => {
  const { details, link } = describeAirAccident({
    id: 'wikidata:Q163107',
    source: 'wikidata',
    kind: 'accident',
    date: '2002-07-01',
    time: null,
    fatalities: 71,
    survivors: 0,
    aircraft: [{ model: 'Tupolev Tu-154M' }, { model: 'Boeing 757-23APF' }],
    events: [],
    flight: 'BTC 2937',
    origin: 'Moscow Domodedovo Airport',
    destination: 'Barcelona Airport',
    registration: 'RA-85816',
    name: 'Überlingen mid-air collision',
    url: 'https://aviation-safety.net/database/record.php?id=20020701-0',
  });
  const text = details.join('\n');
  assert.match(text, /Aircraft 1: Tupolev Tu-154M/);
  assert.match(text, /Aircraft 2: Boeing 757-23APF/);
  // One registration for two aircraft names neither.
  assert.doesNotMatch(text, /RA-85816/);
  assert.match(
    text,
    /Flight BTC 2937 · Route: Moscow Domodedovo Airport → Barcelona Airport/,
  );
  assert.match(text, /Aviation Safety Network record/);
  assert.equal(link.startsWith('https://aviation-safety.net/'), true);
  const single = describeAirAccident({
    source: 'wikidata',
    kind: 'accident',
    aircraft: [{ model: 'Boeing 737 MAX 8' }],
    registration: 'PK-LQP',
    origin: 'Soekarno–Hatta International Airport',
  }).details.join('\n');
  assert.match(single, /Aircraft: PK-LQP · Boeing 737 MAX 8/);
  assert.match(single, /Route: departed from Soekarno–Hatta/);
});
