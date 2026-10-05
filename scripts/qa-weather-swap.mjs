/**
 * Weather history-swap probe: does the scene keep drawing while a draped
 * weather frame is replaced? Runs against a live dev server, turns on one
 * observed product at the Earth view, steps Earlier and plays history while
 * screenshotting, then measures the black fraction inside the globe disc of
 * every capture. Writes <out>/<label>/summary.json.
 *
 *   node scripts/qa-weather-swap.mjs --url http://localhost:4173 --label google
 *     [--layer weather-satellite] [--product clouds] [--headless]
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer';

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')
    ? argv[i + 1]
    : fallback;
};
const flag = (name) => argv.includes(name);
const rawUrl = arg('--url', 'http://localhost:4173');
const url = rawUrl.includes('welcome=')
  ? rawUrl
  : `${rawUrl}${rawUrl.includes('?') ? '&' : '?'}welcome=0`;
const label = arg('--label', 'swap');
const layerId = arg('--layer', 'weather-satellite');
const product = arg(
  '--product',
  layerId === 'weather-satellite' ? 'clouds' : null,
);
const outDir = path.resolve(arg('--out', 'qa-shots/weather-swap'), label);
mkdirSync(outDir, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Globe disc in CSS pixels for the 1400×920 viewport at the Earth view.
const DISC = { cx: 700, cy: 460, r: 300 };

const browser = await puppeteer.launch({
  headless: flag('--headless') ? 'new' : false,
  executablePath:
    process.env.PUPPETEER_EXECUTABLE_PATH ||
    ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find((p) =>
      existsSync(p),
    ),
  protocolTimeout: 300_000,
  defaultViewport: null,
  args: [
    '--no-sandbox',
    '--window-size=1400,1000',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling',
  ],
});
const frames = [];
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 920, deviceScaleFactor: 1 });
  page.on('pageerror', (e) => console.log('  [pageerror]', e.message));
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__godsEyeView?.viewer, {
    timeout: 120_000,
  });
  await sleep(12_000);
  await page.evaluate(
    async ({ layerId, product }) => {
      const gev = window.__godsEyeView;
      const dm = gev.dataManager;
      for (const [id, e] of dm.layers)
        if (e.enabled) await dm.setEnabled(id, false, { origin: 'user' });
      const v = gev.viewer;
      const d = Math.PI / 180;
      v.camera.setView({
        destination: v.scene.ellipsoid.cartographicToCartesian({
          longitude: -80 * d,
          latitude: 25 * d,
          height: 17_368_000,
        }),
        orientation: { heading: 0, pitch: -90 * d, roll: 0 },
      });
      await dm.setEnabled(layerId, true, { origin: 'user' });
      if (product) dm.setLayerParams(layerId, { product }, { origin: 'user' });
    },
    { layerId, product },
  );
  await page
    .waitForFunction(
      ({ layerId, product }) => {
        const d = window.__godsEyeView.dataManager.layers
          .get(layerId)
          ?.module?.getDiagnostics?.();
        return d && !d.loading && d.time && (!product || d.product === product);
      },
      { timeout: 90_000 },
      { layerId, product },
    )
    .catch(() => console.log('  !! first frame not ready'));
  await sleep(3000);
  const diag = () =>
    page.evaluate((layerId) => {
      const d = window.__godsEyeView.dataManager.layers
        .get(layerId)
        .module.getDiagnostics();
      return {
        time: d.time,
        loading: d.loading,
        pending: d.pendingTiles,
        loaded: d.loadedTiles,
        imagery: d.imageryCount,
        mosaic: d.mosaic ?? null,
      };
    }, layerId);
  const capture = async (name) => {
    const file = `${name}.png`;
    await page.screenshot({ path: path.join(outDir, file) });
    frames.push({ file, ...(await diag()) });
  };
  await capture('00-latest');
  const step = (params) =>
    page.evaluate(
      ({ layerId, params }) =>
        window.__godsEyeView.dataManager.setLayerParams(layerId, params, {
          origin: 'user',
        }),
      { layerId, params },
    );
  await step({ step: -1 });
  for (let i = 1; i <= 15; i++) {
    await sleep(400);
    await capture(`earlier-${String(i).padStart(2, '0')}`);
  }
  await step({ play: true });
  for (let i = 1; i <= 20; i++) {
    await sleep(500);
    if (i % 2 === 0) await capture(`play-${String(i).padStart(2, '0')}`);
  }
  await step({ play: true });

  // Black fraction inside the globe disc, measured in a blank page.
  const meter = await browser.newPage();
  for (const frame of frames) {
    const b64 = readFileSync(path.join(outDir, frame.file)).toString('base64');
    const black = await meter.evaluate(
      async ({ b64, DISC }) => {
        const img = new Image();
        img.src = `data:image/png;base64,${b64}`;
        await img.decode();
        const c = document.createElement('canvas');
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        const ctx = c.getContext('2d');
        ctx.drawImage(img, 0, 0);
        const s = img.naturalWidth / 1400;
        const d = ctx.getImageData(0, 0, c.width, c.height).data;
        const rr = (DISC.r * s) ** 2;
        let n = 0;
        let dark = 0;
        for (let y = 0; y < c.height; y += 2)
          for (let x = 0; x < c.width; x += 2) {
            if ((x - DISC.cx * s) ** 2 + (y - DISC.cy * s) ** 2 > rr) continue;
            n++;
            const i = (y * c.width + x) * 4;
            if (d[i] < 18 && d[i + 1] < 18 && d[i + 2] < 18) dark++;
          }
        return dark / n;
      },
      { b64, DISC },
    );
    frame.black = Number(black.toFixed(4));
    console.log(
      `${frame.file}\t${(black * 100).toFixed(1)}%\t${frame.time}\tpending=${frame.pending}`,
    );
  }
  const blackFrames = frames.filter((f) => f.black > 0.15).length;
  const distinctTimes = new Set(frames.map((f) => f.time).filter(Boolean)).size;
  const summary = {
    url: rawUrl,
    label,
    layerId,
    product,
    frames: frames.length,
    blackFrames,
    maxBlack: Math.max(...frames.map((f) => f.black)),
    distinctTimes,
    capturedAt: new Date().toISOString(),
  };
  writeFileSync(
    path.join(outDir, 'summary.json'),
    JSON.stringify({ summary, frames }, null, 2),
  );
  console.log(
    `frames=${frames.length} black(>15%)=${blackFrames} max=${(summary.maxBlack * 100).toFixed(1)}% distinctTimes=${distinctTimes}`,
  );
} finally {
  await browser.close();
}
