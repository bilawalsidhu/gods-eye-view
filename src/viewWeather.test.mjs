import assert from 'node:assert/strict';
import { test } from 'node:test';

import { bindRenderer } from './render/rendererOf.js';
import { createStubRenderer } from './render/stub/index.js';
import { CAPABILITIES } from './render/contract/index.js';
import { createViewWeather, weatherFromObservation } from './viewWeather.js';

const RAIN = {
  weatherCode: 63,
  cloudCoverPct: 90,
  precipitationMm: 2,
  windKph: 36,
  windDirectionDeg: 200,
  visibilityM: 9000,
};

function setup({ capabilities = CAPABILITIES, height = 1500, reply } = {}) {
  const renderer = createStubRenderer({ capabilities });
  const host = {};
  const unbind = bindRenderer(host, renderer);
  renderer.camera.setView({
    destination: { lon: -97.74, lat: 30.27, height },
    orientation: { heading: 0, pitch: -0.3, roll: 0 },
  });
  const asked = [];
  const weatherService = {
    async getConditions(lat, lon) {
      asked.push([lat, lon]);
      if (reply instanceof Error) throw reply;
      return reply ?? { status: 'ready', weather: RAIN };
    },
  };
  const published = [];
  const owners = [];
  const store = {
    publishWeather: (view) => published.push(view),
    connect: (actions) => (owners.push(actions), actions),
    detach: (token) => owners.splice(owners.indexOf(token), 1),
  };
  const saved = new Map();
  const storage = {
    getItem: (k) => saved.get(k) ?? null,
    setItem: (k, v) => saved.set(k, v),
  };
  const act = (name, ...args) => owners.at(-1)?.[name](...args);
  return {
    renderer,
    host,
    weatherService,
    store,
    storage,
    asked,
    published,
    act,
    saved,
    done() {
      unbind();
      renderer.destroy();
    },
  };
}

const settle = () => new Promise((done) => setTimeout(done, 0));

test('an observation becomes what the renderer draws; none is clear', () => {
  const rain = weatherFromObservation(RAIN);
  assert.ok(rain.rain > 0.2, 'rain');
  assert.ok(rain.clouds > 0.8, 'clouds');
  assert.equal(rain.snow, 0);
  assert.equal(rain.wind.speedMps, 10);
  assert.equal(rain.wind.fromDeg, 200);
  assert.equal(weatherFromObservation(null).clouds, 0);
  assert.equal(weatherFromObservation({ weatherCode: null }).rain, 0);
});

test('without the weather capability it does nothing and shows nothing', async (t) => {
  const s = setup({
    capabilities: CAPABILITIES.filter((c) => c !== 'weather'),
  });
  t.after(() => s.done());
  const weather = createViewWeather(s.host, s);
  await settle();
  assert.deepEqual(s.published, [null]);
  assert.deepEqual(s.asked, []);
  weather.destroy();
});

test('live, it draws the conditions under the camera', async (t) => {
  const s = setup();
  t.after(() => s.done());
  const weather = createViewWeather(s.host, s);
  await settle();
  assert.equal(s.asked.length, 1);
  assert.ok(Math.abs(s.asked[0][0] - 30.27) < 1e-6, 'asked at the camera');
  const drawn = s.renderer.globe.weather.get();
  assert.ok(drawn.rain > 0.2 && drawn.clouds > 0.8, 'rain and clouds drawn');
  const last = s.published.at(-1);
  assert.equal(last.live, true);
  assert.equal(last.status, 'live');
  assert.equal(last.values.rain, Math.round(drawn.rain * 100));
  // Not due again: no second ask on a small move.
  await weather.refresh();
  assert.equal(s.asked.length, 1);
  weather.destroy();
  assert.equal(s.published.at(-1), null);
});

