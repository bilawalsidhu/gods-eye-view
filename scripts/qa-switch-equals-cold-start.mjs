import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  createStrict,
  localPreview,
  openPage,
  waitForEngine,
} from './qa-strict-harness.mjs';
import { whenSettled } from './qa/ready.mjs';
import { drawLedger } from './qa/ledger.mjs';
import {
  COLD_START_GROUPS,
  coldStartUrl,
  compareColdStart,
  probeSnapshot,
  sessionExclusion,
} from './qa/coldStart.mjs';
import { coldStartFixtures } from './qa/coldStartFixtures.mjs';
import { stations } from './fixtures/layers/radio.mjs';

// Each registered group compares both directions, with a fresh storage context
// for every cold page. The URL writer and restore path supply the reference.
// node scripts/qa-switch-equals-cold-start.mjs http://127.0.0.1:4309
//   --group=ground --evidence=tmp_switch_cold_ground.json
const base = localPreview(process.argv[2]);
const group = process.argv.find((arg) => arg.startsWith('--group='))?.slice(8);
assert.ok(
  COLD_START_GROUPS[group],
  `Supply --group=${Object.keys(COLD_START_GROUPS).join('|')}`,
);
const { layers, view } = COLD_START_GROUPS[group];
const fixture = await coldStartFixtures(base.origin, group);
const allow = JSON.parse(
  readFileSync(new URL('./qa-ledger-allow.json', import.meta.url), 'utf8'),
);
const strict = createStrict({
  origin: base.origin,
  layers,
  routes: fixture.routes,
  fixtures: fixture.fixtures,
  name: `switch-equals-cold-start--${group}`,
  time: new Date(fixture.epoch).toISOString(),
});
const evidence = (strict.extra.coldStart = {
  group,
  layers,
  samples: [],
  differences: [],
  skipped: [],
});

async function settle(page, cold = false) {
  await whenSettled(page, { timeoutMs: 30000 });
  await page.waitForFunction(
    (layers, cold) => {
      const { dataManager, engine } = window.__godsEyeView;
      engine.render.request('qa-cold-start-readiness');
      return layers.every((id) => {
        const entry = dataManager.layers.get(id),
          module = entry?.module;
        if (!entry) return false;
        if (cold && module.sessionState?.includes('enabled'))
          return !entry.enabled;
        if (
          !entry.enabled ||
          !entry.initialized ||
          entry.sceneDetached ||
          entry.refreshing
        )
          return false;
        const stats = module.getStats?.() ?? {};
        if (stats.loading || stats.refreshing) return false;
        // These layers can be enabled with no search, route or selected subject.
        if (
          [
            'directions',
            'military-awareness',
            'osm-places',
            'sea-marks',
            'ski-pistes',
          ].includes(id)
        )
          return true;
        return stats.count > 0;
      });
    },
    { timeout: 30000, polling: 100 },
    layers,
    cold,
  );
  await whenSettled(page, { frames: 5, timeoutMs: 30000 });
}

async function prepare(page, owners) {
  for (const id of layers) {
    const before = await drawLedger(page);
    assert.equal(
      await page.evaluate(async (id) => {
        const manager = window.__godsEyeView.dataManager;
        return manager.setEnabled(id, true, { origin: 'user' });
      }, id),
      true,
      `${id} enabled`,
    );
    for (const row of await drawLedger(page)) {
      if (!before.some((old) => old.family === row.family && old.id === row.id))
        owners[`${row.family}:${row.id}`] = id;
    }
  }
  await page.evaluate(
    async (group, stationId) => {
      const manager = window.__godsEyeView.dataManager;
      const module = (id) => manager.layers.get(id).module;
      if (group === 'open')
        module('osm-places').setResults(
          [
            {
              id: 'node/1',
              name: 'Fixture Clinic',
              lat: 38.9,
              lon: -77.03,
              tags: {},
            },
            {
              id: 'node/2',
              name: 'Fixture Hospital',
              lat: 38.905,
              lon: -77.02,
              tags: {},
            },
          ],
          { kind: 'clinic', label: 'Clinics', area: 'Washington' },
        );
      if (group === 'street')
        manager.setLayerParams(
          'street-level',
          { kartaview: true, mapillary: false },
          { origin: 'user' },
        );
      if (group === 'wind')
        await manager.setLayerParams(
          'wind',
          { paused: true, overlay: 'temperature', units: 'm/s' },
          { origin: 'user' },
        );
      if (group === 'radio') {
        module('radio').selectStation(stationId, {
          autoplay: true,
          focus: false,
          origin: 'user',
        });
        await manager.setLayerParams(
          'radio',
          { volume: 0.36 },
          { origin: 'user' },
        );
      }
      if (group === 'imagery')
        module('recent-imagery').setBox({
          west: -97.77,
          east: -97.71,
          south: 30.25,
          north: 30.29,
        });
      if (group === 'cables') {
        module('directions').placeEndpoint('a', { lat: 55.32, lon: 10.78 });
        module('directions').placeEndpoint('b', { lat: 55.33, lon: 10.82 });
      }
    },
    group,
    stations[10].id,
  );
  await settle(page);
  if (group === 'cables')
    await page.waitForFunction(
      () =>
        window.__godsEyeView.dataManager.layers
          .get('directions')
          .module.getStats().count > 0,
      { timeout: 30000 },
    );
  if (group === 'wind')
    await page.evaluate(() =>
      window.__godsEyeView.dataManager.layers
        .get('wind')
        .module.setParams({ inspect: true }),
    );
  if (group === 'imagery') {
    await page.waitForFunction(
      () =>
        window.__godsEyeView.dataManager.layers
          .get('recent-imagery')
          .module.getSnapshot()
          .candidates.some(
            (row) =>
              row.product === 'S30' && row.thumbnail?.status === 'present',
          ),
      { timeout: 30000 },
    );
    await page.evaluate(() => {
      const module =
        window.__godsEyeView.dataManager.layers.get('recent-imagery').module;
      const row = module
        .getSnapshot()
        .candidates.find(
          (row) => row.product === 'S30' && row.thumbnail?.status === 'present',
        );
      module.setAssignment('a', row.key);
      module.setMode('image');
    });
  }
  await settle(page);
  // Asynchronous feed completion can create registries after enable resolves.
  for (const row of await drawLedger(page)) {
    const owner = layers.find((id) => row.id.startsWith(id));
    if (owner) owners[`${row.family}:${row.id}`] ??= owner;
  }
}

