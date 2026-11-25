import '../testSupport/registerDom.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPinia } from 'pinia';
import { createApp, nextTick } from 'vue';
import { fakeInput } from '../input/testDoubles.mjs';
import { bindFakeDraw } from '../testSupport/fakeDrawPort.mjs';
import { installEntityContext } from './entityContextBridge.js';
import { createLayerCounts } from './layerCounts.js';
import { useDisplayStore } from './stores/display.js';
import { createViewWeather } from './viewWeather.js';
import ContextView from './views/ContextView.vue';
import { useEntityCardStore } from './stores/entityCard.js';
import { useLayerCountsStore } from './stores/layerCounts.js';
import { usePanelChromeStore } from './stores/panelChrome.js';

const observation = (temperatureC) => ({
  weather: { temperatureC, weatherCode: 0, timeZone: 'America/Los_Angeles' },
});

function weatherRequests() {
  const reads = [];
  return {
    reads,
    spotWeather(lat, lon, { signal, exactPoint }) {
      const result = Promise.withResolvers();
      reads.push({ lat, lon, signal, exactPoint, ...result });
      return result.promise;
    },
  };
}

function mountInspector(t, { regionalBrief, spotWeather, layers = [] } = {}) {
  t.mock.method(globalThis, 'fetch', async (url) =>
    String(url).endsWith('/wikidata_cities/cities.json')
      ? Response.json({
          rows: [
            ['Seattle', 47.61, -122.31, 750_000, 'US', 'Q5083'],
            ['Badajoz', 38.88, -6.97, 150_000, 'ES', 'Q15681'],
            ['Elvas', 38.88, -7.17, 20_000, 'PT', 'Q997224'],
          ],
        })
      : new Response('', { status: 503 }),
  );
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  let wall = Date.parse('2026-11-21T12:00:00Z');
  t.mock.method(Date, 'now', () => wall);
  let visible = true;
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => (visible ? 'visible' : 'hidden'),
  });
  document.body.replaceChildren();
  const host = document.body.appendChild(document.createElement('div'));
  const pinia = createPinia();
  const cards = useEntityCardStore(pinia);
  const layerCounts = useLayerCountsStore(pinia);
  const display = useDisplayStore(pinia);
  const chrome = usePanelChromeStore(pinia);
  const owner = chrome.connect({});
  const viewer = { scene: {} };
  const input = fakeInput(viewer);
  const listeners = new Map();
  let pose = null;
  let moving = false;
  const { unbind } = bindFakeDraw(viewer, {
    camera: {
      pose: () => pose ?? {},
      viewRectangle: () => null,
      on(event, callback) {
        listeners.set(event, callback);
        return () => listeners.delete(event);
      },
    },
  });
  const manager = {
    layers: new Map(layers.map((layer) => [layer.id, layer])),
    isEnabled: (id) => layers.some((layer) => layer.id === id),
    getAll: () => layers,
    subscribe: () => () => {},
  };
  const disconnect = installEntityContext({
    viewer,
    pinia,
    getDataManager: () => manager,
    regionalBrief,
    spotWeather,
    inspector: {
      counts: createLayerCounts({
        getCounts: async () => ({ counts: [] }),
        readState: () => layerCounts.state,
        writeState: layerCounts.publish,
        readShown: () => cards.inspector.shown,
      }),
    },
  });
  const app = createApp(ContextView).use(pinia);
  app.mount(host);
  t.after(() => {
    app.unmount();
    disconnect();
    chrome.detach(owner);
    input.destroy();
    unbind();
    delete document.visibilityState;
  });
  chrome.publish(owner, 'global-context-panel', { collapsed: false });
  return {
    host,
    display,
    facts: () => host.querySelector('.view-context__tiles--facts').textContent,
    clock: () => host.querySelector('.view-context__region').textContent,
    async setOpen(open) {
      chrome.publish(owner, 'global-context-panel', { collapsed: !open });
      await nextTick();
    },
    async point(lat, { lon = -122.31, settled = true } = {}) {
      const event = settled ? 'moveEnd' : moving ? 'changed' : 'moveStart';
      pose = { lat, lon, height: 40_000 };
      moving = !settled;
      listeners.get(event)?.();
      await nextTick();
    },
    async advance(ms = 1000) {
      wall += ms;
      t.mock.timers.tick(ms);
      await nextTick();
    },
    async flush() {
      await new Promise((resolve) => setImmediate(resolve));
      await nextTick();
    },
    jumpWall(ms) {
      wall += ms;
    },
    setVisible(next) {
      visible = next;
      document.dispatchEvent(new Event('visibilitychange'));
    },
  };
}

