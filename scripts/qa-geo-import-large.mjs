#!/usr/bin/env node
/** Large KML acceptance: style equivalence, 27.6 MB import and optional real file.
 * QA_BASE_URL defaults to http://localhost:4173. Optional --file /path/file.kml.
 * For a USGS fixture with blocked icons, add --expect-local-pins to check paint.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { hookRenderErrors, readRenderErrors } from './qa-browserEvidence.mjs';

const base = process.env.QA_BASE_URL || 'http://localhost:4173';
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
const browser = await puppeteer.launch({
  headless: true,
  args:
    process.platform === 'darwin'
      ? ['--use-gl=angle', '--use-angle=metal']
      : ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader'],
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
  await page.waitForFunction(
    () =>
      window.__gevGeoImport &&
      document.getElementById('loading-screen')?.classList.contains('hidden'),
    { timeout: 60000 },
  );
  await page.evaluate(async () => {
    const { viewer, dataManager } = window.__godsEyeView;
    const C = window.__CESIUM__;
    for (const id of dataManager.layers.keys())
      await dataManager.setEnabled(id, false);
    viewer.clock.shouldAnimate = false;
    viewer.imageryLayers.removeAll();
    viewer.terrainProvider = new C.EllipsoidTerrainProvider();
    viewer.camera.cancelFlight();
    viewer.camera.setView({
      destination: C.Cartesian3.fromDegrees(-122.5, 37.72, 50000),
      orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
    });
    // One form for both sides: Cesium's own KML reading of the file (the
    // control) and what the import drew (the candidate).
    const css = (value) =>
      value === undefined || value === null
        ? undefined
        : (Array.isArray(value)
            ? new C.Color(...value)
            : C.Color.fromCssColorString(value)
          ).toCssColorString();
    const at = (p) => {
      const c = C.Cartographic.fromCartesian(new C.Cartesian3(p.x, p.y, p.z));
      return [
        +C.Math.toDegrees(c.longitude).toFixed(6),
        +C.Math.toDegrees(c.latitude).toFixed(6),
      ];
    };
    const sorted = (rows) =>
      rows.sort(
        (a, b) => a.name.localeCompare(b.name) || a.kind.localeCompare(b.kind),
      );
    window.__qaStyleSnapshot = (source) => {
      const now = viewer.clock.currentTime;
      return sorted(
        source.entities.values
          .filter((e) => e.billboard || e.polyline || e.polygon)
          .map((e) => {
            if (e.billboard)
              return {
                name: e.name,
                kind: 'pin',
                point: at(e.position.getValue(now)),
                scale: e.billboard.scale?.getValue(now) ?? 1,
                heading: Math.round(
                  -C.Math.toDegrees(e.billboard.rotation?.getValue(now) ?? 0),
                ),
                image: Boolean(e.billboard.image?.getValue(now)),
                color: css(
                  e.billboard.color?.getValue(now)?.toCssColorString() ??
                    'white',
                ),
              };
            if (e.polyline)
              return {
                name: e.name,
                kind: 'line',
                width: e.polyline.width?.getValue(now),
                color: e.polyline.material?.color
                  ?.getValue(now)
                  ?.toCssColorString(),
                line: e.polyline.positions.getValue(now).map(at),
              };
            return {
              name: e.name,
              kind: 'polygon',
              fill: e.polygon.fill?.getValue(now) !== false,
              color: e.polygon.material?.color
                ?.getValue(now)
                ?.toCssColorString(),
              polygon: e.polygon.hierarchy.getValue(now).positions.map(at),
            };
          }),
      );
    };
    window.__qaDrawnSnapshot = (id) => {
      const drawn = window.__gevGeoImport.drawn(id);
      const ring = (points) =>
        points.map((p) => [+p.lon.toFixed(6), +p.lat.toFixed(6)]);
      return sorted([
        ...drawn.icons.map((i) => ({
          name: i.meta?.name,
          kind: 'pin',
          point: [+i.pos.lon.toFixed(6), +i.pos.lat.toFixed(6)],
          scale: i.scale ?? 1,
          // A KML heading is drawn as a turn on screen, clockwise.
          heading: Math.round((-(i.rotation ?? 0) * 180) / Math.PI),
          image: Boolean(i.image),
          color: css(i.color ?? 'white'),
        })),
        ...drawn.lines.map((l) => ({
          name: l.meta?.name,
          kind: 'line',
          width: l.widthPx,
          color: css(l.style.color),
          line: l.positions.map(at),
        })),
        ...drawn.shapes
          .filter((s) => s.geometry.kind === 'polygon')
          .map((s) => ({
            name: s.meta?.name,
            kind: 'polygon',
            fill: Boolean(s.fill),
            color: css(s.fill),
            polygon: ring(s.geometry.rings[0]),
          })),
      ]);
    };
    // The import's draw sets among the scene's primitives.
    window.__qaImportHosts = () => {
      let n = 0;
      for (let i = 0; i < viewer.scene.primitives.length; i++)
        if (
          String(viewer.scene.primitives.get(i).drawSetId).startsWith(
            'geo-import:',
          )
        )
          n += 1;
      return n;
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
        canvas: viewer.scene.canvas,
        clampToGround: true,
      });
      for (const e of source.entities.values) e.label = undefined;
      return source;
    };
  });
  const equivalent = await page.evaluate(async (text) => {
    const control = await window.__qaUnsharedKml(text);
    const outcomes = await window.__gevGeoImport.importFiles([
      new File([text], 'style-equivalence.kml'),
    ]);
    const expected = JSON.stringify(window.__qaStyleSnapshot(control));
    const actual = JSON.stringify(window.__qaDrawnSnapshot(outcomes[0]?.id));
    const result = {
      ok: outcomes[0]?.ok,
      same: expected === actual,
      entities: JSON.parse(actual).length,
      ...(expected === actual ? {} : { expected, actual }),
    };
    await window.__gevGeoImport.remove(outcomes[0]?.id);
    return result;
  }, small);
  check(
    'shared inline and named styles preserve point, line and polygon overrides/inheritance',
    equivalent.ok && equivalent.same && equivalent.entities === 9,
    JSON.stringify(equivalent),
  );

  // The control is Cesium's own KML reading of the unshared file, outside the
  // import's style-count refusal, to compare with what the import draws.
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
      const scene = viewer.scene;
      viewer.camera.cancelFlight();
      viewer.camera.setView({
        destination: C.Cartesian3.fromDegrees(-122.5, 37.72, 50000),
        orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
      });
      const started = performance.now(),
        samples = [];
      let last,
        frames = 0;
      const remove = scene.postRender.addEventListener(() => {
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
          scene.requestRender();
          if (t - started < 7000) requestAnimationFrame(tick);
          else resolve();
        }
        requestAnimationFrame(tick);
      });
      remove();
      samples.sort((a, b) => a - b);
      const gl = scene.context._gl,
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
    const before = await page.evaluate(() => window.__qaImportHosts());
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
      sources: window.__qaImportHosts(),
    }));
    const item = state.files.find((f) => !priorIds.includes(f.id));
    check(
      `picked ${name} loads`,
      loaded &&
        (expected === null
          ? item?.entityCount > 0
          : item?.entityCount === expected) &&
        state.sources > before,
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
    const same = await page.evaluate(
      (id) =>
        JSON.stringify(window.__qaDrawnSnapshot(id)) ===
        window.__qaUnsharedSnapshot,
      item.id,
    );
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
      const markers = await page.evaluate((id) => {
        const { viewer } = window.__godsEyeView,
          C = window.__CESIUM__;
        const drawn = window.__gevGeoImport.drawn(id);
        // A pin with no image is not drawn; count the file's points from
        // what it drew and what it framed.
        const points = drawn.icons;
        const images = points.filter((i) => i.image);
        if (images.length) {
          const { lon, lat } = images[0].pos;
          viewer.camera.cancelFlight();
          viewer.camera.setView({
            destination: C.Cartesian3.fromDegrees(lon, lat, 100000),
            orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
          });
        }
        return { points: points.length, images: images.length };
      }, suppliedItem.id);
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
        await new Promise((resolve) => setTimeout(resolve, 1000));
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
    'all imported sources are removed',
    await page.evaluate(() => window.__gevGeoImport.list().length === 0),
  );
  console.log('Fixture retained at', file);
} finally {
  await browser.close();
}
process.exitCode = failures ? 1 : 0;
