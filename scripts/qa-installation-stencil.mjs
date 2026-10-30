import fs from 'node:fs/promises';
import puppeteer from 'puppeteer';
import sharp from 'sharp';
import { installTileCache } from './qa/tileCache.mjs';
import { blockPaidQaMaps } from './qa-map-policy.mjs';
import { watchW1Page } from './qa-browserEvidence.mjs';
import {
  COMBINED_EPOCH,
  installCombinedFixture,
} from './fixtures/w2/combined.mjs';

const arg = (key) =>
  process.argv.find((s) => s.startsWith(`--${key}=`))?.slice(key.length + 3);
const base = arg('base-url'),
  out = arg('out');
if (
  !base ||
  !out ||
  ['4173', '4185', '4186', '4187', '4188', '4189', '4194'].includes(
    new URL(base).port,
  )
)
  throw new Error('Explicit unreserved base URL and output required');
const emptyRenders = process.argv.includes('--empty-renders');
const report = { emptyRenders, checks: [], browserErrors: [] };
const check = (name, pass, detail) => {
  report.checks.push({ name, pass: !!pass, detail });
  console.log(pass ? 'PASS' : 'FAIL', name);
};
const browser = await puppeteer.launch({
  headless: true,
  args: ['--use-angle=metal', '--enable-gpu'],
});
try {
  const page = await browser.newPage();
  await blockPaidQaMaps(page);
  await installTileCache(page);
  await page.setViewport({ width: 1280, height: 800 });
  watchW1Page(page, report, { name: 'batch', baseUrl: base, preview: true });
  const fixture = await installCombinedFixture(page);
  await page.evaluateOnNewDocument(() => {
    localStorage.setItem('gev:first-run-mission:v1', 'suppressed');
    window.__gevW2NativeProbe = (native) => {
      window.__stencilNative = native;
      const { view } = native;
      const register = view.registerEffect.bind(view);
      view.registerEffect = (key, Class) =>
        register(
          key,
          key === 'gevInstallationsDrape'
            ? class extends Class {
                constructor(...args) {
                  super(...args);
                  window.__batchOwner = this.owner;
                  window.__batchContext = args[1];
                }
              }
            : Class,
        );
    };
  });
  await page.goto(
    `${base}/?engine=navara&look=cinematic&welcome=0#lat=42.3554&lon=-71.0605&alt=6000&heading=0&pitch=-90&map=osm`,
    { waitUntil: 'domcontentloaded' },
  );
  await page.waitForFunction(
    () =>
      window.__godsEyeView?.engine &&
      document.getElementById('loading-screen')?.classList.contains('hidden'),
    { timeout: 90000 },
  );
  await page.evaluate(async (epoch) => {
    const a = window.__godsEyeView;
    if (window.__GOOGLE_MAPS_API_KEY__ || a.tileset)
      throw new Error('Keyless build required');
    await a.styleManager.initialRestorePromise;
    a.styleManager.orbitController.stop();
    a.engine.camera.cancelFlight();
    a.styleManager._setDetectionMode('OFF');
    (await import('/src/time/clock.js')).appClock.freeze(epoch);
    for (const [id, row] of a.dataManager.layers)
      if (row.enabled) await a.dataManager.setEnabled(id, false);
    await a.dataManager.setEnabled('military-installations', true);
    await a.dataManager.setEnabled('cctv', true);
    a.dataManager.layers
      .get('cctv')
      .module.setParams({ coverageMode: 'viewshed' });
  }, COMBINED_EPOCH);
  await page.waitForFunction(
    () =>
      window.__batchOwner?.scene &&
      window.__godsEyeView.dataManager.layers
        .get('military-installations')
        .module.getStats().count === 20 &&
      window.__godsEyeView.engine.surface.tilesLoaded(),
    { timeout: 90000 },
  );
  await new Promise((r) => setTimeout(r, 4000));
  const frames = () =>
    page.evaluate(async () => {
      const a = window.__godsEyeView;
      for (let i = 0; i < 3; i++)
        await new Promise((resolve) => {
          const off = a.engine.frames.postRender.addEventListener(() => {
            off();
            resolve();
          });
          a.engine.render.request('qa-batch');
        });
    });
  const shot = async (suffix) => {
    await frames();
    const data = await page.evaluate(() =>
      window.__godsEyeView.engine.host.canvas.toDataURL(),
    );
    const png = Buffer.from(data.split(',')[1], 'base64');
    await fs.writeFile(out.replace(/\.json$/, `-${suffix}.png`), png);
    return sharp(png).ensureAlpha().raw().toBuffer();
  };
  const delta = (a, b) => {
    let changed = 0,
      max = 0;
    for (let y = 190; y < 650; y++)
      for (let x = 200; x < 1050; x++) {
        const i = (y * 1280 + x) * 4;
        const d = Math.max(
          ...[0, 1, 2].map((c) => Math.abs(a[i + c] - b[i + c])),
        );
        if (d) changed++;
        max = Math.max(max, d);
      }
    return { changed, max };
  };
  async function mode(original) {
    if (emptyRenders) {
      await page.evaluate((original) => {
        const { mrt, opaque } = window.__batchContext.scenes;
        window.__emptyRenderCallbacks ??= [
          mrt.onBeforeRender,
          opaque.onBeforeRender,
        ];
        [mrt, opaque].forEach((scene, i) => {
          scene.onBeforeRender = original
            ? () => {}
            : window.__emptyRenderCallbacks[i];
        });
      }, original);
      return;
    }
    await page.evaluate((original) => {
      for (const mesh of window.__batchOwner.meshes) {
        mesh.userData.qaOptimizedProcess ??= mesh.process;
        mesh.process = original
          ? Object.getPrototypeOf(mesh).process
          : mesh.userData.qaOptimizedProcess;
      }
    }, original);
  }
  async function submissions() {
    return page.evaluate(async () => {
      const a = window.__godsEyeView,
        renderer = window.__batchContext.getRenderer();
      const render = renderer.render,
        autoReset = renderer.info.autoReset;
      let calls = 0;
      renderer.info.autoReset = false;
      renderer.render = function (...args) {
        calls++;
        return render.apply(this, args);
      };
      try {
        return await new Promise((resolve) => {
          const pre = a.engine.frames.preRender.addEventListener(() => {
            calls = 0;
            renderer.info.reset();
          });
          const post = a.engine.frames.postRender.addEventListener(() => {
            pre();
            post();
            resolve({ renders: calls, draws: renderer.info.render.calls });
          });
          a.engine.render.request('qa-stencil-count');
        });
      } finally {
        renderer.render = render;
        renderer.info.autoReset = autoReset;
      }
    });
  }
  async function compare(name, preserveClears = false) {
    await mode(false);
    const optimized = await shot(name + '-optimized'),
      fast = await submissions();
    await mode(true);
    const baseline = await shot(name + '-original'),
      slow = await submissions();
    const repeat = await shot(name + '-original-repeat');
    check(
      name + ': stable original pixels',
      delta(baseline, repeat).changed === 0,
      delta(baseline, repeat),
    );
    const difference = delta(optimized, baseline);
    check(
      name + ': exact original pixels',
      difference.changed === 0,
      difference,
    );
    check(
      name +
        (preserveClears
          ? ': preserves required clear resolves'
          : ': same draws with fewer render submissions'),
      fast.draws === slow.draws &&
        (preserveClears
          ? fast.renders === slow.renders
          : fast.renders < slow.renders),
      { fast, slow },
    );
    return baseline;
  }
  const baseline = await compare('catalog');
  await page.evaluate(() => {
    for (const mesh of window.__batchOwner.meshes) mesh.visible = false;
  });
  const absent = await shot('no-contours');
  check(
    'removing contours fails the pixel oracle',
    delta(baseline, absent).changed > 100,
    delta(baseline, absent),
  );
  await page.evaluate(async () => {
    const a = window.__godsEyeView;
    await a.dataManager.setEnabled('cctv', false);
    const { loadInstallationGeometry } =
      await import('/scripts/qa-installation-stencil-entry.mjs');
    const {
      createInstallationDrapedMesh,
      createInstallationOutlineDrapedMesh,
    } = await loadInstallationGeometry();
    const owner = window.__batchOwner,
      center = { id: 'qa-hole', longitude: -71.0605, latitude: 42.3554 };
    const rectangle = (w, s, e, n) =>
      [
        [w, s],
        [e, s],
        [e, n],
        [w, n],
        [w, s],
      ].map(([x, y]) => [center.longitude + x, center.latitude + y]);
    const outer = rectangle(-0.016, -0.005, -0.002, 0.005),
      hole = rectangle(-0.012, -0.002, -0.008, 0.002),
      overlap = rectangle(-0.006, -0.004, 0.01, 0.006);
    const opts = {
      ...window.__stencilNative,
      globeNormal: owner.globeNormal,
      globeDepth: owner.globeDepth,
      color: '#00aaff',
      opacity: 0.4,
    };
    const meshes = [
      createInstallationDrapedMesh(center, [outer, hole], opts),
      createInstallationDrapedMesh(center, [overlap], {
        ...opts,
        color: '#ff8800',
        opacity: 0.45,
      }),
      createInstallationOutlineDrapedMesh(center, outer, {
        ...opts,
        widthM: 20,
      }),
    ];
    window.__stencilCustom = meshes;
    window.__stencilSolid = createInstallationDrapedMesh(center, [outer], opts);
    for (const mesh of meshes) owner.meshes.add(mesh);
  });
  for (const [name, heading, pitch] of [
    ['holes-nadir', 0, -90],
    ['holes-oblique', 30, -50],
    ['holes-reverse', 210, -65],
  ]) {
    await page.evaluate(
      async ({ heading, pitch }) => {
        const g = await import('/src/geo/index.js'),
          e = window.__godsEyeView.engine;
        e.camera.setView({
          destination: g.cartesian3.fromDegrees(
            -71.0605 -
              ((6000 / Math.tan(g.math.toRadians(-pitch))) *
                Math.sin(g.math.toRadians(heading))) /
                (111320 * Math.cos(g.math.toRadians(42.3554))),
            42.3554 -
              ((6000 / Math.tan(g.math.toRadians(-pitch))) *
                Math.cos(g.math.toRadians(heading))) /
                111320,
            6000,
          ),
          orientation: {
            heading: g.math.toRadians(heading),
            pitch: g.math.toRadians(pitch),
            roll: 0,
          },
        });
      },
      { heading, pitch },
    );
    await page.waitForFunction(
      () => window.__godsEyeView.engine.surface.tilesLoaded(),
      { timeout: 90000 },
    );
    await new Promise((r) => setTimeout(r, 1000));
    const original = await compare(name);
    await page.evaluate(() => {
      for (const mesh of window.__stencilCustom) mesh.visible = false;
    });
    const absentCustom = await shot(name + '-absent');
    check(
      name + ': custom geometry visible',
      delta(original, absentCustom).changed > 100,
      delta(original, absentCustom),
    );
    await page.evaluate(() => {
      for (const mesh of window.__stencilCustom) mesh.visible = true;
    });
    if (name === 'holes-nadir') {
      await page.evaluate(() => {
        const m = window.__stencilCustom[0];
        window.__stencilHoleGeometry = m.geometry;
        m.geometry = window.__stencilSolid.geometry;
      });
      const solid = await shot('hole-negative');
      check(
        'filling the hole fails the same pixel oracle',
        delta(original, solid).changed > 100,
        delta(original, solid),
      );
      await page.evaluate(() => {
        window.__stencilCustom[0].geometry = window.__stencilHoleGeometry;
      });
    }
  }
  await page.evaluate(() => {
    for (const mesh of [...window.__stencilCustom, window.__stencilSolid]) {
      window.__batchOwner.meshes.delete(mesh);
      mesh.removeFromParent();
      mesh.geometry.dispose();
      mesh.material.dispose();
    }
  });
  if (emptyRenders) {
    await page.evaluate(async () => {
      const manager = window.__godsEyeView.dataManager;
      await manager.setEnabled('military-installations', false);
      await manager.setEnabled('cctv', false);
    });
    await compare('empty');
    await page.evaluate(() => {
      window.__stencilNative.view.globe.hideUnderground = false;
    });
    await compare('empty-depth-clear', true);
  }
  check(
    'no unexpected browser errors',
    report.browserErrors.length === 0,
    report.browserErrors,
  );
  await fixture.dispose();
} catch (error) {
  report.failure = error.stack;
} finally {
  await browser.close();
  await fs.writeFile(out, JSON.stringify(report, null, 2));
}
if (report.failure || report.checks.some((c) => !c.pass)) process.exitCode = 1;
