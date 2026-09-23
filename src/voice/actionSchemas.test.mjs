import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { GEV_ACTION_SCHEMAS, createActionTools } from './actionSchemas.js';
import { GEV_REALTIME_TOOLS } from '../../server/providers/openai/tools.js';

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

test('the complete Realtime tool payload pins the additive analyst, satellite, Local ADS-B, Cyber and Repeaters release', () => {
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
    // Re-derived for the Cyber HUD layout, the Fire Perimeters layer and the
    // additive `show_ham_repeaters` tool with its `ham-repeaters` /
    // `ham-repeaters-panel` enum values; the sonar tool is excluded above.
    '6ddd92c6a59be59a10f9e276bb18087ebbc7c6eafdde7d19a013a728ca5a18b9',
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
    (tool) =>
      ![
        'next_satellite_pass',
        'set_cyber_sonar',
        'show_ham_repeaters',
      ].includes(tool.name),
  );
  const layers = legacy.find((tool) => tool.name === 'analyst_query').parameters
    .properties.layers.items;
  layers.enum = layers.enum.filter(
    (key) =>
      ![
        'satellites',
        'local-datacenters',
        'local-dams',
        'fire-perimeters',
      ].includes(key),
  );
  // Local ADS-B is an additive set_layer_visibility enum value.
  const visibility = legacy.find((tool) => tool.name === 'set_layer_visibility')
    .parameters.properties.layerId;
  visibility.enum = visibility.enum.filter(
    (key) => !['local-adsb', 'fire-perimeters', 'ham-repeaters'].includes(key),
  );
  for (const tool of legacy) {
    for (const value of Object.values(tool.parameters.properties)) {
      if (value.enum)
        value.enum = value.enum.filter((key) => key !== 'fire-perimeters');
    }
  }
  // Repeaters is additive in three enums and one whole tool.
  const menu = legacy.find((tool) => tool.name === 'show_data_layers_menu')
    .parameters.properties.layerId;
  menu.enum = menu.enum.filter((key) => key !== 'ham-repeaters');
  const panels = legacy.find((tool) => tool.name === 'set_panel_open')
    .parameters.properties.panelId;
  panels.enum = panels.enum.filter((key) => key !== 'ham-repeaters-panel');
  // Independently derived by executing trusted c9f9896 actionSchemas in the restricted container.
  const hud = legacy.find((tool) => tool.name === 'set_hud').parameters
    .properties.layout;
  hud.enum = hud.enum.filter((layout) => layout !== 'cyber');
  assert.equal(
    createHash('sha256').update(JSON.stringify(legacy)).digest('hex'),
    '820fff21658f6907e1010b2b79c5431a77f4e34afd2277d62d8de46c368b6f8c',
  );
});
