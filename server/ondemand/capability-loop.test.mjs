import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCatalogue,
  validateDecision,
  extractJson,
  runCapabilityLoop,
  truncateToolResult,
  loadRegistry,
  ACTION_ALLOW_LIST,
} from './capability-loop.js';
import { jsonResponse } from './test-helpers.mjs';

const REGISTRY = {
  capabilities: [
    {
      id: 'earthquake.search',
      provider: 'USGS',
      route: '/api/sources/earthquakes',
      adapter: 'server/sources/usgs-earthquakes.js',
      status: 'registered-unverified',
      params: [
        'starttime',
        'minmagnitude',
        'latitude',
        'longitude',
        'maxradiuskm',
        'limit',
      ],
      description: 'earthquakes',
    },
    {
      id: 'fires.search',
      provider: 'NASA FIRMS',
      route: '/api/sources/fires',
      adapter: 'server/sources/nasa-firms.js',
      status: 'registered-unverified',
      params: ['bbox', 'days'],
      required_params: ['bbox'],
    },
    {
      id: 'maritime.live',
      provider: 'AISStream',
      route: '/api/ais-live',
      adapter: null,
      status: 'PENDING',
    },
    {
      id: 'traffic.flow',
      provider: 'TomTom',
      route: null,
      status: 'rendering-only',
      adapter: 'x',
    },
  ],
};

describe('server/ondemand/capability-loop.js — buildCatalogue', () => {
  test('keeps only rows with an adapter and an executable status; reduces fields', () => {
    const cat = buildCatalogue(REGISTRY);
    assert.deepEqual(
      cat.map((c) => c.id),
      ['earthquake.search', 'fires.search'],
    );
    assert.deepEqual(Object.keys(cat[0]), [
      'id',
      'provider',
      'route',
      'description',
      'params',
      'required_params',
      'coverage',
    ]);
    assert.deepEqual(cat[1].required_params, ['bbox']);
    assert.deepEqual(buildCatalogue({}), []);
  });

  test('loadRegistry reads the real src/registry/capabilities.json and its rows build a non-empty catalogue', async () => {
    const reg = await loadRegistry();
    const cat = buildCatalogue(reg);
    assert.ok(cat.some((c) => c.id === 'earthquake.search'));
    for (const c of cat)
      assert.ok(
        Array.isArray(c.params) && c.params.length > 0,
        `${c.id} has params`,
      );
  });
});

describe('server/ondemand/capability-loop.js — validateDecision (strict)', () => {
  const cat = buildCatalogue(REGISTRY);

  test('accepts a valid decision and stringifies scalar params', () => {
    const v = validateDecision(
      {
        decisions: [
          {
            capabilityId: 'earthquake.search',
            params: { minmagnitude: 4, limit: '20' },
            reason: 'seismic context',
          },
        ],
      },
      cat,
    );
    assert.equal(v.ok, true);
    assert.deepEqual(v.decisions, [
      {
        capabilityId: 'earthquake.search',
        params: { minmagnitude: '4', limit: '20' },
        reason: 'seismic context',
      },
    ]);
    assert.deepEqual(validateDecision({ decisions: [] }, cat), {
      ok: true,
      decisions: [],
      errors: [],
    });
  });

  test('rejects hallucinated capabilityIds, unknown params, missing required params, duplicates, extra keys, non-objects, too many', () => {
    assert.match(
      validateDecision(
        { decisions: [{ capabilityId: 'weather.now', params: {} }] },
        cat,
      ).errors[0],
      /not in the catalogue/,
    );
    assert.match(
      validateDecision(
        {
          decisions: [
            { capabilityId: 'earthquake.search', params: { magnitude: 5 } },
          ],
        },
        cat,
      ).errors[0],
      /not a parameter/,
    );
    assert.match(
      validateDecision(
        { decisions: [{ capabilityId: 'fires.search', params: { days: 1 } }] },
        cat,
      ).errors[0],
      /missing required param "bbox"/,
    );
    assert.match(
      validateDecision(
        {
          decisions: [
            { capabilityId: 'earthquake.search' },
            { capabilityId: 'earthquake.search' },
          ],
        },
        cat,
      ).errors[0],
      /repeats/,
    );
    assert.match(
      validateDecision({ decisions: [], plan: 1 }, cat).errors[0],
      /unexpected top-level keys/,
    );
    assert.equal(validateDecision(null, cat).ok, false);
    assert.equal(validateDecision({ decisions: 'x' }, cat).ok, false);
    assert.match(
      validateDecision(
        {
          decisions: [
            { capabilityId: 'earthquake.search', params: { limit: [1] } },
          ],
        },
        cat,
      ).errors[0],
      /scalar/,
    );
    const many = {
      decisions: Array.from({ length: 5 }, (_, i) => ({
        capabilityId: i % 2 ? 'fires.search' : 'earthquake.search',
        params: { bbox: '1,2,3,4' },
      })),
    };
    assert.match(
      validateDecision(many, cat, { maxDecisions: 4 }).errors[0],
      /more than 4/,
    );
    // any error → nothing is executed
    assert.deepEqual(
      validateDecision(
        {
          decisions: [
            { capabilityId: 'earthquake.search' },
            { capabilityId: 'nope' },
          ],
        },
        cat,
      ).decisions,
      [],
    );
  });

  test('extractJson tolerates fences and leading prose', () => {
    assert.deepEqual(extractJson('```json\n{"decisions":[]}\n```'), {
      decisions: [],
    });
    assert.deepEqual(extractJson('Sure: {"a":1} done'), { a: 1 });
    assert.equal(extractJson('no json here'), null);
    assert.equal(extractJson(42), null);
  });
});

