#!/usr/bin/env node
import { waitForEngine } from './qa-strict-harness.mjs';
import { whenSettled } from './qa/ready.mjs';
// UTILITIES ▸ Import on Navara under the strict network policy: GeoJSON,
// KML, KMZ (a packed icon and a ground overlay) and GPX through the real
// file input, each one row; Navara draws their shapes in the row colour and
// their pins and packed ground overlay; unsupported content is counted
// in the hint; hide, fly-to and remove work on the engine; the files
// survive a switch to Cesium and back and draw on each engine. No file makes
// the page request anything it names (the strict policy fails any request
// outside the preview and the free tile cache).
//
//   node scripts/qa-navara-geo-import.mjs http://127.0.0.1:<PORT>/
import { assertKeylessPreview } from './qa-strict-harness.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { fromDegrees } from '../src/geo/cartesian3.js';
import { createStrict, localPreview } from './qa-strict-harness.mjs';

const VIEW = { lat: 37.7694, lon: -122.4862, alt: 4200 };
const base = localPreview(process.argv[2]);
base.search = '?engine=navara&welcome=0';
base.hash = `v=2&lat=${VIEW.lat}&lon=${VIEW.lon}&alt=${VIEW.alt}&heading=0&pitch=-90&roll=0&map=osm&l=`;
const strict = createStrict({ origin: base.origin, layers: ['geo-import'] });
const SHOTS = process.env.QA_SHOT_DIR || 'qa-shots/navara-geo-import';
fs.mkdirSync(SHOTS, { recursive: true });
const TRAP = 'gev-qa-trap.invalid';

/* ── fixtures (as scripts/qa-geo-import.mjs) ───────────────────────────── */
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
      properties: {
        name: 'QA park',
        description: `<img src="https://${TRAP}/props.png">`,
      },
      geometry: { type: 'Polygon', coordinates: [ring] },
    },
    {
      type: 'Feature',
      properties: { name: 'QA pin' },
      geometry: { type: 'Point', coordinates: [-122.4862, 37.7694] },
    },
  ],
});
const kml = (iconHref, overlay) => `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
<Document>
  <Style id="s"><IconStyle><Icon><href>${iconHref}</href></Icon></IconStyle></Style>
  <NetworkLink><Link><href>https://${TRAP}/link.kml</href></Link></NetworkLink>
  <Placemark><name>QA KML pin</name><styleUrl>#s</styleUrl>
    <description><![CDATA[<img src="https://${TRAP}/balloon.png">]]></description>
    <Point><coordinates>-122.47,37.77,0</coordinates></Point></Placemark>
  <Placemark><name>QA KML line</name>
    <LineString><coordinates>-122.50,37.766 -122.46,37.772</coordinates></LineString></Placemark>
  <GroundOverlay><Icon><href>${overlay}</href></Icon>
    <LatLonBox><north>37.77</north><south>37.76</south><east>-122.46</east><west>-122.47</west></LatLonBox></GroundOverlay>
</Document>
</kml>`;
const gpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="qa" xmlns="http://www.topografix.com/GPX/1/1">
  <wpt lat="37.769" lon="-122.49"><name>QA waypoint</name></wpt>
  <trk><name>QA track</name><trkseg>
    <trkpt lat="37.766" lon="-122.505"></trkpt><trkpt lat="37.768" lon="-122.49"></trkpt>
  </trkseg></trk>
</gpx>`;
// 8×8 opaque white PNG.
const PNG = await sharp({
  create: { width: 8, height: 8, channels: 4, background: '#ffffff' },
})
  .png()
  .toBuffer();
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
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gev-qa-navara-import-'));
const fixture = (name, data) => {
  const file = path.join(dir, name);
  fs.writeFileSync(file, data);
  return file;
};
const FILES = [
  fixture('park.geojson', geojson),
  fixture(
    'remote-bits.kml',
    kml(`https://${TRAP}/icon.png`, `https://${TRAP}/overlay.png`),
  ),
  fixture(
    'packed.kmz',
    storedZip([
      ['doc.kml', Buffer.from(kml('files/pin.png', 'files/overlay.png'))],
      ['files/pin.png', PNG],
      ['files/overlay.png', PNG],
    ]),
  ),
  fixture('walk.gpx', gpx),
];

