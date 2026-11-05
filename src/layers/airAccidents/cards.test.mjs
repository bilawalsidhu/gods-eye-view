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
  assert.match(text, /Gramado\/RS · NCAD/);
  assert.match(text, /Aircraft: PR-NDN · Piper Aircraft PA-42-1000 \(PAY4\)/);
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
