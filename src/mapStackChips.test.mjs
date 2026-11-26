import { readShellSource } from './testSupport/readShellSource.mjs';
import { renderApplicationHtml } from './testSupport/applicationHtml.mjs';
// MAP STACK chip row — the dropdown's replacement control surface.
//
// The owner's complaint was two clicks (open panel → open dropdown) to change
// basemap. These tests pin the chip models: the owner-approved allowlist
// projected from the controller's stack data, one active chip, and the reason
// an unavailable chip gives. Visual's rendering and clicks are pinned in
// src/ui/displayPanelActions.test.mjs. Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  PRESENTED_MAP_STACK_IDS,
  mapStackChipModel,
  mapStackChipModels,
} from './mapStackChips.js';
import { createMapSourceControls } from './ui/mapSourceControls.js';

// Shaped exactly like MapStackController.getStacks() output.
const CONTROLLER_STACKS = [
  {
    id: 'photoreal',
    label: 'Google 3D',
    requiresIon: false,
    available: true,
    unavailableReason: null,
  },
  {
    id: 'bing-aerial',
    label: 'Bing Aerial',
    requiresIon: true,
    available: true,
    unavailableReason: null,
  },
  {
    id: 'bing-labels',
    label: 'Bing Labels',
    requiresIon: true,
    available: true,
    unavailableReason: null,
  },
  {
    id: 'esri-imagery',
    label: 'Esri Satellite',
    requiresIon: false,
    available: true,
    unavailableReason: null,
  },
  {
    id: 'osm',
    label: 'OSM',
    requiresIon: false,
    available: true,
    unavailableReason: null,
  },
];

/** The chips Map Source controls publish for `stacks`, as the dock renders them. */
function publishedChips(stacks, activeId) {
  const views = [];
  createMapSourceControls({
    controller: {
      getStacks: () => stacks,
      getActiveId: () => activeId,
      getState: () => ({
        activeId,
        activeStack: stacks.find((stack) => stack.id === activeId),
        status: 'ready',
      }),
      setStack: async () => null,
    },
    subscribe: () => () => {},
    publish: (view) => views.push(view),
  });
  return views.at(-1).chips;
}

test('the row presents exactly the five owner-approved sources', () => {
  const chips = mapStackChipModels(CONTROLLER_STACKS, 'photoreal');
  assert.deepEqual(
    chips.map((chip) => chip.id),
    ['photoreal', 'bing-aerial', 'bing-labels', 'esri-imagery', 'osm'],
  );
  assert.deepEqual(
    chips.map((chip) => chip.label),
    ['Google 3D', 'Bing Aerial', 'Bing Labels', 'Esri Satellite', 'OSM'],
  );
  assert.deepEqual(PRESENTED_MAP_STACK_IDS, [
    'photoreal',
    'bing-aerial',
    'bing-labels',
    'esri-imagery',
    'osm',
  ]);
});

test('internal and future stacks stay outside the approved presentation set', () => {
  // A future Hybrid stack may land in the controller, but it must not appear
  // until the owner-approved presentation allowlist explicitly includes it.
  const withHybrid = [
    ...CONTROLLER_STACKS,
    { id: 'hybrid', label: 'Hybrid', available: true },
  ];
  const chips = mapStackChipModels(withHybrid, 'photoreal');

  assert.equal(chips.length, 5);
  assert.ok(chips.every((chip) => chip.id !== 'hybrid'));
});

test('the active chip is the only active chip', () => {
  assert.deepEqual(
    mapStackChipModels(CONTROLLER_STACKS, 'bing-labels')
      .filter((chip) => chip.active)
      .map((chip) => chip.id),
    ['bing-labels'],
  );
});

test('keyless ion stacks are unavailable, badged, and say why', () => {
  const keyless = CONTROLLER_STACKS.map((stack) =>
    stack.requiresIon
      ? {
          ...stack,
          available: false,
          unavailableReason:
            'Needs CESIUM_ION_TOKEN — add it in Provider Settings',
        }
      : stack,
  );
  const chips = publishedChips(keyless, 'photoreal');
  const bingAerial = chips[1];

  assert.equal(bingAerial.available, false);
  assert.equal(bingAerial.requirement, 'ION');
  assert.equal(
    bingAerial.ariaLabel,
    'Bing Aerial unavailable: Needs CESIUM_ION_TOKEN — add it in Provider Settings',
  );
  assert.equal(
    bingAerial.title,
    'Needs CESIUM_ION_TOKEN — add it in Provider Settings',
  );
  assert.equal(chips[3].available, true, 'Esri stays selectable');
  assert.equal(chips[3].ariaLabel, null);
});

