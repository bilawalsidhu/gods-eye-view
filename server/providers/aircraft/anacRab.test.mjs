import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import {
  RAB_URL,
  createAnacRab,
  normalizeRegistration,
  parseRabCsv,
  rabTypeName,
} from './anacRab.js';
import { adsbdbProxy } from './enrichment.js';
import { makeFixtureRoot } from '../../../src/tooling/fixtureRoot.mjs';

// The real file's 34 columns, in order (2026-11-04).
const COLUMNS = [
  'MARCAS', 'PROPRIETARIOS', 'OPERADORES', 'NR_CERT_MATRICULA', 'NR_SERIE',
  'CD_TIPO', 'DS_MODELO', 'NM_FABRICANTE', 'CD_CLS', 'NR_PMD', 'CD_TIPO_ICAO',
  'NR_TRIPULACAO_MIN', 'NR_PASSAGEIROS_MAX', 'NR_ASSENTOS',
  'NR_ANO_FABRICACAO', 'DT_VALIDADE_CVA', 'DT_VALIDADE_CA', 'DT_CANC',
  'DS_MOTIVO_CANC', 'CD_INTERDICAO', 'DS_GRAVAME', 'DT_MATRICULA', 'TP_MOTOR',
  'QT_MOTOR', 'TP_POUSO', 'TP_CA', 'CD_PROPOSITO_CAVE', 'NM_PROPOSITO_CAVE',
  'CF_OPERACIONAL', 'DS_CATEGORIA_HOMOLOGACAO', 'TP_OPERACAO', 'DT_VENDA',
  'DS_MOEDA', 'NR_PRECO_VENDA',
];

// Personal and financial values that must never leave the parser.
const SECRETS = [
  'MARIA FIXTURE DA SILVA',
  '***.123.456-**',
  'JOAO FIXTURE OPERADOR',
  'ALIENACAO FIDUCIARIA BANCO FIXTURE',
  '987654.32',
  'SN-FIXTURE-0001',
  '2025-03-14',
];

const quote = (value) => `"${String(value).replace(/"/g, '""')}"`;

function row(values) {
  const people = (name) =>
    JSON.stringify([{ NOME: name, DOCUMENTO: '***.123.456-**', UF: 'GO' }]);
  const base = {
    PROPRIETARIOS: people('MARIA FIXTURE DA SILVA'),
    OPERADORES: people('JOAO FIXTURE OPERADOR'),
    NR_CERT_MATRICULA: '24211',
    NR_SERIE: 'SN-FIXTURE-0001',
    DS_GRAVAME: 'ALIENACAO FIDUCIARIA BANCO FIXTURE',
    DT_VENDA: '2025-03-14',
    DS_MOEDA: 'R$',
    NR_PRECO_VENDA: '987654.32',
    ...values,
  };
  return COLUMNS.map((name) => quote(base[name] ?? '')).join(';');
}

function rabFile(rows, { stamp = 'Atualizado em: 2026-11-04' } = {}) {
  return `﻿${stamp}\r\n${COLUMNS.map(quote).join(';')}\r\n${rows.join('\r\n')}\r\n`;
}

const ROWS = [
  row({
    MARCAS: 'PRABC',
    DS_MODELO: '188B',
    NM_FABRICANTE: 'CESSNA AIRCRAFT',
    CD_TIPO_ICAO: 'C188',
    NR_ASSENTOS: '001',
    NR_ANO_FABRICACAO: '1972',
    CF_OPERACIONAL: 'RBAC 91',
    TP_OPERACAO: 'PRIVADO',
  }),
  row({
    MARCAS: 'PTMBC',
    DS_MODELO: 'EMBRAER EMB-550',
    NM_FABRICANTE: 'EMBRAER',
    CD_TIPO_ICAO: 'E550',
    NR_ASSENTOS: '13',
    NR_ANO_FABRICACAO: '2024',
    CF_OPERACIONAL: 'RBAC 121',
    TP_OPERACAO: 'PRIVADO',
  }),
  row({
    MARCAS: 'PSTAX',
    DS_MODELO: 'C90GTI',
    NM_FABRICANTE: 'TEXTRON AVIATION',
    CD_TIPO_ICAO: 'BE9L',
    NR_ASSENTOS: '8',
    NR_ANO_FABRICACAO: '2020',
    CF_OPERACIONAL: 'RBAC 135',
    TP_OPERACAO: 'PRIVADO',
  }),
  row({
    MARCAS: 'PPGOV',
    DS_MODELO: 'AS350B2',
    NM_FABRICANTE: 'HELIBRAS',
    CD_TIPO_ICAO: 'AS50',
    NR_ASSENTOS: '6',
    NR_ANO_FABRICACAO: '0000',
    CF_OPERACIONAL: 'RBAC 91',
    TP_OPERACAO: 'PUBLICO ESTADUAL',
  }),
  row({
    MARCAS: 'PUXYZ',
    DS_MODELO: 'FLYER GT',
    NM_FABRICANTE: 'FLYER',
    CD_TIPO_ICAO: 'ZZZZ',
    NR_ASSENTOS: '000',
    NR_ANO_FABRICACAO: '1990',
    CF_OPERACIONAL: '',
    TP_OPERACAO: '',
  }),
  // Cancelled: left out entirely.
  row({
    MARCAS: 'PTCAN',
    DS_MODELO: '737-800',
    NM_FABRICANTE: 'BOEING',
    CD_TIPO_ICAO: 'B738',
    DT_CANC: '2019-05-02',
    DS_MOTIVO_CANC: 'EXPORTACAO',
  }),
  // Not a Brazilian mark, and a row cut short: both skipped.
  row({ MARCAS: 'N123AB' }),
  '"PRSHO";"short row"',
];

