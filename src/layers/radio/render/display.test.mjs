// Layer display behavior on the fake engine.

import test from 'node:test';
import assert from 'node:assert/strict';

import * as geo from '../../../geo/index.js';
import { createFakeEngine } from '../../../globe/testing/fakeEngine.js';

import { projectEarthDiscToViewport } from '../../../celestialRing.js';
import { rgbaFromCss } from '../../shared/color.js';
import { createRadioLayer } from '../index.js';
import { RADIO_GLOBE_INTERACTION_MAX_DISTANCE_M } from '../policy.js';
import { createRadioDisplay } from './display.js';

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
const SETS = [
  'radio-stations',
  'radio-clusters',
  'radio-selected',
  'radio-bracket',
];
const NEWS = '#44adff';
const near = (actual, expected, label, tolerance = 1e-6) =>
  assert.ok(
    Math.abs(actual - expected) < tolerance,
    `${label}: ${actual} vs ${expected}`,
  );

function fakeHarness() {
  const engine = createFakeEngine();
  return {
    name: 'the fake engine',
    engine,
    frame: () => engine.fake.frame(),
    /** A click whose pick is `picked` (a mover's pick result). */
    click(picked) {
      engine.fake.script('pick', picked);
      engine.fake.input('click', { position: { x: 100, y: 100 } });
    },
    instance(id, index) {
      const { store, options } = engine.fake.moverSet(id);
      return {
        shown: index < store.count && store.shows[index] === 1,
        color: [...store.colors.slice(index * 4, index * 4 + 4)],
        pixelSize:
          (options.point ?? options.sprite).sizePx * store.scales[index],
        id: store.pickIds[index],
      };
    },
    pick: (id, index) => ({
      id: engine.fake.moverSet(id).store.pickIds[index],
      owner: id,
      instance: index,
    }),
  };
}

const HARNESSES = [fakeHarness];

function fixture(t, makeHarness) {
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
  const h = makeHarness();
  const at = (height) =>
    h.engine.camera.setView({
      destination: geo.cartesian3.fromDegrees(0, 0, height),
    });
  at(1_000_000);
  let response = body();
  let context;
  const entries = new Map();
  const listeners = {
    preRender: h.engine.frames.preRender.numberOfListeners,
    changed: h.engine.camera.changed.numberOfListeners,
  };
  const layer = createRadioLayer({
    source: { getDirectory: async () => response, recordClick: async () => {} },
    services: {
      ground: { cachedGroundFloor: () => 20, warmGroundFloor: noop },
      globe: {
        projectEarthDiscToViewport,
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
        clearSource: (id) => entries.delete(id),
        setVisible: noop,
        setEntries: (id, value) => entries.set(id, value),
      },
    },
    rendererFactory(value) {
      context = value;
      return createRadioDisplay(h.engine, value);
    },
  });
  layer.init(null, { engine: h.engine });
  t.after(() => {
    layer.destroy();
    h.engine.destroy();
  });
  return {
    ...h,
    layer,
    plays,
    entries,
    at,
    listeners,
    get context() {
      return context;
    },
    respond(value) {
      response = value;
    },
    count: (id) => h.engine.movers.list().find((set) => set.id === id)?.count,
    async settle() {
      h.frame();
      await new Promise((resolve) => setTimeout(resolve, 1));
    },
  };
}