test("the view's weather and local time come from the weather alone", async (t) => {
  const briefs = [];
  const weathers = [];
  const { point, advance, flush, facts, clock } = mountInspector(t, {
    regionalBrief: async (...args) => (briefs.push(args), null),
    spotWeather: async (...args) => (
      weathers.push(args),
      {
        weather: { temperatureC: 21.4, weatherCode: 0, timeZone: 'Asia/Tokyo' },
      }
    ),
  });
  await point(35.71, { lon: 139.81 });
  await advance(400);
  await flush();
  assert.equal(weathers.length, 1);
  assert.deepEqual(briefs, [], 'no brief: no place lookup, no news search');
  assert.match(facts(), /21 °C/);
  assert.match(clock(), /local/);
});

test('moving Context replaces a weather reading only after the new spot settles', async (t) => {
  const { reads, spotWeather } = weatherRequests();
  const { host, point, advance, flush, facts, clock } = mountInspector(t, {
    spotWeather,
  });

  await point(47.61);
  await advance();
  reads[0].resolve(observation(18));
  await flush();
  assert.match(facts(), /18 °C/);

  await point(47.81);
  assert.doesNotMatch(
    facts(),
    /18 °C/,
    'a new cell must hide the last cell’s reading immediately',
  );
  assert.match(clock(), /UTC · local time loading…$/);
  await flush();
  assert.doesNotMatch(clock(), /\d\d:\d\d local/);
  await advance();
  assert.equal(reads.length, 2);

  await point(48.01, { settled: false });
  await advance();
  assert.equal(
    reads[1].signal?.aborted,
    true,
    'the superseded request is cancelled',
  );
  reads[1].resolve(observation(32));
  await flush();
  assert.doesNotMatch(
    facts(),
    /32 °C/,
    'a late answer cannot display under another cell',
  );
  await point(48.21, { settled: false });
  await advance();
  assert.equal(reads.length, 2, 'moving camera updates never request weather');

  await point(48.22);
  await advance();
  assert.equal(
    reads.length,
    3,
    'settling within the last cell requests it once',
  );
  assert.equal(reads[2].lat, 48.22);
  reads[2].reject(new Error('fixture refused'));
  await flush();
  assert.match(facts(), /No weather reading here\./);
  const failedTile = host.querySelector(
    '.view-context__tiles--facts .view-context__tile',
  );
  assert.equal(
    failedTile.title,
    failedTile.querySelector('strong').textContent,
  );
  assert.doesNotMatch(
    clock(),
    /local/,
    'a failed new cell clears its borrowed zone',
  );

  // After the short retry, a good reading owns the cell. The provider can
  // then go unavailable while the camera stays parked in the same cell.
  await advance(15 * 4000);
  await advance();
  assert.equal(reads.length, 4);
  reads[3].resolve(observation(25));
  await flush();
  assert.match(facts(), /25 °C/);
  await advance(165 * 4000);
  await advance();
  assert.equal(reads.length, 5);
  reads[4].reject(new Error('provider no longer has a reading'));
  await flush();
  assert.doesNotMatch(
    facts(),
    /25 °C/,
    'a failed parked refresh drops its old observation',
  );
  assert.match(facts(), /No weather reading here\./);
  assert.doesNotMatch(clock(), /local/, 'a failed refresh shows plain UTC');
});

