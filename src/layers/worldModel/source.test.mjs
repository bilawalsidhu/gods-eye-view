import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  ProjectionSourceError,
  assertProjectionSource,
  createHttpProjectionSource,
  refString,
  sourceFeatures,
  validateProjection,
  validateRevisions,
} from './source.js';
import { DEFAULT_VIEW } from './view.js';

const fixture = JSON.parse(
  readFileSync(
    new URL('./fixtures/experiment-002.projection.json', import.meta.url),
    'utf8',
  ),
);
const revisions = JSON.parse(
  readFileSync(
    new URL('./fixtures/experiment-002.revisions.json', import.meta.url),
    'utf8',
  ),
);

/** Route table -> fetchImpl that records every call. */
function fakeFetch(routes) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    const route = routes[String(url)];
    if (!route)
      return Response.json(
        { error: 'not-found', message: `no route ${url}` },
        { status: 404 },
      );
    if (typeof route === 'function') return route(options);
    return Response.json(route.body, { status: route.status ?? 200 });
  };
  return { calls, fetchImpl };
}

test('reads the chain and projects one demand by revision id', async () => {
  const projection = { ...fixture, revision_id: 'rev-1' };
  const { calls, fetchImpl } = fakeFetch({
    '/x/revisions?head=world%2Fmain&limit=20': {
      body: {
        head: 'world/main',
        revisions: [
          { id: 'rev-1', parent_id: null, created_at: 't', bindings: [] },
        ],
      },
    },
    '/x/project': { body: projection },
  });
  const source = createHttpProjectionSource({
    baseUrl: '/x/',
    fetchImpl,
    headers: async () => ({ authorization: 'Bearer t0k', 'x-caller': 'qa' }),
  });
  const chain = await source.getRevisions();
  assert.equal(chain.head, 'world/main');
  assert.equal(chain.revisions[0].id, 'rev-1');
  const result = await source.getProjection({
    revisionId: 'rev-1',
    query: DEFAULT_VIEW.query,
    projectionSpec: DEFAULT_VIEW.projection_spec,
  });
  assert.deepEqual(result, projection);
  assert.equal(calls[0].url, '/x/revisions?head=world%2Fmain&limit=20');
  assert.equal(calls[0].options.headers.authorization, 'Bearer t0k');
  assert.equal(calls[1].url, '/x/project');
  assert.equal(calls[1].options.method, 'POST');
  assert.equal(calls[1].options.headers['content-type'], 'application/json');
  assert.equal(calls[1].options.headers['x-caller'], 'qa');
  const body = JSON.parse(calls[1].options.body);
  assert.equal(body.revision_id, 'rev-1');
  assert.equal('head' in body, false);
  assert.deepEqual(body.query, DEFAULT_VIEW.query);
  assert.deepEqual(body.projection_spec, DEFAULT_VIEW.projection_spec);
  assert.deepEqual(source.describe(), {
    transport: 'http',
    baseUrl: '/x',
    head: 'world/main',
  });
  assert.deepEqual(sourceFeatures(source), {
    heads: true,
    provenance: true,
    revision: true,
    select: true,
    status: true,
  });
});

test('optional reads: heads, provenance by ref, status', async () => {
  const report = {
    ref: { type_id: 't.v1', content_id: 'sha256:aa' },
    descriptors: [],
    sources: [],
  };
  const { calls, fetchImpl } = fakeFetch({
    '/w/heads': { body: { 'world/main': 'rev-1' } },
    '/w/provenance/t.v1%40sha256%3Aaa?follow=source&depth=8': { body: report },
    '/w/provenance/t.v1%40sha256%3Aaa?follow=none&depth=2': { body: report },
    '/w/status?head=world%2Fmain': {
      body: { head: { name: 'world/main' }, bindings: [] },
    },
  });
  const source = createHttpProjectionSource({ baseUrl: '/w', fetchImpl });
  assert.deepEqual(await source.getHeads(), { 'world/main': 'rev-1' });
  assert.deepEqual(
    await source.getProvenance({
      ref: { type_id: 't.v1', content_id: 'sha256:aa' },
    }),
    report,
  );
  assert.deepEqual(
    await source.getProvenance({
      ref: 't.v1@sha256:aa',
      follow: 'none',
      depth: 2,
    }),
    report,
  );
  assert.equal((await source.getStatus()).head.name, 'world/main');
  assert.equal(calls.length, 4);
  assert.equal(
    refString({ type_id: 't.v1', content_id: 'sha256:aa' }),
    't.v1@sha256:aa',
  );
  assert.equal(refString({ type_id: 't.v1' }), '');
  assert.equal(refString(null), '');
  await assert.rejects(source.getProvenance({ ref: {} }), /product ref/);
});