test('a slider takes it off live from what it shows, and the choice is kept', async (t) => {
  const s = setup();
  t.after(() => s.done());
  const weather = createViewWeather(s.host, s);
  await settle();
  const before = s.renderer.globe.weather.get();
  s.act('setWeatherValue', 'snow', 40);
  const after = s.renderer.globe.weather.get();
  assert.equal(after.snow, 0.4);
  assert.equal(after.clouds, before.clouds, 'clouds kept from live');
  assert.equal(s.published.at(-1).live, false);
  weather.destroy();
  // A new page keeps the hand-set weather and asks for none.
  const again = createViewWeather(s.host, s);
  await settle();
  assert.equal(s.renderer.globe.weather.get().snow, 0.4);
  assert.equal(s.asked.length, 1);
  s.act('setWeatherLive', true);
  await settle();
  assert.equal(s.published.at(-1).live, true);
  again.destroy();
});

test('no report fails clear and says so', async (t) => {
  const s = setup({ reply: new Error('down') });
  t.after(() => s.done());
  const weather = createViewWeather(s.host, s);
  await settle();
  assert.equal(s.renderer.globe.weather.get().clouds, 0);
  assert.equal(s.published.at(-1).status, 'unavailable');
  weather.destroy();
});

test('from orbit it asks for no observation', async (t) => {
  const s = setup({ height: 5_000_000 });
  t.after(() => s.done());
  const weather = createViewWeather(s.host, s);
  await settle();
  assert.deepEqual(s.asked, []);
  weather.destroy();
});

test('rising to orbit clears the place observed; coming down asks again', async (t) => {
  const s = setup();
  t.after(() => s.done());
  const weather = createViewWeather(s.host, s);
  await settle();
  assert.ok(s.renderer.globe.weather.get().clouds > 0.8);
  s.renderer.camera.setView({
    destination: { lon: -97.74, lat: 30.27, height: 8_000_000 },
  });
  await weather.refresh();
  assert.equal(s.renderer.globe.weather.get().clouds, 0, 'clear from orbit');
  assert.equal(s.published.at(-1).status, 'none');
  s.renderer.camera.setView({
    destination: { lon: 139.7, lat: 35.7, height: 1500 },
  });
  await weather.refresh();
  assert.equal(s.asked.length, 2);
  assert.ok(Math.abs(s.asked[1][0] - 35.7) < 1e-6, 'asked at Tokyo');
  weather.destroy();
});

test('a move far from a fetch in flight asks again where the camera is', async (t) => {
  const s = setup();
  t.after(() => s.done());
  const replies = [];
  s.weatherService.getConditions = (lat, lon, { signal }) => {
    s.asked.push([lat, lon]);
    return new Promise((resolve, reject) => {
      replies.push(resolve);
      signal.addEventListener('abort', () =>
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
      );
    });
  };
  const weather = createViewWeather(s.host, s);
  await settle();
  assert.equal(s.asked.length, 1, 'Austin asked');
  s.renderer.camera.setView({
    destination: { lon: -104.99, lat: 39.74, height: 1500 },
  });
  const denver = weather.refresh();
  assert.equal(s.asked.length, 2, 'Denver asked while Austin was pending');
  replies[0]({ weather: RAIN });
  replies[1]({ weather: { weatherCode: 71, cloudCoverPct: 100 } });
  await denver;
  await settle();
  const drawn = s.renderer.globe.weather.get();
  assert.ok(drawn.snow > 0, 'Denver’s snow drawn');
  assert.equal(drawn.rain, 0, 'not Austin’s rain');
  weather.destroy();
});

test('turning live off keeps what was shown, haze included', async (t) => {
  const s = setup();
  t.after(() => s.done());
  const weather = createViewWeather(s.host, s);
  await settle();
  const shown = s.renderer.globe.weather.get();
  s.act('setWeatherLive', false);
  assert.deepEqual(s.renderer.globe.weather.get(), shown);
  s.act('setWeatherValue', 'rain', 10);
  const after = s.renderer.globe.weather.get();
  assert.equal(after.rain, 0.1);
  assert.equal(after.haze, shown.haze, 'haze kept until fog moves');
  s.act('setWeatherValue', 'fog', 50);
  assert.equal(s.renderer.globe.weather.get().haze, 0.5 * 0.78);
  weather.destroy();
});
