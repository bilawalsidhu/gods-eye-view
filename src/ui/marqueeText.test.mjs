// src/ui/marqueeText.test.mjs — a name that scrolls only when cut off,
// never with reduced motion, measured again when it changes.
import '../testSupport/registerDom.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp, h, nextTick, ref } from 'vue';
import { createPinia } from 'pinia';
import StoriesHeader from './views/stories/StoriesHeader.vue';
import { getLocale, setLocale } from '../i18n/index.js';
import { followPageLocale } from '../i18n/page.js';
import { applicationI18n } from './i18n.js';
import MarqueeText from './views/panels/MarqueeText.vue';

/** Lay the marquee out as a browser would: its box 200 px, its text `width`. */
function layout(t, widthOf) {
  const proto = globalThis.HTMLElement.prototype;
  const saved = ['scrollWidth', 'clientWidth'].map((name) => [
    name,
    Object.getOwnPropertyDescriptor(proto, name),
  ]);
  Object.defineProperty(proto, 'scrollWidth', {
    configurable: true,
    get() {
      return this.classList?.contains('marquee')
        ? Math.max(200, widthOf(this.textContent))
        : 0;
    },
  });
  Object.defineProperty(proto, 'clientWidth', {
    configurable: true,
    get() {
      return this.classList?.contains('marquee') ? 200 : 0;
    },
  });
  t.after(() => {
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(proto, name, descriptor);
      else delete proto[name];
    }
  });
}

/** Reduced motion as the page reports it, with its change listeners. */
function motionSetting(t, reduce) {
  const listeners = new Set();
  const query = {
    get matches() {
      return reduce.value;
    },
    addEventListener: (type, cb) => listeners.add(cb),
    removeEventListener: (type, cb) => listeners.delete(cb),
  };
  const real = globalThis.matchMedia;
  globalThis.matchMedia = () => query;
  t.after(() => {
    globalThis.matchMedia = real;
  });
  return { listeners, change: () => listeners.forEach((cb) => cb()) };
}

function mount(t, text) {
  document.body.replaceChildren();
  const name = ref(text);
  const app = createApp({ render: () => h(MarqueeText, { text: name.value }) });
  app.mount(document.body.appendChild(document.createElement('div')));
  t.after(() => app.unmount());
  return { name, el: () => document.querySelector('.marquee'), app };
}

const settle = async () => {
  for (let i = 0; i < 3; i++) {
    await new Promise((resolve) => setImmediate(resolve));
    await nextTick();
  }
};

// Eight pixels a character.
const width = (text) => text.length * 8;

test('the Stories phone title measures the displayed screen name when returning to Explore', async (t) => {
  layout(t, width);
  motionSetting(t, ref(false));
  const screen = ref('story');
  const title = 'A story with a title long enough to scroll';
  const app = createApp({
    render: () => h(StoriesHeader, { screen: screen.value, title }),
  });
  const host = document.body.appendChild(document.createElement('div'));
  app.use(createPinia()).mount(host);
  t.after(() => {
    app.unmount();
    host.remove();
  });
  await nextTick();
  const label = host.querySelector('.s-mtitle .marquee');
  assert.equal(label.textContent, title);
  assert.equal(label.classList.contains('is-moving'), true);
  screen.value = 'explore';
  await settle();
  assert.equal(label.textContent, 'Stories');
  assert.equal(label.classList.contains('is-moving'), false);
});

test('a name that fits stays still', async (t) => {
  layout(t, width);
  motionSetting(t, ref(false));
  const { el } = mount(t, 'KUT 90.5');
  await nextTick();
  assert.equal(el().classList.contains('is-moving'), false);
  assert.equal(el().style.getPropertyValue('--marquee-shift'), '');
  assert.equal(el().getAttribute('title'), 'KUT 90.5');
  assert.equal(
    document.querySelectorAll('.marquee__text').length,
    1,
    'one copy for screen readers',
  );
});

