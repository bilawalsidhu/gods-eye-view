/**
 * Overlay redraw p95 with a full live satellite sky plus every content
 * layer, desktop and the mid-phone profile (412x915 @2.625, CPU x4).
 *   node scripts/qa-sky-livesats-perf.mjs --url http://127.0.0.1:4337 --out <dir>
 */
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer';

const arg = (n, f) => {
  const i = process.argv.indexOf(n);
  return i >= 0 ? process.argv[i + 1] : f;
};
const BASE = arg('--url', 'http://127.0.0.1:4337');
const OUT = path.resolve(arg('--out', 'qa-sky-livesats'));
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({
  headless: true,
  protocolTimeout: 600000,
  args: [
    '--no-sandbox',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist',
  ],
});
const HANDLE = `(async () => {
  const m = await import('/src/skyView/skyView.js');
  return m.mountSkyView({ viewer: window.__godsEyeView.viewer });
})()`;
const profiles = [
  {
    name: 'desktop',
    viewport: { width: 1280, height: 800 },
    cpu: 1,
    budget: 8,
  },
  {
    name: 'mid-phone',
    viewport: {
      width: 412,
      height: 915,
      deviceScaleFactor: 2.625,
      isMobile: true,
      hasTouch: true,
    },
    cpu: 4,
    budget: 16,
  },
];
const out = { when: new Date().toISOString(), runs: [] };
const errors = [];
for (const prof of profiles) {
  const page = await browser.newPage();
  await page.setViewport(prof.viewport);
  page.on('pageerror', (e) =>
    errors.push(`${prof.name}: ${String(e).slice(0, 200)}`),
  );
  await page.goto(`${BASE}/`, {
    waitUntil: 'domcontentloaded',
    timeout: 120000,
  });
  await page.waitForFunction(() => window.__godsEyeView?.viewer, {
    timeout: 180000,
  });
  await page.waitForSelector('.gev-sky-btn', { timeout: 180000 });
  await sleep(20000);
  await page.keyboard.press('Escape');
  let st = null;
  for (let i = 0; i < 90; i++) {
    st = await page.evaluate(async (src) => {
      const h = await eval(src);
      if (!h.active)
        await h.enterAt({
          latDeg: 29.7604,
          lonDeg: -95.3698,
          source: 'manual',
          heightM: 15,
          heightKnown: true,
        });
      return {
        a: h.active,
        c: h.content.status,
        s: h.satellites.status,
        n: h.satellites.meta.length,
        t: h.satellites.stats.ticks,
      };
    }, HANDLE);
    if (st.a && st.c === 'ready' && st.s === 'ready' && st.n > 5000 && st.t > 1)
      break;
    await sleep(2000);
  }
  if (prof.cpu > 1) {
    const cdp = await page.createCDPSession();
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: prof.cpu });
  }
  await sleep(1500);
  for (const fov of [60, 100]) {
    const r = await page.evaluate(
      async (src, fov) => {
        const h = await eval(src);
        h.content.setFlags(
          {
            stars: true,
            lines: true,
            names: true,
            boundaries: true,
            starNames: true,
            planets: true,
            grid: true,
          },
          { notify: true },
        );
        await new Promise((r) => setTimeout(r, 800));
        window.__godsEyeView.viewer.useDefaultRenderLoop = false;
        const frame = (i) =>
          new Promise((res) =>
            requestAnimationFrame(() => {
              h.setView({
                azDeg: (200 + i * 0.7) % 360,
                elDeg: 25 + (i % 30),
                fovDeg: fov,
              });
              res();
            }),
          );
        for (let i = 0; i < 30; i++) await frame(i);
        h.resetRedrawPerf();
        for (let i = 0; i < 200; i++) await frame(i);
        window.__godsEyeView.viewer.useDefaultRenderLoop = true;
        const objs = h.satellites.objectsAt(h.clock.getTime());
        return {
          fov,
          redraw: h.redrawPerf(),
          satellitesInSky: objs.filter((o) => o.elDeg > 0).length,
          satelliteDots: h.satelliteModel?.dots?.length ?? 0,
          stars: h.content.lastStats.stars,
          catalogue: h.satellites.meta.length,
        };
      },
      HANDLE,
      fov,
    );
    r.profile = prof.name;
    r.budgetMs = prof.budget;
    r.pass = r.redraw.p95 < prof.budget;
    out.runs.push(r);
    console.log(JSON.stringify(r));
  }
  await page.screenshot({ path: path.join(OUT, `${prof.name}-livesats.png`) });
  await page.close();
}
out.errors = errors;
out.pass = errors.length === 0 && out.runs.every((r) => r.pass);
fs.writeFileSync(
  path.join(OUT, 'livesats-perf.json'),
  JSON.stringify(out, null, 2),
);
console.log(
  out.pass ? 'LIVESATS PERF PASS' : 'LIVESATS PERF FAIL',
  JSON.stringify(errors),
);
await browser.close();
process.exit(out.pass ? 0 : 1);