test('the RAB parser keeps technical fields by registration and nothing personal', () => {
  const parsed = parseRabCsv(rabFile(ROWS), { year: 2026 });
  assert.equal(parsed.updated, '2026-11-04');
  assert.equal(parsed.rows, ROWS.length);
  assert.equal(parsed.skipped, 2);
  assert.deepEqual([...parsed.records.keys()], [
    'PRABC', 'PTMBC', 'PSTAX', 'PPGOV', 'PUXYZ',
  ]);
  assert.deepEqual(parsed.records.get('PRABC'), {
    model: '188B',
    manufacturer: 'CESSNA AIRCRAFT',
    icaoType: 'C188',
    year: 1972,
    seats: 1,
    operation: 'private',
  });
  assert.equal(parsed.records.get('PTMBC').operation, 'airline');
  assert.equal(parsed.records.get('PSTAX').operation, 'air-taxi');
  assert.equal(parsed.records.get('PPGOV').operation, 'government');
  assert.equal(parsed.records.get('PPGOV').year, null, '0000 is no year');
  assert.deepEqual(parsed.records.get('PUXYZ'), {
    model: 'FLYER GT',
    manufacturer: 'FLYER',
    icaoType: null,
    year: 1990,
    seats: null,
    operation: null,
  });
  const kept = JSON.stringify([...parsed.records]);
  for (const secret of SECRETS) assert.ok(!kept.includes(secret), secret);
});

test('anything that is not the RAB file is rejected rather than half-read', () => {
  assert.equal(parseRabCsv('<html><body>Manutenção</body></html>'), null);
  assert.equal(parseRabCsv(''), null);
  assert.equal(parseRabCsv(undefined), null);
  const noHeader = rabFile(ROWS).replace('"NR_ASSENTOS"', '"ASSENTOS"');
  assert.equal(parseRabCsv(noHeader), null);
  const unstamped = parseRabCsv(rabFile(ROWS, { stamp: '' }).replace('﻿\r\n', ''));
  assert.equal(unstamped.updated, null);
  assert.equal(unstamped.records.size, 5);
});

test('registrations normalize to Brazilian marks only', () => {
  assert.equal(normalizeRegistration('PR-ABC'), 'PRABC');
  assert.equal(normalizeRegistration(' pt-mbc '), 'PTMBC');
  assert.equal(normalizeRegistration('PU-XYZ'), 'PUXYZ');
  assert.equal(normalizeRegistration('N123AB'), null);
  assert.equal(normalizeRegistration('PR-ABCD'), null);
  assert.equal(normalizeRegistration('PA-ABC'), null);
  assert.equal(normalizeRegistration(null), null);
});

test('the RAB type name joins maker and model without repeating the maker', () => {
  assert.equal(
    rabTypeName({ manufacturer: 'CESSNA AIRCRAFT', model: '188B' }),
    'CESSNA AIRCRAFT 188B',
  );
  assert.equal(
    rabTypeName({ manufacturer: 'EMBRAER', model: 'EMBRAER EMB-550' }),
    'EMBRAER EMB-550',
  );
  assert.equal(rabTypeName({ manufacturer: null, model: 'FLYER GT' }), 'FLYER GT');
  assert.equal(rabTypeName(null), null);
});

function rabServer({ body = rabFile(ROWS), status = 200 } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, headers: { ...init.headers } });
    if (typeof status === 'function') return status(calls.length);
    return new Response(body, {
      status,
      headers: { etag: '"fixture-etag"', 'last-modified': 'Wed, 04 Nov 2026 05:29:47 GMT' },
    });
  };
  return { calls, fetchImpl };
}