test('a name cut off scrolls by its overflow at 30 px/s, waiting at each end', async (t) => {
  layout(t, width);
  motionSetting(t, ref(false));
  const long = 'Matthew Seibel Skylord · aerospace and more'; // 344 px
  const { el } = mount(t, long);
  await nextTick();
  assert.equal(el().classList.contains('is-moving'), true);
  assert.equal(el().style.getPropertyValue('--marquee-shift'), '-144px');
  // 144 px at 30 px/s is 4.8 s each way, three tenths of the round trip.
  assert.equal(el().style.getPropertyValue('--marquee-duration'), '16s');
});

test('an unchanged mounted name scrolls toward its clipped end after switching locale', async (t) => {
  layout(t, width);
  motionSetting(t, ref(false));
  applicationI18n();
  const original = getLocale();
  const stop = followPageLocale();
  t.after(() => {
    setLocale(original);
    stop();
  });
  setLocale('en');
  // Supply the browser's direction inheritance in the layout-free test DOM.
  t.mock.method(globalThis, 'getComputedStyle', () => ({
    direction: document.documentElement.dir,
  }));
  const { el } = mount(t, 'Matthew Seibel Skylord · aerospace and more');
  const label = el();
  await nextTick();
  assert.equal(label.style.getPropertyValue('--marquee-shift'), '-144px');
  setLocale('ar');
  await nextTick();
  assert.equal(document.documentElement.dir, 'rtl');
  assert.equal(label.style.getPropertyValue('--marquee-shift'), '144px');
  setLocale('en');
  await nextTick();
  assert.equal(label.style.getPropertyValue('--marquee-shift'), '-144px');
  assert.ok(label === el(), 'the mounted name is retained');
});

test('with reduced motion nothing scrolls, and a change of the setting is followed', async (t) => {
  layout(t, width);
  const reduce = ref(true);
  const motion = motionSetting(t, reduce);
  const { el, app } = mount(t, 'Matthew Seibel Skylord · aerospace and more');
  await nextTick();
  assert.equal(
    el().classList.contains('is-moving'),
    false,
    'the ellipsis stays',
  );
  reduce.value = false;
  motion.change();
  await nextTick();
  assert.equal(el().classList.contains('is-moving'), true);
  app.unmount();
  assert.equal(motion.listeners.size, 0, 'its listener goes with it');
});

test('a new name is measured again; the same name keeps its scroll', async (t) => {
  layout(t, width);
  motionSetting(t, ref(false));
  const { el, name } = mount(t, 'Matthew Seibel Skylord · aerospace and more');
  await nextTick();
  const style = el().getAttribute('style');
  name.value = 'Matthew Seibel Skylord · aerospace and more';
  await settle();
  assert.equal(el().getAttribute('style'), style, 'unchanged');
  name.value = 'KUT 90.5';
  await settle();
  assert.equal(el().classList.contains('is-moving'), false);
  name.value =
    'A much longer station name that cannot fit in two hundred pixels';
  await settle();
  assert.equal(el().classList.contains('is-moving'), true);
  assert.notEqual(el().style.getPropertyValue('--marquee-shift'), '-144px');
});

test('the stylesheet scrolls a name only while it moves, and never with reduced motion', async () => {
  const fs = await import('node:fs');
  const css = fs
    .readFileSync(new URL('./styles/entity-card.css', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  const animated = [
    ...css.matchAll(/([^{}]+)\{[^{}]*animation:\s*marquee-scroll/g),
  ].map((m) => m[1].trim());
  assert.deepEqual(animated, ['.marquee.is-moving .marquee__text']);
  const reduced = [
    ...css.matchAll(
      /@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*?)\n\}/g,
    ),
  ]
    .map((m) => m[1])
    .join('\n');
  assert.match(
    reduced,
    /\.marquee\.is-moving \.marquee__text\s*\{\s*animation:\s*none;/,
  );
});
