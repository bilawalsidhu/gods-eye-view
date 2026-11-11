#!/usr/bin/env node
// Cesium-only probes: imagery, terrain and the native timeline validate Cesium import integration.
/**
 * Rendered acceptance for UTILITIES ▸ Import: real files through the real file
 * input and a real drop, drawn through the globe contract.
 *
 * Proves: GeoJSON, KML, KMZ (with a packed icon and ground overlay) and GPX
 * each become one row and owned drawing sets; the imported shape actually paints
 * on the globe in its row's color (a GeoJSON `stroke`/`fill` does not override
 * it) and stops painting when hidden; no import makes the page request
 * anything named in it (network link, remote icon, remote style, palette
 * icon, balloon or extended-data HTML, maki marker) or anything outside the
 * page for it; no drawing keeps a description, label or properties; dated KML
 * and GPX leave the app's clock alone and still draw now; a GPX track keeps
 * its two segments apart; keyboard focus survives hide/show; a dropped file
 * imports like a picked one; a file that is not geodata is refused with a
 * reason and leaves nothing behind; Remove releases every drawing set; no
 * page errors.
 *
 * Usage: dev server up (`npm run dev`), then `node scripts/qa-geo-import.mjs`.
 * QA_BASE_URL (default http://localhost:4173), QA_SHOT_DIR, QA_HEADFUL=1.
 */
import { whenSettled } from './qa/ready.mjs';
import { launchBrowser, closeBrowser } from './qa/browser.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installImportProbe } from './qa-geo-import-probe.mjs';
import { hookRenderErrors, readRenderErrors } from './qa-browserEvidence.mjs';

const BASE_URL =
  process.argv.find((arg) => /^https?:/.test(arg)) ||
  process.env.QA_BASE_URL ||
  'http://localhost:4173';
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
      // A file's own simplestyle and HTML must not survive the import.
      properties: {
        name: 'QA park',
        stroke: '#ff0000',
        fill: '#ff0000',
        'fill-opacity': 1,
        description: `<img src="https://${TRAP_HOST}/props.png">`,
      },
      geometry: { type: 'Polygon', coordinates: [ring.map((p) => [...p, 0])] },
    },
    {
      type: 'Feature',
      properties: { name: 'QA pin', 'marker-symbol': 'rail' },
      geometry: { type: 'Point', coordinates: [-122.4862, 37.7694, 0] },
    },
  ],
});
const kml = (iconHref) => `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:gx="http://www.google.com/kml/ext/2.2">
<Document>
  <Style id="s"><IconStyle><Icon><href>${iconHref}</href></Icon></IconStyle></Style>
  <Style id="palette"><IconStyle><Icon><href>root://icons/palette-4.png</href><gx:x>32</gx:x><gx:y>64</gx:y></Icon></IconStyle></Style>
  <NetworkLink><Link><href>https://${TRAP_HOST}/link.kml</href></Link></NetworkLink>
  <Placemark><name>QA KML pin</name><styleUrl>#s</styleUrl>
    <description><![CDATA[<img src="https://${TRAP_HOST}/balloon.png">]]></description>
    <TimeSpan><begin>2019-01-01T00:00:00Z</begin><end>2019-01-02T00:00:00Z</end></TimeSpan>
    <ExtendedData><Data name="note"><value><![CDATA[<iframe src="https://${TRAP_HOST}/extended.html"></iframe>]]></value></Data></ExtendedData>
    <Point><coordinates>-122.47,37.77,0</coordinates></Point></Placemark>
  <Placemark><name>QA palette pin</name><styleUrl>#palette</styleUrl>
    <Point><coordinates>-122.48,37.771,0</coordinates></Point></Placemark>
  <Placemark><name>QA moving</name>
    <gx:Track><when>2019-01-01T00:00:00Z</when><when>2019-01-01T01:00:00Z</when>
      <gx:coord>-122.49 37.767 0</gx:coord><gx:coord>-122.475 37.772 0</gx:coord></gx:Track></Placemark>
  <Placemark><name>QA split tracks</name><gx:MultiTrack>
    <gx:Track><gx:coord>-122.50 37.767 0</gx:coord><gx:coord>-122.49 37.768 0</gx:coord></gx:Track>
    <gx:Track><gx:coord>-122.47 37.771 0</gx:coord><gx:coord>-122.46 37.772 0</gx:coord></gx:Track>
  </gx:MultiTrack></Placemark>
  <Placemark><name>QA remote style</name><styleUrl>https://${TRAP_HOST}/styles.kml#x</styleUrl>
    <LineString><coordinates>-122.50,37.766 -122.46,37.772</coordinates></LineString></Placemark>
  <GroundOverlay><Icon><href>https://${TRAP_HOST}/overlay.png</href></Icon>
    <LatLonBox><north>37.77</north><south>37.76</south><east>-122.46</east><west>-122.47</west></LatLonBox></GroundOverlay>
</Document>
</kml>`;
const gpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="qa" xmlns="http://www.topografix.com/GPX/1/1">
  <wpt lat="37.769" lon="-122.49"><name>QA waypoint</name></wpt>
  <trk><name>QA track</name><desc>&lt;img src="https://${TRAP_HOST}/gpx.png"&gt;</desc><trkseg>
    <trkpt lat="37.766" lon="-122.505"><time>2018-06-01T10:00:00Z</time></trkpt><trkpt lat="37.768" lon="-122.49"><time>2018-06-01T10:05:00Z</time></trkpt>
  </trkseg><trkseg>
    <trkpt lat="37.770" lon="-122.48"><time>2018-06-01T11:00:00Z</time></trkpt><trkpt lat="37.772" lon="-122.47"><time>2018-06-01T11:05:00Z</time></trkpt>
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