test('remounting Context near the earlier cell shows UTC until the new cell answers', async (t) => {
  const { reads, spotWeather } = weatherRequests();
  const f = mountInspector(t, { spotWeather });
  await f.point(34.848, { lon: -114.614 });
  await f.advance(400);
  reads[0].resolve(observation(18));
  await f.flush();
  assert.match(f.clock(), /local/);

  await f.setOpen(false);
  assert.equal(f.host.querySelector('.view-context__region'), null);
  await f.point(34.719, { lon: -114.488 });
  await f.advance();
  assert.equal(reads.length, 1);

  await f.setOpen(true);
  await f.advance(400);
  assert.equal(reads.length, 2);
  assert.equal(reads[1].lat, 34.719);
  assert.match(f.clock(), /UTC/);
  assert.match(f.clock(), /UTC · local time loading…$/);
  assert.doesNotMatch(f.facts(), /18 °C/);

  reads[1].resolve({
    weather: { ...observation(21).weather, timeZone: 'America/Phoenix' },
  });
  await f.flush();
  assert.match(f.clock(), /local/);
  assert.match(f.facts(), /21 °C/);
});

test('crossing from Arizona to Nevada in one weather cell waits for the new point’s own zone', async (t) => {
  const { reads, spotWeather } = weatherRequests();
  const f = mountInspector(t, { spotWeather });
  // Opposite sides of the Colorado River at Hoover Dam, in the same 0.1° cell.
  await f.point(36.015, { lon: -114.735 });
  await f.advance(400);
  reads[0].resolve({
    weather: { temperatureC: 18, timeZone: 'America/Phoenix' },
  });
  await f.flush();
  assert.match(f.clock(), /05:00 local, 12:00 UTC$/);

  await f.point(36.015, { lon: -114.746 });
  assert.match(f.clock(), /12:00 UTC · local time loading…$/);
  assert.doesNotMatch(f.clock(), /05:00/);
  await f.advance(400);
  assert.equal(reads.length, 2);
  assert.equal(reads[1].lon, -114.746);
  assert.equal(reads[1].exactPoint, true);
  reads[1].resolve({
    weather: { temperatureC: 20, timeZone: 'America/Los_Angeles' },
  });
  await f.flush();
  assert.match(f.clock(), /04:00 local, 12:00 UTC$/);
});

test('a cached observation from across the border does not supply local time', async (t) => {
  const { reads, spotWeather } = weatherRequests();
  const f = mountInspector(t, { spotWeather });
  await f.point(38.832, { lon: -7.1 });
  await f.advance(400);
  reads[0].resolve({
    coordinates: { latitude: 38.828, longitude: -7.1 },
    weather: { temperatureC: 18, weatherCode: 0, timeZone: 'Europe/Madrid' },
  });
  await f.flush();
  assert.match(f.clock(), /UTC/);
  assert.doesNotMatch(f.clock(), /local/);
});

test('a fresh response at rounded request coordinates shows local time offshore', async (t) => {
  const { reads, spotWeather } = weatherRequests();
  const f = mountInspector(t, { spotWeather });
  await f.point(-30.123456, { lon: -130.654321 });
  await f.advance(400);
  reads[0].resolve({
    coordinates: { latitude: -30.12346, longitude: -130.65432 },
    weather: { temperatureC: 18, weatherCode: 0, timeZone: 'Etc/GMT+9' },
  });
  await f.flush();
  assert.match(f.clock(), /local.*UTC/);
});

