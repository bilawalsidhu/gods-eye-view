import { whenFramesDrawn } from './qa/ready.mjs';
import sharp from 'sharp';
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
  'v=2&lat=43.6500&lon=-79.3800&alt=2000000&heading=0&pitch=-90&roll=0&map=sentinel2&l=';
// The fixture field is uniform, so the GPU seeds a fixed particle count.
const WIND_PATHS = 7200;
const strict = createStrict({ origin: base.origin, layers: ['wind'] });
await strict.run({}, async (b) => {
  const { page: p, errors } = await openPage(b);
  const reads = [];
  await p.setRequestInterception(true);
  p.on('request', (req) => {
    const u = new URL(req.url());
    if (!u.pathname.startsWith('/api/wind/')) return req.continue();
    reads.push(u.pathname + u.search);
    const model = u.searchParams.get('model'),
      kind = u.searchParams.get('overlay');
    const count = 36 * 19;
    if (u.pathname.endsWith('/manifest'))
      return req.respond({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          model,
          overlay: kind ?? 'none',
          grid: { nx: 36, ny: 19, lo1: 0, la1: 90, dx: 10, dy: 10 },
          gridUrl: '/api/wind/grid/' + model + '-qa.bin' + u.search,
          cycle: {
            validIso: '2026-11-02T12:00:00Z',
            runIso: '2026-11-02T06:00:00Z',
          },
          ...(kind
            ? {
                scalar: {
                  kind,
                  units: kind === 'temperature' ? '°C' : 'hPa',
                  level:
                    kind === 'temperature'
                      ? '2 m above ground'
                      : 'mean sea level',
                },
              }
            : {}),
        }),
      });
    const values = new Float32Array(count * (kind ? 3 : 2));
    values.fill(8, 0, count);
    values.fill(6, count, count * 2);
    if (kind) values.fill(kind === 'temperature' ? 40 : 1020, count * 2);
    return req.respond({
      status: 200,
      contentType: 'application/octet-stream',
      body: Buffer.from(values.buffer),
    });
  });
  p.on('console', (msg) => {
    if (msg.type() === 'error' && /Shader|WebGLProgram/i.test(msg.text())) {
      errors.push(msg.text());
      console.log('GPU', msg.text().slice(0, 2500));
    }
  });
  await p.goto(base.href);
  await waitForEngine(p, 'navara');
  await p.evaluate(async () => {
    const { dataManager } = window.__godsEyeView;

    const mod = dataManager.layers.get('wind').module;
    window.qaWind = mod;
    mod.setParams({ overlay: 'temperature', paused: true, units: 'm/s' });
    await dataManager.setEnabled('wind', true, { origin: 'user' });
  });
  await p.waitForFunction(
    () =>
      window.qaWind.getDiagnostics().imageryActive &&
      window.qaWind.getDiagnostics().gpu?.ready,
  );
  await p.evaluate(() => window.qaWind.setParams({ inspect: true }));
  const baseline = reads.length;
  for (const kind of ['navara', 'cesium', 'navara']) {
    if ((await p.evaluate(() => window.__godsEyeView.engine.kind)) !== kind) {
      await strict.switchTo(p, kind);
    }
    await p.waitForFunction(
      () =>
        window.qaWind.getDiagnostics().gpu?.ready &&
        window.qaWind.getRowControls().summary.reading?.speed === 10,
      { timeout: 90000 },
    );
    await whenFramesDrawn(p);
    const check = await p.evaluate(() => {
      const { dataManager } = window.__godsEyeView;
      const mod = dataManager.layers.get('wind').module;
      return {
        same: mod === window.qaWind,
        params: mod.getParams(),
        gpu: mod.getDiagnostics().gpu.pathCount,
        reading: mod.getRowControls().summary.reading,
      };
    });
    await strict.check(p, 'wind', 'same wind model', check.same === true);
    await strict.check(
      p,
      'wind',
      'paused parameter retained',
      check.params.paused === true,
    );
    await strict.check(
      p,
      'wind',
      `${WIND_PATHS} GPU paths`,
      check.gpu === WIND_PATHS,
      check.gpu,
    );
    await strict.check(
      p,
      'wind',
      'point reading 40.0 °C from SW',
      check.reading.scalarValue === '40.0 °C' && check.reading.from === 'SW',
      check.reading,
    );
    const sample = await sharp(await p.screenshot())
      .extract({ left: 530, top: 390, width: 24, height: 24 })
      .removeAlpha()
      .raw()
      .toBuffer();
    const [r, g, b] = [0, 1, 2].map((k) => {
      let sum = 0;
      for (let i = k; i < sample.length; i += 3) sum += sample[i];
      return sum / (sample.length / 3);
    });
    console.log(kind, check.gpu, check.reading.wind, [r, g, b]);
    await strict.check(
      p,
      'wind',
      'temperature field visible',
      r > g * 1.35 && r > b * 1.35,
      [r, g, b],
    );
    await strict.check(
      p,
      'wind',
      'no forecast grid read on the switch',
      reads.length === baseline,
      reads.length - baseline,
    );
  }
  await p.evaluate(() => window.qaWind.setParams({ paused: false }));
  await p.waitForFunction(
    () => window.qaWind.getDiagnostics().gpu.phaseSeconds > 0.2,
  );
  await p.evaluate(() => window.qaWind.setParams({ paused: true }));
  const frozen = await p.evaluate(
    () => window.qaWind.getDiagnostics().gpu.phaseSeconds,
  );
  await whenFramesDrawn(p);
  await strict.check(
    p,
    'wind',
    'pause freezes the particle phase',
    (await p.evaluate(
      () => window.qaWind.getDiagnostics().gpu.phaseSeconds,
    )) === frozen,
  );
  assert.deepEqual(errors, []);
  console.log(
    'PASS retained forecast grid, pause, temperature field and sampled wind on both engines',
  );
});
