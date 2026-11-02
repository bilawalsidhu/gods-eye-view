import { fromDegrees } from '../src/geo/cartesian3.js';
import puppeteer from 'puppeteer';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { blockPaidQaMaps } from './qa-map-policy.mjs';

const base = new URL(process.argv[2]);
if (
  !['localhost', '127.0.0.1'].includes(base.hostname) ||
  ['', '4173', '4185', '4186', '4187', '4188', '4189', '4194'].includes(
    base.port,
  )
)
  throw new Error('Supply an unreserved local keyless preview URL');
base.search = '?engine=navara&welcome=0&look=cinematic';
base.hash =
  'v=2&lat=43.6500&lon=-79.3800&alt=46000&heading=0&pitch=-90&roll=0&map=sentinel2&l=';
const b = await puppeteer.launch({
  headless: true,
  args: ['--use-angle=metal', '--enable-gpu'],
});
try {
  const p = await b.newPage();
  await blockPaidQaMaps(p);
  await p.setViewport({ width: 1024, height: 768 });
  const errors = [];
  p.on('pageerror', (e) => {
    errors.push(e.message);
    console.log('error', e.message.split('?')[0]);
  });
  const file = await readFile(
    new URL('./fixtures/ghostmaps-scenes.kmz', import.meta.url),
  );
  await p.evaluateOnNewDocument(
    (bytes) => {
      const fetch = window.fetch.bind(window);
      const events = window.EventSource;
      window.ghostStats = { streams: 0, reads: 0, catalogs: 0, titles: [] };
      window.EventSource = class extends EventTarget {
        constructor(url, options) {
          super();
          if (!url.includes('/api/ghostmaps/events'))
            return new events(url, options);
          window.ghostStats.streams++;
          this.readyState = 1;
        }
        close() {}
      };
      window.fetch = (input, options) => {
        const { pathname } = new URL(input.url ?? input, document.baseURI);
        if (pathname === '/api/ghostmaps/catalog') {
          window.ghostStats.catalogs++;
          return Promise.resolve(
            Response.json({
              commit: 'qa',
              products: [
                { id: 'cip', version: 'qa', title: 'QA', defaultOn: true },
              ],
            }),
          );
        }
        if (pathname.startsWith('/api/ghostmaps/file/')) {
          window.ghostStats.reads++;
          return Promise.resolve(new Response(new Uint8Array(bytes)));
        }
        return fetch(input, options);
      };
      const fill = CanvasRenderingContext2D.prototype.fillText;
      CanvasRenderingContext2D.prototype.fillText = function (value, ...args) {
        if (/QA (pin|route|zone)/i.test(value))
          window.ghostStats.titles.push(value);
        return fill.call(this, value, ...args);
      };
    },
    [...file],
  );
  await p.goto(base.href);
  const ready = async (kind) => {
    await p.waitForFunction(
      (k) =>
        window.__godsEyeView?.engine.kind === k &&
        !document.querySelector('#globe-engine')?.disabled &&
        !document.querySelector('.engine-switch-frame') &&
        document.querySelector('#loading-screen.hidden'),
      { timeout: 90000 },
      kind,
    );
    await p.evaluate(
      () => window.__godsEyeView.styleManager.initialRestorePromise,
    );
  };
  await ready('navara');
  await p.evaluate(async () => {
    const { dataManager } = window.__godsEyeView;
    await dataManager.setEnabled('s2-ghostmaps', true, { origin: 'user' });
    window.qaGhost = dataManager.layers.get('s2-ghostmaps').module;
  });
  const click = async (lon, lat) => {
    const { x, y } = await p.evaluate(
      (pos) => {
        const { engine } = window.__godsEyeView;
        const point = engine.projector.worldToWindow(pos, {});
        const box = engine.host.canvas.getBoundingClientRect();
        window.ghostStats.titles = [];
        return { x: box.left + point.x, y: box.top + point.y };
      },
      fromDegrees(lon, lat),
    );
    await p.mouse.click(x, y);
  };
  for (const kind of ['navara', 'cesium', 'navara']) {
    if ((await p.evaluate(() => window.__godsEyeView.engine.kind)) !== kind) {
      await p.evaluate(() => {
        window.ghostStats.titles = [];
      });
      await p.select('#globe-engine', kind);
      await ready(kind);
      await p.waitForFunction(() =>
        window.ghostStats.titles.some((v) => /QA zone/i.test(v)),
      );
    }
    const inventory = await p.evaluate(() => ({
      same:
        window.qaGhost ===
        window.__godsEyeView.dataManager.layers.get('s2-ghostmaps').module,
      names: window.qaGhost.getAnalystRecords().map((r) => r.name),
      streams: window.ghostStats.streams,
      reads: window.ghostStats.reads,
    }));
    assert.deepEqual(inventory, {
      same: true,
      names: ['QA pin', 'QA route', 'QA zone'],
      streams: 1,
      reads: 1,
    });
    await new Promise((resolve) => setTimeout(resolve, 2200));
    for (const [name, lon, lat] of [
      ['QA pin', -79.38, 43.65],
      ['QA route', -79.375, 43.71],
      ['QA zone', -79.28, 43.61],
    ]) {
      await click(lon, lat);
      await p.waitForFunction(
        (name) =>
          window.ghostStats.titles.some((v) =>
            v.toLowerCase().includes(name.toLowerCase()),
          ),
        { timeout: 12000 },
        name,
      );
      console.log('PASS', kind, name, 'pointer hit');
    }
    await click(-79.316, 43.61);
    await new Promise((resolve) => setTimeout(resolve, 600));
    await p.evaluate(() => {
      window.ghostStats.titles = [];
      window.__godsEyeView.engine.render.request('qa-hole');
    });
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(
      await p.evaluate(() => window.ghostStats.titles.length),
      0,
      kind + ' polygon hole',
    );
    await click(-79.28, 43.61);
    await p.waitForFunction(() =>
      window.ghostStats.titles.some((v) => /QA zone/i.test(v)),
    );
  }
  assert.deepEqual(errors, []);
} finally {
  await b.close();
}
