#!/usr/bin/env node
/**
 * Rendered acceptance for DISPLAY ▸ Import: real files through the real file
 * input and a real drop, parsed by Cesium in the page.
 *
 * Proves: GeoJSON, KML, KMZ (with a packed icon and ground overlay) and GPX
 * each become one row and one data source; the imported shape actually paints
 * on the globe and stops painting when hidden; a KML/KMZ never makes the page
 * request anything named in it (network link, remote icon, remote style); a
 * dropped file imports like a picked one; a file that is not geodata is refused
 * with a reason and leaves nothing behind; Remove gives every data source back;
 * no page errors.
 *
 * Usage: dev server up (`npm run dev`), then `node scripts/qa-geo-import.mjs`.
 * QA_BASE_URL (default http://localhost:4173), QA_SHOT_DIR, QA_HEADFUL=1.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer';

const BASE_URL = process.env.QA_BASE_URL || 'http://localhost:4173';
const SHOT_DIR = process.env.QA_SHOT_DIR || 'qa-shots/geo-import';
const HEADFUL = process.env.QA_HEADFUL === '1';
// Golden Gate Park: a big, flat, green rectangle the test polygon can cover.
const VIEW = { lon: -122.4862, lat: 37.7694, height: 4200, pitch: -88 };
const TRAP_HOST = 'gev-qa-trap.invalid';

/* ── fixtures ──────────────────────────────────────────────────────────── */

const ring = [
  [-122.511, 37.7645],
  [-122.4545, 37.7645],
  [-122.4545, 37.7745],
  [-122.511, 37.7745],
  [-122.511, 37.7645],
];
const geojson = JSON.stringify({
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: { name: 'QA park' },
      geometry: { type: 'Polygon', coordinates: [ring] },
    },
    {
      type: 'Feature',
      properties: { name: 'QA pin' },
      geometry: { type: 'Point', coordinates: [-122.4862, 37.7694] },
    },
  ],
});
const kml = (iconHref) => `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
<Document>
  <Style id="s"><IconStyle><Icon><href>${iconHref}</href></Icon></IconStyle></Style>
  <NetworkLink><Link><href>https://${TRAP_HOST}/link.kml</href></Link></NetworkLink>
  <Placemark><name>QA KML pin</name><styleUrl>#s</styleUrl>
    <description><![CDATA[<img src="https://${TRAP_HOST}/balloon.png">]]></description>
    <Point><coordinates>-122.47,37.77,0</coordinates></Point></Placemark>
  <Placemark><name>QA remote style</name><styleUrl>https://${TRAP_HOST}/styles.kml#x</styleUrl>
    <LineString><coordinates>-122.50,37.766 -122.46,37.772</coordinates></LineString></Placemark>
  <GroundOverlay><Icon><href>https://${TRAP_HOST}/overlay.png</href></Icon>
    <LatLonBox><north>37.77</north><south>37.76</south><east>-122.46</east><west>-122.47</west></LatLonBox></GroundOverlay>
</Document>
</kml>`;
const gpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="qa" xmlns="http://www.topografix.com/GPX/1/1">
  <wpt lat="37.769" lon="-122.49"><name>QA waypoint</name></wpt>
  <trk><name>QA track</name><trkseg>
    <trkpt lat="37.766" lon="-122.505"/><trkpt lat="37.768" lon="-122.49"/><trkpt lat="37.772" lon="-122.47"/>
  </trkseg></trk>
</gpx>`;
// 1×1 PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==',
  'base64',
);
/** Stored (uncompressed) zip — enough for a KMZ fixture. */
function storedZip(files) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const [name, data] of files) {
    const n = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(n.length, 26);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt32LE(data.length, 20);
    c.writeUInt32LE(data.length, 24);
    c.writeUInt16LE(n.length, 28);
    c.writeUInt32LE(offset, 42);
    parts.push(local, n, data);
    central.push(c, n);
    offset += 30 + n.length + data.length;
  }
  const dir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, dir, end]);
}
const kmzDoc = kml('files/pin.png').replace(
  `<href>https://${TRAP_HOST}/overlay.png</href>`,
  '<href>files/overlay.png</href>',
);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gev-qa-geo-import-'));
const fixture = (name, data) => {
  const file = path.join(dir, name);
  fs.writeFileSync(file, data);
  return file;
};
const FILES = [
  fixture('park.geojson', geojson),
  fixture('remote-bits.kml', kml(`https://${TRAP_HOST}/icon.png`)),
  fixture(
    'packed.kmz',
    storedZip([
      ['doc.kml', Buffer.from(kmzDoc)],
      ['files/pin.png', PNG],
      ['files/overlay.png', PNG],
    ]),
  ),
  fixture('walk.gpx', gpx),
];

