import '../testSupport/registerDom.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createPinia } from 'pinia';
import { createApp, h, nextTick, ref } from 'vue';
import { useEntityCardStore } from './stores/entityCard.js';
import { groundSpeedTrend } from './placeCard.js';
import PlaceDetails from './views/panels/PlaceDetails.vue';
import LocalConditions from './views/panels/LocalConditions.vue';

test('the Open-Meteo credit sits on its own unclamped line, outside the weather value', async (t) => {
  const pinia = createPinia();
  const cards = useEntityCardStore(pinia);
  cards.connect({
    spotWeather: async (latitude, longitude) => ({
      coordinates: { latitude, longitude },
      weather: {
        temperatureC: 12,
        weatherCode: 2,
        windKph: 14,
        source: 'open-meteo',
        timeZone: 'UTC',
      },
    }),
  });
  const root = document.createElement('dl');
  const app = createApp({
    render: () => h(LocalConditions, { lat: 35, lon: 139 }),
  });
  app.use(pinia).mount(root);
  t.after(() => {
    app.unmount();
    cards.connect(null);
  });
  await new Promise((resolve) => setImmediate(resolve));
  await nextTick();
  const credit = root.querySelector('a.entity-card__weather-credit');
  assert.ok(
    credit
      ?.closest('dd')
      .classList.contains('entity-card__weather-credit-line'),
  );
  const weather = [...root.querySelectorAll('dd')].find((el) =>
    el.textContent.includes('12 °C'),
  );
  assert.equal(weather.contains(credit), false);
  const css = readFileSync(
    new URL('./styles/entity-card.css', import.meta.url),
    'utf8',
  );
  assert.match(
    css,
    /\.entity-card__weather-credit-line\s*\{[^}]*-webkit-line-clamp:\s*unset/,
  );
});

test('selected place and local conditions clocks use only the requested border point', async (t) => {
  t.mock.method(Date, 'now', () => Date.UTC(2025, 0, 15, 20, 30));
  const settle = async () => {
    await new Promise((resolve) => setImmediate(resolve));
    await nextTick();
  };
  for (const component of [PlaceDetails, LocalConditions]) {
    const pinia = createPinia();
    const store = useEntityCardStore(pinia);
    const longitude = ref(-114.746);
    const requests = [];
    const first = Promise.withResolvers();
    store.connect({
      spotWeather: async (lat, lon, options) => {
        requests.push([lon, options?.exactPoint]);
        const stale = requests.length === 1;
        if (stale) await first.promise;
        if (lon === -114.748) throw new Error('unavailable');
        return {
          coordinates: { latitude: lat, longitude: stale ? -114.735 : lon },
          weather: {
            temperatureC: lon === -114.749 ? null : 20,
            timeZone:
              stale || lon === -114.735
                ? 'America/Phoenix'
                : 'America/Los_Angeles',
          },
        };
      },
    });
    const root = document.createElement('div');
    const app = createApp({
      render: () => {
        const point = { lat: 36.015, lon: longitude.value };
        return h(
          component,
          component === PlaceDetails
            ? {
                airportSpeeds: groundSpeedTrend(),
                card: { ...point, key: 'place:test', title: 'Test place' },
              }
            : point,
        );
      },
    });
    app.use(pinia).mount(root);
    try {
      await nextTick();
      assert.match(root.textContent, /local time loading/);
      first.resolve();
      await settle();
      if (component === LocalConditions)
        assert.equal(root.querySelector('dt').textContent, 'Time');
      assert.match(root.textContent, /20:30 UTC/);
      assert.doesNotMatch(root.textContent, /\d\d:\d\d local/);
      longitude.value = -114.747;
      await settle();
      assert.deepEqual(requests, [
        [-114.746, true],
        [-114.747, true],
      ]);
      assert.match(root.textContent, /12:30 local, 20:30 UTC/);
      if (component === LocalConditions)
        assert.equal(root.querySelector('dt').textContent, 'Local time');
      longitude.value = -114.735;
      await settle();
      assert.deepEqual(requests.at(-1), [-114.735, true]);
      assert.match(root.textContent, /13:30 local, 20:30 UTC/);
      longitude.value = -114.748;
      await settle();
      assert.match(root.textContent, /20:30 UTC/);
      assert.doesNotMatch(root.textContent, /local time loading/);
      longitude.value = -114.749;
      await settle();
      assert.match(root.textContent, /20:30 UTC/);
      assert.doesNotMatch(root.textContent, /\d\d:\d\d local/);
    } finally {
      app.unmount();
    }
  }
});
