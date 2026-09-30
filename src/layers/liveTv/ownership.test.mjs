import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';
import { LIVE_TV_PAGE_SIZE } from './records.js';
import { createLiveTvLayer, liveTvLabelTitle } from './index.js';

const POLAND = {
  code: 'PL',
  name: 'Poland',
  lon: 19.4,
  lat: 52.1,
  channels: 3,
};
const GERMANY = {
  code: 'DE',
  name: 'Germany',
  lon: 10.3,
  lat: 51.1,
  channels: 2,
};
// On the far side of the globe from the test camera above 0°N 0°E.
const FIJI = { code: 'FJ', name: 'Fiji', lon: 178, lat: -17.8, channels: 1 };

const tv = (id, categories = ['general'], extra = {}) => ({
  id,
  name: id.split('.')[0],
  categories,
  streams: [
    {
      url: `https://${id.toLowerCase()}.example/a.m3u8`,
      quality: '720p',
      labels: [],
    },
    {
      url: `https://${id.toLowerCase()}.example/b.m3u8`,
      quality: '',
      labels: ['Geo-blocked'],
    },
  ],
  ...extra,
});
const POLISH = [
  tv('Info.pl', ['news']),
  tv('Kino.pl', ['movies']),
  tv('Sport.pl', ['sports']),
];

function harness({
  countries = [POLAND, GERMANY],
  channels = { PL: POLISH },
  picking = null,
  showAdult,
} = {}) {
  const sources = [];
  const flights = [];
  const opened = [];
  const handlers = [];
  const players = [];
  const countryCalls = [];
  let preRender = null;
  let picked;
  let failCountry = false;
  const overlay = {
    entries: new Map(),
    visible: new Map(),
    setEntries(sourceId, entries, options) {
      assert.equal(sourceId, 'live-tv');
      assert.equal(options.moving, false);
      overlay.entries.set(sourceId, entries);
    },
    setVisible(sourceId, visible) {
      overlay.visible.set(sourceId, visible);
    },
    clearSource(sourceId) {
      overlay.entries.delete(sourceId);
    },
  };
  class FakeHandler {
    constructor(canvas) {
      this.canvas = canvas;
      this.actions = new Map();
      this.destroyed = false;
      handlers.push(this);
    }
    setInputAction(callback, type) {
      this.actions.set(type, callback);
    }
    isDestroyed() {
      return this.destroyed;
    }
    destroy() {
      this.destroyed = true;
    }
  }
  const viewer = {
    dataSources: {
      add(value) {
        sources.push(value);
      },
      remove(value) {
        sources.splice(sources.indexOf(value), 1);
      },
    },
    camera: {
      positionWC: Cesium.Cartesian3.fromDegrees(0, 0, 20_000_000),
      flyTo(options) {
        flights.push(options);
      },
    },
    scene: {
      canvas: {},
      requestRender() {},
      pick: () => picked,
      preRender: {
        addEventListener(callback) {
          preRender = callback;
          return () => {
            preRender = null;
          };
        },
      },
    },
  };
  const layer = createLiveTvLayer({
    source: {
      getSnapshot: async () => ({ countries, fetchedAt: 1, stale: false }),
      getCountry: async (code) => {
        countryCalls.push(code);
        if (failCountry) throw new Error('Live TV HTTP 502');
        return { code, channels: channels[code] || [] };
      },
    },
    cesium: { ...Cesium, ScreenSpaceEventHandler: FakeHandler },
    now: () => 1_000,
    matchMedia: () => ({ matches: false }),
    openExternal: (url) => opened.push(url),
    attachStreams: (video, streams, options) => {
      const player = { video, streams, options, disposed: false };
      player.dispose = () => {
        player.disposed = true;
      };
      players.push(player);
      return player;
    },
    picking,
    pointer: { isPointerFree: () => true },
    overlayHost: overlay,
    showAdult,
  });
  layer.init(viewer);
  return {
    layer,
    viewer,
    overlay,
    sources,
    flights,
    opened,
    handlers,
    players,
    countryCalls,
    failCountry: (value) => {
      failCountry = value;
    },
    labels: () =>
      (overlay.entries.get('live-tv') || []).map(
        ({ id, title, protected: active }) => [id, title, active],
      ),
    runPreRender: () => preRender?.(),
    hasPreRender: () => preRender !== null,
    click(pick) {
      picked = pick;
      handlers.at(-1).actions.get(Cesium.ScreenSpaceEventType.LEFT_CLICK)({
        position: new Cesium.Cartesian2(1, 1),
      });
    },
  };
}

