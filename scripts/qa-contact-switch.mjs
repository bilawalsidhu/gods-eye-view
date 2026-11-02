import puppeteer from 'puppeteer';
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
  'v=2&lat=43.6500&lon=-79.3800&alt=46000&heading=0&pitch=-90&roll=0&map=sentinel2&l=4';
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
  await p.evaluateOnNewDocument(() => {
    const fetch = window.fetch.bind(window);
    window.fetch = (input, options) => {
      const { pathname } = new URL(input.url ?? input, document.baseURI);
      if (pathname === '/api/vessels')
        return Promise.resolve(
          Response.json({
            status: 'live',
            rows: ['123456789', '223456789'].map((mmsi, i) => ({
              mmsi,
              name: 'Toronto ' + i,
              lat: 43.65,
              lon: -79.38 + i * 0.05,
              last_position_epoch: Date.now() / 1000,
            })),
          }),
        );
      if (pathname === '/api/vessels/track')
        return Promise.resolve(Response.json({ samples: [] }));
      if (pathname === '/api/flights')
        return Promise.resolve(
          Response.json({ time: Date.now() / 1000, states: [] }),
        );
      if (pathname === '/api/military')
        return Promise.resolve(Response.json({ now: Date.now(), ac: [] }));
      if (pathname === '/api/military-installations')
        return Promise.resolve(Response.json({ elements: [], status: 'ok' }));
      return fetch(input, options);
    };
  });
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
    const { dataManager, styleManager, tileset } = window.__godsEyeView;
    if (tileset || window.__GOOGLE_MAPS_API_KEY__)
      throw Error('Require keyless preview');
    await dataManager.setEnabled('ais-live-vessels', true, { origin: 'user' });
    window.qaBefore = [...dataManager.getEnabledLayerIds()].sort();
    const outcome = await styleManager.setContextMode('contacts');
    if (!outcome.ok) throw Error(JSON.stringify(outcome));
    window.qaContext = dataManager.layers.get('military-awareness').module;
    window.qaSites = dataManager.layers.get('military-installations').module;
    const vessels = dataManager.layers.get('ais-live-vessels').module;
    if (!vessels.selectById('123456789')) throw Error('Missing first vessel');
    if (!window.qaContext.navigateNext({ targetLayer: 'ais-live-vessels' }))
      throw Error('Cannot navigate to the second vessel');
  });
  const sample = () =>
    p.evaluate(() => {
      const { dataManager, styleManager, engine } = window.__godsEyeView;
      return {
        context:
          window.qaContext ===
          dataManager.layers.get('military-awareness').module,
        sites:
          window.qaSites ===
          dataManager.layers.get('military-installations').module,
        mode: styleManager.getContextModeState().mode,
        subject: window.qaContext.getContextSnapshot()?.subject?.id,
        history:
          window.qaContext._getAwarenessNavigationStateForTest().historyKeys,
        enabled: [...dataManager.getEnabledLayerIds()].sort(),
        ring:
          engine.kind === 'navara'
            ? engine.lines
                .list()
                .filter((line) => line.id === 'gev-awareness-rim').length
            : null,
      };
    });
  const baseline = await sample();
  console.log('baseline', JSON.stringify(baseline));
  assert.equal(baseline.mode, 'flights');
  assert.equal(baseline.subject, '223456789');
  assert.ok(baseline.history.includes('ais-live-vessels:123456789'));
  assert.ok(baseline.ring >= 1);
  for (const kind of ['cesium', 'navara']) {
    await p.select('#globe-engine', kind);
    await ready(kind);
    const current = await sample();
    console.log('handoff', kind, JSON.stringify(current));
    assert.deepEqual(current, {
      ...baseline,
      ring: kind === 'navara' ? baseline.ring : null,
    });
  }
  const restored = await p.evaluate(async () => {
    const { dataManager, styleManager } = window.__godsEyeView;
    const result = await styleManager.setContextMode('off');
    return (
      result.ok &&
      JSON.stringify([...dataManager.getEnabledLayerIds()].sort()) ===
        JSON.stringify(window.qaBefore)
    );
  });
  assert.ok(
    restored,
    'Restore layers enabled by the user before entering Contacts',
  );
  assert.deepEqual(errors, []);
  console.log(
    'PASS Contacts history, dependency ownership and exit restore across both globes',
  );
} finally {
  await b.close();
}
