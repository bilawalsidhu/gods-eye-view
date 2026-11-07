import { realtimeInstructions } from '../../server/providers/openai/instructions.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { GEV_ACTION_SCHEMAS, createActionTools } from './actionSchemas.js';
import { GEV_REALTIME_TOOLS } from '../../server/providers/openai/tools.js';
import { createAreaStore } from '../data/areaStore.js';
import { createAreaResolver } from '../data/areaResolver.js';
import { findAdminCandidates } from '../data/adminBoundaries.js';
import {
  validateArgs,
  validateCall,
} from '../../scripts/voice-bench/grade.mjs';

const stable = (value) =>
  Array.isArray(value)
    ? value.map(stable)
    : value && typeof value === 'object'
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, child]) => [key, stable(child)]),
        )
      : value;

test('the complete Realtime tool payload pins the manifest-generated layer release', () => {
  const digest = createHash('sha256')
    .update(
      JSON.stringify(
        stable(
          GEV_REALTIME_TOOLS.filter((tool) => tool.name !== 'set_cyber_sonar'),
        ),
      ),
    )
    .digest('hex');
  assert.equal(
    digest,
    // Re-derived for Provider Settings and explicit Visual Presets/Scenes routing,
    // plus the deliberate direct Panel tool/target additions and voice layer manifest (generated layer enums and
    // aliases), point-and-ask (pointer sentinels, referent args) and the
    // consolidated tool wording (each policy stated once); model-facing tools
    // omit top-level anyOf (OpenAI rejects it). Contacts list routing preserves
    // requested radius and center authority in descriptions only.
    // Street Level and GNSS extend the manifest; tracked and analyst aircraft describe broadcasts.
    // Air quality (ECCC AQHI) extends the manifest.
    // Globe rotation adds one motion; visual keyhole fit and explicit
    // reset guidance/defaults update only move_camera and mode descriptions.
    // S2 GhostMaps extends the generated layer enums.
    // The Utilities panel (Directions, Draw, Import) adds one panel target.
    // Panel adds named voice targets and timeout; shared Panel/Cockpit guidance
    // is consolidated without changing either feature's arguments.
    // Snow leaves the set_visual_style enum.
    // The Operator HUD layout leaves set_hud's layout enum.
    // The layer alias hint leaves out aliases the layer id already spells.
    // Voice geometry adds resolve_area, find_imagery, osm_query, the analyst
    // area scopes and the osm-places layer; natural-region candidates and the
    // tightened area tool wording follow review.
    // control_cockpit states the own-layer entry rule (Contacts not required).
    // move_camera tilt takes an optional pitchDeg angle, described as
    // absolute with its -45 default, with steps sent as a direction.
    '6a0d154e68beb787c4e20f12d29a5c86577dc343f3e71d8b5651998ea45d8c3c',
  );
});

test('descriptions customize wording without changing immutable shared arguments', () => {
  const descriptions = {
    fly_to_location: {
      description: 'Navigate',
      parameters: { properties: { query: { description: 'A place' } } },
    },
  };
  const tools = createActionTools(descriptions);
  const tool = tools.find((tool) => tool.name === 'fly_to_location');
  assert.equal(tool.description, 'Navigate');
  assert.equal(tool.parameters.properties.query.description, 'A place');
  assert.equal(tool.parameters.properties.query.type, 'string');
  tool.parameters.properties.query.type = 'number';
  assert.equal(
    createActionTools()[0].parameters.properties.query.type,
    'string',
  );
  assert.throws(() => {
    GEV_ACTION_SCHEMAS[0].parameters.properties.query.type = 'number';
  }, TypeError);
  assert.equal(
    JSON.stringify(GEV_ACTION_SCHEMAS).includes('"description"'),
    false,
  );
});

test('every emitted area candidate round-trips through the production schema', async () => {
  const candidateSchema = GEV_ACTION_SCHEMAS.find(
    (tool) => tool.name === 'resolve_area',
  ).parameters.properties.candidateId;
  const resolver = createAreaResolver({
    store: createAreaStore(),
    findAdminCandidates,
  });
  const ambiguous = await resolver.resolve({ query: 'Georgia' });
  assert.equal(ambiguous.needsClarification, true);
  for (const choice of ambiguous.candidates) {
    assert.ok(choice.candidateId.length >= candidateSchema.minLength);
    assert.ok(choice.candidateId.length <= candidateSchema.maxLength);
    assert.match(choice.candidateId, new RegExp(candidateSchema.pattern, 'u'));
    assert.equal(
      (await resolver.resolve({ candidateId: choice.candidateId })).ok,
      true,
    );
  }
  assert.equal(ambiguous.candidates[0].candidateId.length, 44);
  const grammar = new RegExp(candidateSchema.pattern, 'u');
  for (const malformed of [
    'ne:state:bad slug',
    'ne:state:../../etc',
    'ne:state:!!!',
    'ne:state:a_b',
  ])
    assert.doesNotMatch(malformed, grammar);
  assert.ok(`ne:state:${'x'.repeat(80)}`.length > candidateSchema.maxLength);
});

