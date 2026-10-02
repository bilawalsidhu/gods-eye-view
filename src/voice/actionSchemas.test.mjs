import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { GEV_ACTION_SCHEMAS, createActionTools } from './actionSchemas.js';
import { GEV_REALTIME_TOOLS } from '../../server/providers/openai/tools.js';
import { validateArgs } from '../../scripts/voice-bench/grade.mjs';

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
    // Re-derived for the voice layer manifest (generated layer enums and
    // aliases), point-and-ask (pointer sentinels, referent args) and the
    // consolidated tool wording (each policy stated once).
    'a824c2ed0ceb553eb3041350856db05dbfc5abad8a3fa17d29dc378bf7a732d2',
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
    (tool) => !['next_satellite_pass', 'set_cyber_sonar'].includes(tool.name),
  );
  // Layer enums are generated from the voice layer manifest and pinned by
  // layerManifest.test.mjs; the two shipped right-rail panels are additive.
  const property = (name) =>
    legacy.find((tool) => tool.name === name).parameters.properties;
  delete property('set_layer_visibility').layerId.enum;
  delete property('show_data_layers_menu').layerId.enum;
  delete property('get_entity_context').layerId.enum;
  delete property('analyst_query').layers.items.enum;
  const panels = property('set_panel_open').panelId;
  panels.enum = panels.enum.filter(
    (id) => !['weather-panel', 'recent-imagery-panel'].includes(id),
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
  // The analyst centre now requires a real coordinate.
  const center = property('analyst_query').scope.properties.center;
  delete center.required;
  for (const axis of ['lat', 'lon']) {
    delete center.properties[axis].minimum;
    delete center.properties[axis].maximum;
  }
  // Cyber adds one HUD layout.
  const hud = property('set_hud').layout;
  hud.enum = hud.enum.filter((layout) => layout !== 'cyber');
  // Derived by applying the same removals to the 4b56d0e9 actionSchemas.
  assert.equal(
    createHash('sha256').update(JSON.stringify(legacy)).digest('hex'),
    '01f14fdb1523eebfcbff8b115e48e6ab99e36fa06f55a3bb13c65e198f79d758',
  );
});

test('track_entity accepts a referent alone but rejects an empty target', () => {
  const schema = GEV_REALTIME_TOOLS.find(
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
