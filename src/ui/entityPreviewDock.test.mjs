// src/ui/entityPreviewDock.test.mjs — a docked view's card: Show here brings
// the view back into the card and keeps keyboard focus with it.
import '../testSupport/registerDom.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPinia } from 'pinia';
import { createApp, h, nextTick } from 'vue';
import EntityPreview from './views/panels/EntityPreview.vue';
import { useDockedStore } from './stores/docked.js';

test('Show here moves focus to the view it brings back, not the page', async (t) => {
  document.body.replaceChildren();
  const host = document.body.appendChild(document.createElement('div'));
  const pinia = createPinia();
  const docked = useDockedStore(pinia);
  const card = {
    key: 'street-level:p1',
    kind: 'photo',
    layerId: 'street-level',
    title: 'Main St',
    identity: { layerId: 'street-level', id: 'p1' },
  };
  docked.dock({
    key: card.key,
    kind: 'street',
    title: 'Main St',
    identity: card.identity,
  });
  const app = createApp({
    render: () => h(EntityPreview, { card, title: 'Main St' }),
  }).use(pinia);
  app.mount(host);
  t.after(() => app.unmount());
  await nextTick();
  const show = document.querySelector('.entity-hero__docked-show');
  assert.ok(show);
  show.focus();
  show.click();
  await nextTick();
  await nextTick();
  assert.equal(docked.view, null);
  const hero = document.querySelector('.entity-hero');
  assert.ok(hero && hero.dataset.hero !== 'docked');
  assert.ok(
    hero.contains(document.activeElement),
    `focus is in the view, not on ${document.activeElement?.tagName}`,
  );
});

test('a paused chip is announced with its reason', async (t) => {
  const { default: PausedChip } = await import('./views/panels/PausedChip.vue');
  document.body.replaceChildren();
  const host = document.body.appendChild(document.createElement('div'));
  const app = createApp({
    render: () => h(PausedChip, { reason: 'Cameras off · last frame' }),
  });
  app.mount(host);
  t.after(() => app.unmount());
  const chip = document.querySelector('.paused-chip');
  // A label is announced only on an element with a role that takes one.
  assert.equal(chip.getAttribute('role'), 'img');
  assert.match(chip.getAttribute('aria-label'), /Paused: .*Cameras off/);
  assert.match(chip.textContent, /Paused/);
});