function fakePicking() {
  const owners = new Map();
  return {
    owners,
    registerPickOwner(id, predicate) {
      owners.set(id, predicate);
    },
    unregisterPickOwner(id) {
      owners.delete(id);
    },
    resolvePickId: (picked) => picked?.id?.id ?? picked?.id ?? null,
    isOwnedByOtherLayer: (layerId, pickedId) =>
      [...owners].some(([id, owns]) => id !== layerId && owns(pickedId)),
  };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

async function chooseCountry(h, code = 'PL') {
  h.layer.setParams({ country: code });
  await settle();
}

test('the layer requires both source methods and cannot be initialized twice', () => {
  assert.throws(() => createLiveTvLayer({}), TypeError);
  assert.throws(
    () => createLiveTvLayer({ source: { getSnapshot() {} } }),
    TypeError,
  );
  const { layer } = harness();
  assert.throws(() => layer.init({ dataSources: { add() {} } }), /already/);
});

test('an enabled refresh draws one pin per country and labels the busiest', async () => {
  const { layer, sources, overlay, labels, countryCalls, players } = harness();
  assert.equal(overlay.visible.get('live-tv'), false);
  assert.equal(await layer.update(), false, 'disabled layers do not fetch');
  layer.enable();
  assert.equal(await layer.update(), true);
  const entities = sources[0].entities.values;
  assert.deepEqual(
    entities.map(({ id }) => id),
    ['live-tv:PL', 'live-tv:DE'],
  );
  assert.ok(entities[0].point.pixelSize.getValue() >= 6);
  assert.deepEqual(labels(), [
    ['PL', 'Poland · 3 TV', false],
    ['DE', 'Germany · 2 TV', false],
  ]);
  const controls = layer.getRowControls();
  assert.deepEqual(
    controls.chips.map(({ id, label }) => [id, label]),
    [
      ['project', 'iptv-org ↗'],
      ['adult', 'Adult 18+'],
    ],
  );
  assert.deepEqual(
    controls.list.items.map(({ lead, text, params }) => [lead, text, params]),
    [
      ['3', 'Poland', { country: 'PL', focus: true }],
      ['2', 'Germany', { country: 'DE', focus: true }],
    ],
  );
  assert.equal(controls.media, undefined);
  assert.equal(
    controls.info,
    '5 channels in 2 countries · select a TV pin · Third-party streams, linked not hosted',
  );
  assert.match(controls.infoTitle, /linked, not hosted/);
  assert.deepEqual(layer.getStats(), {
    count: 5,
    lastUpdate: 1_000,
    error: null,
    stale: false,
  });
  assert.deepEqual(
    countryCalls,
    [],
    'no channel list until a country is chosen',
  );
  assert.deepEqual(players, [], 'no stream until a channel is chosen');
});

test('choosing a country lists its channels, pages them and filters news', async () => {
  const many = Array.from({ length: LIVE_TV_PAGE_SIZE + 5 }, (_, index) =>
    tv(
      `Ch${String(index).padStart(2, '0')}.pl`,
      index % 2 ? ['news'] : ['general'],
    ),
  );
  const h = harness({ channels: { PL: many } });
  h.layer.enable();
  await h.layer.update();
  h.layer.setParams({ country: 'PL' });
  assert.match(h.layer.getRowControls().info, /Loading channels…/);
  await settle();
  let controls = h.layer.getRowControls();
  assert.deepEqual(h.countryCalls, ['PL']);
  assert.equal(controls.list.items.length, LIVE_TV_PAGE_SIZE);
  assert.equal(controls.list.items[0].text, 'Ch00 · general · Geo-blocked');
  assert.equal(controls.list.items[0].lead, '720p');
  assert.deepEqual(
    controls.chips.map(({ id, disabled }) => [id, disabled]),
    [
      ['news', undefined],
      ['adult', undefined],
      ['previous', true],
      ['next', false],
      ['countries', undefined],
    ],
  );
  assert.match(controls.info, /Page 1 of 2/);
  h.layer.setParams({ page: 'next' });
  controls = h.layer.getRowControls();
  assert.equal(controls.list.items.length, 5);
  assert.equal(controls.list.items[0].ordinal, LIVE_TV_PAGE_SIZE + 1);
  h.layer.setParams({ page: 'next' });
  assert.match(h.layer.getRowControls().info, /Page 2 of 2/, 'clamped');
  h.layer.setParams({ newsOnly: true });
  controls = h.layer.getRowControls();
  assert.equal(controls.chips[0].active, true);
  assert.equal(controls.list.items.length, 22);
  assert.ok(controls.list.items.every(({ text }) => text.includes('news')));
  assert.deepEqual(h.labels()[0], ['PL', 'Poland · 3 TV', true]);
  h.layer.setParams({ clear: true });
  assert.equal(h.layer.getDiagnostics().selectedCountry, null);
});

test('a channel plays only when chosen, restarts on a repeat and stops cleanly', async () => {
  const h = harness();
  h.layer.enable();
  await h.layer.update();
  await chooseCountry(h);
  assert.equal(h.layer.getRowControls().media, null);
  h.layer.setParams({ channelId: 'Kino.pl' });
  let controls = h.layer.getRowControls();
  assert.equal(controls.chips.at(-1).id, 'stop', 'Stop is the last chip');
  assert.equal(controls.list.items[1].lead, '▶');
  assert.equal(controls.list.items[1].active, true);
  const { media } = controls;
  assert.equal(media.label, 'Live TV: Kino');
  assert.deepEqual(h.players, [], 'the descriptor alone fetches nothing');
  const video = {};
  const release = media.attach(video);
  assert.equal(h.players.length, 1);
  assert.equal(h.players[0].video, video);
  assert.deepEqual(
    h.players[0].streams.map(({ url }) => url),
    ['https://kino.pl.example/a.m3u8', 'https://kino.pl.example/b.m3u8'],
  );
  assert.equal(
    h.layer.getRowControls().info,
    'Kino · starting · Poland · Page 1 of 1',
  );
  h.players[0].options.onStatus({ state: 'connecting', index: 1, total: 2 });
  assert.match(
    h.layer.getRowControls().info,
    /^Kino · connecting \(stream 2 of 2\)/,
  );
  h.players[0].options.onStatus({
    state: 'unavailable',
    index: 1,
    total: 2,
    reason: 'network',
  });
  assert.match(
    h.layer.getRowControls().info,
    /^Kino · stream unavailable: the host refused or did not answer\. Try another channel\./,
  );
  assert.equal(h.layer.getDiagnostics().playback.reason, 'network');

  h.layer.setParams({ channelId: 'Kino.pl' });
  const restarted = h.layer.getRowControls().media;
  assert.notEqual(restarted.key, media.key, 'a repeat pick is a new player');
  h.players[0].options.onStatus({ state: 'playing', index: 0, total: 2 });
  assert.equal(
    h.layer.getDiagnostics().playback,
    null,
    'old player is ignored',
  );
  release();
  assert.equal(h.players[0].disposed, true);
  assert.equal(
    typeof media.attach({})(),
    'undefined',
    'a stale attach is inert',
  );
  assert.equal(h.players.length, 1);

  h.layer.setParams({ stop: true });
  controls = h.layer.getRowControls();
  assert.equal(controls.media, null);
  assert.ok(!controls.chips.some(({ id }) => id === 'stop'));
  h.layer.setParams({ channelId: 'Nope.pl' });
  assert.equal(h.layer.getDiagnostics().channelId, null);
});

test('switching country or disabling stops the player and the country request', async () => {
  const h = harness();
  h.layer.enable();
  await h.layer.update();
  await chooseCountry(h);
  h.layer.setParams({ channelId: 'Info.pl' });
  await chooseCountry(h, 'DE');
  assert.equal(h.layer.getDiagnostics().channelId, null);
  assert.equal(
    h.layer.getRowControls().info,
    'Germany · 2 channels · No channels',
  );
  h.layer.setParams({ newsOnly: true });
  assert.match(h.layer.getRowControls().info, /No news channels here$/);
  h.layer.setParams({ newsOnly: false });
  await chooseCountry(h, 'PL');
  h.layer.setParams({ channelId: 'Info.pl' });
  h.layer.disable();
  assert.deepEqual(
    [
      h.layer.getDiagnostics().channelId,
      h.layer.getDiagnostics().selectedCountry,
    ],
    [null, null],
  );
  assert.equal(h.sources[0].show, false);
  assert.equal(h.overlay.visible.get('live-tv'), false);
});

test('adult channels stay hidden until Adult 18+ is on', async () => {
  const NETHERLANDS = {
    code: 'NL',
    name: 'Netherlands',
    lon: 5.6,
    lat: 52.2,
    channels: 0,
    adult: 2,
  };
  const channels = {
    PL: [...POLISH, tv('Late.pl', ['general'], { adult: true })],
    NL: [
      tv('Night.nl', ['general'], { adult: true }),
      tv('Club.nl', ['general'], { adult: true }),
    ],
  };
  const countries = [
    { ...POLAND, adult: 1 },
    { ...GERMANY, adult: 0 },
    NETHERLANDS,
  ];
  const h = harness({ countries, channels });
  h.layer.enable();
  await h.layer.update();
  const pins = () => h.sources[0].entities.values.map(({ id }) => id);
  assert.deepEqual(pins(), ['live-tv:PL', 'live-tv:DE']);
  assert.equal(h.layer.getStats().count, 5);
  await chooseCountry(h);
  let controls = h.layer.getRowControls();
  assert.equal(controls.list.items.length, 3);
  assert.equal(controls.chips.find(({ id }) => id === 'adult').active, false);

  h.layer.setParams({ showAdult: true });
  assert.deepEqual(pins(), ['live-tv:PL', 'live-tv:DE', 'live-tv:NL']);
  assert.equal(h.layer.getStats().count, 8);
  assert.deepEqual(h.labels()[0], ['PL', 'Poland · 4 TV', true]);
  controls = h.layer.getRowControls();
  assert.equal(controls.chips.find(({ id }) => id === 'adult').active, true);
  assert.equal(
    controls.list.items.find(({ id }) => id === 'Late.pl').text,
    '18+ · Late · general · Geo-blocked',
  );
  h.layer.setParams({ channelId: 'Late.pl' });
  h.layer.setParams({ showAdult: false });
  assert.equal(h.layer.getDiagnostics().channelId, null, 'adult player stops');
  assert.equal(h.layer.getDiagnostics().selectedCountry, 'PL');

  h.layer.setParams({ showAdult: true });
  await chooseCountry(h, 'NL');
  h.layer.setParams({ showAdult: false });
  assert.equal(
    h.layer.getDiagnostics().selectedCountry,
    null,
    'an adult-only country closes when its pin goes',
  );

  const shown = harness({ countries, channels, showAdult: true });
  shown.layer.enable();
  await shown.layer.update();
  assert.equal(shown.sources[0].entities.values.length, 3, 'opt-in default');
});

test('a failed channel list is reported on the row', async () => {
  const h = harness();
  h.layer.enable();
  await h.layer.update();
  h.failCountry(true);
  await chooseCountry(h);
  assert.match(
    h.layer.getRowControls().info,
    /Channel list unavailable: Live TV HTTP 502/,
  );
});

test('choosing a country from the list focuses the camera through the shell', async () => {
  const h = harness();
  let navigations = 0;
  h.layer.attachShellServices({
    runNavigation: (navigate) => {
      navigations += 1;
      return navigate();
    },
  });
  h.layer.enable();
  await h.layer.update();
  h.layer.setParams(h.layer.getRowControls().list.items[1].params);
  assert.equal(navigations, 1);
  const destination = Cesium.Cartographic.fromCartesian(
    h.flights[0].destination,
  );
  assert.equal(Math.round(Cesium.Math.toDegrees(destination.longitude)), 10);
  assert.equal(Math.round(Cesium.Math.toDegrees(destination.latitude)), 51);
  assert.equal(Math.round(destination.height), 2_500_000);
  h.layer.setParams({ country: 'ZZ', focus: true });
  assert.equal(h.layer.getDiagnostics().selectedCountry, 'DE');
  h.layer.setParams({ clear: true });
  h.layer.setParams(h.layer.getRowControls().chips[0].params);
  assert.deepEqual(h.opened, ['https://github.com/iptv-org/iptv']);
});

test('globe clicks select pins, yield to siblings and never clear a playing channel', async () => {
  const picking = fakePicking();
  picking.registerPickOwner('flights', (id) => id === 'aircraft-1');
  const h = harness({ picking });
  h.layer.enable();
  await h.layer.update();
  assert.equal(picking.owners.get('live-tv')('live-tv:PL'), true);
  assert.equal(picking.owners.get('live-tv')('aircraft-1'), false);
  h.click({ id: h.sources[0].entities.values[0] });
  assert.equal(h.layer.getDiagnostics().selectedCountry, 'PL');
  assert.equal(h.sources[0].entities.values[0].point.pixelSize.getValue(), 16);
  h.click({ id: 'aircraft-1' });
  assert.equal(h.layer.getDiagnostics().selectedCountry, 'PL');
  await settle();
  h.layer.setParams({ channelId: 'Info.pl' });
  h.click(undefined);
  assert.equal(h.layer.getDiagnostics().selectedCountry, 'PL', 'still playing');
  h.layer.setParams({ stop: true });
  h.click(undefined);
  assert.equal(h.layer.getDiagnostics().selectedCountry, null);
  h.layer.disable();
  assert.equal(h.handlers[0].destroyed, true);
  assert.equal(picking.owners.has('live-tv'), false);
});

test('pins behind the globe are hidden and re-checked when the camera moves', async () => {
  const h = harness({ countries: [GERMANY, FIJI] });
  h.layer.enable();
  await h.layer.update();
  const shown = () =>
    h.sources[0].entities.values.map(({ id, show }) => [id, show]);
  assert.deepEqual(shown(), [
    ['live-tv:DE', true],
    ['live-tv:FJ', false],
  ]);
  h.viewer.camera.positionWC = Cesium.Cartesian3.fromDegrees(
    178,
    -17,
    20_000_000,
  );
  h.runPreRender();
  assert.deepEqual(shown(), [
    ['live-tv:DE', false],
    ['live-tv:FJ', true],
  ]);
  h.layer.disable();
  assert.equal(h.hasPreRender(), false);
});

test('a vanished country clears the selection; destroy releases everything', async () => {
  let countries = [POLAND, GERMANY];
  const h = harness();
  h.layer.enable();
  await h.layer.update();
  await chooseCountry(h);
  const layer = createLiveTvLayer({
    source: {
      getSnapshot: async () => ({ countries }),
      getCountry: async (code) => ({ code, channels: POLISH }),
    },
  });
  const sources = [];
  layer.init({
    dataSources: {
      add: (value) => sources.push(value),
      remove: (value) => sources.splice(sources.indexOf(value), 1),
    },
    camera: { positionWC: Cesium.Cartesian3.fromDegrees(0, 0, 2e7) },
    scene: { requestRender() {} },
  });
  layer.enable();
  await layer.update();
  layer.setParams({ country: 'PL' });
  await settle();
  countries = [GERMANY];
  await layer.update();
  assert.equal(layer.getDiagnostics().selectedCountry, null);
  assert.deepEqual(layer.getDiagnostics().labels, []);
  layer.destroy();
  assert.equal(sources.length, 0);
  assert.equal(layer.getStats().count, 0);
});

test('globe labels carry the country and its channel count', () => {
  assert.equal(
    liveTvLabelTitle({ name: 'India', channels: 1234 }),
    'India · 1,234 TV',
  );
});
