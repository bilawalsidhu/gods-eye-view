import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  buildGodsEyeWorkflowDefinition,
  validateStructuredResponse,
  actionDigest,
  selftestFixture,
  NODE_KEYS,
  NODE_TIERS,
  STRUCTURED_RESPONSE_KEYS,
  SPATIAL_CONTEXT_FIELDS,
  WORKFLOW_NAME,
  WORKFLOW_VERSION,
} from './workflow-definition.js';
import { TIER_DEFAULTS, FLOW_DEFAULTS } from './config.js';
import { GEV_ACTION_SCHEMAS } from '../../src/voice/actionSchemas.js';

const ACTION_NAMES = GEV_ACTION_SCHEMAS.map((s) => s.name);
const FULFILLMENT = 'predefined-gpt-5.6-luna';

function build(nowIso = '2026-09-18T07:00:00.000Z') {
  return buildGodsEyeWorkflowDefinition({
    actionSchemas: GEV_ACTION_SCHEMAS,
    tiers: TIER_DEFAULTS,
    fulfillmentEndpointId: FULFILLMENT,
    nowIso,
  });
}

/** Every object key path used anywhere in the body (arrays flattened). */
function keyPaths(value, prefix = '', out = new Set()) {
  if (Array.isArray(value)) {
    for (const item of value) keyPaths(item, prefix, out);
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      const p = prefix ? `${prefix}.${k}` : k;
      out.add(p);
      keyPaths(v, p, out);
    }
  }
  return out;
}

// docs/ONDEMAND_API_CURRENT.md §7.2 — the OpenAPI CreateWorkflowRequest
// vocabulary (reference/post_workflow.md). Anything outside this set would
// be an invented field.
const DOCUMENTED_PATHS = new Set([
  'name',
  'trigger',
  'trigger.type',
  'trigger.webhook',
  'trigger.webhook.url',
  'trigger.webhook.auth',
  'trigger.webhook.whiteListedIPs',
  'trigger.cron',
  'trigger.cron.expression',
  'trigger.position',
  'trigger.position.x',
  'trigger.position.y',
  'trigger.measured',
  'trigger.measured.width',
  'trigger.measured.height',
  'trigger.nextNodeKeys',
  'nodes',
  'nodes.key',
  'nodes.type',
  'nodes.kind',
  'nodes.dependencies',
  'nodes.dependencies.nodeKey',
  'nodes.nextNodeKeys',
  'nodes.llm',
  'nodes.llm.fulfillmentPrompt',
  'nodes.llm.prompt',
  'nodes.llm.model',
  'nodes.llm.plugins',
  'nodes.llm.plugins.id',
  'nodes.position',
  'nodes.position.x',
  'nodes.position.y',
  'nodes.measured',
  'nodes.measured.width',
  'nodes.measured.height',
  'delivery',
  'enableMemory',
]);