describe('server/ondemand/capability-loop.js — runCapabilityLoop', () => {
  const structured = () => ({
    message:
      'One M4.1 event 120 km east of the viewport centre in the last 24 h.',
    entities: [
      {
        id: 'us7000abcd',
        layerId: 'earthquakes',
        label: 'M4.1',
        role: 'finding',
        latitude: 25.1,
        longitude: 56.2,
      },
    ],
    actions: [
      {
        name: 'fly_to_location',
        params: { latitude: 25.1, longitude: 56.2, rangeM: 200000 },
        reason: 'frame',
        findingIds: ['f1'],
      },
    ],
    evidence: [
      {
        findingId: 'f1',
        entityId: 'us7000abcd',
        field: 'magnitude',
        value: 4.1,
        sourceLayer: 'earthquakes',
      },
    ],
    sources: [
      {
        id: 'earthquake.search',
        kind: 'capability',
        label: 'USGS',
        status: 'used',
      },
    ],
    suggestedNextActions: [],
    runMeta: {
      mode: 'capability-loop',
      executed: ['earthquake.search'],
      generatedAtUtc: '2026-09-18T08:00:00.000Z',
    },
  });

  function makeOndemand({ decisionAnswer, finalAnswer }) {
    const calls = [];
    return {
      calls,
      ondemand: {
        chatBase: 'https://api.on-demand.io/chat/v1',
        fetch: async (url, init = {}) => {
          calls.push({ url, body: init.body });
          if (/\/sessions$/.test(url))
            return jsonResponse(201, { data: { id: 'sess-1' } });
          if (/\/query$/.test(url)) {
            const n = calls.filter((c) => /\/query$/.test(c.url)).length;
            const answer = n === 1 ? decisionAnswer : finalAnswer;
            return jsonResponse(200, {
              data: { answer, messageId: `m${n}`, sessionId: 'sess-1' },
            });
          }
          throw new Error(`unexpected ${url}`);
        },
      },
    };
  }

  test('happy path: creates a session, gets a decision, executes ONLY the decided adapters in the same session, validates the 7-key answer', async () => {
    const executed = [];
    const adapters = {
      'earthquake.search': async (params, ctx) => {
        executed.push(['earthquake.search', params, typeof ctx.now]);
        return {
          ok: true,
          status: 200,
          data: { count: 1, events: [{ id: 'us7000abcd' }] },
          provenance: { provider: 'USGS' },
        };
      },
      'fires.search': async () => {
        executed.push(['fires.search']);
        return {
          ok: true,
          status: 200,
          data: { count: 0, items: [] },
          provenance: { provider: 'FIRMS' },
        };
      },
    };
    const { ondemand, calls } = makeOndemand({
      decisionAnswer:
        '```json\n{"decisions":[{"capabilityId":"earthquake.search","params":{"minmagnitude":4,"limit":20},"reason":"seismic"}]}\n```',
      finalAnswer: JSON.stringify(structured()),
    });
    const logs = [];
    const r = await runCapabilityLoop({
      query: 'Anything unusual near the airport?',
      spatialContext: { bbox: { west: 51, south: 24, east: 57, north: 27 } },
      userId: 'u1',
      registry: REGISTRY,
      adapters,
      ondemand,
      endpointId: 'predefined-claude-sonnet-5',
      reasoningMode: 'low',
      tier: 'INVESTIGATE',
      now: () => new Date('2026-09-18T08:00:00.000Z'),
      log: (l) => logs.push(l),
    });
    assert.equal(r.ok, true);
    assert.equal(r.sessionIdHash.length, 64);
    assert.equal(r.decision.valid, true);
    assert.deepEqual(
      r.executed.map((e) => [e.capabilityId, e.status, e.count]),
      [['earthquake.search', 200, 1]],
    );
    assert.deepEqual(executed, [
      ['earthquake.search', { minmagnitude: '4', limit: '20' }, 'function'],
    ]);
    assert.deepEqual(r.validation, { ok: true, errors: [] });
    assert.equal(r.reasoningMode, 'low');
    assert.equal(r.reasoningModeSent, false);
    // three upstream calls: session, decision, answer — all to the same session
    assert.equal(calls.length, 3);
    assert.ok(
      calls[1].url.includes('/sessions/sess-1/query') &&
        calls[2].url.includes('/sessions/sess-1/query'),
    );
    for (const c of calls.slice(1)) {
      assert.equal(c.body.responseMode, 'sync');
      assert.equal(c.body.endpointId, 'predefined-claude-sonnet-5');
      assert.equal('reasoningMode' in c.body, false);
      assert.equal(typeof c.body.modelConfigs.fulfillmentPrompt, 'string');
    }
    const decisionInput = JSON.parse(calls[1].body.query);
    assert.deepEqual(
      decisionInput.catalogue.map((c) => c.id),
      ['earthquake.search', 'fires.search'],
    );
    assert.equal(decisionInput.now, '2026-09-18T08:00:00.000Z');
    const answerInput = JSON.parse(calls[2].body.query);
    assert.equal(answerInput.toolResults[0].capabilityId, 'earthquake.search');
    assert.equal(answerInput.toolResults[0].data.events[0].id, 'us7000abcd');
    assert.ok(logs.some((l) => l.startsWith('decision valid=true')));
  });

  test('a hallucinated capabilityId is rejected: nothing executes, error stage=decision status 422', async () => {
    let executions = 0;
    const { ondemand, calls } = makeOndemand({
      decisionAnswer:
        '{"decisions":[{"capabilityId":"weather.forecast","params":{}}]}',
      finalAnswer: '{}',
    });
    const r = await runCapabilityLoop({
      query: 'q',
      registry: REGISTRY,
      adapters: {
        'earthquake.search': async () => (
          executions++,
          { ok: true, status: 200, data: {}, provenance: {} }
        ),
      },
      ondemand,
      endpointId: 'e',
      userId: 'u',
    });
    assert.equal(r.ok, false);
    assert.equal(r.decision.valid, false);
    assert.match(r.decision.errors[0], /not in the catalogue/);
    assert.equal(r.error.stage, 'decision');
    assert.equal(r.error.status, 422);
    assert.equal(executions, 0);
    assert.equal(calls.length, 2, 'no answer turn after a rejected decision');
  });

  test('adapter failures are reported to the answer turn as failed tool results; a missing adapter is 501 adapter_missing', async () => {
    const { ondemand, calls } = makeOndemand({
      decisionAnswer:
        '{"decisions":[{"capabilityId":"earthquake.search","params":{}},{"capabilityId":"fires.search","params":{"bbox":"1,2,3,4"}}]}',
      finalAnswer: JSON.stringify(structured()),
    });
    const r = await runCapabilityLoop({
      query: 'q',
      registry: REGISTRY,
      adapters: {
        'earthquake.search': async () => ({
          ok: false,
          status: 429,
          error: { code: 'rate_limited', message: 'slow' },
        }),
      },
      ondemand,
      endpointId: 'e',
      sessionId: 'existing-session',
    });
    assert.deepEqual(
      r.executed.map((e) => [e.capabilityId, e.status, e.error.code]),
      [
        ['earthquake.search', 429, 'rate_limited'],
        ['fires.search', 501, 'adapter_missing'],
      ],
    );
    assert.equal(
      calls.length,
      2,
      'existing sessionId → no session create call',
    );
    const answerInput = JSON.parse(calls[1].body.query);
    assert.deepEqual(
      answerInput.toolResults.map((t) => t.ok),
      [false, false],
    );
  });

  test('an answer that is not the 7-key contract fails validation (ok:false) but still returns the raw answer', async () => {
    const { ondemand } = makeOndemand({
      decisionAnswer: '{"decisions":[]}',
      finalAnswer: '{"message":"hi","entities":[]}',
    });
    const r = await runCapabilityLoop({
      query: 'q',
      registry: REGISTRY,
      adapters: {},
      ondemand,
      endpointId: 'e',
      userId: 'u',
    });
    assert.equal(r.ok, false);
    assert.equal(r.validation.ok, false);
    assert.ok(r.validation.errors.some((e) => e.startsWith('missing key')));
    assert.deepEqual(r.executed, []);
  });

  test('upstream failures at each stage are surfaced with the stage name', async () => {
    const failing = {
      chatBase: 'https://x/chat/v1',
      fetch: async () => new Response('nope', { status: 503 }),
    };
    const r = await runCapabilityLoop({
      query: 'q',
      registry: REGISTRY,
      adapters: {},
      ondemand: failing,
      endpointId: 'e',
      userId: 'u',
    });
    assert.deepEqual(r.error, {
      stage: 'session',
      status: 503,
      message: 'session create failed',
    });
    await assert.rejects(
      runCapabilityLoop({
        query: '',
        registry: REGISTRY,
        adapters: {},
        ondemand: failing,
        endpointId: 'e',
      }),
      TypeError,
    );
  });

  test('truncateToolResult caps item lists and records the cap; ACTION_ALLOW_LIST is a subset of the 28 names', async () => {
    const tr = {
      ok: true,
      data: { count: 100, events: Array.from({ length: 100 }, (_, i) => i) },
    };
    const t = truncateToolResult(tr, 10);
    assert.equal(t.data.events.length, 10);
    assert.equal(t.data.events_truncated_to, 10);
    assert.equal(tr.data.events.length, 100, 'input not mutated');
    const { GEV_ACTION_SCHEMAS } =
      await import('../../src/voice/actionSchemas.js');
    const names = new Set(GEV_ACTION_SCHEMAS.map((s) => s.name));
    for (const a of ACTION_ALLOW_LIST) assert.ok(names.has(a), a);
  });
});