test('retrying failed weather shows loading until cancellation or a usable reading', async (t) => {
  const { reads, spotWeather } = weatherRequests();
  const f = mountInspector(t, {
    spotWeather,
    layers: [{ id: 'flights', name: 'Flights', enabled: true }],
  });
  const weather = () => f.host.querySelector('.view-context__weather');
  await f.point(47.61);
  await f.advance(400);
  reads[0].resolve(null);
  await f.flush();
  assert.match(weather().textContent, /No weather reading here/);
  assert.equal(weather().getAttribute('aria-busy'), 'false');

  await f.advance(15 * 4000);
  assert.equal(reads.length, 1);
  await f.advance(400);
  assert.equal(reads.length, 2);
  assert.match(weather().textContent, /Reading conditions here/);
  assert.equal(weather().getAttribute('aria-busy'), 'true');

  await f.point(47.61, { settled: false });
  assert.equal(reads[1].signal.aborted, true);
  assert.match(weather().textContent, /No weather reading here/);
  assert.equal(weather().getAttribute('aria-busy'), 'false');

  await f.point(47.61);
  await f.advance(400);
  assert.equal(reads.length, 3);
  assert.equal(weather().getAttribute('aria-busy'), 'true');
  reads[2].resolve(observation(19));
  await f.flush();
  assert.match(weather().textContent, /19 °C/);
  assert.equal(weather().getAttribute('aria-busy'), 'false');
});

test('a regional-only host shows the original envelope age for weather missing an observation time', async (t) => {
  const reads = [];
  const { point, advance, flush, facts } = mountInspector(t, {
    async regionalBrief(lat, lon) {
      reads.push({ lat, lon });
      return { ...observation(19), retrievedAt: '2026-11-21T11:15:00Z' };
    },
  });
  await point(47.61);
  await advance(400);
  await flush();
  assert.deepEqual(reads, [{ lat: 47.61, lon: -122.31 }]);
  assert.match(facts(), /19 °C/);
  assert.match(facts(), /Updated 45 min ago/);
});

for (const layersOn of [false, true]) {
  const weatherBlock = layersOn
    ? 'layers-on weather block'
    : 'nothing-on weather tile';
  test(`the ${weatherBlock} recomputes retained weather age on reopen and page visibility before the next tick`, async (t) => {
    let reads = 0;
    const f = mountInspector(t, {
      layers: layersOn
        ? [{ id: 'flights', name: 'Flights', enabled: true }]
        : [],
      async spotWeather() {
        reads++;
        return observation(19);
      },
    });
    const weather = () =>
      layersOn
        ? f.host.querySelector('.view-context__weather').textContent
        : f.facts();
    await f.point(47.61);
    await f.advance(400);
    await f.flush();
    assert.match(weather(), /19 °C/);
    assert.doesNotMatch(weather(), /Updated/);

    if (layersOn) f.host.querySelector('#context-tab-btn-props').click();
    else
      f.display.publishPhoneShell({ enabled: true, sheet: 'layers', tabs: [] });
    await nextTick();
    f.jumpWall(12 * 60 * 60_000);
    if (layersOn) f.host.querySelector('#context-tab-btn-view').click();
    else
      f.display.publishPhoneShell({
        enabled: true,
        sheet: 'context',
        tabs: [],
      });
    await nextTick();
    assert.match(weather(), /Updated 12 h ago/);
    assert.equal(reads, 1);

    f.setVisible(false);
    f.jumpWall(60 * 60_000);
    f.setVisible(true);
    await nextTick();
    assert.match(weather(), /Updated 13 h ago/);
    assert.equal(reads, 1);
  });
}

const A = { lat: 35.71, lon: 139.81 };
const B = { lat: 35.89, lon: 139.81 };
const FAR = { lat: 45.71, lon: 139.81 };
const TOKYO = {
  temperatureC: 21.4,
  timeZone: 'Asia/Tokyo',
  utcOffsetSeconds: 32400,
};
const RECEIVED = Date.parse('2026-11-21T12:00:00Z');