test('a non-ion stack that fails never claims an ion token is required', () => {
  // The startup fallback-to-OSM case: Google 3D tiles failed to load, so
  // photoreal is unavailable for a reason that has nothing to do with ion.
  const tilesFailed = CONTROLLER_STACKS.map((stack) =>
    stack.id === 'photoreal'
      ? {
          ...stack,
          available: false,
          unavailableReason:
            'Needs GOOGLE_MAPS_API_KEY — add it in Provider Settings',
        }
      : stack,
  );
  const chips = publishedChips(tilesFailed, 'osm');
  const google = chips[0];

  assert.equal(google.available, false);
  assert.equal(
    google.ariaLabel,
    'Google 3D unavailable: Needs GOOGLE_MAPS_API_KEY — add it in Provider Settings',
  );
  assert.equal(
    google.requirement,
    '',
    'no ION badge on a stack that does not need ion',
  );
  assert.equal(
    google.title,
    'Needs GOOGLE_MAPS_API_KEY — add it in Provider Settings',
  );
  assert.equal(chips[1].requirement, '', 'available ion stacks stay unbadged');
});

test("models carry the stack's own reason and never invent an active chip", () => {
  assert.deepEqual(mapStackChipModels([{ id: 'osm', label: 'OSM' }], null), [
    {
      id: 'osm',
      label: 'OSM',
      available: true,
      active: false,
      requiresIon: false,
      requirement: '',
      unavailableHint: '',
      title: 'OSM',
    },
  ]);

  // A stack list without a controller-supplied reason still explains itself.
  assert.deepEqual(
    [
      mapStackChipModel(
        {
          id: 'bing-aerial',
          label: 'Bing Aerial',
          requiresIon: true,
          available: false,
        },
        null,
      ),
      mapStackChipModel(
        { id: 'hybrid', label: 'Hybrid', available: false },
        null,
      ),
    ].map(({ requirement, unavailableHint, title }) => ({
      requirement,
      unavailableHint,
      title,
    })),
    [
      {
        requirement: 'ION',
        unavailableHint: 'Needs CESIUM_ION_TOKEN — add it in Provider Settings',
        title: 'Needs CESIUM_ION_TOKEN — add it in Provider Settings',
      },
      {
        requirement: '',
        unavailableHint: 'Hybrid is unavailable',
        title: 'Hybrid is unavailable',
      },
    ],
  );

  assert.deepEqual(mapStackChipModels(undefined, 'osm'), []);
});

test('the Visual panel owns Map Source and the retired left panel is absent', async () => {
  const html = await renderApplicationHtml(
    readFileSync(new URL('../index.html', import.meta.url), 'utf8'),
  );
  const ui = readShellSource();

  assert.doesNotMatch(
    html,
    /map-stack-select/,
    'the SOURCE dropdown is replaced by the chip row',
  );
  assert.doesNotMatch(
    html,
    /id="stack-panel"/,
    'the duplicate left MAP STACK panel is retired',
  );
  assert.match(
    html,
    /id="pp-toggles"[\s\S]*?class="visual-presets"[\s\S]*?class="visual-presets__heading visual-presets__heading--row"/,
    'Visual holds the Map source row',
  );

  const controls = readFileSync(
    new URL('./ui/mapSourceControls.js', import.meta.url),
    'utf8',
  );
  assert.match(
    ui,
    /return this\._mapSourceControls\.select\(stackId, \{ syncShare \}\)/,
    'the application action uses the component selection path',
  );
  const visual = readFileSync(
    new URL('./ui/views/panels/VisualPresets.vue', import.meta.url),
    'utf8',
  );
  assert.match(
    visual,
    /mapSourceControls\.value\?\.select\(chip\.id\)/,
    'chip clicks use the same component selection path',
  );
  assert.match(
    controls,
    /await controller\.setStack\(stackId\)/,
    'selection still delegates source loading to the map controller',
  );
  assert.match(
    controls,
    /render\(controller\.getState\(\)\)/,
    'the active chip is re-synced from actual controller state',
  );
  assert.match(
    ui,
    /window\.addEventListener\('gev:map-stack-changed', onChange\)/,
    'provider-driven fallback reaches the component without a user click',
  );
  assert.match(
    ui,
    /window\.removeEventListener\('gev:map-stack-changed', onChange\)/,
    'the provider-driven subscription has an explicit remover',
  );
  assert.match(
    controls,
    /unsubscribe\?\.\(\)/,
    'component destruction releases its subscription',
  );
});

test('a registered source marked presented shows after the approved ones', () => {
  const chips = mapStackChipModels(
    [
      { id: 'plain', label: 'Plain', available: true, presented: true },
      ...CONTROLLER_STACKS,
      { id: 'hidden', label: 'Hidden', available: true },
    ],
    'plain',
  );
  assert.deepEqual(
    chips.map((chip) => chip.id),
    ['photoreal', 'bing-aerial', 'bing-labels', 'esri-imagery', 'osm', 'plain'],
  );
  assert.equal(chips.at(-1).active, true);
});