test('metadata cannot add tools, fields, types or enum values', () => {
  for (const descriptions of [
    { execute_shell: { description: 'not an action' } },
    {
      fly_to_location: {
        parameters: { properties: { description: 'new field' } },
      },
    },
    { fly_to_location: { $position: -1, description: 'invalid position' } },
    { fly_to_location: { name: 'other' } },
    {
      fly_to_location: {
        parameters: { properties: { arbitrary: { description: 'new field' } } },
      },
    },
    {
      fly_to_location: {
        parameters: { properties: { query: { type: 'number' } } },
      },
    },
    { fly_to_location: { parameters: { required: { 0: 'another' } } } },
    { fly_to_location: { description: { nested: 'invalid' } } },
  ])
    assert.throws(() => createActionTools(descriptions), TypeError);
});

test('all legacy action arguments are byte-identical after removing the deliberate additions', () => {
  const legacy = structuredClone(GEV_ACTION_SCHEMAS).filter(
    (tool) =>
      ![
        'next_satellite_pass',
        'set_cyber_sonar',
        'set_voice_inactivity_timeout',
        'resolve_area',
        'find_imagery',
        'osm_query',
      ].includes(tool.name),
  );
  // Layer enums are generated from the voice layer manifest and pinned by
  // layerManifest.test.mjs; the two shipped right-rail panels are additive.
  const property = (name) =>
    legacy.find((tool) => tool.name === name).parameters.properties;
  delete property('control_cockpit').voicePanel;
  delete property('set_layer_visibility').layerId.enum;
  delete property('show_data_layers_menu').layerId.enum;
  delete property('get_entity_context').layerId.enum;
  delete property('analyst_query').layers.items.enum;
  // Earth-centered rotation is additive; local camera yaw keeps its contract.
  const motion = property('move_camera').motion;
  assert.deepEqual(motion.enum, [
    'orbit',
    'pan',
    'tilt',
    'rotate',
    'rotate_globe',
    'stop',
  ]);
  motion.enum = motion.enum.filter((value) => value !== 'rotate_globe');
  // Tilt to an angle is additive.
  delete property('move_camera').pitchDeg;
  const panels = property('set_panel_open').panelId;
  panels.enum = panels.enum.filter(
    (id) =>
      ![
        'weather-panel',
        'recent-imagery-panel',
        'voice-settings',
        'voice-preview',
        'provider-settings',
        'utilities-panel',
      ].includes(id),
  );
  for (const tool of legacy) {
    // Point-and-ask adds `referent` arguments and 'pointer' enum values.
    delete tool.parameters.properties.referent;
    for (const value of Object.values(tool.parameters.properties)) {
      if (value.enum)
        value.enum = value.enum.filter((key) => key !== 'pointer');
    }
  }
  const track = legacy.find((tool) => tool.name === 'track_entity').parameters;
  delete track.anyOf;
  delete track.properties.query.minLength;
  delete track.properties.query.pattern;
  track.required = ['query'];
  const analystScopeKind = legacy.find((tool) => tool.name === 'analyst_query')
    .parameters.properties.scope.properties.kind;
  analystScopeKind.enum = analystScopeKind.enum.filter(
    (key) => key !== 'pointer',
  );
  // Area handles add three scope kinds and their two identifiers.
  const scope = property('analyst_query').scope;
  scope.properties.kind.enum = scope.properties.kind.enum.filter(
    (kind) => !['area', 'drawn', 'annotation'].includes(kind),
  );
  delete scope.properties.areaId;
  delete scope.properties.id;
  // The analyst centre now requires a real coordinate.
  const center = property('analyst_query').scope.properties.center;
  delete center.required;
  for (const axis of ['lat', 'lon']) {
    delete center.properties[axis].minimum;
    delete center.properties[axis].maximum;
  }
  // Cyber adds one HUD layout and Operator was retired.
  const hud = property('set_hud').layout;
  assert.deepEqual(hud.enum, ['tactical', 'minimal', 'cyber']);
  hud.enum = ['tactical', 'operator', 'minimal'];
  // Snow is retired from set_visual_style; restore it to keep the legacy pin.
  const visualStyle = legacy.find((tool) => tool.name === 'set_visual_style')
    .parameters.properties.style;
  assert.deepEqual(visualStyle.enum, [
    'normal',
    'retro',
    'surveillance',
    'thermal',
    'anime',
    'noir',
  ]);
  visualStyle.enum = [...visualStyle.enum, 'snow'];
  // Derived by applying the same removals to the 4b56d0e9 actionSchemas.
  assert.equal(
    createHash('sha256').update(JSON.stringify(legacy)).digest('hex'),
    '01f14fdb1523eebfcbff8b115e48e6ab99e36fa06f55a3bb13c65e198f79d758',
  );
});