for (const makeHarness of HARNESSES) {
  const { name } = makeHarness();

  test(`stations, clusters and the selection keep their styles; a click plays (${name})`, async (t) => {
    const f = fixture(t, makeHarness);
    f.layer.enable();
    await f.layer.update();
    await f.settle();
    assert.equal(f.plays.length, 0, 'enable must not autoplay');
    assert.equal(f.count('radio-stations'), 4);
    assert.equal(f.count('radio-clusters'), 1);
    assert.deepEqual(
      [0, 1, 2, 3].map((i) => f.instance('radio-stations', i).shown),
      [false, false, false, true],
      'three stations within 42 px cluster; the far one stays single',
    );
    const station = f.instance('radio-stations', 3);
    rgbaFromCss(NEWS)
      .withAlpha(0.86)
      .rgba()
      .forEach((value, i) =>
        near(station.color[i], value, `station colour ${i}`),
      );
    near(station.pixelSize, 13, 'station size');
    const cluster = f.instance('radio-clusters', 0);
    assert.equal(f.layer.picks.owner, 'radio');
    assert.equal(f.layer.picks.predicate(station.id), true);
    assert.equal(f.layer.picks.predicate(cluster.id), true);
    assert.equal(f.layer.picks.predicate('other'), false);
    near(
      cluster.pixelSize,
      Math.min(26, 12 + Math.log2(3) * 1.6),
      'cluster size',
    );
    rgbaFromCss(NEWS)
      .withAlpha(0.9)
      .rgba()
      .forEach((value, i) =>
        near(cluster.color[i], value, `cluster colour ${i}`),
      );
    {
      const { options } = f.engine.fake.moverSet('radio-stations');
      assert.equal(options.point.sizePx, 13);
      assert.equal(options.point.outlinePx, 1);
      assert.deepEqual(
        options.point.scaleByDistance,
        [100_000, 1.15, 12_000_000, 1],
      );
      assert.equal(options.depthTest, 'always');
      assert.equal(options.sharpen, true);
      assert.equal(options.pickable, true);
      assert.equal(
        f.engine.fake.moverSet('radio-clusters').options.point.outlinePx,
        2,
      );
    }
    const clusterId = f.context.parts.renderer.clusters()[0].stationIds[0];
    f.click(f.pick('radio-clusters', 0));
    assert.equal(
      f.plays.length,
      1,
      'play is called inside the direct input callback',
    );
    assert.equal(
      f.layer.getUIState().selected.id,
      clusterId,
      'a cluster click selects its first station',
    );
    assert.equal(f.count('radio-selected'), 1);
    assert.equal(f.count('radio-bracket'), 1);
    const selected = f.instance('radio-selected', 0);
    near(selected.pixelSize, 14, 'selected size');
    near(selected.color[3], 1, 'the selection is opaque');
    const bracket = f.instance('radio-bracket', 0);
    near(bracket.pixelSize, 40, 'bracket size');
    assert.equal(bracket.id, `radio:selected:${clusterId}`);
    assert.equal(f.layer.picks.predicate(bracket.id), true);
    {
      const { options } = f.engine.fake.moverSet('radio-selected');
      assert.equal(options.point.sizePx, 14);
      assert.equal(options.point.scaleByDistance, null);
      assert.deepEqual(
        f.engine.fake.moverSet('radio-bracket').options.sprite.scaleByDistance,
        [100_000, 1, 12_000_000, 0.72],
      );
    }
    f.layer.setFilter('talk');
    await f.settle();
    assert.equal(f.layer.getUIState().selected.id, clusterId);
    assert.equal(f.count('radio-clusters'), 0);
    assert.equal(f.count('radio-selected'), 1);
  });

  test(`a rejected budget keeps the catalog and repeated lifecycles free every set (${name})`, async (t) => {
    const f = fixture(t, makeHarness);
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
      for (const id of SETS) assert.equal(f.count(id), 0, id);
      assert.equal(f.context.state._clickHandler, null);
      assert.equal(f.context.state._horizonTimer, null);
      f.layer.enable();
      f.layer.enable();
      await f.settle();
      assert.equal(
        f.engine.frames.preRender.numberOfListeners,
        f.listeners.preRender + 1,
      );
      assert.equal(
        f.engine.camera.changed.numberOfListeners,
        f.listeners.changed + 1,
      );
    }
    f.layer.destroy();
    f.layer.destroy();
    assert.deepEqual(f.engine.movers.list(), []);
    assert.equal(
      f.engine.frames.preRender.numberOfListeners,
      f.listeners.preRender,
    );
    assert.equal(
      f.engine.camera.changed.numberOfListeners,
      f.listeners.changed,
    );
    assert.equal(f.plays.length, 0);
  });

  test(`navigation yields to a follow and points hide beyond the interaction distance (${name})`, async (t) => {
    const f = fixture(t, makeHarness);
    f.layer.enable();
    await f.layer.update();
    await f.settle();
    let flights = 0;
    const flyTo = f.engine.camera.flyTo;
    f.engine.camera.flyTo = (...args) => {
      flights++;
      return flyTo.apply(f.engine.camera, args);
    };
    t.after(() => {
      f.engine.camera.flyTo = flyTo;
    });
    const follow = f.engine.camera.follow({
      position: () => geo.cartesian3.fromDegrees(0, 0, 0),
      viewFrom: { x: 100, y: 0, z: 0 },
    });
    f.layer.selectStation(rows[0].id, { focus: true, autoplay: false });
    assert.equal(flights, 0, 'a followed camera is not flown');
    follow.stop();
    f.at(RADIO_GLOBE_INTERACTION_MAX_DISTANCE_M + 10_000_000);
    await f.settle();
    for (const id of SETS)
      for (let i = 0; i < f.count(id); i++)
        assert.equal(f.instance(id, i).shown, false, `${id} ${i}`);
    f.at(1_000_000);
    await f.settle();
    assert.equal(f.instance('radio-stations', 3).shown, true, 'back in range');
  });

  test(`recentering reads the Earth disc through the engine's projector (${name})`, (t) => {
    const f = fixture(t, makeHarness);
    f.at(20_000_000);
    const view = f.context.parts.renderer.recenterView();
    const { width, height } = f.engine.host.size();
    assert.equal(view.width, width);
    assert.equal(view.height, height);
    near(view.cartographic.height, 20_000_000, 'camera height', 1e-3);
    const pose = f.engine.camera.pose();
    const expected = projectEarthDiscToViewport(
      {
        camera: {
          positionWC: pose.position,
          directionWC: pose.direction,
          frustum: { fovy: pose.fovy },
        },
        scene: {},
      },
      width,
      height,
      undefined,
      undefined,
      f.engine.projector,
    );
    for (const key of ['earthCenterX', 'earthCenterY', 'earthRadius'])
      near(view.geometry[key], expected[key], key, 1e-6);
    near(view.geometry.earthCenterX, width / 2, 'the globe is centred', 1e-3);
    near(view.toCenter.x, -pose.position.x, 'toCenter', 1e-3);
  });
}
