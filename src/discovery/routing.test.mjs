import test from 'node:test';
import assert from 'node:assert/strict';
import { starterPack } from './starterPack.js';
import { searchDiscovery } from './model.js';
import {
  createDiscoveryLookup,
  routingFeatures,
  proposeDiscoveryRoute,
  systemOneEnvelope,
  createSystemOneShadowAdapter,
} from './routing.js';
const ids = (rows) => rows.map((row) => row.card.id);
const lookup = () => createDiscoveryLookup(starterPack);
const trace = (scope) => lookup().lookup(scope).trace;
const options = {
  kind: 'openjev',
  model: 'fixture-1',
  revision: 'sha256:fixture',
};
const response = (choice = 'text-index') => ({
  model: options.model,
  model_revision: options.revision,
  answers: {
    route: {
      type: 'choice',
      choice,
      probabilities: Object.fromEntries(
        ['exact-id', 'local-cache', 'text-index', 'web-nearby', 'abstain'].map(
          (route) => [route, route === choice ? 1 : 0],
        ),
      ),
      confidence: 1,
    },
  },
  usage: { input_tokens: 20, output_tokens: 5 },
});

test('indexed text, body and spatial results preserve reference ordering', () => {
  const engine = lookup();
  for (const scope of [
    { query: 'Colisee' },
    { query: 'Airbus' },
    { body: 'moon' },
    { body: 'mars', query: 'Olympus' },
    { center: { lat: 48.8583, lon: 2.2945 }, radiusKm: 1 },
    { query: 'unknown' },
    { query: 'Eiffel', body: 'moon' },
  ]) {
    assert.deepEqual(
      ids(engine.lookup(scope).rows),
      ids(searchDiscovery(starterPack.cards, scope)),
    );
  }
  assert.throws(() => engine.lookup({ center: { lat: 91, lon: 0 } }));
  assert.throws(() => engine.lookup({ limit: 101 }));
});
test('whole source identifiers are exact, never prefixes of other entities', () => {
  assert.deepEqual(ids(lookup().lookup({ query: 'q243' }).rows), ['Q243']);
  assert.deepEqual(ids(lookup().lookup({ query: 'Q24' }).rows), []);
  assert.deepEqual(
    ids(lookup().lookup({ query: 'Q243', body: 'mars' }).rows),
    [],
  );
});
test('cache is bounded, immutable and invalidated when public sources change', () => {
  const engine = createDiscoveryLookup(starterPack, { maxCacheEntries: 1 });
  assert.equal(engine.lookup({ query: 'Eiffel' }).trace.route, 'text-index');
  assert.equal(engine.lookup({ query: 'Eiffel' }).trace.route, 'local-cache');
  const result = engine.lookup({ query: 'Eiffel' });
  assert.throws(() => (result.rows[0].card.labels.en = 'changed'));
  engine.lookup({ query: 'Colisee' });
  assert.equal(engine.lookup({ query: 'Eiffel' }).trace.route, 'text-index');
  const pack = structuredClone(starterPack);
  pack.cards = pack.cards.filter((card) => card.id !== 'Q243');
  engine.setPack(pack);
  assert.equal(engine.lookup({ query: 'Eiffel' }).rows.length, 0);
  assert.equal(engine.lookup({ query: 'Eiffel' }).trace.catalogVersion, 2);
});
test('observation is opt-in, capped and metadata-only with no vacuous source proof', () => {
  const engine = createDiscoveryLookup(starterPack, { maxObservations: 2 });
  const scope = {
    query: 'PRIVATE-query-123',
    center: { lat: 48.8583, lon: 2.2945 },
    radiusKm: 1,
    caseTitle: 'PRIVATE-case',
    answer: 'PRIVATE-answer',
  };
  engine.lookup(scope);
  assert.equal(engine.getObservations().length, 0);
  for (let i = 0; i < 3; i++) engine.lookup(scope, { observe: true });
  const { exportObservations } = engine;
  const exported = exportObservations();
  assert.equal(exported.observations.length, 2);
  assert.equal(exported.observations[0].verifiedSourceShape, null);
  assert.doesNotMatch(JSON.stringify(exported), /PRIVATE-|48\.8583|2\.2945/);
  const features = routingFeatures({
    ...exported.observations[0],
    private: 'PRIVATE',
  });
  assert.doesNotMatch(JSON.stringify(features), /PRIVATE/);
  assert.equal(features.source_shape_verified, null);
  exported.observations[0].body = 'mars';
  assert.equal(engine.getObservations()[0].body, 'earth');
  engine.clearObservations();
  assert.equal(engine.getObservations().length, 0);
});
test('shadow proposal needs explicit Earth proximity permission, never auto acts', () => {
  const missing = trace({ query: 'missing' });
  assert.equal(
    proposeDiscoveryRoute(routingFeatures(missing)).route,
    'abstain',
  );
  assert.equal(
    proposeDiscoveryRoute(routingFeatures({ ...missing, allowWeb: true }))
      .route,
    'abstain',
  );
  const result = proposeDiscoveryRoute(
    routingFeatures({ ...missing, allowWeb: true, hasProximity: true }),
  );
  assert.equal(result.route, 'web-nearby');
  assert.equal(result.permitsAutoAct, false);
  assert.equal(
    proposeDiscoveryRoute(
      routingFeatures({
        ...missing,
        body: 'moon',
        allowWeb: true,
        hasProximity: true,
      }),
    ).route,
    'abstain',
  );
});
test('System One envelopes use closed typed metadata without raw query or profile', () => {
  const features = {
    ...routingFeatures(trace({ query: 'Eiffel' })),
    query: 'PRIVATE',
    profile: 'PRIVATE',
  };
  for (const kind of ['jev', 'laya', 'openjev']) {
    const envelope = systemOneEnvelope(features, { kind, model: 'fixture-1' });
    assert.equal(envelope.questions.route.type, 'choice');
    assert.equal(Object.keys(envelope.questions.route.criteria).length, 5);
    assert.doesNotMatch(JSON.stringify(envelope), /PRIVATE/);
  }
  assert.throws(() => systemOneEnvelope(features, { model: 'jev-latest' }));
  assert.throws(() =>
    systemOneEnvelope({ ...features, body: 'PRIVATE' }, { model: 'fixture-1' }),
  );
});
test('disabled and nonlocal adapters perform zero transport calls', async () => {
  let calls = 0;
  const transport = () => {
    calls++;
    return response();
  };
  assert.equal(
    (
      await createSystemOneShadowAdapter({ ...options, transport }).observe(
        trace({ query: 'Eiffel' }),
      )
    ).status,
    'disabled',
  );
  assert.equal(
    (
      await createSystemOneShadowAdapter({
        ...options,
        enabled: true,
        transport,
        transportLocality: 'remote',
      }).observe(trace({ query: 'Eiffel' }))
    ).status,
    'locality-refused',
  );
  assert.equal(calls, 0);
  assert.throws(() =>
    createSystemOneShadowAdapter({ ...options, maxCalls: 21 }),
  );
});
test('injected fixture response reports uncalibrated identity and consumes bounded budget', async () => {
  let calls = 0;
  const adapter = createSystemOneShadowAdapter({
    ...options,
    enabled: true,
    transport: async (request) => {
      calls++;
      assert.doesNotMatch(request.state, /Eiffel/);
      return response();
    },
  });
  const result = await adapter.observe(trace({ query: 'Eiffel' }));
  assert.equal(result.status, 'observed');
  assert.equal(result.identityMatchReported, true);
  assert.equal(result.immutableIdentityVerified, false);
  assert.equal(result.confidenceCalibrated, false);
  assert.equal(result.permitsAutoAct, false);
  assert.equal(result.billedCostUSD, null);
  assert.equal(
    (await adapter.observe(trace({ query: 'Eiffel' }))).status,
    'budget-exhausted',
  );
  assert.equal(calls, 1);
});
test('unsupported routes, malformed probabilities and mismatched identity fail closed', async () => {
  const run = (value, input = trace({ query: 'Eiffel' })) =>
    createSystemOneShadowAdapter({
      ...options,
      enabled: true,
      transport: async () => value,
    }).observe(input);
  assert.equal(
    (await run(response('web-nearby'))).status,
    'requirements-refused',
  );
  assert.equal(
    (await run(response('local-cache'))).status,
    'requirements-refused',
  );
  assert.equal(
    (await run(response(), trace({ query: 'unknown' }))).status,
    'requirements-refused',
  );
  const bad = response();
  bad.answers.route.probabilities['text-index'] = NaN;
  assert.equal((await run(bad)).status, 'malformed-or-unavailable');
  const inconsistent = response('abstain');
  inconsistent.answers.route.choice = 'text-index';
  assert.equal((await run(inconsistent)).status, 'malformed-or-unavailable');
  assert.equal(
    (await run({ ...response(), model: 'other' })).status,
    'identity-mismatch',
  );
});
test('timeouts and caller cancellation stop waiting even for ignoring transports', async () => {
  const adapter = createSystemOneShadowAdapter({
    ...options,
    enabled: true,
    timeoutMs: 10,
    transport: () => new Promise(() => {}),
  });
  assert.equal(
    (await adapter.observe(trace({ query: 'Eiffel' }))).status,
    'timeout',
  );
  assert.equal(
    (await adapter.observe(trace({ query: 'Eiffel' }))).status,
    'budget-exhausted',
  );
  const controller = new AbortController();
  const cancelled = createSystemOneShadowAdapter({
    ...options,
    enabled: true,
    transport: () => new Promise(() => {}),
  });
  const promise = cancelled.observe(trace({ query: 'Eiffel' }), {
    signal: controller.signal,
  });
  controller.abort();
  await assert.rejects(promise, /abort/i);
});
