import { readShellSource } from './testSupport/readShellSource.mjs';
import { renderApplicationHtml } from './testSupport/applicationHtml.mjs';
import { readStylesheet } from './testSupport/readStylesheet.mjs';
// MAP STACK chip row — the dropdown's replacement control surface.
//
// The owner's complaint was two clicks (open panel → open dropdown) to change
// basemap. These tests pin the chip models: the owner-approved allowlist
// projected from the controller's stack data, one active chip, and the reason
// an unavailable chip gives. The dock's rendering and clicks are pinned in
// src/ui/commandDock.test.mjs. Run with: npm test
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

test('the active cyan survives hover', () => {
  const css = readStylesheet(new URL('../style.css', import.meta.url));
  const hover = css.indexOf('.map-stack-chip:hover');
  const active = css.indexOf('.map-stack-chip.active {');
  const unavailable = css.indexOf('.map-stack-chip.unavailable');

  assert.ok(
    hover > 0 && active > hover,
    'active must follow hover so it wins at equal specificity',
  );
  assert.ok(
    unavailable > active,
    'unavailable must follow both so a keyless chip never lights up',
  );
  assert.doesNotMatch(
    css.slice(hover, active),
    /:not\(/,
    'a :not() in the hover selector outranks .active and washes the cyan out on hover',
  );
});

test('the keyboard focus ring survives on the ACTIVE chip', () => {
  // The bug this pins: `.active` legitimately wins the color/border/background/
  // box-shadow it shares with the focus rule, and the base rule sets
  // `outline: none` — so a focus state built only from those properties is
  // INVISIBLE on the active chip. The ring must live on a property no other
  // chip-state rule sets.
  const css = readStylesheet(new URL('../style.css', import.meta.url));
  const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '');
  const chipRules = [
    ...css.matchAll(/([^{}]*\.map-stack-chip[^{}]*)\{([^{}]*)\}/g),
  ].map(([, selector, body], order) => ({
    selector: stripComments(selector).trim(),
    body: stripComments(body),
    order,
  }));
  assert.ok(chipRules.length >= 5, 'expected the chip state rules to be found');

  const ringIndex = chipRules.findIndex(
    ({ selector, body }) =>
      selector.includes(':focus-visible') &&
      /outline:\s*(?!none)\S/.test(body) &&
      /outline-offset:/.test(body),
  );
  assert.ok(
    ringIndex >= 0,
    'a :focus-visible rule must draw a real outline ring',
  );

  // Nothing after it may touch outline again, so the ring cannot be erased by
  // .active, :disabled, or anything added later.
  for (const rule of chipRules.slice(ringIndex + 1)) {
    assert.doesNotMatch(
      rule.body,
      /outline/,
      `"${rule.selector}" must not touch outline — it would erase the focus ring`,
    );
  }
  for (const selector of [
    '.map-stack-chip.active',
    '.map-stack-chip.unavailable',
  ]) {
    assert.ok(
      chipRules.some((rule) => rule.selector.includes(selector)),
      `expected a ${selector} rule to exist for this check to mean anything`,
    );
  }

  // `transition: all` animates outline-width off the `outline: none` base, and
  // Chrome parks that transition at 0px for chips on a wrapped line — the ring
  // never appeared on rows 2 and 3. The base rule must list its properties.
  const base = chipRules.find((rule) =>
    rule.selector.endsWith('.map-stack-chip'),
  );
  assert.ok(base, 'expected the base .map-stack-chip rule');
  assert.doesNotMatch(
    base.body,
    /transition:\s*all\b/,
    'transition: all animates outline-width and kills the focus ring on wrapped rows',
  );
  assert.doesNotMatch(
    base.body,
    /transition:[^;]*outline/,
    'the focus ring must not be animated',
  );
  assert.match(
    base.body,
    /transition:\s*\n?\s*color/,
    'the hover/active treatment still animates',
  );
});

test('the Visual Presets tray owns Map Source and the retired left panel is absent', async () => {
  const html = await renderApplicationHtml(
    readFileSync(new URL('../index.html', import.meta.url), 'utf8'),
  );
  const ui = readShellSource();

  assert.doesNotMatch(
    html,
    /map-stack-select/,
    'the SOURCE dropdown is replaced by the chip row',
  );
  assert.match(
    html,
    /<section class="map-source-section"[\s\S]*?<div id="map-stack-chips" class="map-stack-chip-row" role="group" aria-label="Map source"><\/div>/,
  );
  assert.doesNotMatch(
    html,
    /id="stack-panel"/,
    'the duplicate left MAP STACK panel is retired',
  );
  assert.match(
    html,
    /id="map-source-label">MAP SOURCE<[\s\S]*?id="map-stack-status"/,
  );
  assert.match(
    html,
    /<button id="control-panel-toggle"[\s\S]*?data-dock-toggle-target="control-panel"[\s\S]*?aria-controls="control-panel-popover"/,
    'the compact wing must expose a semantic keyboard disclosure',
  );
  const panels = readFileSync(
    new URL('./ui/panelDisclosure.js', import.meta.url),
    'utf8',
  );
  assert.match(panels, /event\.key !== 'Escape'[\s\S]*?disclosure\?\.focus/);
  assert.match(
    ui,
    /querySelector\(\s*'\.map-stack-chip\.active',?\s*\)\s*\|\|\s*panel\.querySelector\('\.map-stack-chip'\)/,
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
  const dock = readFileSync(
    new URL('./ui/views/CommandDockView.vue', import.meta.url),
    'utf8',
  );
  assert.match(
    dock,
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