test('the RAB index downloads once, is shared, and survives a restart from disk', async (t) => {
  const dir = await makeFixtureRoot('gev-anac-rab-');
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const cachePath = path.join(dir, 'anac-rab.json');
  let now = Date.UTC(2026, 10, 4, 12);
  const server = rabServer();
  const log = { warn() {} };
  const rab = createAnacRab({ fetchImpl: server.fetchImpl, now: () => now, cachePath, log });
  assert.equal(rab.lookup('PR-ABC'), null, 'nothing before the first refresh');
  await Promise.all([rab.ensureFresh(), rab.ensureFresh(), rab.ensureFresh()]);
  assert.equal(server.calls.length, 1);
  assert.equal(server.calls[0].url, RAB_URL);
  assert.equal(rab.lookup('PR-ABC').year, 1972);
  assert.equal(rab.lookup('PT-CAN'), null, 'cancelled marks are absent');
  assert.deepEqual(rab.status(), {
    loaded: true,
    updated: '2026-11-04',
    fetchedAt: now,
    aircraft: 5,
  });

  const cached = await fsp.readFile(cachePath, 'utf8');
  for (const secret of SECRETS) assert.ok(!cached.includes(secret), secret);

  const restarted = createAnacRab({ fetchImpl: server.fetchImpl, now: () => now, cachePath, log });
  await restarted.ensureFresh();
  assert.equal(server.calls.length, 1, 'a fresh disk cache needs no download');
  assert.equal(restarted.lookup('PS-TAX').operation, 'air-taxi');

  now += 25 * 3600_000;
  const stale = rabServer({ status: () => new Response(null, { status: 304 }) });
  const revalidating = createAnacRab({ fetchImpl: stale.fetchImpl, now: () => now, cachePath, log });
  await revalidating.ensureFresh();
  assert.equal(stale.calls[0].headers['If-None-Match'], '"fixture-etag"');
  assert.equal(stale.calls[0].headers['If-Modified-Since'], 'Wed, 04 Nov 2026 05:29:47 GMT');
  assert.equal(revalidating.lookup('PR-ABC').seats, 1, '304 keeps the index');
  await revalidating.ensureFresh();
  assert.equal(stale.calls.length, 1, 'the 304 renewed the day');
});

test('concurrent RAB lookups wait for a fresh disk cache on restart', async (t) => {
  const dir = await makeFixtureRoot('gev-anac-rab-');
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const cachePath = path.join(dir, 'anac-rab.json');
  const now = Date.UTC(2026, 10, 4, 12);
  const server = rabServer();
  const config = {
    fetchImpl: server.fetchImpl,
    now: () => now,
    cachePath,
    log: { warn() {} },
  };
  await createAnacRab(config).ensureFresh();
  assert.equal(server.calls.length, 1);

  const restarted = createAnacRab(config);
  await Promise.all([
    restarted.ensureFresh(),
    restarted.ensureFresh(),
    restarted.ensureFresh(),
  ]);
  assert.equal(server.calls.length, 1, 'parallel readers must not redownload a fresh index');
  assert.equal(restarted.lookup('PR-ABC').year, 1972);
});

test('a failed or foreign download keeps the old index and backs off', async (t) => {
  const dir = await makeFixtureRoot('gev-anac-rab-');
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const cachePath = path.join(dir, 'anac-rab.json');
  let now = Date.UTC(2026, 10, 4, 12);
  const warnings = [];
  const log = { warn: (line) => warnings.push(line) };

  const foreign = rabServer({ body: '<html>portal em manutenção</html>' });
  const empty = createAnacRab({ fetchImpl: foreign.fetchImpl, now: () => now, cachePath, log });
  await empty.ensureFresh();
  assert.equal(empty.status().loaded, false);
  assert.match(warnings.at(-1), /not the RAB aircraft file/);
  await empty.ensureFresh();
  assert.equal(foreign.calls.length, 1, 'no retry inside the back-off');

  const good = rabServer();
  const loaded = createAnacRab({ fetchImpl: good.fetchImpl, now: () => now, cachePath, log });
  await loaded.ensureFresh();
  now += 25 * 3600_000;
  const down = rabServer({ status: 503 });
  const outage = createAnacRab({ fetchImpl: down.fetchImpl, now: () => now, cachePath, log });
  await outage.ensureFresh();
  assert.match(warnings.at(-1), /HTTP 503/);
  assert.equal(outage.lookup('PT-MBC').operation, 'airline', 'old index still served');
  now += 10 * 60_000;
  await outage.ensureFresh();
  assert.equal(down.calls.length, 1);
  now += 30 * 60_000;
  await outage.ensureFresh();
  assert.equal(down.calls.length, 2, 'retried after the back-off');
});

