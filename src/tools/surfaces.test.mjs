import assert from 'node:assert/strict';
import test from 'node:test';
import {
  TOOL_SURFACES,
  catalogForSurface,
  composeCatalog,
  coreTools,
  defineTool,
  toolsForSurface,
} from './index.js';

const names = (tools) => tools.map((tool) => tool.name);

test('each surface offers the tools the table does not turn off', () => {
  for (const surface of ['mcp', 'voice']) {
    const offered = names(toolsForSurface(coreTools, surface));
    const expected = names(coreTools).filter(
      (name) => TOOL_SURFACES[name]?.[surface] !== false,
    );
    assert.deepEqual(offered, expected, surface);
  }
  const mcp = names(toolsForSurface(coreTools, 'mcp'));
  for (const name of [
    'show_in_gods_eye_view',
    'situation_brief',
    'aircraft_in_area',
  ])
    assert.ok(mcp.includes(name), name);
  for (const name of [
    'search_places',
    'plan_route',
    'get_weather',
    'get_hud_caption',
  ])
    assert.ok(!mcp.includes(name), name);
  const voice = names(toolsForSurface(coreTools, 'voice'));
  assert.ok(voice.includes('get_weather'));
  assert.ok(voice.includes('military_awareness'));
  assert.ok(!voice.includes('aircraft_in_area'));
});

test('overrides turn a tool on or off for one surface', () => {
  const voice = names(
    toolsForSurface(coreTools, 'voice', {
      get_weather_map: { voice: true },
      get_weather: { voice: false },
    }),
  );
  assert.ok(voice.includes('get_weather_map'));
  assert.ok(!voice.includes('get_weather'));
  assert.ok(
    !names(
      toolsForSurface(coreTools, 'mcp', { get_weather: { mcp: false } }),
    ).includes('get_weather'),
  );
});

test('every table entry names a core tool and a known surface', () => {
  const names = new Set(coreTools.map((tool) => tool.name));
  for (const [name, entry] of Object.entries(TOOL_SURFACES)) {
    assert.ok(names.has(name), name);
    for (const key of Object.keys(entry))
      assert.ok(['voice', 'mcp'].includes(key), `${name}: ${key}`);
  }
});

test('a surface view hides tools from clients but not from composites', async () => {
  const leaf = defineTool({
    name: 'leaf',
    title: 'Leaf',
    description: 'A hidden building block.',
    inputSchema: { type: 'object', properties: {} },
    run: async () => ({ summary: 'leaf', data: {} }),
  });
  const outer = defineTool({
    name: 'outer',
    title: 'Outer',
    description: 'Calls leaf.',
    inputSchema: { type: 'object', properties: {} },
    run: async (args, { tools }) => tools.call('leaf', {}),
  });
  const view = catalogForSurface(
    composeCatalog({ tools: [leaf, outer] }),
    'voice',
    { leaf: { voice: false } },
  );
  assert.deepEqual(
    view.list().map((tool) => tool.name),
    ['outer'],
  );
  assert.equal(view.get('leaf'), undefined);
  await assert.rejects(
    view.call('leaf', {}),
    (error) => error.code === 'unsupported',
  );
  assert.equal((await view.call('outer', {})).summary, 'leaf');
});

test('unknown surfaces and tool names are rejected', () => {
  assert.throws(
    () => toolsForSurface(coreTools, 'email'),
    /Unknown tool surface/,
  );
  assert.throws(
    () => toolsForSurface(coreTools, 'voice', { get_wether: { voice: false } }),
    /Unknown tool: get_wether/,
  );
  assert.throws(
    () =>
      toolsForSurface(coreTools, 'voice', { get_weather: { voise: false } }),
    /Unknown tool surface for get_weather: voise/,
  );
});
