// src/scenes/interactionsView.test.mjs — the Scene actions panel renders in
// the viewer's container from what the scene interactions owner presents.
import '../testSupport/registerDom.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp, nextTick } from 'vue';
import { createPinia } from 'pinia';
import { useSceneInteractionsStore } from '../ui/stores/sceneInteractions.js';
import SceneInteractions from '../ui/views/panels/SceneInteractions.vue';
import { createSceneInteractions } from './interactions.js';

const target = (featureId) => ({ packId: 'qa', featureId });
const key = (featureId) => JSON.stringify(['qa', featureId]);
const SHOT = {
  interactions: [
    {
      id: 'card',
      label: 'Read about it',
      target: target('point'),
      action: { type: 'card', text: 'A note.', url: 'https://example.com/a' },
    },
    {
      id: 'fly',
      label: 'Fly there',
      target: target('point'),
      action: { type: 'fly' },
    },
  ],
};

function fixture(t, { execute = async () => true } = {}) {
  document.body.replaceChildren();
  const container = document.body.appendChild(document.createElement('div'));
  const canvas = container.appendChild(document.createElement('canvas'));
  const pinia = createPinia();
  const app = createApp(SceneInteractions).use(pinia);
  app.mount(document.body.appendChild(document.createElement('div')));
  const executed = [];
  const interactions = createSceneInteractions(
    { container, scene: { canvas, pick: () => null } },
    {
      execute: (action, signal) => {
        executed.push(action.type);
        return execute(action, signal);
      },
      store: useSceneInteractionsStore(pinia),
    },
  );
  t.after(() => {
    interactions.destroy();
    app.unmount();
  });
  const $ = (selector) => container.querySelector(selector);
  const settle = async () => {
    for (let flush = 0; flush < 4; flush += 1) await nextTick();
  };
  return { interactions, container, executed, $, settle, pinia };
}

test('a shot with actions shows its panel in the viewer container', async (t) => {
  const { interactions, $, settle } = fixture(t);
  assert.equal($('[data-director-interactions]'), null);
  interactions.activate(SHOT, new Map([[key('point'), {}]]));
  await settle();
  const panel = $('[data-director-interactions]');
  assert.equal(panel.tagName, 'SECTION');
  assert.equal(panel.getAttribute('aria-label'), 'Scene actions');
  assert.equal(panel.style.position, 'absolute');
  assert.equal(panel.style.zIndex, '31');
  assert.equal(panel.querySelector('strong').textContent, 'Scene actions');
  assert.equal(
    panel.querySelector('[role=status]').textContent,
    'Select a feature or use Tab and Enter to choose an action.',
  );
  const buttons = [...panel.querySelectorAll('button')];
  assert.deepEqual(
    buttons.map((button) => [
      button.dataset.directorAction,
      button.textContent,
    ]),
    [
      ['card', 'Read about it'],
      ['fly', 'Fly there'],
    ],
  );
  assert.ok(buttons.every((button) => button.type === 'button'));
  assert.deepEqual(
    buttons.map((button) => button.getAttribute('aria-pressed')),
    ['false', 'false'],
  );
  assert.equal($('[data-director-action-card]').children.length, 0);
});

test('an action reports its outcome and a card action shows its text and source', async (t) => {
  const { interactions, executed, $, settle } = fixture(t);
  interactions.activate(SHOT, new Map([[key('point'), {}]]));
  await settle();
  $('[data-director-action="card"]').click();
  await settle();
  const card = $('[data-director-action-card]');
  assert.equal(card.querySelector('p').textContent, 'A note.');
  const link = card.querySelector('a');
  assert.equal(link.textContent, 'Source');
  assert.equal(link.getAttribute('href'), 'https://example.com/a');
  assert.equal(link.target, '_blank');
  assert.equal(link.rel, 'noopener noreferrer');
  assert.equal($('[role=status]').textContent, 'Action complete');
  const card1 = $('[data-director-action="card"]');
  assert.equal(card1.getAttribute('aria-pressed'), 'true');
  // happy-dom orders the shorthand its own way.
  assert.deepEqual(card1.style.outline.split(' ').sort(), [
    '#6eeaff',
    '2px',
    'solid',
  ]);
  $('[data-director-action="fly"]').click();
  await settle();
  assert.deepEqual(executed, ['fly']);
  assert.equal(card.children.length, 0, 'another action clears the card');
  assert.equal($('[data-director-action="card"]').style.outline, '');
});

test('buttons are disabled while an action runs, and clearing removes the panel', async (t) => {
  let finish;
  const { interactions, $, settle } = fixture(t, {
    execute: () => new Promise((resolve) => (finish = resolve)),
  });
  interactions.activate(SHOT, new Map([[key('point'), {}]]));
  await settle();
  $('[data-director-action="fly"]').click();
  await settle();
  assert.ok(
    [...$('[data-director-interactions]').querySelectorAll('button')].every(
      (button) => button.disabled,
    ),
  );
  finish(false);
  await settle();
  assert.equal(
    $('[role=status]').textContent,
    'Action unavailable or cancelled',
  );
  interactions.clear();
  await settle();
  assert.equal($('[data-director-interactions]'), null);
});

test('a button from an earlier panel cannot run the replacement actions', async (t) => {
  const { interactions, executed, $, settle } = fixture(t);
  interactions.activate(SHOT, new Map([[key('point'), {}]]));
  await settle();
  const old = $('[data-director-action="fly"]');
  interactions.clear();
  await settle();
  interactions.activate(SHOT, new Map([[key('point'), {}]]));
  await settle();
  assert.ok(old !== $('[data-director-action="fly"]'));
  old.click();
  await settle();
  assert.deepEqual(executed, []);
  assert.equal(interactions.getState().selected, null);
});

test('a button reused before the next render still belongs to its own panel', async (t) => {
  const { interactions, executed, $, settle } = fixture(t);
  interactions.activate(SHOT, new Map([[key('point'), {}]]));
  await settle();
  const old = $('[data-director-action="fly"]');
  interactions.activate(SHOT, new Map([[key('point'), {}]]));
  old.click();
  await settle();
  assert.deepEqual(executed, []);
  assert.ok(old !== $('[data-director-action="fly"]'));
  assert.equal(old.isConnected, false);
});

test("an earlier owner leaves a later owner's panel alone", async (t) => {
  const { interactions, container, $, settle, pinia } = fixture(t);
  const later = createSceneInteractions(
    { container, scene: { canvas: $('canvas'), pick: () => null } },
    { execute: async () => true, store: useSceneInteractionsStore(pinia) },
  );
  t.after(() => later.destroy());
  interactions.activate(SHOT, new Map([[key('point'), {}]]));
  later.activate(SHOT, new Map([[key('point'), {}]]));
  interactions.destroy();
  await settle();
  assert.ok($('[data-director-interactions]'));
  $('[data-director-action="fly"]').click();
  await settle();
  assert.equal(later.getState().selected, 'fly');
});
