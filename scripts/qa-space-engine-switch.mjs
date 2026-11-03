import assert from 'node:assert/strict';
import puppeteer from 'puppeteer';
import { launchFixture } from '../src/bench/launchFixture.js';
import {
  satelliteFixture,
  SATELLITE_FIXTURE_EPOCH,
} from '../src/bench/satelliteFixture.js';
import { blockPaidQaMaps } from './qa-map-policy.mjs';
import { switchGlobe } from './qa-switch-globe.mjs';
const url = new URL(process.argv[2]),
  missions = process.argv.includes('--missions');
if (
  !['localhost', '127.0.0.1'].includes(url.hostname) ||
  ['', '4173', '4185', '4186', '4187', '4188', '4189', '4194'].includes(
    url.port,
  )
)
  throw Error('Supply local keyless preview URL');
url.search = '?engine=navara&welcome=0';
url.hash = 'v=2&lat=5&lon=5&alt=18000000&pitch=-90&heading=0&map=sentinel2&l=';
const b = await puppeteer.launch({
  headless: true,
  args: ['--use-angle=metal', '--enable-gpu'],
});
try {
  const p = await b.newPage();
  await blockPaidQaMaps(p);
  const errors = [];
  p.on('pageerror', (e) => {
    errors.push(e.message);
    console.log('error', e.message);
  });
  const groups = Object.fromEntries(
    [
      'stations',
      'visual',
      'gps-ops',
      'glo-ops',
      'galileo',
      'geo',
      'starlink',
    ].map((g) => [g, satelliteFixture(g)]),
  );
  await p.evaluateOnNewDocument(
    (groups, launches, epoch) => {
      const fetch = window.fetch.bind(window);
      window.spaceReads = {};
      const mono = performance.now();
      Date.now = () => epoch + performance.now() - mono;
      window.fetch = (input, opt) => {
        const path = new URL(input.url ?? input, location.href).pathname;
        if (path.startsWith('/api/celestrak/') || path === '/api/launches') {
          window.spaceReads[path] = (window.spaceReads[path] || 0) + 1;
          const g = path.split('/').pop();
          return Promise.resolve(
            g === 'launches'
              ? Response.json(launches)
              : new Response(groups[g] ?? groups.stations),
          );
        }
        return fetch(input, opt);
      };
    },
    groups,
    launchFixture(),
    SATELLITE_FIXTURE_EPOCH,
  );
  await p.goto(url.href);
  await p.waitForFunction(
    () =>
      window.__godsEyeView?.engine.kind === 'navara' &&
      document.querySelector('#loading-screen.hidden'),
  );
  await p.evaluate(async (missions) => {
    const { dataManager, styleManager, tileset } = window.__godsEyeView;
    if (tileset || window.__GOOGLE_MAPS_API_KEY__)
      throw Error('Expected keyless preview');
    await styleManager.initialRestorePromise;
    window.sa = dataManager.layers.get('satellites').module;
    window.la = dataManager.layers.get('rocket-launches').module;
    if (missions) {
      const result = await styleManager.setContextMode('space-missions');
      if (!result.ok) throw Error('Missions mode unavailable: ' + result.error);
    } else await dataManager.setEnabled('satellites', true, { origin: 'user' });
  }, missions);
  if (!missions) {
    await p.waitForFunction(() => window.sa.getStats().count === 839, {
      timeout: 40000,
    });
    console.log('core catalog ready');
    await p.evaluate(() => window.sa.setParams({ catalog: 'dense' }));
    await p.waitForFunction(() => window.sa.getStats().count === 6839, {
      timeout: 60000,
    });
    console.log('dense catalog ready');
    assert.ok(
      await p.evaluate(() => window.sa.trackById(25544, { origin: 'user' })),
    );
  } else {
    await p.waitForFunction(() => window.la.getStats().count === 3, {
      timeout: 40000,
    });
    await p.evaluate(() => {
      window.la.selectMissionAt(0);
      window.la.startSelectedReplay();
      window.la.setReplaySpeed(4);
    });
    await p.waitForFunction(() => window.la.qaDrawn()?.replay?.active, {
      timeout: 20000,
    });
    await p.waitForFunction(
      () => window.la.qaDrawn()?.replay?.phaseProgress > 0.001,
      { timeout: 35000 },
    );
    await p.evaluate(() => window.la.toggleReplayPause());
  }
  const before = await p.evaluate(() => ({
    reads: window.spaceReads,
    stamp: (window.la.getStats().count ? window.la : window.sa).getStats()
      .lastUpdate,
    mission: window.la.qaDrawn()?.selected,
    replay: window.la.qaDrawn()?.replay,
  }));
  console.log(
    'before switch',
    before.reads,
    before.mission,
    before.replay?.active,
  );
  for (const kind of ['cesium', 'navara']) {
    await switchGlobe(p, kind);
    const state = await p.evaluate(() => {
      const { dataManager, engine, styleManager } = window.__godsEyeView;
      return {
        ids: [
          dataManager.layers.get('satellites').module === window.sa,
          dataManager.layers.get('rocket-launches').module === window.la,
        ],
        reads: window.spaceReads,
        sat: window.sa.getStats(),
        params: window.sa.getParams(),
        follow: !!engine.camera.following(),
        ring: window.sa.qaDrawn()?.rings.length,
        mission: window.la.qaDrawn(),
        mode: styleManager.getContextModeState().mode,
        missionStats: window.la.getStats(),
      };
    });
    console.log(
      kind,
      state.ids,
      state.sat.count,
      state.params.selectedSatTrackingId,
      state.follow,
      state.mode,
      state.mission?.selected,
      state.mission?.replay?.phaseProgress,
    );
    assert.ok(state.ids.every(Boolean));
    assert.deepEqual(state.reads, before.reads);
    if (missions) {
      assert.equal(state.mode, 'space-missions');
      assert.equal(state.mission.selected, before.mission);
      assert.ok(state.mission.paused && state.mission.replay.active);
      assert.equal(state.mission.speed, 4);
      assert.equal(state.missionStats.lastUpdate, before.stamp);
      assert.equal(
        state.mission.replay.phaseProgress,
        before.replay.phaseProgress,
      );
    } else {
      assert.equal(state.sat.count, 6839);
      assert.equal(state.params.selectedSatTrackingId, 25544);
      assert.ok(state.follow && state.ring > 0);
      assert.equal(state.sat.lastUpdate, before.stamp);
    }
  }
  if (missions) {
    await p.evaluate(() => window.la.toggleReplayPause());
    await p.waitForFunction(() => window.la.qaDrawn()?.paused === false);
    await p.waitForFunction(
      (progress) => window.la.qaDrawn()?.replay?.phaseProgress > progress,
      {},
      before.replay.phaseProgress,
    );
    await switchGlobe(p, 'cesium');
    const moving = await p.evaluate(() => window.la.qaDrawn());
    assert.ok(
      moving.replay?.active &&
        !moving.paused &&
        moving.replay.phaseProgress > before.replay.phaseProgress,
    );
    const left = await p.evaluate(() =>
      window.__godsEyeView.styleManager.setContextMode(null),
    );
    assert.ok(left.ok);
    assert.equal(
      await p.evaluate(() =>
        window.__godsEyeView.dataManager.isEnabled('rocket-launches'),
      ),
      false,
    );
  }
  assert.deepEqual(errors, []);
  console.log('PASS retained space data and active camera across both planets');
} finally {
  await b.close();
}
