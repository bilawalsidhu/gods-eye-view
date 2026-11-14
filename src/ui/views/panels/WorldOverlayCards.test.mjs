import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { installVueDom } from '../../../testSupport/vueDom.mjs';

let mount;
let nextTick;
let createPinia;
let WorldOverlayCards;
let useWorldOverlayCardsStore;
let uninstall;
before(async () => {
  uninstall = installVueDom();
  ({ mount } = await import('@vue/test-utils'));
  ({ nextTick } = await import('vue'));
  ({ createPinia } = await import('pinia'));
  WorldOverlayCards = (await import('./WorldOverlayCards.vue')).default;
  ({ useWorldOverlayCardsStore } =
    await import('../../stores/worldOverlayCards.js'));
});
after(() => uninstall());

const style = { background: 'rgba(4, 12, 16, 0.82)', accent: '#6be8ff' };

const card = (overrides = {}) => ({
  key: 'site:1',
  kind: 'selected',
  title: 'Picked site',
  details: ['OPENSTREETMAP', 'Baton Rouge'],
  accent: '#6be8ff',
  w: 180,
  h: 61,
  padX: 12,
  padY: 8,
  titleH: 15,
  lineH: 15,
  ...overrides,
});

test('map cards are drawn at their solved size and moved without re-rendering', async () => {
  const pinia = createPinia();
  const store = useWorldOverlayCardsStore(pinia);
  const wrapper = mount(WorldOverlayCards, { global: { plugins: [pinia] } });
  assert.equal(wrapper.findAll('.world-overlay-card').length, 0);

  // The frame can arrive before the element exists: it is placed on mount.
  store.writeFrame([{ key: 'site:1', x: 40.3, y: 52, scale: 1, alpha: 0.5 }], 1);
  store.publish({ owner: {}, style, cards: [card()] });
  await nextTick();
  const element = wrapper.get('.world-overlay-card').element;
  assert.deepEqual(
    wrapper.findAll('.world-overlay-card p').map((line) => line.text()),
    ['Picked site', 'OPENSTREETMAP', 'Baton Rouge'],
  );
  assert.ok(element.classList.contains('is-selected'));
  assert.equal(element.style.width, '180px');
  assert.equal(element.style.height, '61px');
  assert.equal(
    wrapper.element.style.getPropertyValue('--overlay-card-bg'),
    style.background,
    'the plate uses the overlay\u2019s own tokens',
  );
  assert.equal(element.style.transform, 'translate3d(40px, 52px, 0)');
  assert.equal(element.style.opacity, '0.5');

  let renders = 0;
  const observer = new MutationObserver(() => renders++);
  observer.observe(wrapper.element, { childList: true, subtree: true });
  store.writeFrame([{ key: 'site:1', x: 90, y: 20, scale: 0.8, alpha: 1 }], 1);
  assert.equal(element.style.transform, 'translate3d(90px, 20px, 0) scale(0.8)');
  assert.equal(element.style.opacity, '1');
  await nextTick();
  observer.disconnect();
  assert.equal(renders, 0, 'a position write adds and removes no elements');

  store.publish({ owner: {}, style, cards: [card({ key: 'jet:2', kind: 'tracked' })] });
  await nextTick();
  const cards = wrapper.findAll('.world-overlay-card');
  assert.equal(cards.length, 1);
  assert.ok(cards[0].element.classList.contains('is-tracked'));
  assert.equal(cards[0].element.style.transform, '', 'a new card waits for its own frame');

  wrapper.unmount();
  store.writeFrame([{ key: 'jet:2', x: 1, y: 1, scale: 1, alpha: 1 }], 1);
});
