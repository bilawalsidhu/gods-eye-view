// src/ui/itemCharts.test.mjs — a fire's chart says how many satellite hits
// it counts, worded for that count in every language (one hit, two hits).
import '../testSupport/registerDom.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createPinia } from 'pinia';
import { createApp, h, nextTick, reactive, ref } from 'vue';
import { describeEntity } from '../data/entityContext.js';
import { setLocale } from '../i18n/index.js';
import { useEntityCardStore } from './stores/entityCard.js';
import ItemCharts from './views/panels/ItemCharts.vue';

const FIRE = {
  key: 'local-firms:f1',
  layerId: 'local-firms',
  lat: 38.5,
  lon: -122.4,
};

async function mountChart(t, records, card = FIRE, snapshotEnd) {
  document.body.replaceChildren();
  const pinia = createPinia();
  const cards = useEntityCardStore(pinia);
  cards.layerModule = () => ({ getStats: () => ({ at: snapshotEnd }) });
  cards.recordsNear = () => records;
  const tick = ref(0);
  const app = createApp({
    render: () => h(ItemCharts, { card, tick: tick.value }),
  }).use(pinia);
  t.after(() => app.unmount());
  app.mount(document.body.appendChild(document.createElement('div')));
  await nextTick();
  return tick;
}

async function chartLabel(t, hits, snapshotEnd) {
  const now = snapshotEnd ?? Date.now();
  const records = Array.from({ length: hits }, (_, index) => ({
    record: { acqTime: now - (index + 1) * 60_000, frp: 10 },
  }));
  await mountChart(t, records, FIRE, snapshotEnd);
  return document
    .querySelector('.item-charts svg[role="img"]')
    ?.getAttribute('aria-label');
}

test('one satellite fire hit is one hit, two are hits', async (t) => {
  assert.equal(
    await chartLabel(t, 1),
    '1 satellite fire hit within 25 km in the last 24 hours',
  );
  assert.equal(
    await chartLabel(t, 2),
    '2 satellite fire hits within 25 km in the last 24 hours',
  );
});

test('each language words the count with its own plural form', async (t) => {
  t.after(() => setLocale('en'));
  setLocale('ru');
  assert.equal(
    await chartLabel(t, 1),
    '1 спутниковое обнаружение пожара в пределах 25 км за последние 24 часа',
  );
  assert.equal(
    await chartLabel(t, 2),
    '2 спутниковых обнаружения пожаров в пределах 25 км за последние 24 часа',
  );
  setLocale('de');
  assert.match(await chartLabel(t, 1), /^1 Satelliten-Feuermeldung im/);
  assert.match(await chartLabel(t, 2), /^2 Satelliten-Feuermeldungen im/);
});

