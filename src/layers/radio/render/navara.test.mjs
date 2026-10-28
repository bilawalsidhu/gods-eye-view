import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeEngine } from '../../../globe/testing/fakeEngine.js';
import { createRadioLayer } from '../index.js';
import { createRadioNavaraRenderer } from './navara.js';

const rows = Array.from({ length: 4 }, (_, i) => ({
  id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
  name: `Station ${i}`,
  lat: 0,
  lon: i === 3 ? 10 : i * 0.001,
  streamUrl: `https://audio.example.test/${i}.mp3`,
  homepage: null,
  tags: ['news'],
  languages: ['English'],
  state: '',
  country: 'United States',
  countryCode: 'US',
  metadataTrust: 'untrusted-community',
  codec: 'MP3',
  bitrate: 128,
}));
const body = (stations = rows, generation = 1) => ({
  stations,
  updatedAt: new Date().toISOString(),
  stale: false,
  degraded: false,
  acceptedGeneration: generation,
  catalogInstance: 'fixture',
});
const noop = () => {};
function fixture(t) {
  const previous = globalThis.Audio;
  const plays = [];
  globalThis.Audio = class {
    volume = 0.8;
    addEventListener() {}
    pause() {}
    removeAttribute() {}
    load() {}
    play() {
      plays.push(this.src);
      return Promise.resolve();
    }
  };
  t.after(() => {
    globalThis.Audio = previous;
  });
  const engine = createFakeEngine({ kind: 'navara' });
  engine.fake.setPose({ longitude: 0, latitude: 0, height: 1_000_000 });
  let response = body();
  let context;
  const entries = new Map();
  const layer = createRadioLayer({
    source: { getDirectory: async () => response, recordClick: async () => {} },
    services: {
      ground: { cachedGroundFloor: () => 20, warmGroundFloor: noop },
      globe: {
        earthDiscScreenRadius: () => null,
        getKeyholeGeometry: () => ({ radius: 500 }),
      },
      picking: {
        registerPickOwner: noop,
        unregisterPickOwner: noop,
        resolvePickId: (pick) => pick?.id,
        isOwnedByOtherLayer: () => false,
      },
      render: { governorRequestRender: noop },
      overlays: {
        clearOverlaySource: (id) => entries.delete(id),
        setOverlaySourceVisible: noop,
        setOverlayEntries: (id, value) => entries.set(id, value),
      },
    },
    rendererFactory(value) {
      context = value;
      return createRadioNavaraRenderer(engine, value);
    },
  });
  layer.init(null, { engine });
  t.after(() => layer.destroy());
  return {
    engine,
    layer,
    plays,
    entries,
    context,
    respond(value) {
      response = value;
    },
    async settle() {
      engine.fake.frame();
      await new Promise((resolve) => setTimeout(resolve, 1));
    },
  };
}

test('Navara radio preserves station clusters, direct gesture audio and selected style', async (t) => {
  const f = fixture(t);
  f.layer.enable();
  await f.layer.update();
  await f.settle();
  assert.equal(f.plays.length, 0, 'enable must not autoplay');
  const normal = f.engine.fake.moverSet('radio-stations');
  const cluster = f.engine.fake.moverSet('radio-clusters');
  assert.equal(normal.store.count, 4);
  assert.equal(cluster.store.count, 1);
  assert.equal(normal.options.point.sizePx, 13);
  assert.equal(normal.options.point.outlinePx, 1);
  assert.equal(cluster.options.point.outlinePx, 2);
  assert.equal(normal.options.sharpen, true);
  assert.deepEqual(
    Array.from(normal.store.shows.slice(0, normal.store.count)),
    [0, 0, 0, 1],
  );
  const id = cluster.store.pickIds[0];
  assert.ok(id.startsWith('radio:'));
  f.engine.fake.script('pick', { id });
  f.engine.fake.input('click', { position: { x: 100, y: 100 } });
  assert.equal(
    f.plays.length,
    1,
    'play is called inside the direct input callback',
  );
  assert.equal(f.layer.getUIState().selected.id, id.slice(6));
  const selected = f.engine.fake.moverSet('radio-selected');
  const bracket = f.engine.fake.moverSet('radio-bracket');
  assert.equal(selected.store.count, 1);
  assert.equal(selected.options.point.sizePx, 14);
  assert.equal(selected.options.point.scaleByDistance, null);
  assert.equal(bracket.options.sprite.sizePx, 40);
  assert.equal(bracket.store.pickIds[0], `radio:selected:${id.slice(6)}`);
  f.layer.setFilter('talk');
  await f.settle();
  assert.equal(f.layer.getUIState().selected.id, id.slice(6));
  assert.equal(cluster.store.count, 0);
  assert.equal(selected.store.count, 1);
});

test('Navara radio budget rejection preserves the accepted catalog and repeated lifecycle frees every batch', async (t) => {
  const f = fixture(t);
  f.layer.enable();
  await f.layer.update();
  await f.settle();
  const accepted = f.layer.getAcceptedCatalogSnapshot();
  f.respond(body(Array(751).fill(rows[0]), 2));
  await f.layer.update();
  assert.equal(f.layer.getAcceptedCatalogSnapshot(), accepted);
  assert.equal(f.layer.getStats().count, 4);
  assert.match(f.layer.getStats().error, /previous station catalog/);
  for (let i = 0; i < 10; i++) {
    f.layer.disable();
    await f.settle();
    for (const name of [
      'radio-stations',
      'radio-clusters',
      'radio-selected',
      'radio-bracket',
    ])
      assert.equal(f.engine.fake.moverSet(name).store.count, 0);
    assert.equal(f.context.state._clickHandler, null);
    assert.equal(f.context.state._horizonTimer, null);
    f.layer.enable();
    f.layer.enable();
    await f.settle();
    assert.equal(f.engine.frames.preRender.numberOfListeners, 1);
    assert.equal(f.engine.camera.changed.numberOfListeners, 1);
  }
  f.layer.destroy();
  f.layer.destroy();
  assert.deepEqual(f.engine.movers.list(), []);
  assert.equal(f.engine.frames.preRender.numberOfListeners, 0);
  assert.equal(f.engine.camera.changed.numberOfListeners, 0);
  assert.equal(f.plays.length, 0);
});

test('Navara radio navigation yields to follow ownership and hides points outside the native distance range', async (t) => {
  const f = fixture(t);
  f.layer.enable();
  await f.layer.update();
  await f.settle();
  const follow = f.engine.camera.follow({
    position: () => ({ x: 6378140, y: 0, z: 0 }),
    viewFrom: { x: 100, y: 0, z: 0 },
  });
  const before = f.engine.fake.callsOf('camera.flyTo').length;
  f.layer.selectStation(rows[0].id, { focus: true, autoplay: false });
  assert.equal(f.engine.fake.callsOf('camera.flyTo').length, before);
  follow.stop();
  f.engine.fake.setPose({ longitude: 0, latitude: 0, height: 60_000_000 });
  await f.settle();
  for (const name of [
    'radio-stations',
    'radio-clusters',
    'radio-selected',
    'radio-bracket',
  ]) {
    const { store } = f.engine.fake.moverSet(name);
    assert.ok(
      Array.from(store.shows.slice(0, store.count)).every(
        (value) => value === 0,
      ),
    );
  }
});
