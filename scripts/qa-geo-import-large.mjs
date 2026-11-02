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
    window.__qaStyleSnapshot = (source) => {
      const now = viewer.clock.currentTime;
      const images = new Map();
      const imageValue = (p) => {
        const value = p?.getValue(now);
        if (value?.tagName !== 'CANVAS') return value;
        if (!images.has(value)) images.set(value, value.toDataURL());
        return images.get(value);
      };
      const color = (p) => p?.getValue(now)?.toCssColorString();
      const positions = (p) => p?.getValue(now)?.map((v) => [v.x, v.y, v.z]);
      const renderedPins = new Map();
      const collection = source.importedBillboards;
      if (collection)
        for (let i = 0; i < collection.length; i++) {
          const pin = collection.get(i);
          renderedPins.set(pin.id, pin);
        }
      const actual = (e, key, fallback) => {
        const pin = renderedPins.get(e);
        return pin ? pin[key] : (e.billboard?.[key]?.getValue(now) ?? fallback);
      };
      return (source.importedEntities || source.entities.values)
        .map((e) => ({
          name: e.name,
          point: renderedPins.get(e)?.position || e.position?.getValue(now),
          scale: e.billboard ? actual(e, 'scale', 1) : undefined,
          rotation: e.billboard ? actual(e, 'rotation', 0) : undefined,
          image: renderedPins.get(e)?.image || imageValue(e.billboard?.image),
          color: e.billboard
            ? actual(e, 'color', C.Color.WHITE).toCssColorString()
            : undefined,
          width: e.polyline?.width?.getValue(now),
          lineColor: color(e.polyline?.material?.color),
          line: positions(e.polyline?.positions),
          fill: e.polygon?.fill?.getValue(now),
          outline: e.polygon?.outline?.getValue(now),
          polygonColor: color(e.polygon?.material?.color),
          polygon: e.polygon?.hierarchy
            ?.getValue(now)
            ?.positions?.map((v) => [v.x, v.y, v.z]),
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
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
      for (const e of source.importedEntities || source.entities.values)
        e.label = undefined;
      return source;
    };
  });
  const equivalent = await page.evaluate(async (text) => {
    const { viewer } = window.__godsEyeView;
    const control = await window.__qaUnsharedKml(text);
    const outcomes = await window.__gevGeoImport.importFiles([
      new File([text], 'style-equivalence.kml'),
    ]);
    const candidate = viewer.dataSources.get(viewer.dataSources.length - 1);
    const result = {
      ok: outcomes[0]?.ok,
      same:
        JSON.stringify(window.__qaStyleSnapshot(control)) ===
        JSON.stringify(window.__qaStyleSnapshot(candidate)),
      entities: (candidate.importedEntities || candidate.entities.values)
        .length,
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
    const before = await page.evaluate(
      () => window.__godsEyeView.viewer.dataSources.length,
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
      sources: window.__godsEyeView.viewer.dataSources.length,
    }));
    const item = state.files.find((f) => !priorIds.includes(f.id));
    check(
      `picked ${name} loads`,
      loaded &&
        (expected === null
          ? item?.entityCount > 0
          : item?.entityCount === expected) &&
        state.sources === before + 1,
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
      const viewer = window.__godsEyeView.viewer;
      const source = viewer.dataSources.get(viewer.dataSources.length - 1);
      return (
        JSON.stringify(window.__qaStyleSnapshot(source)) ===
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
        const { viewer } = window.__godsEyeView,
          C = window.__CESIUM__;
        const source = viewer.dataSources.get(viewer.dataSources.length - 1);
        const points = (
          source.importedEntities || source.entities.values
        ).filter((e) => e.position && e.billboard);
        const images = points.filter((e) =>
          e.billboard.image?.getValue(viewer.clock.currentTime),
        );
        if (images.length) {
          const at = C.Cartographic.fromCartesian(
            images[0].position.getValue(viewer.clock.currentTime),
          );
          viewer.camera.cancelFlight();
          viewer.camera.setView({
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
