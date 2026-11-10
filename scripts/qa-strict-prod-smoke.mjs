import { whenSettled } from './qa/ready.mjs';
// Contract: the production build starts cold on each engine without a page
// error. A fresh page per engine opens the keyless preview of `vite build`
// (its hashed entry chunk, not the dev server), waits until the engine runs
// and its loading screen is gone, lets late work run, then switches once to
// the other engine with real input; no uncaught exception or unhandled
// rejection may show at any point. The dev server serves Cesium as an ES
// module, so module-load errors of the production bundle only show here.
//
//   node scripts/qa-strict-prod-smoke.mjs http://127.0.0.1:4208

import assert from 'node:assert/strict';
import {
  ENGINES,
  createStrict,
  localPreview,
  waitForEngine,
} from './qa-strict-harness.mjs';

const base = localPreview(process.argv[2]);
const strict = createStrict({ origin: base.origin, layers: [] });
const results = [];
strict.extra.contracts = results;
await strict.run({}, async (b) => {
  for (const start of ENGINES) {
    const page = await b.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const url = new URL(base.origin);
    url.search = `?engine=${start}&welcome=0`;
    await page.goto(url.href, { waitUntil: 'domcontentloaded' });
    const entry = await page.evaluate(() => ({
      viteClient: !!document.querySelector('script[src*="@vite/client"]'),
      scripts: [...document.querySelectorAll('script[type="module"][src]')]
        .map((s) => new URL(s.src).pathname)
        .filter((p) => p.startsWith('/assets/')),
    }));
    assert.ok(
      !entry.viteClient && entry.scripts.length > 0,
      `the preview serves a production build ${JSON.stringify(entry)}`,
    );
    try {
      await waitForEngine(page, start, { timeout: 90000 });
    } catch (error) {
      throw Error(
        `${start} did not start: ${error.message}; page errors ${JSON.stringify(errors)}`,
      );
    }
    // Late work after the start: idle prefetch, layer timers, workers.
    await page.waitForNetworkIdle({ idleTime: 500, timeout: 30000 });
    await whenSettled(page);
    const other = start === 'cesium' ? 'navara' : 'cesium';
    await strict.pick(page, other);
    await waitForEngine(page, other, { timeout: 90000 });
    await page.waitForNetworkIdle({ idleTime: 500, timeout: 30000 });
    await whenSettled(page);
    const row = { start, switchedTo: other, entry: entry.scripts, errors };
    results.push(row);
    console.log(errors.length ? 'FAIL' : 'PASS', JSON.stringify(row));
    await page.close();
  }
  assert.deepEqual(
    results.filter((row) => row.errors.length),
    [],
    'a production cold start threw',
  );
});