function install(plugin) {
  let handler;
  plugin.configureServer({
    middlewares: {
      use(route, fn) {
        assert.equal(route, '/api/adsbdb');
        handler = fn;
      },
    },
  });
  return (url) =>
    new Promise((resolve) => {
      const res = {
        writeHead(status) {
          this.status = status;
        },
        end(body) {
          resolve({ status: this.status, body: JSON.parse(body) });
        },
      };
      handler({ url }, res);
    });
}

test('adsbdb type lookups gain RAB details for Brazilian registrations only', async (t) => {
  const dir = await makeFixtureRoot('gev-anac-adsbdb-');
  const cwd = process.cwd();
  process.chdir(dir);
  const env = process.env.ANAC_RAB_ENABLED;
  t.after(async () => {
    process.chdir(cwd);
    if (env === undefined) delete process.env.ANAC_RAB_ENABLED;
    else process.env.ANAC_RAB_ENABLED = env;
    await fsp.rm(dir, { recursive: true, force: true });
  });
  delete process.env.ANAC_RAB_ENABLED;
  const registrations = { e48abc: 'PR-ABC', a1b2c3: 'N123AB', e4f00d: 'PP-GOV', e4beef: 'PT-MBC' };
  t.mock.method(globalThis, 'fetch', async (url) => {
    const hex = String(url).split('/').pop();
    assert.match(String(url), /^https:\/\/api\.adsbdb\.com\/v0\/aircraft\//);
    if (!(hex in registrations)) return new Response('', { status: 404 });
    return Response.json({
      response: {
        aircraft: {
          icao_type: hex === 'e4beef' ? 'E550' : null,
          manufacturer: hex === 'e4beef' ? 'Embraer' : null,
          type: hex === 'e4beef' ? 'Praetor 500' : null,
          registration: registrations[hex],
        },
      },
    });
  });
  const server = rabServer();
  const request = install(
    adsbdbProxy({
      createRegistry: () =>
        createAnacRab({
          fetchImpl: server.fetchImpl,
          cachePath: path.join(dir, 'anac-rab.json'),
          log: { warn() {} },
        }),
    }),
  );

  const foreign = await request('/type/a1b2c3');
  assert.deepEqual(foreign.body, {
    found: true,
    typeCode: null,
    typeName: null,
    registration: 'N123AB',
  });
  assert.equal(server.calls.length, 0, 'no download until a Brazilian mark appears');

  const brazilian = await request('/type/e48abc');
  assert.deepEqual(brazilian.body, {
    found: true,
    typeCode: 'C188',
    typeName: 'CESSNA AIRCRAFT 188B',
    registration: 'PR-ABC',
    rab: { year: 1972, seats: 1, operation: 'private' },
  });
  const known = await request('/type/e4beef');
  assert.equal(known.body.typeName, 'Embraer Praetor 500', "adsbdb's own type wins");
  assert.equal(known.body.typeCode, 'E550');
  assert.deepEqual(known.body.rab, { year: 2024, seats: 13, operation: 'airline' });
  assert.equal(server.calls.length, 1);

  // adsbdb does not know e4cafe; its callsign is a Brazilian mark.
  const byTail = await request('/type/e4cafe?tail=PSTAX');
  assert.deepEqual(byTail.body, {
    found: true,
    typeCode: 'BE9L',
    typeName: 'TEXTRON AVIATION C90GTI',
    registration: 'PS-TAX',
    rab: { year: 2020, seats: 8, operation: 'air-taxi' },
  });
  assert.deepEqual((await request('/type/e4cafe')).body, { found: false });
  assert.deepEqual(
    (await request('/type/a1cafe?tail=PSTAX')).body,
    { found: false },
    'a foreign transponder borrows no Brazilian record',
  );
  assert.deepEqual((await request('/type/e4cafe?tail=PTZZZ')).body, {
    found: false,
  });
  const tailIgnored = await request('/type/e48abc?tail=PSTAX');
  assert.equal(tailIgnored.body.registration, 'PR-ABC', "adsbdb's mark wins");
  assert.equal(tailIgnored.body.rab.operation, 'private');
  assert.equal(server.calls.length, 1);

  process.env.ANAC_RAB_ENABLED = '0';
  const optedOut = await request('/type/e4f00d');
  assert.equal(optedOut.body.registration, 'PP-GOV');
  assert.equal(optedOut.body.rab, undefined);
});
