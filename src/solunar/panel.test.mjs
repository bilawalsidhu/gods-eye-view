// src/solunar/panel.test.mjs — the SOLUNAR card as the view renders it:
// the card owner (src/solunar/panel.js) publishes the week into the card
// store and the view (src/ui/views/panels/SolunarPanel.vue) renders it over
// happy-dom.
import '../testSupport/registerDom.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createPinia } from 'pinia';
import { createApp, nextTick } from 'vue';
import { useSolunarStore } from '../ui/stores/solunar.js';
import SolunarPanel from '../ui/views/panels/SolunarPanel.vue';
import { HOUR12_STORAGE_KEY, createSolunarPanel } from './panel.js';
import { formatClock, formatLatLon, starsText } from './format.js';

const setup = async (over = {}) => {
  document.body.replaceChildren();
  const container = document.body.appendChild(document.createElement('div'));
  const host = container.appendChild(document.createElement('div'));
  const pinia = createPinia();
  const store = useSolunarStore(pinia);
  const memory = new Map();
  const storage = {
    getItem: (k) => (memory.has(k) ? memory.get(k) : null),
    setItem: (k, v) => memory.set(k, String(v)),
  };
  let centered = 0;
  const panel = createSolunarPanel({
    store,
    storage,
    // 2026-11-02 12:00 in Chicago (CST)
    now: () => Date.UTC(2026, 10, 2, 18),
    onUseCenter: () => centered++,
    ...over,
  });
  const app = createApp(SolunarPanel).use(pinia);
  app.mount(host);
  await nextTick();
  return {
    container,
    host,
    panel,
    store: memory,
    centered: () => centered,
    unmount: () => app.unmount(),
  };
};
const LAKE = [33.05, -95.1];
const text = (n) => n.textContent.replace(/\s+/g, ' ').trim();

test('before a spot is chosen the card says to click the map', async () => {
  const { container } = await setup();
  assert.match(text(container), /Click the map to choose a spot/);
  assert.equal(container.querySelectorAll('.gev-sl-day').length, 0);
});

test('a spot shows seven local days, the zone and the rating rule', async () => {
  const { container, panel } = await setup();
  assert.equal(panel.setSpot(...LAKE), true);
  await nextTick();
  assert.equal(
    container.querySelectorAll('.gev-sl-controls .ui-button').length,
    3,
  );
  const days = [...container.querySelectorAll('.gev-sl-day')];
  assert.equal(days.length, 7);
  assert.deepEqual(
    days.map((d) => d.dataset.date),
    [
      '2026-11-02',
      '2026-11-03',
      '2026-11-04',
      '2026-11-05',
      '2026-11-06',
      '2026-11-07',
      '2026-11-08',
    ],
  );
  assert.match(
    text(container.querySelector('.gev-sl-spot')),
    /33\.050°N 95\.100°W · America\/Chicago/,
  );
  assert.match(
    text(container.querySelector('.gev-sl-zone')),
    /America\/Chicago/,
  );
  const rule = text(container.querySelector('.gev-sl-rule'));
  for (const part of [
    'new or full moon within 1 day = 2 points, within 2.5 days = 1 point',
    '1 h either side of sunrise and of sunset',
    'major window',
    'at least 1 and at most 4',
    'No outside data',
  ])
    assert.ok(rule.includes(part), part);
});

test('Nov 2 shows moonrise "none" and does not borrow Nov 3\'s 1:05 AM; Nov 3 has it', async () => {
  const { container, panel } = await setup();
  panel.setSpot(...LAKE);
  await nextTick();
  const row = (date, cls) =>
    text(
      container.querySelector(
        `.gev-sl-day[data-date="${date}"] .gev-sl-${cls} .gev-sl-value`,
      ),
    );
  assert.equal(row('2026-11-02', 'moonrise'), 'none');
  assert.equal(row('2026-11-02', 'moonset'), '1:51 PM');
  assert.equal(row('2026-11-02', 'upper'), '7:00 AM');
  assert.equal(row('2026-11-03', 'moonrise'), '1:05 AM');
  assert.equal(row('2026-11-03', 'sunrise'), '6:40 AM');
  assert.equal(row('2026-11-03', 'sunset'), '5:27 PM');
  // a "none" row is marked so it can be styled apart
  assert.ok(
    container.querySelector(
      '.gev-sl-day[data-date="2026-11-02"] .gev-sl-moonrise .gev-sl-none',
    ),
  );
  // no minor window is made from the missing rise
  const minor = row('2026-11-02', 'minor');
  assert.ok(!minor.includes('Moonrise'), minor);
});

test('windows list their range and what makes them', async () => {
  const { container, panel } = await setup();
  panel.setSpot(...LAKE);
  await nextTick();
  const major = text(
    container.querySelector(
      '.gev-sl-day[data-date="2026-11-02"] .gev-sl-major .gev-sl-value',
    ),
  );
  assert.match(major, /6:00 AM – 8:00 AM \(Moon overhead\)/);
  const minor = text(
    container.querySelector(
      '.gev-sl-day[data-date="2026-11-02"] .gev-sl-minor .gev-sl-value',
    ),
  );
  assert.match(minor, /1:21 PM – 2:21 PM \(Moonset\)/);
});