describe('server/ondemand/workflow-definition.js — GodsEye Advanced Spatial Workflow v1', () => {
  test('emits ONLY the documented CreateWorkflowRequest vocabulary (§7.2) — no invented fields', () => {
    const body = build();
    for (const p of keyPaths(body)) {
      assert.ok(
        DOCUMENTED_PATHS.has(p),
        `undocumented field path emitted: ${p}`,
      );
    }
    assert.equal(body.name, WORKFLOW_NAME);
    assert.equal(WORKFLOW_NAME, 'GodsEye Advanced Spatial Workflow');
    assert.equal(WORKFLOW_VERSION, 1);
    assert.equal(String(WORKFLOW_VERSION), FLOW_DEFAULTS.flowVersion);
    assert.equal(body.trigger.type, 'webhook'); // in the documented enum cron|webhook
    assert.deepEqual(body.trigger.webhook, {});
    assert.deepEqual(body.trigger.nextNodeKeys, [NODE_KEYS[0]]);
    assert.deepEqual(body.delivery, []);
    assert.equal(body.enableMemory, false);
  });

  test('is the required linear chain: session_context → … → structured_response, all documented llm nodes', () => {
    const body = build();
    assert.deepEqual(
      body.nodes.map((n) => n.key),
      [...NODE_KEYS],
    );
    assert.deepEqual(
      [...NODE_KEYS],
      [
        'session_context',
        'spatial_context_builder',
        'intent_classifier',
        'capability_resolver',
        'planner',
        'verification',
        'spatial_action_planner',
        'synthesis',
        'structured_response',
      ],
    );
    body.nodes.forEach((node, i) => {
      assert.equal(
        node.type,
        'llm',
        `${node.key} must be a documented llm node`,
      );
      assert.ok(
        ['source', 'intermediate', 'sink'].includes(node.kind),
        `${node.key} kind`,
      );
      assert.equal(
        node.kind,
        i === 0
          ? 'source'
          : i === body.nodes.length - 1
            ? 'sink'
            : 'intermediate',
      );
      assert.deepEqual(
        node.dependencies,
        i === 0 ? [] : [{ nodeKey: body.nodes[i - 1].key }],
        `${node.key} dependencies`,
      );
      assert.deepEqual(
        node.nextNodeKeys,
        i === body.nodes.length - 1 ? [] : [body.nodes[i + 1].key],
        `${node.key} nextNodeKeys`,
      );
      assert.ok(
        node.llm.fulfillmentPrompt.length > 40,
        `${node.key} system prompt`,
      );
      assert.ok(node.llm.prompt.length > 80, `${node.key} task prompt`);
      assert.match(
        node.llm.prompt,
        /Return exactly/,
        `${node.key} must carry a JSON-output instruction`,
      );
      assert.deepEqual(node.llm.plugins, []);
      if (i > 0) {
        assert.ok(
          node.llm.prompt.includes(`{${body.nodes[i - 1].key}}`),
          `${node.key} must reference its upstream node output`,
        );
      }
    });
    assert.ok(body.nodes[0].llm.prompt.includes('{trigger}'));
  });

  test('maps every node to the TIER_DEFAULTS endpoint of its tier (no per-node reasoning field exists in §7.2)', () => {
    const body = build();
    for (const node of body.nodes) {
      const tier = NODE_TIERS[node.key];
      assert.ok(tier, `${node.key} has a tier`);
      const expected =
        tier === 'FULFILLMENT'
          ? FULFILLMENT
          : TIER_DEFAULTS[tier].fulfillmentEndpointId;
      assert.equal(node.llm.model, expected, `${node.key} model`);
      assert.equal('reasoningMode' in node.llm, false);
    }
    // The classification node runs on the ASK tier (luna, the tier whose
    // benchmarked reasoningMode is 'low').
    assert.equal(NODE_TIERS.intent_classifier, 'ASK');
    assert.equal(
      TIER_DEFAULTS.ASK.fulfillmentEndpointId,
      'predefined-gpt-5.6-luna',
    );
    assert.equal(TIER_DEFAULTS.ASK.reasoningMode, 'low');
    assert.equal(NODE_TIERS.planner, 'INVESTIGATE');
    assert.equal(NODE_TIERS.verification, 'INVESTIGATE');
    assert.equal(
      TIER_DEFAULTS.INVESTIGATE.fulfillmentEndpointId,
      'predefined-claude-sonnet-5',
    );
    assert.equal(NODE_TIERS.synthesis, 'FULFILLMENT');
    const models = new Set(body.nodes.map((n) => n.llm.model));
    assert.deepEqual([...models].sort(), [
      'predefined-claude-sonnet-5',
      'predefined-gpt-5.6-luna',
    ]);
  });

  test('the Spatial Action Planner enumerates exactly the 28 MapAction names from src/voice/actionSchemas.js', () => {
    assert.equal(ACTION_NAMES.length, 28);
    const body = build();
    const planner = body.nodes.find((n) => n.key === 'spatial_action_planner');
    for (const name of ACTION_NAMES) {
      assert.ok(
        planner.llm.fulfillmentPrompt.includes(`${name}(`),
        `planner prompt lists ${name}`,
      );
    }
    assert.ok(
      planner.llm.fulfillmentPrompt.includes('ONLY use these 28 action names'),
    );
    const digest = actionDigest(GEV_ACTION_SCHEMAS);
    assert.equal(digest.length, 28);
    assert.equal(
      digest[0],
      'fly_to_location(locationId?:enum[austin|sf|nyc|tokyo|london|paris|dubai|dc], query?:string, latitude?:number, longitude?:number, viewMode?:enum[close|overview], rangeM?:number, waitForArrival?:boolean)',
    );
    assert.ok(digest.includes('zoom_to_globe()'));
    assert.ok(
      digest.some((d) =>
        d.startsWith(
          'set_layer_visibility(layerId:enum[flights|military|earthquakes|',
        ),
      ),
    );
    // the final formatter also carries the allow-list, so it can drop unknown names
    const formatter = body.nodes.find((n) => n.key === 'structured_response');
    for (const name of ACTION_NAMES)
      assert.ok(formatter.llm.prompt.includes(name));
  });

  test('the Spatial Context Builder accepts exactly the 15 §13 fields and the final node the 7 StructuredResponse keys', () => {
    assert.deepEqual(
      [...SPATIAL_CONTEXT_FIELDS],
      [
        'camera',
        'viewport',
        'center',
        'altitude',
        'zoom',
        'viewScale',
        'mapStack',
        'visibleBounds',
        'activeLayers',
        'selectedEntity',
        'trackedEntity',
        'visibleEntities',
        'timeline',
        'investigation',
        'userAction',
      ],
    );
    assert.deepEqual(
      [...STRUCTURED_RESPONSE_KEYS],
      [
        'message',
        'entities',
        'actions',
        'evidence',
        'sources',
        'suggestedNextActions',
        'runMeta',
      ],
    );
    const body = build();
    const builder = body.nodes.find((n) => n.key === 'spatial_context_builder');
    assert.ok(builder.llm.prompt.includes(SPATIAL_CONTEXT_FIELDS.join(', ')));
    const formatter = body.nodes.find((n) => n.key === 'structured_response');
    assert.ok(
      formatter.llm.fulfillmentPrompt.includes(
        STRUCTURED_RESPONSE_KEYS.join(', '),
      ),
    );
    assert.ok(
      formatter.llm.prompt.includes(
        '"nodeChain": ' + JSON.stringify(NODE_KEYS),
      ),
    );
    assert.ok(
      formatter.llm.prompt.includes(`"flowVersion": ${WORKFLOW_VERSION}`),
    );
  });

  test('the embedded self-test fixture is the Abu Dhabi International Airport viewport with the earthquake_search catalogue', () => {
    const fixture = selftestFixture('2026-09-18T07:00:00.000Z');
    assert.equal(fixture.query, 'What is unusual around this airport?');
    const sc = fixture.spatialContext;
    assert.deepEqual(Object.keys(sc), [...SPATIAL_CONTEXT_FIELDS]);
    assert.ok(Math.abs(sc.center.latitude - 24.433) < 0.01);
    assert.ok(Math.abs(sc.center.longitude - 54.651) < 0.01);
    assert.ok(
      sc.activeLayers.includes('flights') &&
        sc.activeLayers.includes('earthquakes'),
    );
    assert.ok(sc.visibleEntities.length >= 3);
    assert.ok(sc.visibleEntities.some((e) => e.layerId === 'flights'));
    assert.ok(sc.visibleEntities.some((e) => e.layerId === 'ais-live-vessels'));
    assert.equal(sc.timeline.now, '2026-09-18T07:00:00.000Z');
    assert.equal(sc.investigation, null);
    assert.equal(sc.userAction, 'query');
    assert.equal(fixture.capabilityCatalogue.length, 1);
    assert.equal(fixture.capabilityCatalogue[0].id, 'earthquake.search');
    assert.equal(
      fixture.capabilityCatalogue[0].ondemand_tool,
      'earthquake_search',
    );
    assert.equal(
      fixture.capabilityCatalogue[0].route,
      '/api/sources/earthquakes',
    );
    // and it is embedded verbatim in the source node's prompt
    const body = build('2026-09-18T07:00:00.000Z');
    assert.ok(body.nodes[0].llm.prompt.includes(JSON.stringify(fixture)));
  });

  test('build() rejects missing inputs instead of guessing a model id', () => {
    assert.throws(
      () =>
        buildGodsEyeWorkflowDefinition({
          actionSchemas: [],
          tiers: TIER_DEFAULTS,
          fulfillmentEndpointId: FULFILLMENT,
        }),
      /actionSchemas/,
    );
    assert.throws(
      () =>
        buildGodsEyeWorkflowDefinition({
          actionSchemas: GEV_ACTION_SCHEMAS,
          tiers: {},
          fulfillmentEndpointId: FULFILLMENT,
        }),
      /tiers/,
    );
    assert.throws(
      () =>
        buildGodsEyeWorkflowDefinition({
          actionSchemas: GEV_ACTION_SCHEMAS,
          tiers: TIER_DEFAULTS,
          fulfillmentEndpointId: '',
        }),
      /fulfillmentEndpointId/,
    );
  });

  describe('validateStructuredResponse', () => {
    const good = () => ({
      message: 'ok',
      entities: [],
      actions: [
        {
          name: 'fly_to_location',
          params: { latitude: 24.4, longitude: 54.6 },
        },
      ],
      evidence: [],
      sources: [],
      suggestedNextActions: [],
      runMeta: { workflow: WORKFLOW_NAME },
    });

    test('accepts the 7-key shape with known action names', () => {
      assert.deepEqual(validateStructuredResponse(good(), ACTION_NAMES), {
        ok: true,
        errors: [],
      });
    });

    test('rejects a missing key, an extra key and an unknown action name', () => {
      const missing = good();
      delete missing.sources;
      assert.deepEqual(
        validateStructuredResponse(missing, ACTION_NAMES).errors,
        ['missing key: sources', 'sources must be an array'],
      );
      const extra = { ...good(), debug: true };
      assert.deepEqual(validateStructuredResponse(extra, ACTION_NAMES).errors, [
        'extra key: debug',
      ]);
      const unknown = good();
      unknown.actions.push({ name: 'launch_missiles', params: {} });
      assert.deepEqual(
        validateStructuredResponse(unknown, ACTION_NAMES).errors,
        ['actions[1].name "launch_missiles" is not a known MapAction'],
      );
      assert.equal(validateStructuredResponse(null, ACTION_NAMES).ok, false);
      assert.equal(validateStructuredResponse([], ACTION_NAMES).ok, false);
    });
  });

  describe('committed artefacts stay in sync with the builder', () => {
    test('docs/ondemand-workflows/gods-eye-advanced-v1.json: the LIVE workflow object equals the current build (id = FLOW_DEFAULTS)', async () => {
      const exported = JSON.parse(
        await readFile(
          new URL(
            '../../docs/ondemand-workflows/gods-eye-advanced-v1.json',
            import.meta.url,
          ),
          'utf8',
        ),
      );
      const live = exported.workflow;
      assert.equal(live.id, FLOW_DEFAULTS.spatialFlowId);
      assert.equal(live.name, WORKFLOW_NAME);
      assert.equal(live.isActive, true);
      assert.equal(live.enableMemory, false);
      assert.equal(live.trigger.type, 'webhook');
      // Rebuild with the fixture timestamp the live prompts were created with.
      const nowIso = /"now":"([^"]+)"/.exec(live.nodes[0].llm.prompt)[1];
      const rebuilt = build(nowIso);
      assert.deepEqual(
        live.nodes.map((n) => n.key),
        [...NODE_KEYS],
      );
      live.nodes.forEach((node, i) => {
        const expected = rebuilt.nodes[i];
        assert.equal(node.type, expected.type, `${node.key} type`);
        assert.equal(node.kind, expected.kind, `${node.key} kind`);
        assert.deepEqual(
          node.dependencies ?? [],
          expected.dependencies,
          `${node.key} dependencies`,
        );
        assert.deepEqual(
          node.nextNodeKeys ?? [],
          expected.nextNodeKeys,
          `${node.key} nextNodeKeys`,
        );
        assert.equal(node.llm.model, expected.llm.model, `${node.key} model`);
        assert.equal(
          node.llm.fulfillmentPrompt,
          expected.llm.fulfillmentPrompt,
          `${node.key} system prompt drifted from the live workflow`,
        );
        assert.equal(
          node.llm.prompt,
          expected.llm.prompt,
          `${node.key} task prompt drifted from the live workflow`,
        );
      });
      // The export's re-import body is the builder output too.
      const bodyNow = /"now":"([^"]+)"/.exec(
        exported.createBody.nodes[0].llm.prompt,
      )[1];
      assert.deepEqual(exported.createBody, build(bodyNow));
      // No credential-like value survives the export.
      assert.deepEqual(live.trigger.webhook, {
        auth: { username: '', password: '' },
      });
      assert.equal(JSON.stringify(exported).includes('apikey'), false);
    });

    test('docs/ondemand-workflows/verification-2026-09-18.json: the recorded live run validates against the 7-key/28-name contract', async () => {
      const run = JSON.parse(
        await readFile(
          new URL(
            '../../docs/ondemand-workflows/verification-2026-09-18.json',
            import.meta.url,
          ),
          'utf8',
        ),
      );
      assert.equal(run.workflowId, FLOW_DEFAULTS.spatialFlowId);
      assert.equal(run.finalStatus, 'success');
      assert.deepEqual(
        validateStructuredResponse(run.structuredResponse, ACTION_NAMES),
        { ok: true, errors: [] },
      );
      assert.deepEqual(Object.keys(run.structuredResponse), [
        ...STRUCTURED_RESPONSE_KEYS,
      ]);
      assert.deepEqual(Object.keys(run.nodeOutputs), [...NODE_KEYS]);
      assert.ok(run.calls.every((c) => c.status === 200));
      assert.ok(
        run.timeToFirstLogMs > 0 && run.totalLatencyMs > run.timeToFirstLogMs,
      );
      assert.equal(
        run.structuredResponse.runMeta.flowVersion,
        WORKFLOW_VERSION,
      );
      assert.equal(run.structuredResponse.runMeta.mode, 'selftest');
      for (const a of run.structuredResponse.actions)
        assert.ok(ACTION_NAMES.includes(a.name), a.name);
    });
  });
});
