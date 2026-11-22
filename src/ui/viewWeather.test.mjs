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
    spotWeather(lat, lon, { signal }) {
      const result = Promise.withResolvers();
      reads.push({ lat, lon, signal, ...result });
      return result.promise;
    },
  };
}

function mountInspector(t, { regionalBrief, spotWeather, layers = [] } = {}) {
  t.mock.method(
    globalThis,
    'fetch',
    async () => new Response('', { status: 503 }),
  );
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  let elapsed = 0;
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
      weatherClock: { nowMonotonic: () => elapsed },
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
      elapsed += ms;
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
  const { point, advance, flush, facts, clock } = mountInspector(t, {
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
  assert.match(clock(), /local/, 'a nearby zone remains while fetching');
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
  assert.match(
    clock(),
    /local/,
    'the verified zone still belongs to this cell',
  );
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
  assert.doesNotMatch(f.clock(), /local/);
  assert.doesNotMatch(f.facts(), /18 °C/);

  reads[1].resolve({
    weather: { ...observation(21).weather, timeZone: 'America/Phoenix' },
  });
  await f.flush();
  assert.match(f.clock(), /local/);
  assert.match(f.facts(), /21 °C/);
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
