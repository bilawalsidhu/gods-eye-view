import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CONSOLE_MODULES,
  VISUAL_PRESETS,
  buildCommands,
  filterCommands,
  scoreMatch,
} from './commands.js';

const LAYERS = [
  { id: 'flights', name: 'Flights', enabled: true, stats: { count: 800 } },
  { id: 'local-firms', name: 'Active Fires', enabled: false, keyRequired: true },
  { id: 'radio', name: 'Radio', enabled: false },
];
const PLACES = [
  { id: 'tokyo', name: 'Tokyo' },
  { id: 'san-francisco', name: 'San Francisco' },
];

function registry(actions = {}, overrides = {}) {
  return buildCommands({
    layers: LAYERS,
    places: PLACES,
    activeStyle: 'thermal',
    isPanelOpen: (panelId) => panelId === 'data-panel',
    actions,
    ...overrides,
  });
}

test('the registry covers every place, layer, preset, module and console action', () => {
  const commands = registry();
  const ids = commands.map((command) => command.id);
  assert.equal(new Set(ids).size, ids.length, 'command ids are unique');
  for (const place of PLACES) assert.ok(ids.includes(`place:${place.id}`));
  for (const layer of LAYERS) assert.ok(ids.includes(`layer:${layer.id}`));
  for (const preset of VISUAL_PRESETS) assert.ok(ids.includes(`style:${preset.id}`));
  for (const module of CONSOLE_MODULES)
    assert.ok(ids.includes(`panel:${module.panelId}`));
  assert.ok(ids.includes('system:classic'));
});

test('a command names the state it will move the application to', () => {
  const commands = registry();
  const byId = (id) => commands.find((command) => command.id === id);
  assert.match(byId('layer:flights').title, /^Disable Flights$/);
  assert.match(byId('layer:radio').title, /^Enable Radio$/);
  // Open panels offer to close, and the applied preset is marked, not offered
  // as a fresh action with no effect.
  assert.match(byId('panel:data-panel').title, /^Close /);
  assert.match(byId('panel:cctv-panel').title, /^Open /);
  assert.equal(byId('style:thermal').state, 'ACTIVE');
  assert.equal(byId('style:noir').state, '');
});

test('a layer held back by a missing key is offered but not runnable', () => {
  const fires = registry().find((command) => command.id === 'layer:local-firms');
  assert.equal(fires.disabled, true);
  assert.match(fires.subtitle, /provider key/i);
});

test('running a command delegates to the owner of the behaviour', async () => {
  const calls = [];
  const commands = registry({
    flyToPlace: (id) => calls.push(['fly', id]),
    setLayerEnabled: (id, next) => calls.push(['layer', id, next]),
    applyStyle: (name) => calls.push(['style', name]),
    togglePanel: (panelId) => calls.push(['panel', panelId]),
    standDown: () => calls.push(['standDown']),
  });
  for (const id of [
    'place:tokyo',
    'layer:flights',
    'style:noir',
    'panel:radio-panel',
    'system:classic',
  ])
    commands.find((command) => command.id === id).run();
  assert.deepEqual(calls, [
    ['fly', 'tokyo'],
    ['layer', 'flights', false],
    ['style', 'noir'],
    ['panel', 'radio-panel'],
    ['standDown'],
  ]);
});

test('an action the console does not supply is a no-op, not a crash', () => {
  const command = registry({}).find((entry) => entry.id === 'place:tokyo');
  assert.doesNotThrow(() => command.run());
});

test('scoring prefers a prefix, then a contained word, then a subsequence', () => {
  const prefix = scoreMatch('tokyo fly go city', 'tok');
  const word = scoreMatch('fly to tokyo', 'tokyo');
  const loose = scoreMatch('toggle keyboard yield', 'tky');
  assert.ok(prefix > word, 'a prefix outranks a contained match');
  assert.ok(word > loose, 'a contained match outranks a subsequence');
  assert.equal(scoreMatch('tokyo', 'paris'), 0, 'a miss scores zero');
  assert.equal(scoreMatch('anything', ''), 1, 'an empty query matches all');
});

test('filtering ranks matches, drops misses and holds the section order', () => {
  const commands = registry();
  const tokyo = filterCommands(commands, 'tokyo');
  assert.equal(tokyo[0].id, 'place:tokyo');
  assert.ok(!tokyo.some((command) => command.id === 'place:san-francisco'));
  assert.deepEqual(filterCommands(commands, 'zzzzqqq'), []);

  const all = filterCommands(commands, '', 200);
  const sections = [...new Set(all.map((command) => command.section))];
  assert.deepEqual(sections, ['NAVIGATE', 'FEEDS', 'VISUAL', 'MODULES', 'CONSOLE']);
  assert.equal(filterCommands(commands, '', 3).length, 3, 'the limit is honoured');
});