/* ── harness ───────────────────────────────────────────────────────────── */

const browser = await puppeteer.launch({
  headless: !HEADFUL,
  args: [
    '--no-sandbox',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    ...(process.platform === 'darwin'
      ? ['--use-angle=metal', '--enable-gpu']
      : ['--use-gl=angle', '--use-angle=swiftshader']),
  ],
});
const page = await browser.newPage();
const errors = [];
const trapped = [];
page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
page.on('request', (request) => {
  if (request.url().includes(TRAP_HOST)) trapped.push(request.url());
});
let failures = 0;
function check(name, passed, detail = '') {
  console.log(
    `[${passed ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`,
  );
  if (!passed) failures++;
}
fs.mkdirSync(SHOT_DIR, { recursive: true });
const shot = (name) =>
  page.screenshot({
    path: path.join(SHOT_DIR, `${name}.jpg`),
    type: 'jpeg',
    quality: 82,
  });
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const CLIP = { x: 380, y: 240, width: 480, height: 320 };

/** Pixels in the clip close to the first import color (#39d0ff). */
async function cyanPixels() {
  await page.evaluate(() => window.__godsEyeView.viewer.scene.requestRender());
  await wait(600);
  const base64 = await page.screenshot({
    clip: CLIP,
    type: 'png',
    encoding: 'base64',
  });
  return page.evaluate(async (b64) => {
    const bitmap = await createImageBitmap(
      await (await fetch(`data:image/png;base64,${b64}`)).blob(),
    );
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d');
    context.drawImage(bitmap, 0, 0);
    const { data } = context.getImageData(0, 0, bitmap.width, bitmap.height);
    let n = 0;
    for (let i = 0; i < data.length; i += 4) {
      const [r, g, b] = [data[i], data[i + 1], data[i + 2]];
      if (b > 150 && g > 120 && r < 140 && b - r > 60) n += 1;
    }
    return n;
  }, base64);
}
const state = () =>
  page.evaluate(() => ({
    files: window.__gevGeoImport.list(),
    dataSources: window.__godsEyeView.viewer.dataSources.length,
    rows: document.querySelectorAll('#geo-import-list .geo-import-row').length,
    hint: document.getElementById('geo-import-hint')?.textContent || '',
  }));

