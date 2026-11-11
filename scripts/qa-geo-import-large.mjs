#!/usr/bin/env node
// Cesium-only probes: KML DataSources, imagery and the Julian clock form the Cesium reference oracle.
/** Large KML acceptance: style equivalence, 27.6 MB import and optional real file.
 * QA_BASE_URL defaults to http://localhost:4173. Optional --file /path/file.kml.
 * For a USGS fixture with blocked icons, add --expect-local-pins to check paint.
 */
import { whenSettled } from './qa/ready.mjs';
import { launchBrowser, closeBrowser } from './qa/browser.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installImportProbe } from './qa-geo-import-probe.mjs';
import { hookRenderErrors, readRenderErrors } from './qa-browserEvidence.mjs';

const base =
  process.argv.find((arg) => /^https?:/.test(arg)) ||
  process.env.QA_BASE_URL ||
  'http://localhost:4173';
const supplied = process.argv.includes('--file')
  ? path.resolve(process.argv[process.argv.indexOf('--file') + 1])
  : null;
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gev-large-kml-'));
const file = path.join(directory, 'metadata-rich-27mb.kml');
const style =
  '<Style><IconStyle><scale>0.6</scale><color>ff00dd66</color></IconStyle></Style>';
const notes = 'A local observation with supporting detail. '.repeat(120);
const placemarks = Array.from({ length: 5000 }, (_, i) => {
  const lon = -122.6 + (i % 100) * 0.002;
  const lat = 37.65 + Math.floor(i / 100) * 0.003;
  return `<Placemark><name>Point ${i}</name><styleUrl>#base</styleUrl>${style}<description>${notes}</description><Point><coordinates>${lon},${lat},0</coordinates></Point></Placemark>`;
});
const wrap = (body) =>
  `<kml xmlns="http://www.opengis.net/kml/2.2"><Document><Style id="base"><IconStyle><heading>25</heading><scale>1.2</scale></IconStyle><LineStyle><color>ffdd6600</color><width>7</width></LineStyle><PolyStyle><color>6600ddff</color><fill>1</fill><outline>0</outline></PolyStyle></Style>${body}</Document></kml>`;
const large = wrap(placemarks.join(''));
fs.writeFileSync(file, large);
const bytes = fs.statSync(file).size;
if (bytes < 20 * 1024 * 1024 || bytes > 30 * 1024 * 1024)
  throw new Error(`Fixture must be 20–30 MiB, got ${bytes} bytes`);