function fixture(t) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: RECEIVED });
  const { reads, spotWeather } = weatherRequests();
  const publications = [];
  let input = { center: A, moving: false, shown: true, mountId: 1 };
  let visible = true;
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => (visible ? 'visible' : 'hidden'),
  });
  t.after(() => delete document.visibilityState);
  const owner = createViewWeather({
    read: spotWeather,
    readCurrentInput: () => input,
    publish: (state) => publications.push(state),
  });
  t.after(owner.stop);
  return {
    reads,
    publications,
    owner,
    get state() {
      return publications.at(-1);
    },
    setInput(changes, { deliver = true } = {}) {
      input = { ...input, ...changes };
      if (deliver) owner.update(input);
    },
    setVisible(next) {
      visible = next;
    },
    advance(ms) {
      t.mock.timers.tick(ms);
    },
    async finish(value) {
      reads.at(-1).resolve(value);
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

test('a failed read becomes due after one wall-clock minute, even while hidden, and a cancelled retry stays due', async (t) => {
  const f = fixture(t);
  f.setInput({});
  f.advance(400);
  await f.finish({ weather: { ...TOKYO, temperatureC: null } });
  assert.equal(f.state.failed, true);
  assert.equal(f.state.pending, false);
  assert.equal(f.state.reading, null);
  assert.equal(f.state.zone, null);
  assert.equal(f.state.freshnessAt, null);

  f.advance(20_000);
  f.setInput({ shown: false });
  f.advance(39_999);
  f.owner.pulse();
  f.setVisible(false);
  f.setInput({ shown: true });
  f.advance(1);
  f.owner.pulse();
  f.advance(400);
  assert.equal(f.reads.length, 1, 'a due retry waits while the page is hidden');
  f.setVisible(true);
  f.owner.pulse();
  f.advance(400);
  assert.equal(f.reads.length, 2);
  assert.equal(f.state.pending, true);
  assert.equal(f.state.failed, true);

  f.setInput({ moving: true });
  assert.equal(f.reads[1].signal.aborted, true);
  assert.equal(f.state.pending, false);
  assert.equal(f.state.failed, true);
  await f.finish({ weather: TOKYO });
  assert.equal(f.state.reading, null);

  f.setInput({ moving: false });
  f.advance(400);
  assert.equal(f.reads.length, 3);
  await f.finish({ weather: TOKYO });
  assert.equal(f.state.reading, TOKYO);
  assert.equal(f.state.failed, false);
});

test('a hung weather read times out, retries, and cannot overwrite the retry', async (t) => {
  const f = fixture(t);
  f.setInput({});
  f.advance(400);
  assert.equal(f.state.pending, true);
  assert.equal(f.reads.length, 1);

  f.advance(14_999);
  assert.equal(f.state.pending, true);
  assert.equal(f.reads[0].signal.aborted, false);
  f.advance(1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.reads[0].signal.reason?.name, 'TimeoutError');
  assert.equal(f.state.failed, true);
  assert.equal(f.state.pending, false);
  assert.equal(f.state.reading, null);

  f.advance(59_999);
  f.owner.pulse();
  assert.equal(f.reads.length, 1);
  f.advance(1);
  f.owner.pulse();
  f.advance(399);
  assert.equal(f.reads.length, 1);
  f.advance(1);
  assert.equal(f.reads.length, 2);
  await f.finish({ weather: TOKYO });
  assert.equal(f.state.reading, TOKYO);
  assert.equal(f.state.failed, false);
  assert.equal(f.reads[1].signal.reason?.name, 'AbortError');

  f.reads[0].resolve({ weather: { ...TOKYO, temperatureC: 99 } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.state.reading, TOKYO);
});

test('a completed deadline becomes due only on a visible pulse', async (t) => {
  const f = fixture(t);
  f.setInput({});
  f.advance(400);
  await f.finish(null);
  f.advance(59_600);
  f.owner.pulse();
  f.advance(500);

  f.setVisible(false);
  f.setInput({ moving: true });
  f.setInput({ moving: false });
  f.owner.pulse();
  f.advance(400);
  assert.equal(
    f.reads.length,
    1,
    'a background camera update cannot start a retry',
  );

  f.setVisible(true);
  f.advance(400);
  assert.equal(
    f.reads.length,
    1,
    'restoring visibility alone does not start a retry',
  );
  f.owner.pulse();
  f.advance(400);
  assert.equal(f.reads.length, 2);
});

test('settle samples live eligibility and a late reply releases its attempt before a coalesced camera update', async (t) => {
  const f = fixture(t);
  f.setInput({});
  f.setInput({ moving: true }, { deliver: false });
  f.advance(400);
  assert.deepEqual(f.reads, []);
  assert.deepEqual(f.publications, []);

  f.setInput({ moving: false }, { deliver: false });
  f.owner.pulse();
  f.advance(400);
  assert.equal(f.state.pending, true);

  f.reads[0].resolve({ weather: TOKYO });
  f.setInput({ center: B }, { deliver: false });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.reads[0].signal.aborted, true);
  assert.deepEqual(f.state, {
    reading: null,
    failed: false,
    zone: null,
    freshnessAt: null,
    pending: false,
  });

  f.setInput({ center: A }, { deliver: false });
  f.owner.pulse();
  f.advance(400);
  assert.equal(f.reads.length, 2);
  assert.equal(f.reads[1].lat, A.lat);

  const lastPublication = f.state;
  f.owner.stop();
  await f.finish({ weather: TOKYO });
  assert.equal(f.reads[1].signal.aborted, true);
  assert.equal(f.state, lastPublication);
});

test('a refresh retains weather through a hide and a failed refresh clears the local clock', async (t) => {
  const f = fixture(t);
  f.setInput({});
  f.advance(400);
  const retrievedAt = '2026-11-21T10:00:00Z';
  await f.finish({ weather: TOKYO, retrievedAt });
  const zone = f.state.zone;
  assert.equal(f.state.freshnessAt, Date.parse(retrievedAt));

  f.setInput({ shown: false, mountId: null });
  f.advance(659_600);
  f.owner.pulse();
  f.setInput({ shown: true, mountId: 2 });
  f.owner.pulse();
  f.advance(400);
  assert.equal(f.reads.length, 1);
  assert.equal(f.state.reading, TOKYO);
  assert.equal(f.state.zone, zone);

  f.owner.pulse();
  f.advance(400);
  assert.equal(f.reads.length, 2);
  assert.equal(f.state.pending, true);
  assert.equal(f.state.reading, TOKYO);
  await f.finish(null);
  assert.equal(f.state.failed, true);
  assert.equal(f.state.pending, false);
  assert.equal(f.state.reading, null);
  assert.equal(f.state.zone, null);
});

test('a new point clears the previous zone before settling, including across mounts', async (t) => {
  const f = fixture(t);
  f.setInput({});
  f.advance(400);
  const weather = { ...TOKYO, observedAt: '2026-11-21T08:00:00Z' };
  await f.finish({ weather, retrievedAt: '2026-11-21T11:59:00Z' });
  assert.equal(f.state.freshnessAt, Date.parse(weather.observedAt));
  assert.equal(f.state.zone.timeZone, TOKYO.timeZone);

  f.setInput({ center: B });
  assert.equal(f.state.zone, null);
  f.advance(400);
  assert.equal(f.state.zone, null);
  assert.equal(f.state.reading, null);
  await f.finish(null);
  assert.equal(f.state.zone, null);

  f.setInput({ center: A });
  f.advance(400);
  await f.finish({ weather: TOKYO });
  assert.equal(f.state.freshnessAt, RECEIVED + 1200);
  f.setInput({ center: FAR, moving: true });
  assert.equal(f.state.zone, null);

  f.setInput({ center: A, moving: false });
  f.advance(400);
  await f.finish({ weather: TOKYO });
  f.setInput({ shown: false, mountId: null });
  f.setInput({ center: B, shown: true, mountId: 2 });
  f.advance(400);
  assert.equal(f.state.pending, true);
  assert.equal(f.state.zone, null);
});