const browser = await launchBrowser({
  headless: true,
  args: [
    '--no-sandbox',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    ...(process.platform === 'darwin' ? ['--enable-gpu'] : []),
  ],
});
const page = await browser.newPage();
await hookRenderErrors(page);
const errors = [];
const trapped = [];
page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
page.on('console', (message) => {
  if (/Ignoring clampToGround/.test(message.text()))
    errors.push(message.text());
});
// Anything a file names, and the icon assets Cesium would load on a file's
// behalf (KML palette icons from maps.google.com, GeoJSON maki markers).
const FILE_FETCH = [TRAP_HOST, 'maps.google.com/mapfiles', '/maki/'];
page.on('request', (request) => {
  if (FILE_FETCH.some((needle) => request.url().includes(needle)))
    trapped.push(request.url());
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
  await page.evaluate(() => window.__godsEyeView.engine.render.request());
  await whenSettled(page);
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
      if (b > 45 && g > 30 && r < 100 && b - r > 30) n += 1;
    }
    return n;
  }, base64);
}
const state = () =>
  page.evaluate(() => ({
    files: window.__gevGeoImport.list(),
    drawing: window.__qaImports.list(),
    groups: window.__qaImports.groups().length,
    rows: document.querySelectorAll('#geo-import-list .geo-import-row').length,
    hint: document.getElementById('geo-import-hint')?.textContent || '',
  }));

