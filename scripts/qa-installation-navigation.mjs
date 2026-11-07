#!/usr/bin/env node
/** Mapped installations: isolated camera navigation, cached revisits and Contacts release. */
import fs from 'node:fs';
import puppeteer from 'puppeteer';
import { moveCamera } from './qa-journey-recorder.mjs';

const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log(
    'Usage: node scripts/qa-installation-navigation.mjs <url> [--baseline]',
  );
  process.exit(0);
}
const baseline = args.includes('--baseline');
const result = { views: [], errors: [], forbidden: [], failures: [] };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({
  headless: true,
  args: ['--use-angle=metal', '--disable-background-timer-throttling'],
  protocolTimeout: 120000,
});
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  const tiles = [];
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (
      u.hostname === 'tiles.openfreemap.org' &&
      /\/\d+\/\d+\/\d+(\.pbf)?$/.test(u.pathname)
    )
      tiles.push(u.pathname);
    if (
      /overpass/i.test(u.hostname) ||
      u.hostname === 'nominatim.openstreetmap.org'
    )
      result.forbidden.push(u.hostname);
  });
  page.on('pageerror', (e) => result.errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') result.errors.push(m.text());
  });
  await page.evaluateOnNewDocument(() =>
    sessionStorage.setItem('gev:first-run-mission-session:v1', 'dismissed'),
  );
  await page.goto(
    args.find((a) => /^https?:/.test(a)),
    { waitUntil: 'domcontentloaded' },
  );
  await page.waitForFunction(
    () =>
      window.__godsEyeView?.dataManager &&
      document.getElementById('loading-screen')?.classList.contains('hidden'),
    { timeout: 120000 },
  );
  await page.evaluate(
    () => window.__godsEyeView.styleManager.initialRestorePromise,
  );
  await page.keyboard.press('Escape');
  await page.evaluate(async () => {
    const g = window.__godsEyeView;
    for (const [id] of g.dataManager.layers)
      await g.dataManager.setEnabled(id, false);
    g.viewer.scene.screenSpaceCameraController.enableCollisionDetection = false;
    window.installationEvents = { changed: 0, end: 0 };
    window.installationEntityRefs = new Map();
    g.viewer.camera.changed.addEventListener(
      () => window.installationEvents.changed++,
    );
    g.viewer.camera.moveEnd.addEventListener(
      () => window.installationEvents.end++,
    );
  });
  let low = 60000,
    high = 400000;
  for (let i = 0; i < 9; i++) {
    const height = (low + high) / 2;
    await moveCamera(page, { lat: 32.72, lon: -117.16, height, pitch: -90 }, 0);
    const fits = await page.evaluate(async () => {
      const { installationTileZoom } =
        await import('/src/layers/installations/source.js');
      const r = window.__godsEyeView.viewer.camera.computeViewRectangle();
      const d = 180 / Math.PI;
      return (
        r &&
        installationTileZoom({
          west: r.west * d,
          east: r.east * d,
          south: r.south * d,
          north: r.north * d,
        }) !== null
      );
    });
    if (fits) low = height;
    else high = height;
  }
  const widestHeight = Math.floor(low);
  result.widestHeight = widestHeight;
  result.firstTooWideHeight = Math.ceil(high);
  let enabled = false;
  const places = [
    ['san-diego', 32.72, -117.16],
    ['pendleton', 33.33, -117.4],
    ['miramar', 32.87, -117.14],
    ['san-diego-return', 32.72, -117.16],
  ];
  for (const height of [
    5000,
    20000,
    60000,
    150000,
    widestHeight,
    400000,
    5000,
  ]) {
    for (const [name, lat, lon] of height >= 150000
      ? places.slice(0, 1)
      : places) {
      const before = tiles.length;
      const previous = await page.evaluate(
        () =>
          window.__godsEyeView.dataManager.layers
            .get('military-installations')
            .module.getStats().lastUpdate,
      );
      await moveCamera(
        page,
        { lat, lon, height, pitch: -90 },
        enabled ? 0.6 : 0,
      );
      const stop = Date.now();
      if (!enabled) {
        await page.evaluate(() =>
          window.__godsEyeView.dataManager.setEnabled(
            'military-installations',
            true,
          ),
        );
        enabled = true;
      }
      await page
        .waitForFunction(
          (prev, wide) => {
            const s = window.__godsEyeView.dataManager.layers
              .get('military-installations')
              .module.getStats();
            return (
              !s.loading &&
              (s.lastUpdate > prev || (wide && s.status === 'zoom-in'))
            );
          },
          { timeout: 6000 },
          previous,
          height === 400000,
        )
        .catch(() => {});
      const snapshot = await page.evaluate(() => {
        const g = window.__godsEyeView;
        const ds = g.viewer.dataSources.getByName('military-installations')[0];
        const points = ds.entities.values.filter((e) => e.point);
        const stable = points.every(
          (e) =>
            !window.installationEntityRefs.has(e.id) ||
            window.installationEntityRefs.get(e.id) === e,
        );
        window.installationEntityRefs = new Map(points.map((e) => [e.id, e]));
        return {
          ...g.dataManager.layers
            .get('military-installations')
            .module.getStats(),
          stable,
          ids: points.map((e) => e.id),
          events: { ...window.installationEvents },
        };
      });
      const row = {
        name,
        height,
        ms: Date.now() - stop,
        tiles: tiles.length - before,
        updated: snapshot.lastUpdate > previous,
        ...snapshot,
      };
      if (
        (!row.stable && result.views.at(-1)?.height === height) ||
        new Set(row.ids).size !== row.ids.length
      )
        result.failures.push(
          `${name}/${height}: unstable or duplicate site entities`,
        );
      if (name.endsWith('return')) {
        const first = result.views.find(
          (v) => v.name === 'san-diego' && v.height === height,
        );
        if (
          first &&
          JSON.stringify([...first.ids].sort()) !==
            JSON.stringify([...row.ids].sort())
        )
          result.failures.push(
            `${name}/${height}: changed site ids on revisit`,
          );
      }
      result.views.push(row);
      console.log(JSON.stringify(row));
      if (!row.updated && row.status !== 'zoom-in')
        result.failures.push(`${name}/${height}: no reload`);
      if (row.ms > 1500 && row.status !== 'zoom-in')
        result.failures.push(`${name}/${height}: ${row.ms} ms`);
      if (name.endsWith('return') && row.tiles)
        result.failures.push(`${name}/${height}: revisit fetched ${row.tiles}`);
    }
  }
  for (const gesture of [
    'wheel',
    'keyboard',
    'contacts-close',
    'contacts-clear',
  ]) {
    let previous = await page.evaluate(
      () =>
        window.__godsEyeView.dataManager.layers
          .get('military-installations')
          .module.getStats().lastUpdate,
    );
    if (gesture === 'wheel') {
      await page.mouse.move(640, 400);
      await page.mouse.wheel({ deltaY: -350 });
    } else if (gesture === 'keyboard') {
      await page.evaluate(() =>
        document.getElementById('search-toggle').click(),
      );
      await page.focus('#location-search');
      await page.evaluate(() => {
        document.getElementById('location-search').value = '';
      });
      await page.type('#location-search', '33.33, -117.40');
      await page.keyboard.press('Enter');
      await sleep(4500);
    } else {
      await moveCamera(
        page,
        { lat: 32.87, lon: -117.14, height: 5000, pitch: -90 },
        0.6,
      );
      await page.waitForFunction(
        () =>
          window.__godsEyeView.viewer.dataSources
            .getByName('military-installations')[0]
            .entities.values.some((e) => e.point),
        { timeout: 5000 },
      );
      await page.evaluate(() => {
        const button = document.getElementById('global-context-flights-btn');
        if (button.getAttribute('aria-selected') !== 'true') button.click();
      });
      await page.waitForFunction(
        () => {
          const g = window.__godsEyeView;
          return (
            g.dataManager.isEffectivelyEnabled('military-awareness') &&
            !g.dataManager.layers.get('military-awareness').module.getParams()
              .passive
          );
        },
        { timeout: 15000 },
      );
      await sleep(1000);
      await page.evaluate(async () => {
        const g = window.__godsEyeView;
        const ds = g.viewer.dataSources.getByName('military-installations')[0];
        const id = ds.entities.values.find((e) => e.point).id;
        window.installationSubjectId = id;
        await g.dataManager.layers
          .get('military-awareness')
          .module.focusTarget('military-installations', id);
      });
      await page.waitForFunction(
        () => {
          const a =
            window.__godsEyeView.dataManager.layers.get(
              'military-awareness',
            ).module;
          const subject = a.getContextSnapshot()?.subject;
          return (
            subject?.layerId === 'military-installations' &&
            subject.id === window.installationSubjectId &&
            !a._getAwarenessNavigationStateForTest().pendingSelectionKey
          );
        },
        { timeout: 15000 },
      );
      await page.waitForFunction(
        () => !window.__godsEyeView.viewer.camera._currentFlight,
        { timeout: 10000 },
      );
      await page.waitForFunction(
        () =>
          window.__godsEyeView.dataManager.layers
            .get('military-installations')
            .module.getStats().coverage.kind === 'subject',
        { timeout: 10000 },
      );
      await page.waitForFunction(
        () =>
          document
            .getElementById('global-context-flights-btn')
            .getAttribute('aria-busy') === 'false',
        { timeout: 30000 },
      );
      const anchored = await page.evaluate(() =>
        window.__godsEyeView.dataManager.layers
          .get('military-installations')
          .module.getStats(),
      );
      if (anchored.coverage.kind !== 'subject')
        result.failures.push(`${gesture}: Contacts did not acquire subject`);
      result.contextClear = await page.evaluate(async (clear) => {
        if (clear) {
          const { clearSelectedEntityContextForLayer, getContextStore } =
            await import('/src/data/contextStore.js');
          const store = getContextStore();
          const before = {
            selectedId: store.selectedEntityId,
            record: store.entities.get(store.selectedEntityId)?.id,
            subject: window.__godsEyeView.dataManager.layers
              .get('military-awareness')
              .module.getContextSnapshot()?.subject,
          };
          clearSelectedEntityContextForLayer('military-installations');
          return before;
        } else document.getElementById('global-context-flights-btn').click();
      }, gesture === 'contacts-clear');
      if (gesture === 'contacts-clear') {
        await page.waitForFunction(
          () =>
            !window.__godsEyeView.dataManager.layers
              .get('military-awareness')
              .module.getContextSnapshot(),
          { timeout: 5000 },
        );
      } else {
        await page.waitForFunction(
          () => {
            const button = document.getElementById(
              'global-context-flights-btn',
            );
            return (
              button.getAttribute('aria-selected') === 'false' &&
              button.getAttribute('aria-busy') === 'false'
            );
          },
          { timeout: 30000 },
        );
      }
      await page.waitForFunction(
        () => !window.__godsEyeView.viewer.camera._currentFlight,
        { timeout: 10000 },
      );
      await sleep(500);
      previous = await page.evaluate(
        () =>
          window.__godsEyeView.dataManager.layers
            .get('military-installations')
            .module.getStats().lastUpdate,
      );
      await moveCamera(
        page,
        { lat: 33.33, lon: -117.4, height: 5000, pitch: -90 },
        0.6,
      );
    }
    await page
      .waitForFunction(
        (prev) => {
          const s = window.__godsEyeView.dataManager.layers
            .get('military-installations')
            .module.getStats();
          return (
            !s.loading && s.lastUpdate > prev && s.coverage.kind === 'viewport'
          );
        },
        { timeout: 6000 },
        previous,
      )
      .catch(() => result.failures.push(`${gesture}: no viewport reload`));
    const row = await page.evaluate(() =>
      window.__godsEyeView.dataManager.layers
        .get('military-installations')
        .module.getStats(),
    );
    if (gesture.startsWith('contacts') && row.count !== 1)
      result.failures.push(
        `${gesture}: destination count ${row.count}, expected 1`,
      );
    result.views.push({ name: gesture, ...row });
    console.log(JSON.stringify({ name: gesture, ...row }));
  }
  await page.screenshot({ path: 'qa-shots/installations-navigation.png' });
} finally {
  fs.mkdirSync('qa-shots', { recursive: true });
  fs.writeFileSync(
    `qa-shots/installations-navigation-${baseline ? 'before' : 'after'}.json`,
    JSON.stringify(result, null, 2),
  );
  await browser.close();
}
if (
  !baseline &&
  (result.failures.length || result.errors.length || result.forbidden.length)
)
  process.exitCode = 1;