const small = wrap(
  Array.from({ length: 6 }, (_, i) => {
    const kind = i % 3;
    const geometry =
      kind === 0
        ? '<Point><coordinates>-122.49,37.77,0</coordinates></Point>'
        : kind === 1
          ? '<LineString><coordinates>-122.50,37.77,0 -122.49,37.77,0</coordinates></LineString>'
          : '<Polygon><outerBoundaryIs><LinearRing><coordinates>-122.50,37.77,0 -122.49,37.77,0 -122.49,37.78,0 -122.50,37.77,0</coordinates></LinearRing></outerBoundaryIs></Polygon>';
    const override =
      kind === 0
        ? style
        : kind === 1
          ? '<Style><LineStyle><width>3</width></LineStyle></Style>'
          : '<Style><PolyStyle><outline>1</outline></PolyStyle></Style>';
    return `<Placemark><name>Small ${i}</name><styleUrl>#base</styleUrl>${override}${geometry}</Placemark>`;
  }).join('') +
    '<Style id="named-a"><IconStyle><scale>0.8</scale></IconStyle></Style>' +
    '<Style id="named-b"><IconStyle><scale>0.8</scale></IconStyle></Style>' +
    '<StyleMap id="paired"><Pair><key>normal</key><Style><IconStyle><scale>0.8</scale></IconStyle></Style></Pair></StyleMap>' +
    ['named-a', 'named-b', 'paired']
      .map(
        (id) =>
          `<Placemark><name>${id}</name><styleUrl>#${id}</styleUrl><Point><coordinates>-122.49,37.77,0</coordinates></Point></Placemark>`,
      )
      .join(''),
);
const browser = await launchBrowser({
  headless: true,
  args: process.platform === 'darwin' ? [] : ['--no-sandbox'],
});
const page = await browser.newPage();
await hookRenderErrors(page);
const errors = [];
const fileRequests = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.setRequestInterception(true);
page.on('request', (request) => {
  if (new URL(request.url()).hostname === 'earthquake.usgs.gov') {
    fileRequests.push(request.url());
    void request.abort();
  } else void request.continue();
});
let failures = 0;
const check = (name, ok, detail) => {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}`, detail ?? '');
  if (!ok) failures++;
};
try {
  await page.setViewport({ width: 1440, height: 900 });
  await page.goto(`${base}/?welcome=0`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__gevGeoImport, { timeout: 60000 });
  await whenSettled(page);
  await installImportProbe(page);
  await page.evaluate(async () => {
    const { viewer, dataManager } = window.__godsEyeView;
    const C = window.__CESIUM__;
    for (const id of dataManager.layers.keys())
      await dataManager.setEnabled(id, false);
    viewer.clock.shouldAnimate = false;
    viewer.imageryLayers.removeAll();
    viewer.terrainProvider = new C.EllipsoidTerrainProvider();
    window.__godsEyeView.engine.camera.cancelFlight();
    window.__godsEyeView.engine.camera.setView({
      destination: C.Cartesian3.fromDegrees(-122.5, 37.72, 50000),
      orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
    });
    const rgba = (color) => [color.red, color.green, color.blue, color.alpha];
    const xyz = (p) => [p.x, p.y, p.z];
    const lonLat = (p) => {
      const c = C.Cartographic.fromCartesian(p);
      return [C.Math.toDegrees(c.longitude), C.Math.toDegrees(c.latitude)];
    };
    const canonical = (rows) =>
      rows
        .map((row) =>
          JSON.stringify(row, (_, value) =>
            typeof value === 'number'
              ? Math.round(value * 1e5) / 1e5 + 0
              : value,
          ),
        )
        .sort();
    window.__qaStyleSnapshot = (source) => {
      const now = viewer.clock.currentTime;
      const value = (property) => property?.getValue(now);
      const rows = [];
      for (const e of source.entities.values) {
        if (e.billboard && e.position) {
          const b = e.billboard,
            image = value(b.image);
          const scale = value(b.scale) ?? 1;
          const width = (value(b.width) ?? image.width) * scale;
          const height = (value(b.height) ?? image.height) * scale;
          const offset = value(b.pixelOffset) ?? { x: 0, y: 0 };
          const centerY =
            offset.y -
            (value(b.verticalOrigin) === C.VerticalOrigin.BOTTOM
              ? height / 2
              : 0);
          // A clamped billboard keeps its file height and Cesium clamps it
          // while drawing; the import draws its pins at the sampled ground.
          // Both compare by longitude and latitude.
          const clamped =
            (value(b.heightReference) ?? C.HeightReference.NONE) !==
            C.HeightReference.NONE;
          rows.push({
            kind: 'pin',
            position: (clamped ? lonLat : xyz)(value(e.position)),
            size:
              2 *
              Math.max(
                Math.abs(offset.x) + width / 2,
                Math.abs(centerY) + height / 2,
                0.5,
              ),
            rotation: value(b.rotation) ?? 0,
            color: rgba(value(b.color) ?? C.Color.WHITE),
            image: Boolean(image),
          });
        }
        if (e.polyline)
          rows.push({
            kind: 'line',
            positions: value(e.polyline.positions).map(lonLat),
            width: value(e.polyline.width),
            color: rgba(value(e.polyline.material.color)),
          });
        if (e.polygon && value(e.polygon.fill) !== false) {
          const hierarchy = value(e.polygon.hierarchy);
          rows.push({
            kind: 'polygon',
            rings: [
              hierarchy.positions,
              ...hierarchy.holes.map((hole) => hole.positions),
            ].map((ring) => ring.map(lonLat)),
            fill: rgba(value(e.polygon.material.color)),
          });
        }
      }
      return canonical(rows);
    };
    window.__qaDrawnSnapshot = () => {
      const rows = [];
      for (const r of window.__qaImports.records()) {
        if (r.kind === 'movers')
          for (const item of r.items)
            rows.push({
              kind: 'pin',
              position: (r.options.depthTest === 'always' ? lonLat : xyz)(
                item.position,
              ),
              size: r.options.sprite.sizePx,
              rotation: item.rotation,
              color: item.color,
              image: r.options.sprite.atlas.canvas.width > 0,
            });
        if (r.kind === 'ground')
          for (const item of r.items)
            rows.push(
              r.options.kind === 'corridor'
                ? {
                    kind: 'line',
                    positions: item.positions,
                    width: item.widthPx,
                    color: item.color,
                  }
                : { kind: 'polygon', rings: item.rings, fill: item.fill },
            );
      }
      return canonical(rows);
    };
    window.__qaUnsharedKml = async (text) => {
      const doc = new DOMParser().parseFromString(text, 'application/xml');
      for (const el of [...doc.getElementsByTagName('*')])
        if (
          ['description', 'ExtendedData', 'BalloonStyle'].includes(el.localName)
        )
          el.remove();
      const source = await C.KmlDataSource.load(doc, {
        camera: viewer.scene.camera,
        canvas: window.__godsEyeView.engine.host.canvas,
        clampToGround: true,
      });
      for (const e of source.importedEntities || source.entities.values)
        e.label = undefined;
      return source;
    };
  });
  const equivalent = await page.evaluate(async (text) => {
    const control = await window.__qaUnsharedKml(text);
    const outcomes = await window.__gevGeoImport.importFiles([
      new File([text], 'style-equivalence.kml'),
    ]);
    const candidate = window.__gevGeoImport
      .list()
      .find((file) => file.id === outcomes[0]?.id);
    const result = {
      ok: outcomes[0]?.ok,
      same:
        JSON.stringify(window.__qaStyleSnapshot(control)) ===
        JSON.stringify(window.__qaDrawnSnapshot()),
      entities: candidate?.entityCount,
    };
    await window.__gevGeoImport.remove(outcomes[0]?.id);
    return result;
  }, small);
  check(
    'shared inline and named styles preserve point, line and polygon overrides/inheritance',
    equivalent.ok && equivalent.same && equivalent.entities === 9,
    JSON.stringify(equivalent),
  );

  // The control bypasses the former style-count refusal solely in this test,
  // to compare native unshared rendering against normalized rendering.
  await page.evaluate(async (text) => {
    const source = await window.__qaUnsharedKml(text);
    window.__qaUnsharedSnapshot = JSON.stringify(
      window.__qaStyleSnapshot(source),
    );
    window.__qaControl = source;
    await window.__godsEyeView.viewer.dataSources.add(source);
  }, large);
  const measure = async () =>
    page.evaluate(async () => {
      const C = window.__CESIUM__,
        { viewer } = window.__godsEyeView;
      window.__godsEyeView.engine.camera.cancelFlight();
      window.__godsEyeView.engine.camera.setView({
        destination: C.Cartesian3.fromDegrees(-122.5, 37.72, 50000),
        orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
      });
      const started = performance.now(),
        samples = [];
      let last,
        frames = 0;
      const remove =
        window.__godsEyeView.engine.frames.postRender.addEventListener(() => {
          const t = performance.now();
          if (t - started < 2000) return;
          frames++;
          if (last !== undefined) samples.push(t - last);
          last = t;
        });
      await new Promise((resolve) => {
        let previous = performance.now();
        function tick(t) {
          viewer.camera.rotate(
            C.Cartesian3.UNIT_Z,
            Math.min(t - previous, 100) * 0.0000002,
          );
          previous = t;
          window.__godsEyeView.engine.render.request();
          if (t - started < 7000) requestAnimationFrame(tick);
          else resolve();
        }
        requestAnimationFrame(tick);
      });
      remove();
      samples.sort((a, b) => a - b);
      const gl = window.__godsEyeView.engine.host.canvas.getContext('webgl2'),
        debug = gl.getExtension('WEBGL_debug_renderer_info');
      return {
        fps: frames / 5,
        p50Ms: samples[Math.floor(samples.length * 0.5)],
        p95Ms: samples[Math.floor(samples.length * 0.95)],
        renderer: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : null,
      };
    });
  console.log('UNSHARED CONTROL', JSON.stringify(await measure()));
  await page.evaluate(() =>
    window.__godsEyeView.viewer.dataSources.remove(window.__qaControl, true),
  );

  const loadPicked = async (filename, expected) => {
    const before = await page.evaluate(
      () => window.__qaImports.groups().length,
    );
    const priorIds = await page.evaluate(() =>
      window.__gevGeoImport.list().map((f) => f.id),
    );
    const started = performance.now();
    await (await page.$('#geo-import-input')).uploadFile(filename);
    const name = path.basename(filename);
    const loaded = await page
      .waitForFunction(
        ({ name, priorIds }) =>
          window.__gevGeoImport.list().some((f) => !priorIds.includes(f.id)) ||
          document
            .getElementById('geo-import-hint')
            .textContent.startsWith(`${name}:`),
        { timeout: 120000 },
        { name, priorIds },
      )
      .then(
        () => true,
        () => false,
      );
    const state = await page.evaluate(() => ({
      files: window.__gevGeoImport.list(),
      hint: document.getElementById('geo-import-hint').textContent,
      groups: window.__qaImports.groups().length,
    }));
    const item = state.files.find((f) => !priorIds.includes(f.id));
    check(
      `picked ${name} loads`,
      loaded &&
        (expected === null
          ? item?.entityCount > 0
          : item?.entityCount === expected) &&
        state.groups === before + 1,
      JSON.stringify({
        bytes: fs.statSync(filename).size,
        loadMs: Math.round(performance.now() - started),
        ...state,
      }),
    );
    return item;
  };
  const item = await loadPicked(file, 5000);
  if (item) {
    const same = await page.evaluate(() => {
      return (
        JSON.stringify(window.__qaDrawnSnapshot()) ===
        window.__qaUnsharedSnapshot
      );
    });
    check('all 5,000 normalized graphics match their unshared control', same);
    console.log('NORMALIZED CANDIDATE', JSON.stringify(await measure()));
    await page.evaluate((id) => window.__gevGeoImport.remove(id), item.id);
  }
  if (supplied) {
    const clockBefore = await page.evaluate(() => {
      const v = window.__godsEyeView.viewer,
        C = window.__CESIUM__;
      return [
        C.JulianDate.toIso8601(v.clock.startTime),
        C.JulianDate.toIso8601(v.clock.stopTime),
        C.JulianDate.toIso8601(v.clock.currentTime),
        v.clock.multiplier,
      ];
    });
    const suppliedItem = await loadPicked(supplied, null);
    const clockAfter = await page.evaluate(() => {
      const v = window.__godsEyeView.viewer,
        C = window.__CESIUM__;
      return [
        C.JulianDate.toIso8601(v.clock.startTime),
        C.JulianDate.toIso8601(v.clock.stopTime),
        C.JulianDate.toIso8601(v.clock.currentTime),
        v.clock.multiplier,
      ];
    });
    check(
      'real dated KML leaves the shared clock unchanged',
      JSON.stringify(clockBefore) === JSON.stringify(clockAfter),
    );
    if (suppliedItem && process.argv.includes('--expect-local-pins')) {
      const markers = await page.evaluate(() => {
        const C = window.__CESIUM__;
        const sets = window.__qaImports
          .records()
          .filter((record) => record.kind === 'movers');
        const points = sets.flatMap((record) => record.items);
        const images = sets
          .filter((record) => record.options.sprite.atlas.canvas.width > 0)
          .flatMap((record) => record.items);
        if (images.length) {
          const at = C.Cartographic.fromCartesian(images[0].position);
          window.__godsEyeView.engine.camera.cancelFlight();
          window.__godsEyeView.engine.camera.setView({
            destination: C.Cartesian3.fromRadians(
              at.longitude,
              at.latitude,
              100000,
            ),
            orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
          });
        }
        return { points: points.length, images: images.length };
      });
      check(
        'supplied point markers have drawable images',
        markers.points > 0 && markers.images === markers.points,
        JSON.stringify(markers),
      );
      if (markers.points) {
        const yellowPixels = async () => {
          const shot = await page.screenshot({
            clip: { x: 620, y: 350, width: 200, height: 200 },
            type: 'png',
            encoding: 'base64',
          });
          return page.evaluate(async (base64) => {
            const bitmap = await createImageBitmap(
              await (await fetch(`data:image/png;base64,${base64}`)).blob(),
            );
            const canvas = new OffscreenCanvas(bitmap.width, bitmap.height),
              context = canvas.getContext('2d');
            context.drawImage(bitmap, 0, 0);
            const data = context.getImageData(
              0,
              0,
              bitmap.width,
              bitmap.height,
            ).data;
            let count = 0;
            for (let i = 0; i < data.length; i += 4)
              if (data[i] > 150 && data[i + 1] > 150 && data[i + 2] < 100)
                count++;
            return count;
          }, shot);
        };
        const setVisible = (visible) =>
          page.evaluate(
            ({ id, visible }) => window.__gevGeoImport.setVisible(id, visible),
            { id: suppliedItem.id, visible },
          );
        await setVisible(false);
        await whenSettled(page);
        const hidden = await yellowPixels();
        await setVisible(true);
        let shown = hidden;
        const deadline = performance.now() + 10000;
        while (performance.now() < deadline && shown <= hidden + 10) {
          await new Promise((resolve) => setTimeout(resolve, 500));
          shown = await yellowPixels();
        }
        check(
          'real USGS markers paint when shown and disappear when hidden',
          shown > hidden + 10,
          JSON.stringify({ hidden, shown }),
        );
        await page.screenshot({
          path: path.join(directory, 'real-kml-visible.png'),
        });
      }
    }
    if (suppliedItem)
      await page.evaluate(
        (id) => window.__gevGeoImport.remove(id),
        suppliedItem.id,
      );
  }
  check(
    'file-directed USGS icon/metadata requests never leave the page',
    fileRequests.length === 0,
    fileRequests.length,
  );
  errors.push(...(await readRenderErrors(page)));
  check(
    'no uncaught page or render errors',
    errors.length === 0,
    JSON.stringify(errors),
  );
  check(
    'all imported files and drawing sets are removed',
    await page.evaluate(
      () =>
        window.__gevGeoImport.list().length === 0 &&
        Object.values(window.__qaImports.list()).every(
          (list) => list.length === 0,
        ),
    ),
  );
  console.log('Fixture retained at', file);
} finally {
  await closeBrowser(browser);
}
process.exitCode = failures ? 1 : 0;