test('each day has a hunting and a fishing rating of 1 to 4 stars with an accessible label', async () => {
  const { container, panel } = await setup();
  panel.setSpot(...LAKE);
  await nextTick();
  for (const r of container.querySelectorAll('.gev-sl-rate')) {
    const n = Number(r.dataset.stars);
    assert.ok(n >= 1 && n <= 4);
    assert.match(
      r.getAttribute('aria-label'),
      new RegExp(`: ${n} of 4 stars$`),
    );
    assert.equal(text(r.querySelector('.gev-sl-star-glyphs')), starsText(n, 4));
    assert.equal(text(r.querySelector('.gev-sl-star-glyphs')).length, 4);
  }
  assert.equal(container.querySelectorAll('.gev-sl-hunting').length, 7);
  assert.equal(container.querySelectorAll('.gev-sl-fishing').length, 7);
});

test('12 h / 24 h toggle re-renders and is remembered', async () => {
  const { container, panel, store } = await setup();
  panel.setSpot(...LAKE);
  await nextTick();
  const sunset = () =>
    text(
      container.querySelector(
        '.gev-sl-day[data-date="2026-11-03"] .gev-sl-sunset .gev-sl-value',
      ),
    );
  const chips = () => [...container.querySelectorAll('.gev-sl-clock')];
  chips()
    .find((c) => text(c) === '24 h')
    .click();
  await nextTick();
  assert.equal(sunset(), '17:27');
  assert.equal(store.get(HOUR12_STORAGE_KEY), '24');
  assert.equal(panel.getHour12(), false);
  chips()
    .find((c) => text(c) === '12 h')
    .click();
  await nextTick();
  assert.equal(sunset(), '5:27 PM');
  assert.equal(store.get(HOUR12_STORAGE_KEY), '12');
  assert.equal(
    chips()
      .find((c) => c.classList.contains('active'))
      .getAttribute('aria-pressed'),
    'true',
  );
});

test('a stored 24 h choice is used on the next start', async () => {
  const { container, panel } = await setup({
    storage: { getItem: () => '24', setItem() {} },
  });
  panel.setSpot(...LAKE);
  await nextTick();
  assert.equal(panel.getHour12(), false);
  assert.match(
    text(container.querySelector('.gev-sl-sunrise .gev-sl-value')),
    /^\d\d:\d\d$/,
  );
});

test('Use map centre calls back; invalid points are refused', async () => {
  const { container, panel, centered } = await setup();
  panel.setSpot(...LAKE);
  await nextTick();
  container.querySelector('.gev-sl-center').click();
  assert.equal(centered(), 1);
  assert.equal(panel.setSpot(NaN, 4), false);
  assert.equal(panel.setSpot(10, undefined), false);
  assert.equal(panel.getSpot().latDeg, 33.05, 'the old spot stays');
});

test("the spot's own zone decides the days, not the viewer's", async () => {
  const { container, panel } = await setup({
    now: () => Date.UTC(2026, 10, 4, 3),
  });
  panel.setSpot(...LAKE);
  await nextTick();
  assert.equal(
    container.querySelector('.gev-sl-day').dataset.date,
    '2026-11-03',
  );
  panel.setSpot(-33.87, 151.21);
  await nextTick();
  assert.equal(
    container.querySelector('.gev-sl-day').dataset.date,
    '2026-11-04',
  );
  assert.match(
    text(container.querySelector('.gev-sl-spot')),
    /33\.870°S 151\.210°E · Australia\/Sydney/,
  );
});

test('text is never parsed as markup', async () => {
  const { container, panel } = await setup();
  panel.setSpot(...LAKE);
  await nextTick();
  assert.equal(container.querySelectorAll('script, img, iframe').length, 0);
  assert.ok(!container.innerHTML.includes('&lt;'));
});

test('destroy empties the card and ignores later calls', async () => {
  const { host, panel } = await setup();
  panel.setSpot(...LAKE);
  await nextTick();
  assert.equal(host.querySelectorAll('.gev-sl-day').length, 7);
  panel.destroy();
  await nextTick();
  const body = host.querySelector('.gev-sl-body');
  assert.equal(body.children.length, 0);
  assert.equal(text(body), '');
  panel.setSpot(...LAKE);
  await nextTick();
  assert.equal(body.children.length, 0);
  assert.equal(text(body), '');
});

test('helpers', () => {
  assert.equal(formatLatLon(-33.87, 151.21), '33.870°S 151.210°E');
  assert.equal(starsText(3, 4), '★★★☆');
  assert.equal(
    formatClock(Date.UTC(2026, 10, 3, 13, 5, 31), 'America/Chicago', false),
    '07:06',
  );
});

test('a day with two major windows lists them one per line', async () => {
  const { container, panel } = await setup();
  panel.setSpot(...LAKE);
  await nextTick();
  const value = container.querySelector(
    '.gev-sl-day[data-date="2026-11-03"] .gev-sl-major .gev-sl-value',
  );
  assert.deepEqual(value.textContent.split('\n'), [
    '6:48 AM – 8:48 AM (Moon overhead)',
    '7:11 PM – 9:11 PM (Moon underfoot)',
  ]);
});

test('24 h clock shows 00:05, never 24:05', () => {
  const midnight = Date.UTC(2026, 10, 3, 6, 5);
  assert.equal(formatClock(midnight, 'America/Chicago', false), '00:05');
  assert.equal(formatClock(midnight, 'America/Chicago', true), '12:05 AM');
});
