import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mergeAirAccidentRecords,
  normalizeAirAccidentSnapshot,
  normalizeCenipaTables,
  normalizeWikidataResults,
  parseSemicolonCsv,
} from './records.js';

const OCCURRENCES = parseSemicolonCsv(
  [
    'codigo_ocorrencia;codigo_ocorrencia1;codigo_ocorrencia2;ocorrencia_classificacao;ocorrencia_latitude;ocorrencia_longitude;ocorrencia_cidade;ocorrencia_uf;ocorrencia_pais;ocorrencia_aerodromo;ocorrencia_dia;ocorrencia_hora;investigacao_status;divulgacao_relatorio_numero;divulgacao_relatorio_publicado',
    '86202;86202;86202;ACIDENTE;-29.37055555555;-50.83222222222;GRAMADO;RS;BRASIL;NCAD;22/12/2024;12:15:00;FINALIZADA;A-001/CENIPA/2025;SIM',
    '88808;88808;88808;INCIDENTE;-23.43555;-46.47305;GUARULHOS;SP;BRASIL;SBGR;19/04/2026;04:00:00;FINALIZADA;***;NÃO',
    '88769;88769;88769;INCIDENTE GRAVE;-12.90861;-38.3225;SALVADOR;BA;BRASIL;SBSV;09/05/2026;19:15:00;ATIVA;***;NÃO',
    '88770;88770;88770;ACIDENTE;-12.90861;-38.3225;SALVADOR;BA;BRASIL;SBSV;10/05/2026;10:00:00;ATIVA;***;NÃO',
    '88771;88771;88771;ACIDENTE;***;***;CUIABÁ;MT;BRASIL;***;11/05/2026;10:00:00;ATIVA;***;NÃO',
  ].join('\r\n'),
);
const AIRCRAFT = parseSemicolonCsv(
  [
    'codigo_ocorrencia2;aeronave_matricula;aeronave_tipo_equipamento;aeronave_fabricante;aeronave_modelo;aeronave_tipo_icao;aeronave_ano_fabricacao;aeronave_fase_operacao;aeronave_tipo_operacao;aeronave_nivel_dano;aeronave_fatalidades_total',
    '86202;PRNDN;AVIÃO;PIPER AIRCRAFT;PA-42-1000;PAY4;1990;DECOLAGEM;PRIVADA;DESTRUÍDA;10',
    '88769;PSGFC;AVIÃO;BOEING COMPANY;737-8EH;B738;2007;POUSO;REGULAR;NENHUM;0',
  ].join('\n'),
);
const TYPES = parseSemicolonCsv(
  [
    'codigo_ocorrencia1;ocorrencia_tipo;taxonomia_tipo_icao',
    '86202;PERDA DE CONTROLE EM VOO;LOC-I',
    '86202;"VOO CONTROLADO CONTRA O TERRENO; CFIT";CFIT',
  ].join('\n'),
);

test('CENIPA keeps accidents and serious incidents with a position, joined', () => {
  const rows = normalizeCenipaTables({
    occurrences: OCCURRENCES,
    aircraft: AIRCRAFT,
    types: TYPES,
  });
  assert.deepEqual(
    rows.map((row) => row.id),
    ['cenipa:86202', 'cenipa:88769', 'cenipa:88770'],
  );
  const [gramado, salvador] = rows;
  assert.equal(gramado.kind, 'accident');
  assert.equal(gramado.date, '2024-12-22');
  assert.equal(gramado.time, '12:15');
  assert.equal(gramado.fatalities, 10);
  assert.equal(gramado.report, 'A-001/CENIPA/2025');
  assert.equal(gramado.investigation, 'finished');
  assert.equal(gramado.aircraft[0].registration, 'PRNDN');
  assert.equal(gramado.aircraft[0].phase, 'DECOLAGEM');
  assert.equal('fatalities' in gramado.aircraft[0], false);
  assert.deepEqual(
    gramado.events.map((event) => event.label),
    ['PERDA DE CONTROLE EM VOO', 'VOO CONTROLADO CONTRA O TERRENO; CFIT'],
  );
  assert.equal(gramado.approximate, false);
  assert.equal(salvador.kind, 'serious-incident');
  assert.equal(salvador.report, null, 'unpublished reports are not shown');
  // Two occurrences at the aerodrome's reference point.
  assert.equal(salvador.approximate, true);
  assert.equal(rows[2].fatalities, null, 'no aircraft row: unknown, not 0');
});