try {
  await page.setViewport({ width: 1280, height: 860 });
  await page.goto(`${BASE_URL}/?welcome=0`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => window.__gevGeoImport && window.__godsEyeView?.engine,
    { timeout: 90_000 },
  );
  await whenSettled(page);
  await page.evaluate(async (view) => {
    const viewer = window.__godsEyeView.viewer;
    for (const id of window.__godsEyeView.dataManager.layers.keys())
      await window.__godsEyeView.dataManager.setEnabled(id, false);
    viewer.imageryLayers.removeAll();
    viewer.terrainProvider = new window.__CESIUM__.EllipsoidTerrainProvider();
    viewer.scene.globe.baseColor = window.__CESIUM__.Color.BLACK;
    viewer.scene.globe.enableLighting = false;
    window.__godsEyeView.engine.camera.cancelFlight?.();
    window.__godsEyeView.engine.camera.setView({
      destination: window.__CESIUM__.Cartesian3.fromDegrees(
        view.lon,
        view.lat,
        view.height,
      ),
      orientation: { heading: 0, pitch: (view.pitch * Math.PI) / 180, roll: 0 },
    });
    window.__godsEyeView.engine.render.request();
  }, VIEW);
  await whenSettled(page);
  await page.evaluate(() => {
    const panel = document.getElementById('utilities-panel');
    if (panel?.classList.contains('collapsed'))
      document
        .querySelector(
          '.panel-collapse-btn[data-collapse-target="utilities-panel"]',
        )
        ?.click();
  });
  await page.waitForFunction(
    () =>
      document.getElementById('geo-import-button')?.getBoundingClientRect()
        .width > 0,
    { timeout: 10_000 },
  );
  await installImportProbe(page);
  const before = await state();
  check(
    'Import is in the UTILITIES panel with an empty, hidden list',
    before.rows === 0 &&
      !(await page.evaluate(() =>
        document
          .getElementById('geo-import-list')
          .classList.contains('visible'),
      )),
  );
  const cyanBefore = await cyanPixels();
  await page.evaluate(() => {
    window.__godsEyeView.viewer.clock.shouldAnimate = false;
  });
  const clock = () =>
    page.evaluate(() => {
      const c = window.__godsEyeView.viewer.clock;
      const iso = (t) => window.__CESIUM__.JulianDate.toIso8601(t, 0);
      return {
        start: iso(c.startTime),
        stop: iso(c.stopTime),
        range: c.clockRange,
        step: c.clockStep,
        multiplier: c.multiplier,
        animate: c.shouldAnimate,
        // Wall-clock drift aside, the current time must not jump to 2018/2019.
        currentTime: window.__CESIUM__.JulianDate.toIso8601(c.currentTime),
      };
    });
  const clockBefore = await clock();

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
    'four picked files become four rows and four groups of drawing sets',
    imported && after.rows === 4 && after.groups === before.groups + 4,
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
  const clockAfter = await clock();
  check(
    "dated KML and GPX leave the app's clock alone",
    JSON.stringify(clockAfter) === JSON.stringify(clockBefore) &&
      (await page.evaluate(
        () =>
          window.__godsEyeView.viewer.clockTrackedDataSource?.clock ===
          undefined,
      )),
    `${JSON.stringify(clockBefore)} → ${JSON.stringify(clockAfter)}`,
  );
  // Over the files: their pins on the ground show unless beyond the
  // horizon, so all of them show here.
  await page.evaluate((view) => {
    window.__godsEyeView.engine.camera.cancelFlight?.();
    window.__godsEyeView.engine.camera.setView({
      destination: window.__CESIUM__.Cartesian3.fromDegrees(
        view.lon,
        view.lat,
        view.height,
      ),
      orientation: { heading: 0, pitch: (view.pitch * Math.PI) / 180, roll: 0 },
    });
  }, VIEW);
  await whenSettled(page);
  const inside = await page.evaluate(() => {
    const groups = window.__qaImports.groups();
    const pins = (group) =>
      group.filter((r) => r.kind === 'movers').flatMap((r) => r.items);
    const paths = (group) =>
      group
        .filter((r) => r.kind === 'ground' && r.options.kind === 'corridor')
        .flatMap((r) => r.items);
    const kml = groups[1],
      kmz = groups[2],
      gpx = groups[3];
    const drawings = groups.flat().flatMap((r) => [r.options, ...r.items]);
    return {
      groups: groups.length,
      metadata: drawings.some((r) =>
        [
          'description',
          'label',
          'properties',
          'kml',
          'availability',
          'clock',
        ].some((key) => key in r),
      ),
      fallbackPins: pins(kml).length,
      datedPinsShown:
        pins(kml).length > 0 && pins(kml).every((pin) => pin.show),
      kmlVertices: paths(kml).map((line) => line.positions.length),
      gpxLines: paths(gpx).length,
      gpxPoints: pins(gpx).length,
      kmzPins: pins(kmz).length,
      kmzOverlay: kmz.some(
        (r) => r.kind === 'imagery' && r.options.source.url.startsWith('blob:'),
      ),
      groundedLines: [kml, kmz].every(
        (group) =>
          paths(group).length === 4 && !group.some((r) => r.kind === 'lines'),
      ),
      xyzPolygon: groups[0].some(
        (r) =>
          r.kind === 'ground' &&
          r.options.kind === 'polygon' &&
          r.items[0].rings.flat().every((p) => p.length === 2),
      ),
    };
  });
  check(
    'import drawing contains no descriptions, labels, properties or time data',
    inside.groups === 4 && !inside.metadata,
    JSON.stringify(inside),
  );
  check(
    'dated KML pins draw now and its moving track is a two-vertex line',
    inside.datedPinsShown && inside.kmlVertices[0] === 2,
    JSON.stringify(inside),
  );
  check(
    'blocked KML icons use drawable local fallback pins',
    inside.fallbackPins === 2,
    JSON.stringify(inside),
  );
  check(
    'KML MultiTrack keeps its segments and original vertex count',
    inside.kmlVertices.slice(1, 3).join() === '2,2',
    JSON.stringify(inside),
  );
  check(
    'the GPX track keeps its two segments apart',
    inside.gpxLines === 2 && inside.gpxPoints === 1,
    JSON.stringify(inside),
  );
  check(
    'KMZ retains its packed pin and imagery overlay',
    inside.kmzPins === 2 && inside.kmzOverlay && after.files[2].undrawn === 0,
  );
  check(
    'XYZ polygons and KML/KMZ lines use ground geometry',
    inside.xyzPolygon && inside.groundedLines,
  );
  const cyanShown = await cyanPixels();
  await shot('imported');
  check(
    'the imported polygon paints on the globe',
    cyanShown > cyanBefore * 4 && cyanShown > cyanBefore + 5000,
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

  // Keyboard: focus stays on the same control when the list is rebuilt.
  const toggleSelector = `#geo-import-list [data-import-id="${parkId}"] button[data-action="toggle"]`;
  await page.focus(toggleSelector);
  await page.keyboard.press('Enter');
  const focusAfterHide = await page.evaluate(
    (sel) => document.activeElement === document.querySelector(sel),
    toggleSelector,
  );
  await page.keyboard.press('Enter');
  const focusAfterShow = await page.evaluate(
    (sel) =>
      document.activeElement === document.querySelector(sel) &&
      document.activeElement.getAttribute('aria-pressed') === 'true',
    toggleSelector,
  );
  check(
    'keyboard focus stays on the toggle through hide and show',
    focusAfterHide && focusAfterShow,
  );

  // Dropped onto the globe, as a person drags from their file manager.
  await page.evaluate((text) => {
    const container = window.__godsEyeView.engine.host.container;
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
    window.__godsEyeView.engine.host.container.dispatchEvent(
      new DragEvent('drop', {
        dataTransfer: transfer,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  await whenSettled(page);
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
    'Remove releases every import drawing set',
    cleared.rows === 0 &&
      Object.values(cleared.drawing).every((list) => list.length === 0),
    JSON.stringify(cleared.drawing),
  );
  await wait(1500);
  check(
    'nothing named inside a file, and no icon asset for one, was ever requested',
    trapped.length === 0,
    trapped.join(' '),
  );
  errors.push(...(await readRenderErrors(page)));
  check('no page or rendering errors', errors.length === 0, errors.join(' | '));
} catch (error) {
  check('harness ran to completion', false, error?.stack || String(error));
} finally {
  await closeBrowser(browser);
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