test('historical fire hits are binned against the snapshot end', async (t) => {
  const label = await chartLabel(t, 1, Date.UTC(2025, 0, 2));
  const heading = document.querySelector('.item-charts h4').textContent;
  const day = new Intl.DateTimeFormat('en', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(Date.UTC(2025, 0, 2));
  assert.equal(heading, `24 h to ${day} 00:00 UTC`);
  assert.ok(label.includes(heading));
  assert.match(label, /1 satellite fire hit/);
  assert.doesNotMatch(label, /last 24 hours/i);
});

test('fire power shows the strongest single detection and leaves hours without FRP empty', async (t) => {
  const now = Date.now();
  await mountChart(t, [
    { record: { acqTime: now - 60_000, frp: 10 } },
    { record: { acqTime: now - 120_000, frp: 30 } },
    { record: { acqTime: now - 61 * 60_000 } },
    { record: { acqTime: now - 181 * 60_000, frp: 5 } },
  ]);
  const power = document.querySelectorAll('.item-charts__row')[1];
  assert.equal(power.querySelector('strong').textContent, '30 MW');
  assert.equal(power.querySelectorAll('polyline').length, 2);
});

test('no FRP at all hides the fire power row', async (t) => {
  await mountChart(
    t,
    [1, 2].map((min) => ({
      record: { acqTime: Date.now() - min * 60_000 },
    })),
  );
  const labels = Array.from(
    document.querySelectorAll('.item-charts__label'),
    (el) => el.textContent,
  );
  assert.deepEqual(labels, ['Hotspots']);
  assert.equal(
    document.querySelector('.item-charts__row strong').textContent,
    '2',
  );
});

test('the quake chart counts every nearby quake and says only the latest 24 are drawn', async (t) => {
  const card = {
    key: 'earthquakes:q30',
    identity: { layerId: 'earthquakes', id: 'q30' },
    layerId: 'earthquakes',
    lat: 35,
    lon: 139,
  };
  const records = Array.from({ length: 31 }, (_, i) => ({
    record: {
      id: `q${i}`,
      magnitude: 3 + (i % 3) / 10,
      timeMs: 1e12 + Math.min(i, 29) * 60_000,
    },
  }));
  await mountChart(t, records, card);
  const chart = () => document.querySelector('.item-charts__chart');
  const bars = [...chart().querySelectorAll('rect')];
  assert.equal(bars.length, 24);
  assert.equal(chart().querySelectorAll('rect.is-last').length, 1);
  assert.ok(bars.at(-1).classList.contains('is-last'));
  assert.equal(
    document.querySelector('.item-charts__row strong').textContent,
    '31',
  );
  assert.equal(
    chart().getAttribute('aria-label'),
    '31 quakes nearby, oldest first · 24 of 31 shown',
  );
  await mountChart(t, records.slice(0, 5), card);
  assert.equal(chart().querySelectorAll('rect.is-last').length, 0);
  assert.equal(
    chart().getAttribute('aria-label'),
    '5 quakes nearby, oldest first',
  );
});

test('a vessel’s speed uses the knot abbreviation in every language', async (t) => {
  t.after(() => setLocale('en'));
  const card = reactive({
    key: 'ais:ferry',
    layerId: 'ais-live-vessels',
    kind: 'vessel',
    moving: true,
    speedMps: 0.5,
  });
  const tick = await mountChart(t, [], card);
  tick.value++;
  await nextTick();
  assert.equal(Boolean(document.querySelector('.item-charts__chart')), false);
  card.speedMps = 0.5144;
  tick.value++;
  await nextTick();
  for (const [locale, expected] of Object.entries({
    es: '1 kn',
    fr: '1 nd',
    it: '1 kn',
    pt: '1 kt',
  })) {
    setLocale(locale);
    tick.value++;
    await nextTick();
    assert.equal(
      document.querySelector('.item-charts__row strong').textContent,
      expected,
      locale,
    );
  }
});

test('a speed chart adds new reports and holds its last point when the ferry leaves the feed', async (t) => {
  const at = 1700000000000;
  const reading = (observedMs, speedMps = 3) =>
    describeEntity(null, {
      layerId: 'transit',
      id: 'river',
      record: {
        key: 'river',
        label: 'River ferry',
        mode: 'ferry',
        lat: 10,
        lon: 10,
        observedMs,
        speedMps,
      },
    });
  const card = reactive(reading(at));
  const tick = await mountChart(t, [], card);
  const points = () =>
    document
      .querySelector('.item-charts polyline')
      ?.getAttribute('points')
      .split(' ').length ?? 0;
  tick.value++;
  await nextTick();
  assert.equal(points(), 0, 'one observation cannot draw a line');
  Object.assign(card, reading(at + 30000));
  await nextTick();
  assert.equal(points(), 2, 'a new report may confirm the same speed');
  Object.assign(card, reading(at, 2));
  await nextTick();
  assert.equal(points(), 2, 'a late older report does not extend history');
  const store = useEntityCardStore();
  store.lost = true;
  Object.assign(card, reading(at + 60000, 9));
  tick.value++;
  await nextTick();
  assert.equal(points(), 2);
});