await strict.run({}, async (browser) => {
  for (const [from, target] of [
    ['cesium', 'navara'],
    ['navara', 'cesium'],
  ]) {
    const direction = `${from} -> ${target}`;
    const sample = { direction, owners: {} };
    evidence.samples.push(sample);
    let context, page;
    const close = async () => {
      const unexpected = await page
        ?.evaluate(() => window.__coldStartUnexpectedApi ?? [])
        .catch(() => []);
      for (const path of unexpected ?? [])
        evidence.differences.push({
          layer: '[page]',
          direction,
          family: 'fixture',
          id: path,
          field: 'unstubbed API',
          switchValue: 'blocked',
          coldStartValue: 'fixture required',
        });
      await page?.evaluate(() => window.__qaFinishMonitors?.()).catch(() => {});
      await context?.close();
      context = page = null;
    };
    const open = async (url) => {
      context = await browser.createBrowserContext();
      const opened = await openPage(context, { shaderErrors: true });
      page = opened.page;
      sample.errors ??= [];
      sample.errors.push(opened.errors);
      await page.evaluateOnNewDocument(() => {
        if (localStorage.length || sessionStorage.length)
          throw new Error('Cold-start storage is not empty');
      });
      await fixture.install(page);
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      return opened;
    };
    try {
      const url = new URL(base.origin);
      url.search = `?engine=${from}&welcome=0&look=cinematic`;
      const [lat, lon, alt] = view;
      url.hash = `v=2&lat=${lat}&lon=${group === 'street' ? fixture.streetLongitude : lon}&alt=${alt}&heading=0&pitch=-90&roll=0&map=osm&l=`;
      await open(url.href);
      await waitForEngine(page, from, { timeout: 60000 });
      await prepare(page, sample.owners);
      sample.before = await probeSnapshot(page, layers);
      await strict.switchTo(page, target);
      await settle(page);
      sample.switched = await probeSnapshot(page, layers);
      sample.url = await page.evaluate(() => {
        window.__godsEyeView.styleManager.shareLinkManager.flush();
        return location.href;
      });
      const retention = compareColdStart(sample.before, sample.switched, {
        direction,
        owners: sample.owners,
        sessionState: false,
      });
      sample.retention = retention.differences.filter((row) =>
        sessionExclusion(row, sample.before),
      );
      evidence.differences.push(
        ...sample.retention.map((row) => ({
          ...row,
          family: `handoff:${row.family}`,
        })),
      );
      await close();
      sample.coldUrl = coldStartUrl(sample.url, target);
      await open(sample.coldUrl);
      await waitForEngine(page, target, { timeout: 60000 });
      await settle(page, true);
      sample.cold = await probeSnapshot(page, layers);
      sample.comparison = compareColdStart(sample.switched, sample.cold, {
        direction,
        owners: sample.owners,
        allow,
      });
      evidence.differences.push(...sample.comparison.differences);
      evidence.skipped.push(...sample.comparison.skipped);
      for (const id of layers) {
        if (
          ![...sample.retention, ...sample.comparison.differences].some(
            (row) => row.layer === id || row.layer === '[page]',
          )
        )
          strict.record(
            id,
            target,
            'engine switch equals a fresh share-link restore; declared session fields survive the switch',
          );
      }
      for (const error of sample.errors.flat())
        evidence.differences.push({
          layer: '[page]',
          direction,
          family: 'error',
          id: '',
          field: 'pageerror',
          switchValue: error,
          coldStartValue: null,
        });
    } catch (error) {
      sample.error = String(error.stack ?? error);
      sample.failureSnapshot = await probeSnapshot(page, layers).catch(
        () => null,
      );
      evidence.differences.push({
        layer: layers.join(', '),
        direction,
        family: 'readiness',
        id: '',
        field: 'error',
        switchValue: error.message,
        coldStartValue: '<not captured>',
      });
    } finally {
      await close();
    }
  }
  console.log(
    `switch-equals-cold-start ${group}: ${evidence.differences.length} differences, ${evidence.skipped.length} declared session differences`,
  );
  if (evidence.differences.length)
    console.table(
      evidence.differences.map((row) => ({
        ...row,
        switchValue: JSON.stringify(row.switchValue),
        coldStartValue: JSON.stringify(row.coldStartValue),
      })),
    );
  assert.equal(
    evidence.differences.length,
    0,
    'See coldStart.differences in the evidence file',
  );
  console.log(
    `PASS switch-equals-cold-start ${group}: 2 directions, ${layers.length} layers, 0 differences`,
  );
});
