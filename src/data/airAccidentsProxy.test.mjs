import test from 'node:test';
import assert from 'node:assert/strict';
import { airAccidentsProxy } from '../../server/providers/airAccidents.js';

const OCCURRENCE_CSV =
  'codigo_ocorrencia;codigo_ocorrencia1;codigo_ocorrencia2;ocorrencia_classificacao;ocorrencia_latitude;ocorrencia_longitude;ocorrencia_dia\r\n' +
  '1;1;1;ACIDENTE;-10.5;-50.5;01/02/2025\r\n';
const AIRCRAFT_CSV =
  'codigo_ocorrencia2;aeronave_matricula;aeronave_fatalidades_total\n1;PTABC;2\n';
const TYPES_CSV = 'codigo_ocorrencia1;ocorrencia_tipo\n1;POUSO BRUSCO\n';

function latin1(text) {
  return new Response(Uint8Array.from(text, (c) => c.charCodeAt(0)));
}

function fakeFetch({ wikidataFails = false, cenipaFails = false } = {}) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), options });
    const href = String(url);
    if (href.includes('query.wikidata.org')) {
      if (wikidataFails) return new Response('', { status: 503 });
      return Response.json({ results: { bindings: [] } });
    }
    if (cenipaFails) return new Response('', { status: 503 });
    if (href.endsWith('ocorrencia.csv')) return latin1(OCCURRENCE_CSV);
    if (href.endsWith('aeronave.csv')) return latin1(AIRCRAFT_CSV);
    if (href.endsWith('ocorrencia_tipo.csv')) return latin1(TYPES_CSV);
    return new Response('', { status: 404 });
  };
  return { fetchImpl, calls };
}

function handlerOf(plugin) {
  let handler;
  plugin.configureServer({
    middlewares: { use: (_path, fn) => (handler = fn) },
  });
  return handler;
}

function request(handler, { method = 'GET', url = '/' } = {}) {
  return new Promise((resolve) => {
    const res = {
      destroyed: false,
      writeHead(status, headers) {
        this.status = status;
        this.headers = headers;
      },
      end(body) {
        resolve({
          status: this.status,
          headers: this.headers,
          body: JSON.parse(body),
        });
      },
    };
    handler(
      { method, url, headers: {}, socket: { remoteAddress: '127.0.0.1' } },
      res,
    );
  });
}

test('serves one cached snapshot from fixed upstreams', async () => {
  const { fetchImpl, calls } = fakeFetch();
  const handler = handlerOf(airAccidentsProxy({ fetchImpl }));
  const first = await request(handler);
  assert.equal(first.status, 200);
  assert.equal(first.body.records.length, 1);
  assert.equal(first.body.records[0].aircraft[0].registration, 'PTABC');
  assert.equal(first.body.records[0].fatalities, 2);
  assert.deepEqual(first.body.sources, { cenipa: true, wikidata: true });
  for (const { url } of calls)
    assert.match(
      url,
      /^https:\/\/(dedalo\.sti\.fab\.mil\.br\/dadosabertos\/|query\.wikidata\.org\/sparql\?)/,
    );
  const count = calls.length;
  await request(handler);
  assert.equal(calls.length, count, 'second request is served from cache');
});

test('one failing source still serves the other; both failing is a 502', async () => {
  const partial = handlerOf(
    airAccidentsProxy({
      fetchImpl: fakeFetch({ wikidataFails: true }).fetchImpl,
    }),
  );
  const ok = await request(partial);
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body.sources, { cenipa: true, wikidata: false });

  const down = handlerOf(
    airAccidentsProxy({
      fetchImpl: fakeFetch({ wikidataFails: true, cenipaFails: true })
        .fetchImpl,
    }),
  );
  const failed = await request(down);
  assert.equal(failed.status, 502);
});

test('a failed refresh serves the last snapshot as stale', async () => {
  let clock = 0;
  let fail = false;
  const { fetchImpl: good } = fakeFetch();
  const { fetchImpl: bad } = fakeFetch({
    wikidataFails: true,
    cenipaFails: true,
  });
  const handler = handlerOf(
    airAccidentsProxy({
      fetchImpl: (...args) => (fail ? bad : good)(...args),
      now: () => clock,
    }),
  );
  await request(handler);
  fail = true;
  clock = 25 * 60 * 60 * 1000;
  const stale = await request(handler);
  assert.equal(stale.status, 200);
  assert.equal(stale.body.stale, true);
  assert.equal(stale.headers['X-Data-Stale'], 'true');
});

test('rejects other methods and routes', async () => {
  const handler = handlerOf(
    airAccidentsProxy({ fetchImpl: fakeFetch().fetchImpl }),
  );
  assert.equal((await request(handler, { method: 'POST' })).status, 405);
  assert.equal((await request(handler, { url: '/x' })).status, 404);
});
