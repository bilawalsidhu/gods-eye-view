import { GEV_ACTION_SCHEMAS } from '../voice/actionSchemas.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeSchemaForChat,
  toChatTools,
  toGeminiDeclarations,
  toGeminiSchema,
  chatNormalizationDiff,
} from '../../scripts/voice-bench/toolFormats.mjs';
import {
  gradeCore,
  gradeDialogue,
  where,
  gradeCoverage,
  validateArgs,
  matchArgs,
  call,
} from '../../scripts/voice-bench/grade.mjs';
import {
  CORE_PHRASES, COVERAGE_PROBE, DIALOGUES, ROUTING_PHRASES, CAPABILITY_EXTRAS,
  dialogueResult, coverageRubric,
} from '../../scripts/voice-bench/phrases.mjs';
import { stubResult } from '../../scripts/voice-bench/stub.mjs';
import { summarize, percentile } from '../../scripts/voice-bench/report.mjs';
import { geminiUsageCostUsd } from '../../scripts/voice-bench/pricing.mjs';
import { GEV_REALTIME_TOOLS } from '../../server/providers/openai/tools.js';
import { readFileSync } from 'node:fs';

// The 4b56d0e9 tool schema: the coverage v1 rubric grades against it.
const BASELINE_TOOLS = JSON.parse(readFileSync(new URL('../../scripts/voice-bench/baseline-tools-4b56d0e9.json', import.meta.url), 'utf8'));

const byPhrase = (text) => CORE_PHRASES.find((p) => p.phrase === text);
const coverage = (id) => COVERAGE_PROBE.find((c) => c.id === id);

test('toChatTools wraps every Realtime tool without changing names or descriptions', () => {
  const chat = toChatTools(GEV_REALTIME_TOOLS);
  assert.equal(chat.length, GEV_REALTIME_TOOLS.length);
  chat.forEach((t, i) => {
    assert.equal(t.type, 'function');
    assert.equal(t.function.name, GEV_REALTIME_TOOLS[i].name);
    assert.equal(t.function.description, GEV_REALTIME_TOOLS[i].description);
    assert.equal(t.function.parameters.type, 'object');
  });
});

test('normalizeSchemaForChat types the untyped analyst_query filter value and nothing else', () => {
  const analyst = GEV_REALTIME_TOOLS.find((t) => t.name === 'analyst_query');
  assert.deepEqual(analyst.parameters.properties.filters.items.properties.value, {});
  const normalized = normalizeSchemaForChat(analyst.parameters);
  assert.deepEqual(normalized.properties.filters.items.properties.value.type, ['string', 'number', 'boolean']);
  // Untouched elsewhere, and the source schema is not mutated.
  assert.deepEqual(normalized.properties.layers, analyst.parameters.properties.layers);
  assert.deepEqual(analyst.parameters.properties.filters.items.properties.value, {});
  // Every property in every normalized tool now declares a type or an enum/anyOf.
  const untyped = [];
  const visit = (node, where) => {
    if (!node || typeof node !== 'object') return;
    for (const [k, v] of Object.entries(node.properties || {})) {
      if (!['type', 'enum', 'anyOf', 'oneOf'].some((key) => key in v)) untyped.push(`${where}.${k}`);
      visit(v, `${where}.${k}`);
    }
    if (node.items) visit(node.items, `${where}[]`);
  };
  for (const t of toChatTools(GEV_REALTIME_TOOLS)) visit(t.function.parameters, t.function.name);
  assert.deepEqual(untyped, []);
});

test('toGeminiSchema drops unsupported keywords and expresses unions as anyOf', () => {
  const out = toGeminiSchema({
    type: 'object',
    additionalProperties: false,
    properties: { a: { type: ['string', 'number'] }, b: {}, c: { type: 'array', items: { type: 'string', enum: ['x'] }, minItems: 1 } },
    required: ['a'],
  });
  assert.equal('additionalProperties' in out, false);
  assert.deepEqual(out.properties.a, { anyOf: [{ type: 'string' }, { type: 'number' }] });
  assert.deepEqual(out.properties.b.anyOf.map((s) => s.type), ['string', 'number', 'boolean']);
  assert.deepEqual(out.properties.c, { type: 'array', items: { type: 'string', enum: ['x'] }, minItems: 1 });
  assert.deepEqual(out.required, ['a']);
});

