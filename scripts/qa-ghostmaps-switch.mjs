import { whenPickable, whenSettled } from './qa/ready.mjs';
import { fromDegrees } from '../src/geo/cartesian3.js';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import {
  createStrict,
  localPreview,
  openPage,
  waitForEngine,
} from './qa-strict-harness.mjs';

const base = localPreview(process.argv[2]);
base.search = '?engine=navara&welcome=0&look=cinematic';
base.hash =
  'v=2&lat=43.6500&lon=-79.3800&alt=46000&heading=0&pitch=-90&roll=0&map=sentinel2&l=';
const strict = createStrict({ origin: base.origin, layers: ['s2-ghostmaps'] });
await strict.run({}, async (b) => {
  const { page: p, errors } = await openPage(b);
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
  await waitForEngine(p, 'navara');
  await p.evaluate(async () => {
    const { dataManager } = window.__godsEyeView;
    await dataManager.setEnabled('s2-ghostmaps', true, { origin: 'user' });
    window.qaGhost = dataManager.layers.get('s2-ghostmaps').module;
  });
  const click = async (lon, lat, pickId) => {
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
    if (pickId)
      await whenPickable(
        p,
        { x, y, id: pickId },
        (picked, position) => picked?.id === position.id,
      );
    await p.mouse.click(x, y);
  };
  const overlay = () =>
    p.evaluate(() => {
      const canvas = document.getElementById('world-overlay-canvas');
      const data = canvas
        .getContext('2d')
        .getImageData(0, 0, canvas.width, canvas.height).data;
      let pixels = 0;
      for (let i = 3; i < data.length; i += 4) if (data[i]) pixels++;
      return pixels;
    });
  for (const kind of ['navara', 'cesium', 'navara']) {
    if ((await p.evaluate(() => window.__godsEyeView.engine.kind)) !== kind) {
      await p.evaluate(() => {
        window.ghostStats.titles = [];
      });
      await strict.switchTo(p, kind);
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
    await strict.passed(
      p,
      's2-ghostmaps',
      'same model, three features, one event stream, one KMZ read',
    );
    await whenSettled(p);
    for (const [name, lon, lat, pickId] of [
      ['QA pin', -79.38, 43.65, 'ghostmaps:cip:0:0'],
      ['QA route', -79.375, 43.71, 'ghostmaps:cip:1:0'],
      ['QA zone', -79.28, 43.61, 'ghostmaps:cip:2:0'],
    ]) {
      await click(lon, lat, pickId);
      await p.waitForFunction(
        (name) =>
          window.ghostStats.titles.some((v) =>
            v.toLowerCase().includes(name.toLowerCase()),
          ),
        { timeout: 12000 },
        name,
      );
      await strict.passed(
        p,
        's2-ghostmaps',
        `a click on ${name} draws its card text`,
      );
      console.log('PASS', kind, name, 'pointer hit');
    }
    // Not vacuous: the zone's card is up, so the overlay only clears when
    // the click in the hole is handled as a click on empty ground. The
    // overlay without any card is measured with a click far from every
    // feature.
    const shown = await overlay();
    await click(-79.316, 43.61);
    await p.waitForFunction(
      (shown) => {
        const canvas = document.getElementById('world-overlay-canvas');
        const data = canvas
          .getContext('2d')
          .getImageData(0, 0, canvas.width, canvas.height).data;
        let pixels = 0;
        for (let i = 3; i < data.length; i += 4) if (data[i]) pixels++;
        return pixels < shown - 100;
      },
      { timeout: 10000 },
      shown,
    );
    const hole = await overlay();
    await click(-79.45, 43.55);
    await whenSettled(p);
    const empty = await overlay();
    console.log(
      kind,
      'overlay pixels: zone card',
      shown,
      'hole',
      hole,
      'empty ground',
      empty,
    );
    await strict.check(
      p,
      's2-ghostmaps',
      'a click in the zone hole clears the selected zone card like empty ground',
      shown > empty + 100 && Math.abs(hole - empty) <= 0.02 * shown,
      { shown, hole, empty },
    );
    await click(-79.28, 43.61);
    await p.waitForFunction(() =>
      window.ghostStats.titles.some((v) => /QA zone/i.test(v)),
    );
  }
  assert.deepEqual(errors, []);
});