const WIKIDATA = {
  results: {
    bindings: [
      {
        item: { value: 'http://www.wikidata.org/entity/Q130000001' },
        itemLabel: { value: '2024 Gramado Piper PA-42 crash' },
        date: { value: '2024-12-22T00:00:00Z' },
        coord: { value: 'Point(-50.859873888 -29.367363611)' },
        deaths: { value: '10' },
        enwiki: {
          value: 'https://en.wikipedia.org/wiki/2024_Gramado_Piper_PA-42_crash',
        },
      },
      {
        item: { value: 'http://www.wikidata.org/entity/Q163107' },
        itemLabel: { value: 'Überlingen mid-air collision' },
        date: { value: '2002-07-01T00:00:00Z' },
        coord: { value: 'Point(9.173888888 47.778333333)' },
        deaths: { value: '71' },
        injured: { value: '0' },
        enwiki: { value: 'javascript:alert(1)' },
      },
      {
        item: { value: 'http://www.wikidata.org/entity/Q163107' },
        coord: { value: 'Point(9 47)' },
      },
      {
        item: { value: 'http://www.wikidata.org/entity/Q9' },
        coord: { value: 'Point(500 47)' },
      },
    ],
  },
};

test('Wikidata items become one record each, with only safe article links', () => {
  const rows = normalizeWikidataResults(WIKIDATA);
  assert.equal(rows.length, 2);
  const uberlingen = rows[1];
  assert.equal(uberlingen.id, 'wikidata:Q163107');
  assert.equal(uberlingen.lat, 47.778333333);
  assert.equal(uberlingen.fatalities, 71);
  assert.equal(uberlingen.injuries, 0);
  assert.equal(uberlingen.url, 'https://www.wikidata.org/wiki/Q163107');
});

test('a Wikidata item on a CENIPA accident is merged into it', () => {
  const cenipa = normalizeCenipaTables({
    occurrences: OCCURRENCES,
    aircraft: AIRCRAFT,
    types: TYPES,
  });
  const merged = mergeAirAccidentRecords(
    cenipa,
    normalizeWikidataResults(WIKIDATA),
  );
  assert.equal(merged.length, 4);
  const gramado = merged.find((row) => row.id === 'cenipa:86202');
  assert.equal(gramado.name, '2024 Gramado Piper PA-42 crash');
  assert.match(gramado.url, /^https:\/\/en\.wikipedia\.org\//);
  assert.ok(merged.some((row) => row.id === 'wikidata:Q163107'));
});

test('the browser drops malformed rows and rejects a malformed payload', () => {
  assert.equal(normalizeAirAccidentSnapshot({}), null);
  const rows = normalizeAirAccidentSnapshot({
    records: [
      { id: 'a', kind: 'accident', source: 'cenipa', lat: 1, lon: 2 },
      { id: 'a', kind: 'accident', source: 'cenipa', lat: 1, lon: 2 },
      { id: 'b', kind: 'incident', source: 'cenipa', lat: 1, lon: 2 },
      { id: 'c', kind: 'accident', source: 'other', lat: 1, lon: 2 },
      { id: 'd', kind: 'accident', source: 'wikidata', lat: 91, lon: 2 },
    ],
  });
  assert.deepEqual(
    rows.map((row) => row.id),
    ['a'],
  );
  assert.deepEqual(rows[0].aircraft, []);
});
