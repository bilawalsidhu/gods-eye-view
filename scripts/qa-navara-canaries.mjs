#!/usr/bin/env node
// Package canaries deliberately bypass adapter workarounds. A passing canary
// means the upstream bug still exists. Fixture errors prove nothing about it.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { closeBrowser } from './qa/browser.mjs';

const origin = new URL(process.argv[2] ?? 'http://localhost:4300').origin;
assert.ok(['localhost', '127.0.0.1'].includes(new URL(origin).hostname));
assert.equal(
  new URL(origin).port,
  '4300',
  'Use the dedicated keyless canary server on port 4300',
);
const profile = await mkdtemp(path.resolve('tmp_navara_canaries_profile_'));
const results = { confirmed: 0, gone: 0, fixtureErrors: 0 };
let browser;
try {
  browser = await puppeteer.launch({
    headless: true,
    userDataDir: profile,
    protocolTimeout: 60_000,
    args: ['--use-angle=metal', '--enable-gpu'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 800, height: 600 });
  page.setDefaultTimeout(30_000);
  page.on('pageerror', (error) => console.error(error.message));
  await page.setRequestInterception(true);
  const pendingTiles = [];
  const tile = {
    contentType: 'image/png',
    body: Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGP4DwQACfsD/fteaysAAAAASUVORK5CYII=',
      'base64',
    ),
  };
  let holdTiles = true;
  await page.exposeFunction('pendingTileCount', () => pendingTiles.length);
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname === '/tmp_navara_canaries.html') {
      request.respond({
        contentType: 'text/html',
        body: '<body style="margin:0"><div id="globe" style="width:800px;height:600px"></div></body>',
      });
    } else if (url.pathname.startsWith('/tmp_navara_canaries_tile/')) {
      if (holdTiles) pendingTiles.push(request);
      else request.respond(tile);
    } else if (
      url.origin === origin ||
      ['blob:', 'data:'].includes(url.protocol)
    ) {
      request.continue();
    } else request.abort();
  });
  await page.goto(`${origin}/tmp_navara_canaries.html`);
  await page.evaluate(async () => {
    // Use Vite's resolved package URLs so the adapter and fixture share classes.
    const imports = await (
      await fetch('/src/globe/navara/internals.js')
    ).text();
    const sdkUrl = imports.match(
      /from "([^"]*\/three\/dist\/index.js[^\"]*)"/,
    )[1];
    const optionsSource = await (
      await fetch('/src/globe/navara/viewOptions.js')
    ).text();
    const threeUrl = optionsSource.match(/from "([^"]+)"/)[1];
    const [sdk, three, internals, options] = await Promise.all([
      import(sdkUrl),
      import(threeUrl),
      import('/src/globe/navara/internals.js'),
      import('/src/globe/navara/viewOptions.js'),
    ]);
    const container = document.getElementById('globe');
    const canvas = document.createElement('canvas');
    container.appendChild(canvas);
    canvas.getContext('webgl2', options.NAVARA_CONTEXT_ATTRIBUTES);
    const view = new sdk.default(
      options.navaraViewOptions({ container, canvas }),
    );
    await view.init();
    internals.navaraHooks(view);
    view.lit = false;
    view.setCamera({
      lng: 0,
      lat: 0,
      height: 18_000_000,
      heading: 0,
      pitch: -90,
      roll: 0,
    });
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const until = async (predicate, timeout = 5000) => {
      const start = performance.now();
      while (!predicate()) {
        if (performance.now() - start > timeout)
          throw new Error('Fixture did not become ready');
        await wait(20);
      }
    };
    const frame = () =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          view.off('postRender', done);
          reject(new Error('No rendered frame within five seconds'));
        }, 5000);
        const done = () => {
          clearTimeout(timer);
          view.off('postRender', done);
          resolve();
        };
        view.on('postRender', done);
        view.forceUpdate();
      });
    let ctx;
    class Probe extends sdk.MeshDesc {
      createMesh() {
        ctx = this.ctx;
        return new three.Group();
      }
    }
    view.registerMesh('canaryProbe', Probe);
    const probe = view.addMesh({ canaryProbe: {} });
    await frame();
    const polygon = {
      type: 'Feature',
      properties: {},
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [-8, -8],
            [8, -8],
            [8, 8],
            [-8, 8],
            [-8, -8],
          ],
        ],
      },
    };
    window.canary = {
      sdk,
      three,
      internals,
      view,
      canvas,
      ctx,
      probe,
      wait,
      until,
      frame,
      polygon,
    };
  });

  async function check(name, remove, run) {
    try {
      const evidence = await page.evaluate(run);
      assert.equal(
        typeof evidence?.present,
        'boolean',
        'Fixture returned no verdict',
      );
      if (evidence.present) {
        console.log(`PASS ${name}: bug confirmed; ${JSON.stringify(evidence)}`);
        results.confirmed++;
      } else {
        console.error(
          `BUG GONE ${name}: bug absent with fixture controls satisfied; review/delete ${remove}. ${JSON.stringify(evidence)}`,
        );
        results.gone++;
      }
    } catch (error) {
      console.error(
        `FIXTURE ERROR ${name}: ${error.message}; no conclusion about the bug; keep the workaround`,
      );
      results.fixtureErrors++;
    }
  }

  await check(
    'batch-ids-retained',
    'src/globe/navara/movers/batchIds.js and its pool wiring',
    async () => {
      const { sdk, three, ctx, frame } = window.canary;
      const batches = [];
      for (let round = 0; round < 3; round++) {
        const mesh = new three.InstancedMesh(
          new three.PlaneGeometry(),
          new three.MeshBasicMaterial(),
          8,
        );
        const wrapper = new sdk.PickableInstancedMeshWrapper(mesh, 8, ctx);
        ctx.registerPickableMesh('canary-batch', wrapper);
        batches.push([...wrapper.batchIds]);
        ctx.unregisterPickableMesh('canary-batch');
        mesh.geometry.dispose();
        mesh.material.dispose();
        await frame();
      }
      const ids = batches.flat();
      if (
        batches.some(
          (batch) =>
            batch.length !== 8 ||
            batch.some((id) => !Number.isInteger(id) || id <= 0) ||
            new Set(batch).size !== batch.length,
        )
      )
        throw new Error('Fixture did not allocate eight valid IDs per batch');
      return {
        present: new Set(ids).size === ids.length,
        batches,
      };
    },
  );

  await check(
    'deleted-vector-events-retained',
    'src/globe/navara/featureQueue.js and dropOrphanFeatureChanges wiring',
    async () => {
      const { view, internals, polygon, frame, wait } = window.canary;
      for (let attempt = 0; attempt < 12; attempt++) {
        const source = view.addSource({ type: 'geojson', data: polygon });
        const layer = view.addLayer({
          type: 'vector',
          source,
          polygon: { color: 0xff0000 },
        });
        await wait(30 + attempt * 10);
        layer.update({ type: 'vector', source, polygon: { color: 0x00ff00 } });
        layer.delete();
        source.delete();
        await wait(100);
      }
      const orphaned = () =>
        internals
          .featureChangeQueue(view)
          .events.filter(
            (event) => !view.findLayerById(String(event.layer_id)),
          );
      const before = orphaned().length;
      await frame();
      await wait(500);
      await frame();
      const after = orphaned().length;
      internals.navaraHooks(view).dropOrphanFeatureChanges();
      if (before === 0)
        throw new Error('Fixture did not produce orphaned vector events');
      return { present: after > 0, before, after };
    },
  );

  await check(
    'idle-before-raster-arrives',
    'maps.js SETTLE_MS/SETTLE_EVERY_MS redraw timer',
    async () => {
      const { view, internals, until } = window.canary;
      await until(() => internals.isIdle(view));
      let idle = false;
      const onIdle = () => {
        idle = true;
      };
      view.on('idle', onIdle);
      const source = view.addSource({
        type: 'raster-tile',
        url: `${location.origin}/tmp_navara_canaries_tile/{z}/{x}/{y}.png`,
        maxZoom: 1,
      });
      const layer = view.addLayer({ type: 'raster', source });
      view.forceUpdate();
      await until(() => idle);
      view.off('idle', onIdle);
      window.canary.raster = { source, layer };
      const pending = await window.pendingTileCount();
      if (pending === 0)
        throw new Error('Fixture did not hold any raster requests');
      return {
        present: idle && pending > 0,
        idle,
        pending,
      };
    },
  );
  holdTiles = false;
  for (const request of pendingTiles) await request.respond(tile);
  if (pendingTiles.length) {
    await page.waitForFunction(() =>
      performance
        .getEntriesByType('resource')
        .some(
          (entry) =>
            entry.name.includes('/tmp_navara_canaries_tile/') &&
            entry.responseEnd > 0,
        ),
    );
  }
  await page.evaluate(() => {
    window.canary.raster?.layer.delete();
    window.canary.raster?.source.delete();
  });

  await page.evaluate(() => window.canary.view.dispose());
} catch (error) {
  console.error(
    `FIXTURE ERROR browser session: ${error.message}; no conclusion about the bugs; keep the workarounds`,
  );
  results.fixtureErrors++;
} finally {
  if (browser) await closeBrowser(browser);
  await rm(profile, { recursive: true, force: true });
  console.log(
    `${results.confirmed} bugs confirmed, ${results.gone} bugs gone, ${results.fixtureErrors} fixture errors`,
  );
  process.exitCode = results.gone === 0 && results.fixtureErrors === 0 ? 0 : 1;
}