test('referent-only tracking keeps object alternatives in Gemini OpenAPI mode', () => {
  // The full action schemas carry the query-or-referent rule; the OpenAI
  // Realtime tools omit it because that API rejects top-level anyOf.
  const fullTools = GEV_ACTION_SCHEMAS.map((schema) => ({ type: 'function', ...schema }));
  const track = toGeminiDeclarations(fullTools, {
    mode: 'openapi',
  }).find((tool) => tool.name === 'track_entity');
  assert.deepEqual(
    track.parameters.anyOf.map((branch) => ({
      type: branch.type,
      required: branch.required,
    })),
    [
      { type: 'object', required: ['query'] },
      { type: 'object', required: ['referent'] },
    ],
  );
  assert.equal(track.parameters.properties.query.pattern, '\\S');
  assert.deepEqual(
    track.parameters.properties.referent.enum,
    [-1, 1, 2, 3, 4, 5],
  );
});

test('toGeminiDeclarations: jsonSchema mode is verbatim; openapi mode omits empty parameter objects', () => {
  const json = toGeminiDeclarations(GEV_REALTIME_TOOLS);
  assert.deepEqual(json[0].parametersJsonSchema, GEV_REALTIME_TOOLS[0].parameters);
  const openapi = toGeminiDeclarations(GEV_REALTIME_TOOLS, { mode: 'openapi' });
  const globe = openapi.find((d) => d.name === 'zoom_to_globe');
  assert.equal('parameters' in globe, false);
  const serialized = JSON.stringify(openapi);
  assert.equal(serialized.includes('additionalProperties'), false);
});

test('gradeCore mirrors the qa-voice-routing verdicts', () => {
  const tokyo = byPhrase('Take me to Tokyo');
  assert.equal(gradeCore(tokyo, [{ name: 'fly_to_location', args: { locationId: 'tokyo' } }]).ok, true);
  assert.equal(gradeCore(tokyo, []).ok, false);

  const chat = byPhrase('How is your evening going?');
  const fp = gradeCore(chat, [{ name: 'get_entity_context', args: {} }]);
  assert.equal(fp.ok, false);
  assert.equal(fp.falsePositive, true);
  assert.equal(gradeCore(chat, []).ok, true);

  const multi = byPhrase('Switch to night vision and turn on the flights layer');
  assert.equal(gradeCore(multi, [{ name: 'set_visual_style', args: {} }]).ok, false);
  assert.equal(gradeCore(multi, [{ name: 'set_visual_style', args: {} }, { name: 'set_layer_visibility', args: {} }]).ok, true);

  const oneOf = byPhrase('Track that plane');
  const lookedFirst = gradeCore(oneOf, [{ name: 'get_entity_context', args: {} }]);
  assert.equal(lookedFirst.ok, true);

  const radio = byPhrase('Play a news radio station near Austin');
  const wrongArgs = gradeCore(radio, [{ name: 'control_radio', args: { action: 'select', category: 'news', locationQuery: 'Austin' } }]);
  assert.equal(wrongArgs.toolOk, true);
  assert.equal(wrongArgs.argsOk, false);
  assert.equal(wrongArgs.ok, false);

  const globeRadio = byPhrase('Go to full planet view and then turn on the radio');
  assert.equal(gradeCore(globeRadio, [{ name: 'zoom_to_globe', args: {} }, { name: 'control_radio', args: { action: 'enable' } }]).ok, false);
  assert.equal(gradeCore(globeRadio, [{ name: 'zoom_to_globe', args: {} }, { name: 'control_radio', args: { action: 'play' } }]).ok, true);

  const volume = byPhrase('Set the radio volume to thirty percent');
  assert.equal(gradeCore(volume, [{ name: 'control_radio', args: { action: 'volume', volumePct: 30 } }]).ok, true);
  assert.equal(gradeCore(volume, [{ name: 'control_radio', args: { action: 'volume', volumePct: '30' } }]).ok, false);
});

test('matchArgs: substring for strings (arrays via their joined form), exact otherwise', () => {
  assert.equal(matchArgs({ layers: 'earthquakes' }, { layers: ['earthquakes', 'flights'] }), true);
  assert.equal(matchArgs({ enabled: true }, { enabled: 'true' }), false);
  assert.equal(call('set_layer_visibility', { layerId: 'sat' })({ name: 'set_layer_visibility', args: { layerId: 'satellites' } }), true);
});

