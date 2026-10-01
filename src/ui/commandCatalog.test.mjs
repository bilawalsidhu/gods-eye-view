import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_COMMAND_CATALOG,
  createCommandCatalog,
  searchCommandCatalog,
} from './commandCatalog.js';

test('default commands are schema-valid typed actions with unique ids', () => {
  assert.ok(DEFAULT_COMMAND_CATALOG.length >= 10);
  assert.equal(
    new Set(DEFAULT_COMMAND_CATALOG.map(({ id }) => id)).size,
    DEFAULT_COMMAND_CATALOG.length,
  );
  assert.ok(
    DEFAULT_COMMAND_CATALOG.every(({ action }) => action?.name && action?.args),
  );
});

test('catalog rejects actions or arguments that are not in the canonical schema', () => {
  assert.throws(
    () =>
      createCommandCatalog([
        {
          id: 'made-up',
          label: 'Made Up',
          group: 'Test',
          keywords: [],
          action: { name: 'does_not_exist', args: {} },
        },
      ]),
    /Unknown command action/,
  );

  assert.throws(
    () =>
      createCommandCatalog([
        {
          id: 'open-weather',
          label: 'Open Weather',
          group: 'Panels',
          keywords: ['weather'],
          action: {
            name: 'set_panel_open',
            args: { panelId: 'weather-panel', open: true },
          },
        },
      ]),
    /schema enum/,
    'the visible Weather panel is not currently a legal set_panel_open target',
  );

  assert.throws(
    () =>
      createCommandCatalog([
        {
          id: 'bad-panel-args',
          label: 'Bad Panel Args',
          group: 'Panels',
          keywords: [],
          action: {
            name: 'set_panel_open',
            args: { panelId: 'cctv-panel' },
          },
        },
      ]),
    /missing required open/,
  );
});

test('search ranks exact and label-prefix matches ahead of keyword-only matches', () => {
  const catalog = createCommandCatalog();
  assert.equal(
    searchCommandCatalog(catalog, 'open cameras')[0].id,
    'open-cameras',
  );
  assert.equal(searchCommandCatalog(catalog, 'thermal')[0].id, 'style-thermal');
  assert.equal(
    searchCommandCatalog(catalog, 'missions')[0].id,
    'space-missions-context',
  );
});

test('multi-token search requires every token and stays deterministic', () => {
  const catalog = createCommandCatalog();
  assert.deepEqual(
    searchCommandCatalog(catalog, 'camera panel').map(({ id }) => id),
    ['open-cameras'],
  );
  assert.deepEqual(searchCommandCatalog(catalog, 'does not exist'), []);
  assert.deepEqual(
    searchCommandCatalog(catalog, '', { limit: 2 }).map(({ id }) => id),
    ['open-data-layers', 'open-cameras'],
  );
});

test('catalog metadata cannot mutate the canonical action schema', () => {
  const catalog = createCommandCatalog();
  assert.throws(() => {
    catalog[0].action.args.open = false;
  }, TypeError);
});