test('globe rotation is an additive camera motion with the existing control arguments', () => {
  const schema = GEV_ACTION_SCHEMAS.find(
    (tool) => tool.name === 'move_camera',
  ).parameters;
  for (const motion of ['rotate_globe', 'rotate', 'orbit', 'pan', 'tilt']) {
    assert.deepEqual(
      validateArgs(schema, {
        motion,
        direction: 'right',
        speed: 'slow',
        mode: 'continuous',
      }),
      [],
    );
  }
  assert.ok(validateArgs(schema, { motion: 'spin_camera' }).length > 0);
});

test('track_entity accepts a referent alone but rejects an empty target', () => {
  const schema = GEV_ACTION_SCHEMAS.find(
    (tool) => tool.name === 'track_entity',
  ).parameters;
  assert.deepEqual(validateArgs(schema, { referent: 2 }), []);
  assert.deepEqual(validateArgs(schema, { referent: -1 }), []);
  assert.deepEqual(validateArgs(schema, { query: 'UPS793' }), []);
  assert.ok(validateArgs(schema, {}).length > 0);
  assert.ok(validateArgs(schema, { query: '' }).length > 0);
  assert.ok(validateArgs(schema, { query: '   ' }).length > 0);
  assert.ok(validateArgs(schema, { referent: 0 }).length > 0);
  assert.ok(validateArgs(schema, { referent: 6 }).length > 0);
});

test('tools sent to the model never carry a top-level schema combinator', () => {
  for (const tool of createActionTools()) {
    assert.equal(tool.parameters.type, 'object', tool.name);
    for (const key of ['anyOf', 'oneOf', 'allOf', 'enum', 'not'])
      assert.equal(tool.parameters[key], undefined, `${tool.name}.${key}`);
  }
  // The runner still knows track_entity needs a query or a referent.
  const track = GEV_ACTION_SCHEMAS.find((s) => s.name === 'track_entity');
  assert.ok(track.parameters.anyOf);
});

test('the benchmark still rejects an empty track_entity although the model-facing tool omits anyOf', () => {
  assert.ok(
    validateCall(GEV_REALTIME_TOOLS, { name: 'track_entity', args: {} })
      .length > 0,
  );
  assert.deepEqual(
    validateCall(GEV_REALTIME_TOOLS, {
      name: 'track_entity',
      args: { referent: 2 },
    }),
    [],
  );
});

test('globe reset guidance requires a separate explicit command after refusal', () => {
  const paragraph = realtimeInstructions()
    .split('\n')
    .find((line) => line.includes('globe-view-required'));
  assert.ok(paragraph);
  assert.match(paragraph, /calls only move_camera motion rotate_globe/);
  assert.match(paragraph, /explicit user Reset\/Show Globe View/);
  assert.match(paragraph, /never from your own plan/);
  assert.match(paragraph, /bare yes\/ok/);
  assert.match(paragraph, /Do not ask a question/);
});

test('direct voice timeout schema accepts None and exact integers, rejects malformed duration', () => {
  const tool = GEV_REALTIME_TOOLS.find(
    (tool) => tool.name === 'set_voice_inactivity_timeout',
  );
  for (const minutes of [0, 1, 5, 60])
    assert.equal(validateArgs(tool.parameters, { minutes }).length, 0);
  for (const minutes of [-1, 61, 1.5, '5'])
    assert.ok(validateArgs(tool.parameters, { minutes }).length > 0);
});

test('tilt accepts an angle with no direction', () => {
  const schema = GEV_ACTION_SCHEMAS.find(
    (tool) => tool.name === 'move_camera',
  ).parameters;
  assert.deepEqual(validateArgs(schema, { motion: 'tilt', pitchDeg: -45 }), []);
  assert.deepEqual(validateArgs(schema, { motion: 'tilt' }), []);
  // No range in the schema (prompt budget): the runner clamps to -89..-5.
  assert.ok(
    validateArgs(schema, { motion: 'tilt', pitchDeg: 'steep' }).length > 0,
  );
});