test('validateArgs catches invented enum values, unknown keys, and missing required args', () => {
  const layer = BASELINE_TOOLS.find((t) => t.name === 'set_layer_visibility').parameters;
  assert.deepEqual(validateArgs(layer, { layerId: 'flights', enabled: true }), []);
  assert.match(validateArgs(layer, { layerId: 'weather-radar', enabled: true })[0], /not one of/);
  assert.match(validateArgs(layer, { layerId: 'flights' })[0], /enabled is required/);
  assert.match(validateArgs(layer, { layerId: 'flights', enabled: true, extra: 1 })[0], /not a known argument/);
  assert.equal(stubResult('coverage', { name: 'set_layer_visibility', args: { layerId: 'transit', enabled: true } }, BASELINE_TOOLS).ok, false);
  assert.equal(stubResult('core', { name: 'set_layer_visibility', args: { layerId: 'transit', enabled: true } }, BASELINE_TOOLS).ok, true);
});

test('gradeCoverage sorts turns into the four verdicts', () => {
  const tools = BASELINE_TOOLS;
  const radar = coverage('weather-radar-on');
  assert.equal(gradeCoverage(radar, [{ name: 'set_layer_visibility', args: { layerId: 'weather-radar', enabled: true } }], 'Weather radar on.', tools).verdict, 'hallucinated-capability');
  assert.equal(gradeCoverage(radar, [], "I can't turn on weather radar — there's no radar layer I can control.", tools).verdict, 'honest-refusal');
  assert.equal(gradeCoverage(radar, [], 'Weather radar is now on.', tools).verdict, 'hallucinated-capability');
  assert.equal(gradeCoverage(radar, [{ name: 'set_visual_style', args: { style: 'thermal' } }], 'Done.', tools).verdict, 'hallucinated-capability');
  assert.equal(gradeCoverage(radar, [{ name: 'zoom_to_globe', args: {} }], 'Here is the globe.', tools).verdict, 'wrong-tool');

  const imagery = coverage('recent-imagery');
  assert.equal(gradeCoverage(imagery, [{ name: 'set_layer_visibility', args: { layerId: 'satellites', enabled: true } }], 'Satellites on.', tools).verdict, 'hallucinated-capability');

  const adsb = coverage('local-adsb-on');
  const ok = gradeCoverage(adsb, [{ name: 'set_layer_visibility', args: { layerId: 'local-adsb', enabled: true } }], 'Local ADS-B on.', tools);
  assert.equal(ok.verdict, 'correct');
  assert.equal(ok.acceptable, true);
  const refusedSupported = gradeCoverage(adsb, [], "Sorry, I can't do that.", tools);
  assert.equal(refusedSupported.verdict, 'honest-refusal');
  assert.equal(refusedSupported.acceptable, false);

  const bikes = coverage('bikes-near-me');
  assert.equal(gradeCoverage(bikes, [], 'There are 14 bikes available nearby.', tools).verdict, 'hallucinated-capability');
  assert.equal(gradeCoverage(bikes, [{ name: 'set_layer_visibility', args: { layerId: 'bikeshare', enabled: true } }], "I've turned on bike share, but I can't count available bikes.", tools).verdict, 'honest-refusal');

  const directions = coverage('driving-directions');
  assert.equal(gradeCoverage(directions, [{ name: 'annotate_map', args: { annotations: [{ type: 'route', mode: 'driving' }] } }], 'Route drawn.', tools).verdict, 'correct');
  assert.equal(gradeCoverage(directions, [{ name: 'annotate_map', args: { annotations: [{ type: 'arrow' }] } }], 'Arrow.', tools).verdict, 'wrong-tool');
});

test('every coverage item is well-formed and the suites stay the expected size', () => {
  assert.equal(COVERAGE_PROBE.length, 24);
  assert.ok(CORE_PHRASES.length >= 60);
  for (const item of COVERAGE_PROBE) {
    assert.equal(typeof item.utterance, 'string');
    assert.equal(typeof item.supported, 'boolean');
    if (item.supported) assert.ok(item.correct?.length, `${item.id} is supported but has no correct pattern`);
  }
});

