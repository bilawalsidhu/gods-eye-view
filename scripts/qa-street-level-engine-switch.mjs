import assert from 'node:assert/strict';
import puppeteer from 'puppeteer';
import { blockPaidQaMaps } from './qa-map-policy.mjs';
import { serveFixtures, newFixture } from './qa-street-level.mjs';
import { KV_LINE, KV_SEQUENCE_ID } from './fixtures/street-level/kartaView.mjs';
import {
  PNX_PARK,
  PNX_SEQUENCES,
  panoramaxPictures,
} from './fixtures/street-level/panoramax.mjs';
const panorama = process.argv.includes('--panoramax');
const provider = panorama ? 'panoramax' : 'kartaview';
const base = new URL(process.argv[2]);
if (
  !['localhost', '127.0.0.1'].includes(base.hostname) ||
  ['', '4173', '4185', '4186', '4187', '4188', '4189', '4194'].includes(
    base.port,
  )
)
  throw Error('Keyless local preview required');
base.search = '?engine=navara&welcome=0';
const at = panorama
  ? PNX_PARK
  : { lat: 38.5831, lon: KV_LINE.lon, height: 850 };
base.hash = `v=2&lat=${at.lat}&lon=${at.lon}&alt=${at.height}&heading=0&pitch=-90&roll=0&map=sentinel2&l=`;
const browser = await puppeteer.launch({
  headless: true,
  args: ['--use-angle=metal', '--enable-gpu'],
});
try {
  const p = await browser.newPage();
  await blockPaidQaMaps(p);
  await p.setViewport({ width: 1280, height: 900 });
  const errors = [],
    fixture = newFixture({ configured: true });
  p.on('pageerror', (e) => {
    errors.push(e.message);
    console.error(e.message.split('?')[0]);
  });
  p.on('console', (m) => {
    if (/shader|registerMeshPicker/i.test(m.text()) && m.type() === 'error')
      errors.push(m.text());
  });
  await serveFixtures(p, fixture);
  let photoRequests = 0;
  p.on('request', (req) => {
    if (
      /\.jpg(?:$|\?)/i.test(new URL(req.url()).pathname) &&
      /openstreetcam|kartaview|panoramax/.test(new URL(req.url()).hostname)
    )
      photoRequests++;
  });
  await p.goto(base.href);
  const ready = async (k) => {
    await p.waitForFunction(
      (kind) =>
        window.__godsEyeView?.engine?.kind === kind &&
        !document.querySelector('#globe-engine')?.disabled &&
        !document.querySelector('.engine-switch-frame') &&
        document.querySelector('#loading-screen.hidden'),
      { timeout: 90000 },
      k,
    );
    await p.evaluate(
      () => window.__godsEyeView.styleManager.initialRestorePromise,
    );
  };
  await ready('navara');
  await p.evaluate(async (provider) => {
    const { dataManager, tileset } = window.__godsEyeView;
    if (tileset || window.__GOOGLE_MAPS_API_KEY__)
      throw Error('Expected keyless preview');
    window.qaStreet = dataManager.layers.get('street-level').module;
    await dataManager.setEnabled('street-level', true, { origin: 'user' });
    window.qaStreet.setProviderEnabled(provider, true);
  }, provider);
  const until = async (fn) => {
    try {
      await p.waitForFunction(fn, { timeout: 20000 });
    } catch (e) {
      console.log(await p.evaluate(() => window.qaStreet.getUIState()));
      throw e;
    }
  };
  await until(() => window.qaStreet.getUIState().coverage.count > 0);
  // The fixture drive passes under the middle of the canvas. Click its actual picked line.
  const xy = await p.evaluate(
    (prefix) => {
      const { engine } = window.__godsEyeView,
        canvas = engine.host.canvas,
        rect = canvas.getBoundingClientRect();
      for (let dy = -30; dy <= 30; dy += 3)
        for (let dx = -40; dx <= 40; dx++) {
          const at = { x: rect.width / 2 + dx, y: rect.height / 2 + dy },
            pick = engine.picker.pick(at);
          if (typeof pick?.id === 'string' && pick.id.startsWith(prefix))
            return { x: at.x + rect.x, y: at.y + rect.y, id: pick.id };
        }
      return null;
    },
    panorama ? 'pnx:seq:' : 'kv:line:',
  );
  assert.ok(xy, 'native ground line was pickable');
  console.log('pick', xy);
  await p.mouse.click(xy.x, xy.y);
  await until(
    () =>
      window.qaStreet.getUIState().street.open &&
      window.qaStreet.getUIState().sequence.images > 0 &&
      (document.querySelector('#sl-viewer img')?.naturalWidth > 0 ||
        document.querySelector('#sl-viewer canvas:not([hidden])')?.width > 0),
  );
  if (panorama) {
    const expected = panoramaxPictures().filter(
      (p) => p.sequenceId === xy.id.slice('pnx:seq:'.length),
    ).length;
    await p.waitForFunction(
      (n) => window.qaStreet.getUIState().sequence.images === n,
      { timeout: 20000 },
      expected,
    );
  }
  const first = await p.evaluate(() => {
    window.streetPhoto =
      document.querySelector('#sl-viewer canvas:not([hidden])') ??
      document.querySelector('#sl-viewer img');
    return window.qaStreet.getUIState();
  });
  assert.ok(
    (panorama ? PNX_SEQUENCES : [KV_SEQUENCE_ID]).includes(
      first.street.sequenceId,
    ),
  );
  const reads = photoRequests;
  for (const kind of ['cesium', 'navara']) {
    await p.select('#globe-engine', kind);
    await ready(kind);
    const state = await p.evaluate(() => ({
      model:
        window.__godsEyeView.dataManager.layers.get('street-level').module ===
        window.qaStreet,
      samePhoto:
        document.querySelector('#sl-viewer')?.contains(window.streetPhoto) &&
        window.streetPhoto.isConnected,
      ui: window.qaStreet.getUIState(),
    }));
    console.log(
      kind,
      state.model,
      state.samePhoto,
      state.ui.street.imageId,
      state.ui.sequence.images,
      state.ui.coverage.count,
    );
    assert.equal(state.model, true);
    assert.equal(state.samePhoto, true);
    assert.ok(state.ui.street.open);
    assert.equal(state.ui.street.imageId, first.street.imageId);
    assert.equal(state.ui.sequence.images, first.sequence.images);
    assert.deepEqual(state.ui.filter, first.filter);
    assert.ok(state.ui.coverage.count > 0);
  }
  assert.equal(photoRequests, reads);
  assert.deepEqual(errors, []);
  assert.deepEqual(fixture.unknown, []);
  console.log(
    'PASS native line pick, same mounted photo and sequence across two switches',
  );
} finally {
  await browser.close();
}