test('typed errors: head missing, unauthorized, unreachable, http, malformed', async () => {
  const code = (promise) =>
    promise.then(
      () => assert.fail('expected rejection'),
      (error) => {
        assert.ok(error instanceof ProjectionSourceError, String(error));
        return error.code;
      },
    );
  const source = (routes) =>
    createHttpProjectionSource({
      baseUrl: '/w',
      fetchImpl: fakeFetch(routes).fetchImpl,
    });
  const chain = '/w/revisions?head=world%2Fmain&limit=20';
  assert.equal(
    await code(
      source({
        [chain]: { body: { head: 'world/main', revisions: [] } },
      }).getRevisions(),
    ),
    'head-missing',
  );
  assert.equal(
    await code(
      source({
        [chain]: {
          body: { error: 'not-found', message: 'head world/main not set' },
          status: 404,
        },
      }).getRevisions(),
    ),
    'head-missing',
  );
  assert.equal(
    await code(
      source({ [chain]: { body: { a: 1 }, status: 401 } }).getRevisions(),
    ),
    'unauthorized',
  );
  assert.equal(
    await code(
      source({
        [chain]: { body: { error: 'down' }, status: 502 },
      }).getRevisions(),
    ),
    'unreachable',
  );
  assert.equal(
    await code(
      source({
        [chain]: { body: { revisions: [{ nope: 1 }] } },
      }).getRevisions(),
    ),
    'malformed',
  );
  assert.equal(
    await code(source({}).getProjection({ revisionId: 'rev-1' })),
    'http',
  );
  assert.equal(
    await code(
      source({
        '/w/project': { body: { ...fixture, revision_id: 'other' } },
      }).getProjection({ revisionId: 'rev-1' }),
    ),
    'malformed',
  );
  assert.equal(
    await code(
      source({
        '/w/project': { body: { revision_id: 'rev-1', points: [] } },
      }).getProjection({ revisionId: 'rev-1' }),
    ),
    'malformed',
  );
  const network = createHttpProjectionSource({
    baseUrl: '/w',
    fetchImpl: async () => {
      throw new TypeError('fetch failed');
    },
  });
  assert.equal(await code(network.getRevisions()), 'unreachable');
  const message = await source({ [chain]: { body: { revisions: [] } } })
    .getRevisions()
    .catch((error) => error.message);
  assert.match(message, /world\/main is not set; run `worldmodel noaa replay`/);
  await assert.rejects(source({}).getProjection({}), /revisionId or a head/);
});

test('abort wins even when the transport keeps going', async () => {
  const abort = new AbortController();
  const source = createHttpProjectionSource({
    baseUrl: '/w',
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => {
        abort.abort();
        return { head: 'world/main', revisions: [{ id: 'rev-1' }] };
      },
    }),
  });
  await assert.rejects(source.getRevisions({ signal: abort.signal }), {
    name: 'AbortError',
  });
});

test('any object with the two required methods is a ProjectionSource; the rest is optional', () => {
  const memory = {
    async getRevisions() {
      return { head: 'world/main', revisions: [{ id: 'fixture' }] };
    },
    async getProjection({ revisionId }) {
      return { ...fixture, revision_id: revisionId };
    },
  };
  assert.equal(assertProjectionSource(memory), memory);
  assert.deepEqual(sourceFeatures(memory), {
    heads: false,
    provenance: false,
    revision: false,
    select: false,
    status: false,
  });
  assert.throws(
    () => assertProjectionSource({ getRevisions() {} }),
    /ProjectionSource/,
  );
  assert.throws(
    () => assertProjectionSource({ getHeadRevision() {}, getProjection() {} }),
    /getRevisions/,
  );
  assert.throws(() => createHttpProjectionSource({}), /baseUrl/);
  assert.equal(validateProjection(fixture), fixture);
  assert.throws(() => validateProjection({ revision_id: 'x' }), /points array/);
  assert.equal(
    validateRevisions(revisions, 'world/main').revisions.length,
    revisions.revisions.length,
  );
  assert.throws(() => validateRevisions({}, 'h'), /revisions array/);
});

test("one revision by id: its bindings and the descriptors that carry its products' headers (GEN-299)", async () => {
  const revision = {
    id: 'rev-9',
    parent_id: 'rev-8',
    created_at: '2026-10-12T00:00:00+00:00',
    metadata: {},
    bindings: [],
    descriptors: {
      'simulation.rf.communications': {
        semantic: {
          metadata: { model: { calibration_status: 'illustrative' } },
        },
      },
    },
  };
  const calls = [];
  const answer = (body) => async (url) => {
    calls.push(url);
    return {
      ok: true,
      status: 200,
      json: async () => body,
      text: async () => JSON.stringify(body),
    };
  };
  const source = createHttpProjectionSource({
    baseUrl: '/x',
    fetchImpl: answer(revision),
  });
  assert.deepEqual(await source.getRevision({ revisionId: 'rev-9' }), revision);
  assert.equal(calls[0], '/x/revisions/rev-9');
  const liar = createHttpProjectionSource({
    baseUrl: '/x',
    fetchImpl: answer({ ...revision, id: 'rev-1' }),
  });
  await assert.rejects(
    liar.getRevision({ revisionId: 'rev-9' }),
    (e) => e.code === 'malformed',
  );
  await assert.rejects(source.getRevision({}), TypeError);
});