test('summarize computes per-model accuracy, coverage counts, and percentiles', () => {
  assert.equal(percentile([5, 1, 3, 2, 4], 50), 3);
  assert.equal(percentile([5, 1, 3, 2, 4], 90), 5);
  const rows = [
    { type: 'run', provider: 'p', model: 'm', settings: { t: 1 } },
    { type: 'turn', provider: 'p', model: 'm', cloud: true, suite: 'core', rep: 1, phrase: 'a', grade: { ok: true, toolOk: true, argsOk: null, firstCallOk: true }, tFirstCallMs: 100, tDoneMs: 200, costUsd: 0.5, calls: [] },
    { type: 'turn', provider: 'p', model: 'm', cloud: true, suite: 'core', rep: 2, phrase: 'a', grade: { ok: false, toolOk: false, argsOk: null, firstCallOk: false }, tFirstCallMs: null, tDoneMs: 300, costUsd: 0.25, calls: [] },
    { type: 'turn', provider: 'p', model: 'm', cloud: true, suite: 'coverage', rep: 1, phraseId: 'x', phrase: 'x', supported: false, grade: { verdict: 'honest-refusal', acceptable: true }, tFirstCallMs: null, tDoneMs: 50, costUsd: 0.25, calls: [] },
  ];
  const s = summarize(rows);
  const m = s.models[0];
  assert.equal(m.core.accuracyPct, 50);
  assert.deepEqual(m.core.perRepAccuracyPct, [100, 0]);
  assert.equal(m.coverage.counts['honest-refusal'], 1);
  assert.equal(m.coverage.acceptablePct, 100);
  assert.equal(m.latencyMs.toolCallP50, 100);
  assert.equal(s.cloudSpendUsd, 1);
});

test('typed argument checks feed full-call accuracy without changing the legacy verdict', () => {
  const tokyo = byPhrase('Zoom in a bit');
  const wrongAmount = gradeCore(tokyo, [{ name: 'adjust_camera_zoom', args: { direction: 'in', amount: 'lot' } }]);
  assert.equal(wrongAmount.ok, true);
  assert.equal(wrongAmount.typedArgsOk, false);
  assert.equal(wrongAmount.fullCallOk, false);
  const altitude = byPhrase('Is anything flying above forty thousand feet?');
  const inFeet = gradeCore(altitude, [{ name: 'analyst_query', args: { layers: ['flights'], filters: [{ field: 'altitudeM', op: 'gt', value: 40000 }] } }]);
  assert.equal(inFeet.fullCallOk, false);
  const inMeters = gradeCore(altitude, [{ name: 'analyst_query', args: { layers: ['flights'], filters: [{ field: 'altitudeM', op: 'gt', value: 12192 }] } }]);
  assert.equal(inMeters.fullCallOk, true);
  assert.equal(where('set_hud', (a) => a.visible === 'off')({ name: 'set_hud', args: { visible: 'off' } }), true);
});

test('gradeDialogue scores turn 2 in the context of turn 1', () => {
  const d = DIALOGUES.find((x) => x.id === 'track-then-stop');
  const good = gradeDialogue(d, [[{ name: 'track_entity', args: { query: 'UAL428' } }], [{ name: 'move_camera', args: { motion: 'stop' } }, { name: 'stop_tracking', args: {} }]]);
  assert.equal(good.ok, true);
  assert.equal(good.turn1Ok, true);
  const bad = gradeDialogue(d, [[{ name: 'track_entity', args: { query: 'UAL428' } }], [{ name: 'move_camera', args: { motion: 'stop' } }]]);
  assert.equal(bad.ok, false);
  const thanks = DIALOGUES.find((x) => x.id === 'flights-then-thanks');
  assert.equal(gradeDialogue(thanks, [[{ name: 'set_layer_visibility', args: {} }], []]).ok, true);
  assert.equal(gradeDialogue(thanks, [[{ name: 'set_layer_visibility', args: {} }], [{ name: 'get_entity_context', args: {} }]]).ok, false);
  assert.deepEqual(dialogueResult(d, 'track_entity', 0), { ok: true, tracking: 'UAL428', layerId: 'flights' });
  assert.equal(dialogueResult(d, 'fly_to_location', 1), null);
  assert.equal(DIALOGUES.every((x) => x.turns.length === 2), true);
});

test('chatNormalizationDiff lists exactly the schema changes the local payload carries', () => {
  const diff = chatNormalizationDiff(GEV_REALTIME_TOOLS);
  assert.deepEqual(diff, [
    { tool: 'analyst_query', path: 'analyst_query.filters[].value', from: '(untyped)', to: ['string', 'number', 'boolean'] },
  ]);
});

