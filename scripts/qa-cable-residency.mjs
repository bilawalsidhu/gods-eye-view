#!/usr/bin/env node
/** Real native picking, viewport residency, selection, return-to-view and re-enable. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import puppeteer from 'puppeteer';
import {
  hookRenderErrors,
  readRenderErrors,
  watchPage,
} from './qa-browserEvidence.mjs';

const args = process.argv.slice(2),
  option = (flag, fallback) =>
    args.includes(flag) ? args[args.indexOf(flag) + 1] : fallback;
const out = path.resolve(
  option('--out', 'qa-artifacts/resource-costs/cable-gates'),
);
const url = new URL(option('--url', 'http://127.0.0.1:4176'));
url.searchParams.set('welcome', '0');
url.searchParams.set('performance', 'standard');
await fs.mkdir(out, { recursive: true });
const report = { checks: [], errors: [], snapshots: [] };
const check = (name, pass) => {
  report.checks.push({ name, pass: Boolean(pass) });
  assert.ok(pass, name);
};
const browser = await puppeteer.launch({
  headless: true,
  protocolTimeout: 180000,
  args: [
    '--no-sandbox',
    ...(process.platform === 'darwin'
      ? ['--use-angle=metal', '--enable-gpu']
      : ['--use-gl=angle', '--use-angle=swiftshader']),
  ],
});
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 860 });
  watchPage(page, { name: 'cable-residency', errors: report.errors });
  await hookRenderErrors(page);
  await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForFunction(
    () =>
      window.__godsEyeView?.performance &&
      document.getElementById('loading-screen')?.classList.contains('hidden'),
    { timeout: 90000 },
  );
  await page.evaluate(async () => {
    const app = window.__godsEyeView;
    await app.performance.ready;
    for (const [id, entry] of app.dataManager.layers)
      if (entry.enabled)
        await app.dataManager.setEnabled(id, false, { origin: 'user' });
    await app.styleManager.setMapStack('osm');
  });
  async function view(lon, lat, height) {
    await page.evaluate(
      ({ lon, lat, height }) => {
        const v = window.__godsEyeView.viewer;
        v.camera.cancelFlight();
        v.camera.setView({
          destination: v.scene.globe.ellipsoid.cartographicToCartesian({
            longitude: (lon * Math.PI) / 180,
            latitude: (lat * Math.PI) / 180,
            height,
          }),
          orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
        });
        v.camera.moveEnd.raiseEvent();
        v.scene.requestRender();
      },
      { lon, lat, height },
    );
    await new Promise((r) => setTimeout(r, 2000));
  }
  async function enable(on) {
    await page.evaluate(
      (on) =>
        window.__godsEyeView.dataManager.setEnabled(
          'telegeography-submarine-cables',
          on,
          { origin: 'user' },
        ),
      on,
    );
    if (on)
      await page.waitForFunction(
        () => {
          const s = window.__godsEyeView.dataManager.layers
            .get('telegeography-submarine-cables')
            .module.getStats();
          return s.count > 0 && !s.loading && !s.error;
        },
        { timeout: 90000 },
      );
    await new Promise((r) => setTimeout(r, 2500));
  }
  const snapshot = () =>
    page.evaluate(() => {
      const app = window.__godsEyeView,
        viewer = app.viewer,
        sources = Array.from({ length: viewer.dataSources.length }, (_, i) =>
          viewer.dataSources.get(i),
        ).filter((s) => /Cable|Landing/.test(s.name));
      return {
        stats: app.dataManager.layers
          .get('telegeography-submarine-cables')
          .module.getStats(),
        sources: sources.map((s) => ({
          name: s.name,
          count: s.entities.values.length,
        })),
        ids: sources.flatMap((s) => s.entities.values.map((e) => e.id)),
        selected: viewer.selectedEntity?.id,
      };
    });
  await view(-40, 35, 4500000);
  await enable(true);
  const first = await snapshot();
  report.snapshots.push(first);
  check('full feature population retained', first.stats.count > 2000);
  check(
    'native sources contain only a subset of the world',
    first.sources.length === 3 &&
      first.sources.reduce((n, s) => n + s.count, 0) < first.stats.count * 2,
  );
  await page.screenshot({ path: path.join(out, 'atlantic.png') });
  const picked = await page.evaluate(() => {
    const v = window.__godsEyeView.viewer;
    for (let i = 0; i < v.dataSources.length; i++)
      for (const entity of v.dataSources.get(i).entities.values) {
        if (
          entity.__gevTeleGeography?.kind !== 'cable' ||
          !entity.polyline?.clampToGround?.getValue(v.clock.currentTime)
        )
          continue;
        for (const position of entity.polyline.positions.getValue(
          v.clock.currentTime,
        )) {
          const p = v.scene.cartesianToCanvasCoordinates(position);
          if (!p || p.x < 320 || p.x > 1100 || p.y < 200 || p.y > 650) continue;
          for (const dx of [-2, 0, 2])
            for (const dy of [-2, 0, 2]) {
              const hit = v.scene.pick({ x: p.x + dx, y: p.y + dy });
              if (hit?.id?.__gevTeleGeography?.kind === 'cable') {
                const e = hit.id;
                window.__qaCableSelected = e;
                v.selectedEntity = e;
                return {
                  id: e.id,
                  info: e.__gevTeleGeography,
                  width: e.polyline.width.getValue(v.clock.currentTime),
                  alpha: e.polyline.material.getValue(v.clock.currentTime).color
                    .alpha,
                };
              }
            }
        }
      }
    return null;
  });
  report.picked = picked;
  check(
    'ground route remains natively pickable with full cable metadata',
    Boolean(picked?.info.reference && picked.info.label),
  );
  check(
    'normal line styling preserved',
    picked.width === 2.5 && picked.alpha === 0.92,
  );
  await view(103, 1, 500000);
  const selected = await page.evaluate(() => {
    const v = window.__godsEyeView.viewer,
      e = window.__qaCableSelected;
    return {
      same: v.selectedEntity === e,
      resident: Array.from({ length: v.dataSources.length }, (_, i) =>
        v.dataSources.get(i),
      ).some((s) => s.entities.contains(e)),
    };
  });
  check(
    'offscreen selection keeps its entity and details',
    selected.same && selected.resident,
  );
  await page.evaluate(() => {
    const v = window.__godsEyeView.viewer;
    v.selectedEntity = undefined;
    v.camera.moveEnd.raiseEvent();
    v.scene.requestRender();
  });
  await new Promise((r) => setTimeout(r, 1500));
  check(
    'deselected offscreen render entity is released',
    await page.evaluate(() => {
      const v = window.__godsEyeView.viewer;
      return !Array.from({ length: v.dataSources.length }, (_, i) =>
        v.dataSources.get(i),
      ).some((s) => s.entities.contains(window.__qaCableSelected));
    }),
  );
  report.snapshots.push(await snapshot());
  await view(-40, 35, 4500000);
  const returned = await snapshot();
  report.snapshots.push(returned);
  check(
    'returning to a view restores stable segment identity',
    returned.ids.includes(picked.id),
  );
  await page.setViewport({ width: 800, height: 860 });
  await new Promise((r) => setTimeout(r, 2000));
  await page.setViewport({ width: 1440, height: 860 });
  await new Promise((r) => setTimeout(r, 2000));
  const resized = await snapshot();
  check(
    'resizing a parked camera restores visible routes without a pan',
    resized.ids.includes(picked.id),
  );
  for (const [activeId, expected] of [
    ['photoreal', 1],
    ['osm', 0],
  ]) {
    // Exercise the native classification transition without requiring a
    // Google credential or pretending to measure live Google tile memory.
    await page.evaluate(
      (activeId) =>
        window.dispatchEvent(
          new CustomEvent('gev:map-stack-changed', { detail: { activeId } }),
        ),
      activeId,
    );
    await new Promise((r) => setTimeout(r, 2500));
    check(
      `native cable classification switches for ${activeId}`,
      await page.evaluate((expected) => {
        const v = window.__godsEyeView.viewer;
        return Array.from({ length: v.dataSources.length }, (_, i) =>
          v.dataSources.get(i),
        )
          .filter((s) => s.name.endsWith('Submarine Cables'))
          .every((s) =>
            s.entities.values.every(
              (e) =>
                e.polyline.classificationType.getValue(v.clock.currentTime) ===
                expected,
            ),
          );
      }, expected),
    );
  }
  check(
    'travel preserves worldwide feature count',
    returned.stats.count === first.stats.count,
  );
  await enable(false);
  const disabled = await snapshot();
  check(
    'disable releases all native cable sources',
    disabled.sources.length === 0,
  );
  await enable(true);
  const rebuilt = await snapshot();
  report.snapshots.push(rebuilt);
  check(
    're-enable preserves counts and stable IDs',
    rebuilt.stats.count === first.stats.count &&
      rebuilt.ids.includes(picked.id),
  );
  report.errors.push(...(await readRenderErrors(page)));
  check('no browser/render errors', report.errors.length === 0);
} catch (error) {
  report.errors.push(String(error.stack || error));
  process.exitCode = 1;
} finally {
  await fs.writeFile(
    path.join(out, 'report.json'),
    JSON.stringify(report, null, 2),
  );
  await browser.close();
  console.log(
    JSON.stringify({ checks: report.checks, errors: report.errors }, null, 2),
  );
}