try {
  await page.setViewport({ width: 1280, height: 860 });
  await page.goto(`${BASE_URL}/?welcome=0`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () =>
      window.__gevGeoImport &&
      window.__godsEyeView?.viewer &&
      document.getElementById('loading-screen')?.classList.contains('hidden'),
    { timeout: 90_000 },
  );
  await page.evaluate((view) => {
    const viewer = window.__godsEyeView.viewer;
    viewer.camera.cancelFlight?.();
    viewer.camera.setView({
      destination: window.__CESIUM__.Cartesian3.fromDegrees(
        view.lon,
        view.lat,
        view.height,
      ),
      orientation: { heading: 0, pitch: (view.pitch * Math.PI) / 180, roll: 0 },
    });
    viewer.scene.requestRender();
  }, VIEW);
  await wait(4000);
  await page.evaluate(() => {
    const rail = document.getElementById('pp-toggles');
    if (rail?.classList.contains('collapsed'))
      document
        .querySelector('.panel-collapse-btn[data-collapse-target="pp-toggles"]')
        ?.click();
  });
  await page.waitForFunction(
    () =>
      document.getElementById('geo-import-button')?.getBoundingClientRect()
        .width > 0,
    { timeout: 10_000 },
  );
  const before = await state();
  check(
    'Import is on the DISPLAY rail with an empty, hidden list',
    before.rows === 0 &&
      !(await page.evaluate(() =>
        document
          .getElementById('geo-import-list')
          .classList.contains('visible'),
      )),
  );
  const cyanBefore = await cyanPixels();

  // Picked through the real <input type=file>.
  const input = await page.$('#geo-import-input');
  await input.uploadFile(...FILES);
  const imported = await page
    .waitForFunction(() => window.__gevGeoImport.list().length === 4, {
      timeout: 60_000,
    })
    .then(
      () => true,
      () => false,
    );
  const after = await state();
  check(
    'four picked files become four rows and four data sources',
    imported &&
      after.rows === 4 &&
      after.dataSources === before.dataSources + 4,
    JSON.stringify(
      after.files.map((f) => `${f.name}:${f.format}:${f.entityCount}`),
    ),
  );
  check(
    'formats are recognized',
    after.files.map((f) => f.format).join() === 'geojson,kml,kmz,gpx',
  );
  check(
    'the KML and KMZ had their outside references removed',
    after.files[1].removed > 0 && after.files[2].removed > 0,
    `removed ${after.files[1].removed}/${after.files[2].removed}`,
  );
  check(
    'the hint says so',
    /Added 4 files\..*left out/.test(after.hint),
    after.hint,
  );
  await page.evaluate((view) => {
    const viewer = window.__godsEyeView.viewer;
    viewer.camera.cancelFlight?.();
    viewer.camera.setView({
      destination: window.__CESIUM__.Cartesian3.fromDegrees(
        view.lon,
        view.lat,
        view.height,
      ),
      orientation: { heading: 0, pitch: (view.pitch * Math.PI) / 180, roll: 0 },
    });
  }, VIEW);
  await wait(2500);
  const cyanShown = await cyanPixels();
  await shot('imported');
  check(
    'the imported polygon paints on the globe',
    cyanShown > cyanBefore * 4,
    `${cyanBefore} → ${cyanShown}`,
  );

  const parkId = after.files[0].id;
  await page.click(
    `#geo-import-list [data-import-id="${parkId}"] button[data-action="toggle"]`,
  );
  const cyanHidden = await cyanPixels();
  check(
    'hiding it stops it painting',
    cyanHidden < cyanShown / 3,
    `${cyanShown} → ${cyanHidden}`,
  );
  await page.click(
    `#geo-import-list [data-import-id="${parkId}"] button[data-action="toggle"]`,
  );
  check(
    'showing it again paints it again',
    (await cyanPixels()) > cyanHidden * 4,
  );

  // Dropped onto the globe, as a person drags from their file manager.
  await page.evaluate((text) => {
    const container = window.__godsEyeView.viewer.container;
    const transfer = new DataTransfer();
    transfer.items.add(
      new File([text], 'dropped.geojson', { type: 'application/geo+json' }),
    );
    for (const type of ['dragenter', 'dragover', 'drop'])
      container.dispatchEvent(
        new DragEvent(type, {
          dataTransfer: transfer,
          bubbles: true,
          cancelable: true,
        }),
      );
  }, geojson);
  const dropped = await page
    .waitForFunction(() => window.__gevGeoImport.list().length === 5, {
      timeout: 20_000,
    })
    .then(
      () => true,
      () => false,
    );
  check('a file dropped on the globe imports', dropped);

  // Not geodata: refused with a reason, nothing added.
  await page.evaluate(() => {
    const transfer = new DataTransfer();
    transfer.items.add(
      new File(['just some notes'], 'notes.txt', { type: 'text/plain' }),
    );
    window.__godsEyeView.viewer.container.dispatchEvent(
      new DragEvent('drop', {
        dataTransfer: transfer,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  await wait(800);
  const refused = await state();
  check(
    'a file that is not geodata is refused with a reason',
    refused.files.length === 5 &&
      /notes\.txt: Only GeoJSON, KML, KMZ and GPX/.test(refused.hint),
    refused.hint,
  );

  // Remove every file through its row button.
  for (const { id } of refused.files)
    await page.click(
      `#geo-import-list [data-import-id="${id}"] button[data-action="remove"]`,
    );
  const cleared = await state();
  check(
    'Remove gives every data source back',
    cleared.rows === 0 && cleared.dataSources === before.dataSources,
    `${cleared.dataSources} vs ${before.dataSources}`,
  );
  await wait(1500);
  check(
    'nothing named inside the KML/KMZ was ever requested',
    trapped.length === 0,
    trapped.join(' '),
  );
  check('no page errors', errors.length === 0, errors.join(' | '));
} catch (error) {
  check('harness ran to completion', false, error?.stack || String(error));
} finally {
  await browser.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
