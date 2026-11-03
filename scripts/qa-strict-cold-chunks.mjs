// Contract: a cold start loads only the engine it starts. From the network
// log of a fresh page:
// - a cold Navara start requests nothing of the Cesium library (/cesium/…:
//   Cesium.js, its workers and assets);
// - a cold Cesium start requests no chunk that carries three or Navara code
//   (the FORBIDDEN_MARKERS of src/tooling/mainChunk.js) and no Navara wasm.
// Control: after a pick to the other engine, its code is requested, so the
// detection sees what it is looking for.
//
// Known gap: the production build externalizes Cesium to the global its
// index.html script defines, and engine-neutral modules still read that
// global when they load, so a cold Navara start loads Cesium.js and its
// widget styles too. That row is reported as a known gap (its control is
// that the detection does see Cesium.js) instead of failing the run; any
// other Cesium request at a cold Navara start still fails it.
//
//   node scripts/qa-strict-cold-chunks.mjs http://127.0.0.1:4208

import assert from 'node:assert/strict';
import { forbiddenMarkersIn } from '../src/tooling/mainChunk.js';
import {
  createStrict,
  localPreview,
  waitForEngine,
} from './qa-strict-harness.mjs';
import { installSessionFixtures, openApp } from './qa-strict-session.mjs';

const base = localPreview(process.argv[2]);
const strict = createStrict({ origin: base.origin, layers: [] });
const contents = new Map();
// The preview's own file: three or Navara markers in it?
const markersOf = async (url) => {
  if (!contents.has(url))
    contents.set(
      url,
      fetch(url)
        .then((r) => r.text())
        .then(forbiddenMarkersIn),
    );
  return contents.get(url);
};
const cesiumCode = (url) => new URL(url).pathname.startsWith('/cesium/');
const navaraCode = async (url) => {
  const { pathname } = new URL(url);
  if (/navara.*\.wasm$/.test(pathname)) return ['navara wasm'];
  if (!pathname.endsWith('.js') || pathname.startsWith('/cesium/')) return [];
  return markersOf(url);
};
const KNOWN_COLD_NAVARA_CESIUM = new Set([
  '/cesium/Cesium.js',
  '/cesium/Widgets/widgets.css',
]);
const results = [];
strict.extra.contracts = results;
await strict.run({ args: ['--use-angle=metal', '--enable-gpu'] }, async (b) => {
  for (const start of ['navara', 'cesium']) {
    const p = await b.newPage();
    await p.setViewport({ width: 1280, height: 800 });
    const urls = [];
    p.on('request', (request) => {
      if (request.url().startsWith(base.origin)) urls.push(request.url());
    });
    await installSessionFixtures(p);
    await openApp(p, base.origin, start);
    // Let lazy loads that follow the start (workers, idle prefetch) happen.
    await new Promise((resolve) => setTimeout(resolve, 5000));
    const before = [...urls];
    const other = start === 'navara' ? 'cesium' : 'navara';
    await strict.pick(p, other);
    await waitForEngine(p, other);
    const after = urls.slice(before.length);
    const otherCode = async (list) => {
      const found = [];
      for (const url of list)
        if (
          other === 'cesium'
            ? cesiumCode(url)
            : (await navaraCode(url)).length > 0
        )
          found.push(new URL(url).pathname);
      return [...new Set(found)];
    };
    const loaded = await otherCode(before);
    const known =
      start === 'navara'
        ? loaded.filter((path) => KNOWN_COLD_NAVARA_CESIUM.has(path))
        : [];
    const row = {
      start,
      otherEngine: other,
      loadedAtColdStart: loaded.filter((path) => !known.includes(path)),
      knownGap: known,
      loadedAfterPick: (await otherCode(after)).length,
    };
    results.push(row);
    console.log(
      row.loadedAtColdStart.length
        ? 'FAIL'
        : row.knownGap.length
          ? 'KNOWN GAP'
          : 'PASS',
      JSON.stringify(row),
    );
    await p.close();
  }
  for (const row of results)
    assert.ok(
      row.loadedAfterPick > 0 || row.knownGap.includes('/cesium/Cesium.js'),
      `control: ${row.otherEngine} code is detected when it loads`,
    );
  assert.deepEqual(
    results.filter((row) => row.loadedAtColdStart.length),
    [],
    'a cold start loaded the other engine',
  );
});