await strict.run(
  {
    args: [
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
    ],
  },
  async (browser) => {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 860 });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(base.href);
    const ready = async (kind) => {
      await waitForEngine(page, kind);
      await page.waitForFunction(
        () => window.__gevGeoImport?.diagnostics().attached,
      );
      await page.evaluate(
        () => window.__godsEyeView.styleManager.initialRestorePromise,
      );
    };
    await ready('navara');
    await assertKeylessPreview(page);
    const state = () =>
      page.evaluate(() => ({
        files: window.__gevGeoImport.list(),
        diagnostics: window.__gevGeoImport.diagnostics(),
        rows: document.querySelectorAll('#geo-import-list .geo-import-row')
          .length,
        hint: document.getElementById('geo-import-hint')?.textContent || '',
        // Both engines draw imported pins through mover sets.
        pins: window.__godsEyeView.engine.movers
          .list()
          .filter(({ id }) => id.startsWith('geo-import-'))
          .reduce((n, set) => n + set.count, 0),
      }));
    /** Pixels near the first file's colour (#39d0ff) on the canvas. */
    const cyan = async () => {
      await page.evaluate(() => window.__godsEyeView.requestRender?.('qa'));
      await whenSettled(page);
      const { data, info } = await sharp(
        await page.screenshot({
          clip: { x: 400, y: 260, width: 480, height: 300 },
        }),
      )
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      let n = 0;
      for (let i = 0; i < data.length; i += info.channels) {
        const [r, g, b] = [data[i], data[i + 1], data[i + 2]];
        if (b > 120 && g > 90 && b - r > 50) n++;
      }
      return n;
    };
    const setAll = (visible) =>
      page.evaluate((v) => {
        for (const file of window.__gevGeoImport.list())
          window.__gevGeoImport.setVisible(file.id, v);
      }, visible);

    await page.evaluate(() => {
      const panel = document.getElementById('utilities-panel');
      if (panel?.classList.contains('collapsed'))
        document
          .querySelector(
            '.panel-collapse-btn[data-collapse-target="utilities-panel"]',
          )
          ?.click();
    });
    const input = await page.$('#geo-import-input');
    assert.ok(input, 'the Import file input');
    await input.uploadFile(...FILES);
    await page.waitForFunction(
      () =>
        window.__gevGeoImport.list().length === 4 &&
        !/Reading/.test(
          document.getElementById('geo-import-hint')?.textContent || '',
        ),
      { timeout: 90000 },
    );
    const imported = await state();
    console.log('navara import', JSON.stringify(imported));
    await strict.check(
      page,
      'geo-import',
      'GeoJSON, KML, KMZ and GPX each become one row and one drawing on Navara',
      imported.files.length === 4 &&
        imported.rows === 4 &&
        imported.diagnostics.drawn === 4,
      { files: imported.files.map((f) => f.format), rows: imported.rows },
    );
    // Packed overlays draw through imagery; remote overlays are removed on import.
    const undrawn = Object.fromEntries(
      imported.files.map((f) => [f.name, f.undrawn]),
    );
    await strict.check(
      page,
      'geo-import',
      'all supported geometry, including the packed overlay, draws on Navara',
      undrawn['packed.kmz'] === 0 &&
        undrawn['park.geojson'] === 0 &&
        undrawn['remote-bits.kml'] === 0 &&
        undrawn['walk.gpx'] === 0,
      { undrawn, hint: imported.hint },
    );
    await strict.check(
      page,
      'geo-import',
      'the files’ pins are drawn as Navara sprites',
      imported.pins >= 4,
      { pins: imported.pins },
    );
    // The first file is flown to after the batch; settle there.
    await whenSettled(page);
    await page.screenshot({ path: `${SHOTS}/navara-imported.png` });

    for (const kind of ['navara', 'cesium', 'navara']) {
      if (
        (await page.evaluate(() => window.__godsEyeView.engine.kind)) !== kind
      ) {
        await strict.pick(page, kind);
        await ready(kind);
        await page.waitForFunction(
          () => window.__gevGeoImport.diagnostics().drawn === 4,
          { timeout: 60000 },
        );
        await whenSettled(page);
        await page.screenshot({ path: `${SHOTS}/${kind}-after-switch.png` });
      }
      const shown = await cyan();
      await setAll(false);
      const hidden = await cyan();
      await setAll(true);
      console.log(kind, 'cyan', { shown, hidden });
      await strict.check(
        page,
        'geo-import',
        'the imported shapes paint the first file’s colour and stop when hidden',
        shown - hidden > 1500,
        { shown, hidden },
      );
      const kept = await state();
      await strict.check(
        page,
        'geo-import',
        'the same four files are listed and drawn on this engine',
        kept.files.length === 4 && kept.diagnostics.drawn === 4,
        kept.diagnostics,
      );
    }
    // Fly-to on Navara goes through the engine camera.
    const flight = await page.evaluate(
      async (destination) => {
        const { engine } = window.__godsEyeView;
        engine.camera.setView({ destination });
        const before = engine.camera.height();
        const [first] = window.__gevGeoImport.list();
        const ok = window.__gevGeoImport.flyTo(first.id);
        return { ok, before };
      },
      fromDegrees(-100, 40, 3e6),
    );
    await whenSettled(page);
    flight.after = await page.evaluate(() =>
      window.__godsEyeView.engine.camera.height(),
    );
    await strict.check(
      page,
      'geo-import',
      'Fly to a file moves the Navara camera onto it',
      flight.ok && flight.after < flight.before / 2,
      flight,
    );
    // Remove gives the drawing back.
    await page.evaluate(() => {
      for (const file of window.__gevGeoImport.list())
        window.__gevGeoImport.remove(file.id);
    });
    const removed = await state();
    await strict.check(
      page,
      'geo-import',
      'Remove takes every file and its pins off Navara',
      removed.files.length === 0 && removed.rows === 0 && removed.pins === 0,
      { files: removed.files.length, pins: removed.pins },
    );
    assert.deepEqual(errors, []);
    console.log('PASS Navara import of GeoJSON, KML, KMZ and GPX');
  },
);
