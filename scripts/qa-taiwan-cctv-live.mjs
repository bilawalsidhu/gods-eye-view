/**
 * qa-taiwan-cctv-live.mjs — Taiwan live MJPEG CCTV proof.
 *
 * Enables CCTV, activates a Taiwan Freeway Bureau camera, and asserts the
 * panel preview is streaming /api/cctv/media (not refreshed stills): the
 * preview decodes, its pixels change over time, and switching away closes
 * the stream.
 *
 * Run:  node scripts/qa-taiwan-cctv-live.mjs --url http://localhost:4173 [--shots <dir>]
 */
import puppeteer from 'puppeteer';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const APP_URL = arg('--url', 'http://localhost:4173');
const SHOTS = arg('--shots', '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const browser = await puppeteer.launch({
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  defaultViewport: { width: 1600, height: 900 },
});
try {
  const page = await browser.newPage();
  const media = { opened: 0, finished: 0 };
  page.on('request', (req) => {
    if (req.url().includes('/api/cctv/media/tw-')) media.opened += 1;
  });
  page.on('requestfinished', (req) => {
    if (req.url().includes('/api/cctv/media/tw-')) media.finished += 1;
  });
  page.on('requestfailed', (req) => {
    if (req.url().includes('/api/cctv/media/tw-')) media.finished += 1;
  });
  await page.goto(APP_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(
    () => window.__godsEyeView?.viewer && window.__godsEyeView?.dataManager,
    { timeout: 60000 },
  );
  await sleep(3000);
  await page.evaluate(async () => {
    const dm = window.__godsEyeView.dataManager;
    if (!dm.layers.get('cctv').enabled) await dm.toggle('cctv');
  });
  await page.waitForFunction(
    () =>
      (window.__godsEyeView.dataManager.layers.get('cctv').module.getUIState()
        .count || 0) > 100,
    { timeout: 120000 },
  );
  const target = await page.evaluate(() => {
    const ui = window.__godsEyeView.dataManager.layers
      .get('cctv')
      .module.getUIState();
    const cams = ui.cameras || [];
    const tw = cams.filter((c) => String(c.id).startsWith('tw-freeway-'));
    return { total: cams.length, taiwan: tw.length, id: tw[0]?.id, name: tw[0]?.name };
  });
  check('Taiwan freeway cameras in client catalog', target.taiwan > 0, JSON.stringify(target));

  await page.evaluate((id) => {
    window.__godsEyeView.dataManager.layers
      .get('cctv')
      .module.setParams({ selectedCameraId: id });
  }, target.id);

  const decoded = await page
    .waitForFunction(
      () => {
        const img = document.getElementById('cctv-frame');
        return img && img.naturalWidth > 0 && img.dataset.live === 'true';
      },
      { timeout: 45000 },
    )
    .then(() => true)
    .catch(() => false);
  const panel = await page.evaluate(() => {
    const img = document.getElementById('cctv-frame');
    return {
      src: img?.getAttribute('src'),
      w: img?.naturalWidth,
      h: img?.naturalHeight,
      badge: document.querySelector('[id*="cctv-source"], .cctv-source-badge')?.textContent,
    };
  });
  check('panel preview decodes the live stream', decoded, JSON.stringify(panel));
  check('panel preview uses the media (stream) route', /\/api\/cctv\/media\//.test(panel.src || ''));

  const signature = () =>
    page.evaluate(() => {
      const img = document.getElementById('cctv-frame');
      const c = document.createElement('canvas');
      c.width = 96;
      c.height = 54;
      const ctx = c.getContext('2d');
      ctx.drawImage(img, 0, 0, 96, 54);
      const d = ctx.getImageData(0, 0, 96, 54).data;
      let h = 0x811c9dc5;
      for (let i = 0; i < d.length; i += 4) h = Math.imul(h ^ d[i], 16777619);
      return h >>> 0;
    });
  const sigs = [];
  for (let i = 0; i < 6; i++) {
    sigs.push(await signature());
    await sleep(700);
  }
  check('preview pixels change over ~4 s (moving video)', new Set(sigs).size > 1, sigs.join(','));
  check('exactly one stream opened for the panel + plane budget', media.opened >= 1 && media.opened <= 3, `opened=${media.opened}`);
  if (SHOTS) {
    await page.screenshot({ path: `${SHOTS}/taiwan-cctv-live.png` });
    console.log(`screenshot: ${SHOTS}/taiwan-cctv-live.png`);
  }

  await page.evaluate(async () => {
    await window.__godsEyeView.dataManager.toggle('cctv');
  });
  await sleep(1500);
  const closed = await page.evaluate(() => !document.getElementById('cctv-frame')?.getAttribute('src'));
  check('disabling CCTV releases the stream', closed && media.finished >= 1, `finished=${media.finished}`);
} finally {
  await browser.close();
}
process.exit(failed ? 1 : 0);
