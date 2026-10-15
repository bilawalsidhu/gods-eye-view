import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CABA_MAX_ROWS,
  parseCabaTrafficCsv,
  cabaTrafficFeatures,
} from './records.js';

const header = 'tipo_de_fiscalizador;ubicación;latitud;longitud\n';
const line = 'Analítica de video;AV. CÓRDOBA 6287;-34,5827315;-58,448532';
const snapshot = (rows) => ({ rows, fetchedAt: Date.UTC(2026, 9, 14) });

test('decimal commas and accented BOM headers preserve locations', () => {
  const rows = parseCabaTrafficCsv('\ufeff' + header + line + '\r\n');
  assert.deepEqual(rows, [
    {
      type: 'Analítica de video',
      location: 'AV. CÓRDOBA 6287',
      latitude: -34.5827315,
      longitude: -58.448532,
    },
  ]);
  const [feature] = cabaTrafficFeatures(snapshot(rows));
  assert.deepEqual(feature.geometry.coordinates, [-58.448532, -34.5827315]);
  assert.equal(feature.properties.license, 'CC-BY-2.5-AR');
  assert.equal(feature.properties.operational_status, 'Not provided by source');
  assert.equal(feature.properties.imagery, 'Not provided by source');
  assert.equal(
    feature.properties.catalog_retrieved_at,
    '2026-10-14T00:00:00.000Z',
  );
  assert.equal(Object.hasOwn(feature.properties, 'frameUrl'), false);
});

test('quoted comma CSV, escaped quotes and CRLF preserve punctuation', () => {
  const rows = parseCabaTrafficCsv(
    'Tipo_de_fiscalizador,Ubicación,Latitud,Longitud\r\n' +
      '"Cinemómetro","AV. A, cruce ""B""","-34,6","-58,4"\r\n',
  );
  assert.equal(rows[0].location, 'AV. A, cruce "B"');
  assert.deepEqual([rows[0].latitude, rows[0].longitude], [-34.6, -58.4]);
});

test('tab-separated exports and reordered headers remain usable', () => {
  const rows = parseCabaTrafficCsv(
    'LONGITUD\tLATITUD\tUBICACION\tTIPO_DE_FISCALIZADOR\n' +
      '-58.4\t-34.6\tAV. TEST\tCinemómetro\n',
  );
  assert.equal(rows[0].longitude, -58.4);
  assert.equal(rows[0].type, 'Cinemómetro');
});

test('malformed and empty CSVs fail visibly', () => {
  for (const input of [
    '',
    '<html>maintenance</html>',
    header,
    header + 'x;y;;',
    header + 'x;y;0;0',
    header + 'x;y;-58.4;-34.6',
    header + 'x;y;-34.6junk;-58.4',
    header + 'x;y;-34.6;-58.4;extra',
    header + '"unterminated;y;-34.6;-58.4',
    header + '"x"trailing;y;-34.6;-58.4',
    header + 'x;damaged\ufffdname;-34.6;-58.4',
    'tipo_de_fiscalizador;ubicación;latitud;latitud\nx;y;-34.6;-58.4',
  ]) {
    assert.throws(() => parseCabaTrafficCsv(input), undefined, input);
  }
});

test('duplicate rows collapse; colocated types remain distinct', () => {
  const first = parseCabaTrafficCsv(header + line)[0];
  const second = { ...first, type: 'Cinemómetro' };
  const a = cabaTrafficFeatures(snapshot([first, second, first]));
  const b = cabaTrafficFeatures(snapshot([second, first]));
  assert.equal(a.length, 2);
  assert.deepEqual(a.map((x) => x.id).sort(), b.map((x) => x.id).sort());
});

test('oversized inventories reject without truncation', () => {
  assert.throws(() =>
    parseCabaTrafficCsv(
      header +
        Array(CABA_MAX_ROWS + 1)
          .fill(line)
          .join('\n'),
    ),
  );
  assert.throws(() => parseCabaTrafficCsv('x'.repeat(2 * 1024 * 1024 + 1)));
  assert.throws(() => cabaTrafficFeatures({ rows: [], fetchedAt: 1 }));
  assert.throws(() =>
    cabaTrafficFeatures({
      rows: parseCabaTrafficCsv(header + line),
      fetchedAt: null,
    }),
  );
});