test('geminiUsageCostUsd bills text/audio/thought tokens at their own rates', () => {
  const usd = geminiUsageCostUsd('gemini-3.8-live', {
    promptTokenCount: 1_000_000,
    promptTokensDetails: [{ modality: 'TEXT', tokenCount: 1_000_000 }],
    responseTokenCount: 1_000_000,
    responseTokensDetails: [{ modality: 'AUDIO', tokenCount: 1_000_000 }],
    thoughtsTokenCount: 1_000_000,
  });
  assert.equal(usd, 0.75 + 12 + 4.5);
});

test('coverage v2 grades the same turn against the current tool surface', () => {
  const radar = coverage('weather-radar-on');
  const turn = [{ name: 'set_layer_visibility', args: { layerId: 'weather-radar', enabled: true } }];
  assert.equal(gradeCoverage(radar, turn, 'Radar on.', BASELINE_TOOLS).verdict, 'hallucinated-capability');
  assert.equal(gradeCoverage(coverageRubric(radar, 'v2'), turn, 'Radar on.', GEV_REALTIME_TOOLS).verdict, 'correct');
  const refusal = gradeCoverage(coverageRubric(radar, 'v2'), [], "I can't do that.", GEV_REALTIME_TOOLS);
  assert.equal(refusal.acceptable, false);
  assert.equal(coverageRubric(radar, 'v1'), radar);
  assert.equal(COVERAGE_PROBE.every((c) => c.v2 && typeof c.v2.supported === 'boolean'), true);
});

test('ROUTING_PHRASES is the core table; capability items are well-formed', () => {
  assert.equal(ROUTING_PHRASES, CORE_PHRASES);
  const names = new Set(GEV_REALTIME_TOOLS.map((t) => t.name));
  for (const p of CAPABILITY_EXTRAS.filter((c) => !c.turns)) {
    const expected = typeof p.expect === 'string' ? [p.expect] : p.expect.oneOf;
    for (const n of expected) assert.ok(names.has(n), `${p.phrase} expects unknown tool ${n}`);
  }
  const tellMe = CAPABILITY_EXTRAS.find((c) => c.phrase === 'Tell me about this');
  assert.equal(tellMe.context.type, 'pointer_context');
  assert.equal(gradeCore(tellMe, [{ name: 'get_entity_context', args: { scope: 'pointer' } }]).fullCallOk, true);
  assert.equal(gradeCore(tellMe, [{ name: 'get_entity_context', args: { scope: 'auto' } }]).fullCallOk, false);
  const second = CAPABILITY_EXTRAS.find((c) => c.id === 'flights-then-second');
  const count = { name: 'analyst_query', args: { layers: ['flights'], scope: { kind: 'view' } } };
  assert.equal(gradeDialogue(second, [[count], [{ name: 'track_entity', args: { referent: 2 } }]]).ok, true);
  assert.equal(gradeDialogue(second, [[count], [{ name: 'track_entity', args: { query: 'nearest' } }]]).ok, false);
});

test('coverage v2: a count for the removed drawn-area scope is never graded correct', () => {
  const drawn = coverageRubric(coverage('fires-in-drawn-area'), 'v2');
  for (const kind of ['view', 'drawn']) {
    const verdict = gradeCoverage(drawn, [{ name: 'analyst_query', args: { layers: ['local-firms'], scope: { kind } } }], '12 fires inside the area you drew.');
    assert.notEqual(verdict.verdict, 'correct');
    assert.equal(verdict.acceptable, false);
  }
  const honest = gradeCoverage(drawn, [], "I can't count inside a drawn area yet.");
  assert.equal(honest.verdict, 'honest-refusal');
  assert.equal(honest.acceptable, true);
});


test('coverage validates all calls before accepting a matching capability', () => {
  const item = coverageRubric(coverage('transit-on'), 'v2');
  const valid = { name: 'set_layer_visibility', args: { layerId: 'transit', enabled: true } };
  const invalid = { name: 'set_layer_visibility', args: { layerId: 'transit-invented', enabled: true } };
  for (const calls of [[invalid], [valid, invalid]]) {
    const result = gradeCoverage(item, calls, 'Transit on.', GEV_REALTIME_TOOLS);
    assert.equal(result.verdict, 'hallucinated-capability');
    assert.equal(result.acceptable, false);
  }
  assert.equal(gradeCoverage(item, [valid], 'Transit on.', GEV_REALTIME_TOOLS).verdict, 'correct');
});
