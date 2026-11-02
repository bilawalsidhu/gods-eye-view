#!/usr/bin/env node
// Real source rectangle footprints, including absence of paint at the globe limb.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import puppeteer from 'puppeteer';
import sharp from 'sharp';
import { watchW1Page } from './qa-browserEvidence.mjs';
import { firmsFixture, FIRMS_EPOCH_MS } from './fixtures/w2/firms.mjs';
const arg = (key) =>
  process.argv.find((v) => v.startsWith(`--${key}=`))?.slice(key.length + 3);
const base = arg('base-url'),
  preview = process.argv.includes('--preview');
if (
  !base ||
  [4173, 4185, 4186, 4187, 4188, 4189].includes(Number(new URL(base).port))
)
  throw new Error('Supply unreserved --base-url');
const softCorners = process.argv.includes('--diagnostic-soft-corners');
if (preview && softCorners) throw new Error('Shader mutation is dev-only');
const out = path.resolve(arg('out') ?? 'qa-artifacts/w2/firms/ground.json');
await fs.mkdir(path.dirname(out), { recursive: true });
const sha = (v) => crypto.createHash('sha256').update(v).digest('hex');
const fixture = firmsFixture();
const report = {
  checks: [],
  softCorners,
  mutations: 0,
  browserErrors: [],
  sourceCount: 371,
  geometryLook: 'minimal; sharpen/bloom disabled; native FXAA disabled',
  epochMs: FIRMS_EPOCH_MS,
  fixtureSha256: sha(JSON.stringify(fixture)),
  driverSha256: sha(await fs.readFile(new URL(import.meta.url))),
  scenes: { cesium: {}, navara: {} },
};
const check = (name, pass, detail) => {
  report.checks.push({ name, pass: Boolean(pass), detail });
  console.log(pass ? 'PASS' : 'FAIL', name);
};
const browser = await puppeteer.launch({
  headless: true,
  protocolTimeout: 180000,
  args: ['--use-angle=metal'],
});
const images = [];
const rendererSource = await fs.readFile(
  new URL('../src/layers/shared/render/navaraGroundCells.js', import.meta.url),
  'utf8',
);
const coverageSource = rendererSource.slice(
  rendererSource.indexOf('vec3 pixelPlane('),
  rendererSource.indexOf('void mainImage('),
);
if (!coverageSource.includes('rectangleCoverage('))
  throw new Error('Lost actual rectangle shader anchor');
report.rendererSha256 = sha(rendererSource);

try {
  const mathPage = await browser.newPage();
  watchW1Page(mathPage, report, {
    name: 'coverage-math',
    baseUrl: base,
    preview,
  });
  try {
    const cases = [
      {
        name: 'full pixel',
        planes: [
          [2, 1, 0],
          [2, -1, 0],
          [2, 0, 1],
          [2, 0, -1],
        ],
        expected: 1,
      },
      {
        name: 'single edge',
        planes: [
          [0, 1, 0],
          [2, -1, 0],
          [2, 0, 1],
          [2, 0, -1],
        ],
        expected: 0.5,
      },
      {
        name: 'square corner',
        planes: [
          [0, 1, 0],
          [2, -1, 0],
          [0, 0, 1],
          [2, 0, -1],
        ],
        expected: 0.25,
      },
      {
        name: 'thin strip without contained corners',
        planes: [
          [0.05, 1, 0],
          [0.05, -1, 0],
          [2, 0, 1],
          [2, 0, -1],
        ],
        expected: 0.1,
      },
      {
        name: 'acute corner with disjoint edge coverage',
        planes: [
          [-0.4, 1, 0],
          [-0.4, 0, 1],
          [0.5, -1, -1],
          [2, 1, 0],
        ],
        expected: 0,
      },
      {
        name: 'edges through exact pixel vertices',
        planes: [
          [0, 1, 1],
          [0, 1, -1],
          [2, -1, 0],
          [2, 0, -1],
        ],
        expected: 0.25,
      },
      {
        name: 'four clipped diagonal sides',
        planes: [
          [0.5, 1, 1],
          [0.5, 1, -1],
          [0.5, -1, 1],
          [0.5, -1, -1],
        ],
        expected: 0.5,
      },
      {
        name: 'degenerate point',
        planes: [
          [0, 1, 1],
          [0, 1, -1],
          [0, -1, 1],
          [0, -1, -1],
        ],
        expected: 0,
      },
    ];
    const results = await mathPage.evaluate(
      ({ source, cases }) => {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 1;
        const gl = canvas.getContext('webgl2', { antialias: false });
        if (!gl) throw new Error('Actual WebGL2 context required');
        const compile = (type, source) => {
          const shader = gl.createShader(type);
          gl.shaderSource(shader, source);
          gl.compileShader(shader);
          if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
            throw new Error(gl.getShaderInfoLog(shader));
          return shader;
        };
        const vertex = compile(
          gl.VERTEX_SHADER,
          '#version 300 es\nvoid main(){vec2 p=vec2((gl_VertexID<<1)&2,gl_VertexID&2);gl_Position=vec4(p*2.0-1.0,0.0,1.0);}',
        );
        const fragment = compile(
          gl.FRAGMENT_SHADER,
          '#version 300 es\nprecision highp float; uniform vec3 planes[4];out vec4 result;\n' +
            source +
            '\nvoid main(){result=vec4(rectangleCoverage(planes[0],planes[1],planes[2],planes[3]),0.0,0.0,1.0);}',
        );
        const program = gl.createProgram();
        gl.attachShader(program, vertex);
        gl.attachShader(program, fragment);
        gl.linkProgram(program);
        if (!gl.getProgramParameter(program, gl.LINK_STATUS))
          throw new Error(gl.getProgramInfoLog(program));
        gl.useProgram(program);
        const uniform = gl.getUniformLocation(program, 'planes[0]');
        const results = cases.map((item) => {
          gl.uniform3fv(uniform, new Float32Array(item.planes.flat()));
          gl.drawArrays(gl.TRIANGLES, 0, 3);
          const pixel = new Uint8Array(4);
          gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
          return {
            name: item.name,
            actual: pixel[0],
            expected: Math.round(item.expected * 255),
            error: gl.getError(),
          };
        });
        gl.deleteProgram(program);
        gl.deleteShader(vertex);
        gl.deleteShader(fragment);
        gl.getExtension('WEBGL_lose_context')?.loseContext();
        return results;
      },
      { source: coverageSource, cases },
    );
    report.coverageMath = results;
    for (const item of results)
      check(
        'actual GLSL coverage: ' + item.name,
        Math.abs(item.actual - item.expected) <= 1 && item.error === 0,
        item,
      );
  } finally {
    await mathPage.close();
  }
  for (const engine of ['cesium', 'navara']) {
    const context = await browser.createBrowserContext();
    try {
      const page = await context.newPage();
      if (softCorners && engine === 'navara') {
        await page.setRequestInterception(true);
        page.on('request', async (request) => {
          if (
            new URL(request.url()).pathname !==
            '/src/layers/shared/render/navaraGroundCells.js'
          )
            return request.continue();
          try {
            const response = await fetch(request.url());
            const source = await response.text();
            const marker = '  if(partial<2) return coverage;';
            if (source.split(marker).length !== 2)
              throw new Error('Lost actual corner coverage mutation anchor');
            report.mutations++;
            await request.respond({
              status: response.status,
              contentType: 'application/javascript',
              body: source.replace(marker, '  return coverage;'),
            });
          } catch (error) {
            report.browserErrors.push({
              kind: 'mutation',
              message: error.message,
            });
            await request.abort();
          }
        });
      }

      await page.setViewport({ width: 1280, height: 800 });
      watchW1Page(page, report, { name: engine, baseUrl: base, preview });
      await page.evaluateOnNewDocument((payload) => {
        localStorage.setItem('gev:first-run-mission:v1', 'suppressed');
        const original = window.fetch.bind(window);
        window.fetch = (input, init) => {
          const u = new URL(
            typeof input === 'string' ? input : (input.url ?? input),
            location.href,
          );
          if (u.origin === location.origin && u.pathname === '/api/firms')
            return Promise.resolve(
              new Response(JSON.stringify(payload), {
                headers: { 'content-type': 'application/json' },
              }),
            );
          if (
            u.origin === location.origin &&
            u.pathname === '/api/openai/hud-summary'
          )
            return Promise.resolve(
              new Response(
                JSON.stringify({
                  summary: 'FIRMS rectangle footprint fixture',
                }),
                { headers: { 'content-type': 'application/json' } },
              ),
            );
          return original(input, init);
        };
      }, fixture);
      const url = new URL(base);
      url.searchParams.set('engine', engine);
      url.searchParams.set('look', 'minimal');
      await page.goto(url.href, {
        waitUntil: 'domcontentloaded',
        timeout: 180000,
      });
      await page.waitForFunction(
        () =>
          window.__godsEyeView?.layers &&
          document
            .getElementById('loading-screen')
            ?.classList.contains('hidden'),
        { timeout: 180000 },
      );
      const actual = await page.evaluate(
        () => window.__godsEyeView.engine.kind,
      );
      if (actual !== engine)
        throw new Error('Requested rectangle engine did not boot');
      await page.evaluate(
        () => window.__godsEyeView.styleManager.initialRestorePromise,
      );
      await page.evaluate(async (epoch) => {
        const a = window.__godsEyeView;
        a.styleManager.orbitController.stop();
        a.engine.camera.cancelFlight();
        for (const [id] of a.dataManager.layers)
          if (a.dataManager.isEnabled(id)) await a.layers.disable(id);
        (await import('/src/time/clock.js')).appClock.freeze(epoch);
        (await import('/src/data/detection.js')).setMode('OFF');
        if (a.viewer)
          a.viewer.clock.currentTime =
            a.viewer.clock.currentTime.constructor.fromDate(new Date(epoch));
        a.styleManager._setBloomEnabled(false);
        a.styleManager._setSharpenEnabled(false);
        if (a.viewer) a.viewer.scene.postProcessStages.fxaa.enabled = false;
        const canvas = a.engine.host.canvas,
          style = document.createElement('style');
        style.textContent = '.w2-ground-hidden{visibility:hidden!important}';
        document.head.append(style);
        for (const element of document.body.querySelectorAll('*'))
          if (element !== canvas && !element.contains(canvas))
            element.classList.add('w2-ground-hidden');
      }, FIRMS_EPOCH_MS);
      for (const [name, pose] of Object.entries({
        global: [-110, 40, 15000000],
        regional: [-122.42, 37.77, 4000000],
      })) {
        await page.evaluate(async (pose) => {
          const a = window.__godsEyeView,
            geo = await import('/src/geo/index.js');
          a.engine.camera.setView({
            destination: geo.cartesian3.fromDegrees(...pose),
            orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
          });
          await a.layers.enable('local-firms');
          a.engine.render.request('firms-ground-on');
        }, pose);
        const ready = await page.evaluate(async () => {
          const a = window.__godsEyeView,
            start = performance.now();
          let since = null;
          while (performance.now() - start < 90000) {
            if (
              a.engine.surface.tilesLoaded() &&
              a.dataManager.layers.get('local-firms').module.getStats().cells >
                0
            )
              since ??= performance.now();
            else since = null;
            if (since !== null && performance.now() - since > 1500) return true;
            a.engine.render.request('firms-ground-settle');
            await new Promise((r) => setTimeout(r, 100));
          }
          return false;
        });
        if (!ready) throw new Error('Ground scene did not settle');
        await new Promise((r) => setTimeout(r, 4000));
        const oracle =
          engine === 'navara' ? report.scenes.cesium[name].rectangles : null;
        const evidence = await page.evaluate(
          async ({ oracle, epoch }) => {
            const a = window.__godsEyeView,
              e = a.engine,
              geo = await import('/src/geo/index.js');
            const rectangles =
              oracle ??
              a.viewer.dataSources.getByName('local-firms').flatMap((source) =>
                source.entities.values
                  .filter((entity) => entity.rectangle)
                  .map((entity) => {
                    const r = entity.rectangle.coordinates.getValue(
                      a.viewer.clock.currentTime,
                    );
                    return {
                      west: r.west,
                      east: r.east,
                      south: r.south,
                      north: r.north,
                      color: (() => {
                        const c = entity.rectangle.material.color.getValue(
                          a.viewer.clock.currentTime,
                        );
                        return {
                          red: c.red,
                          green: c.green,
                          blue: c.blue,
                          alpha: c.alpha,
                        };
                      })(),
                    };
                  }),
              );
            const boxes = rectangles
              .map((rect) => {
                let west = rect.west,
                  east = rect.east;
                if (east < west) east += 2 * Math.PI;
                const xs = [],
                  ys = [];
                // Both the actual ellipsoid and conservative roof elevations, with a dense
                // perimeter/interior sample. Bounds retain the existing2px raster tolerance.
                for (let row = 0; row <= 16; row++)
                  for (let col = 0; col <= 16; col++)
                    for (const height of [0, 12000]) {
                      const position = geo.cartesian3.fromRadians(
                        west + ((east - west) * col) / 16,
                        rect.south + ((rect.north - rect.south) * row) / 16,
                        height,
                      );
                      if (!e.projector.horizonVisible(position)) continue;
                      const p = e.projector.worldToWindow(position);
                      if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) {
                        xs.push(p.x);
                        ys.push(p.y);
                      }
                    }
                return xs.length
                  ? {
                      left: Math.min(...xs) - 2,
                      right: Math.max(...xs) + 2,
                      top: Math.min(...ys) - 2,
                      bottom: Math.max(...ys) + 2,
                    }
                  : null;
              })
              .filter(Boolean);
            const colorControls = rectangles
              .map((rect) => {
                let east = rect.east;
                if (east < rect.west) east += 2 * Math.PI;
                const position = geo.cartesian3.fromRadians(
                  (rect.west + east) / 2,
                  (rect.south + rect.north) / 2,
                  0,
                );
                if (!e.projector.horizonVisible(position)) return null;
                const center = e.projector.worldToWindow(position),
                  west = e.projector.worldToWindow(
                    geo.cartesian3.fromRadians(
                      rect.west,
                      (rect.south + rect.north) / 2,
                      0,
                    ),
                  ),
                  south = e.projector.worldToWindow(
                    geo.cartesian3.fromRadians(
                      (rect.west + east) / 2,
                      rect.south,
                      0,
                    ),
                  );
                if (
                  !center ||
                  !west ||
                  !south ||
                  Math.hypot(center.x - west.x, center.y - west.y) < 4 ||
                  Math.hypot(center.x - south.x, center.y - south.y) < 4 ||
                  center.x < 5 ||
                  center.x > 1274 ||
                  center.y < 5 ||
                  center.y > 794
                )
                  return null;
                const x = Math.floor(center.x),
                  y = Math.floor(center.y);
                // Check the whole RGB stencil geometrically, independently of
                // measured colors. Near the limb, long projected edges can
                // still enclose a subpixel-wide source rectangle.
                for (const dx of [-1.5, 0.5, 2.5])
                  for (const dy of [-1.5, 0.5, 2.5]) {
                    const screen = { x: x + dx, y: y + dy };
                    const hit = e.picker.pickPositionSupported
                      ? e.picker.pickPosition(screen)
                      : e.picker.pickGlobe(screen);
                    const c = hit && geo.cartographic.fromCartesian(hit);
                    if (!c) return null;
                    let lon = c.longitude;
                    if (lon < rect.west) lon += 2 * Math.PI;
                    if (
                      lon < rect.west ||
                      lon > east ||
                      c.latitude < rect.south ||
                      c.latitude > rect.north
                    )
                      return null;
                  }
                return { x, y, color: rect.color };
              })
              .filter(Boolean);
            return {
              rectangles,
              boxes,
              colorControls,
              stats: a.dataManager.layers.get('local-firms').module.getStats(),
              engineEpochMs: e.clock.now(),
              height: e.camera.height(),
            };
          },
          { oracle, epoch: FIRMS_EPOCH_MS },
        );
        check(
          `${engine}/${name}: actual source and native rectangle geometry`,
          evidence.stats.count === 371 &&
            evidence.stats.cells === evidence.rectangles.length &&
            evidence.boxes.length > 0 &&
            evidence.engineEpochMs === FIRMS_EPOCH_MS &&
            Math.abs(evidence.height - pose[2]) < 2,
          { cells: evidence.stats.cells, boxes: evidence.boxes.length },
        );
        const on = out.replace(/\.json$/, `-${engine}-${name}-on.png`),
          off = out.replace(/\.json$/, `-${engine}-${name}-off.png`);
        await page.screenshot({ path: on });
        await page.evaluate(async () => {
          const a = window.__godsEyeView;
          await a.layers.disable('local-firms');
          a.engine.render.request('firms-ground-off');
        });
        await new Promise((r) => setTimeout(r, 1200));
        await page.screenshot({ path: off });
        report.scenes[engine][name] = evidence;
        images.push({ engine, name, on, off });
      }
    } finally {
      await context.close();
    }
  }
} catch (error) {
  check('ground footprint scenario completes', false, error.message);
} finally {
  await browser.close();
}
for (const { engine, name, on, off } of images) {
  const [a, b] = await Promise.all(
    [on, off].map((file) => sharp(file).removeAlpha().raw().toBuffer()),
  );
  const { boxes } = report.scenes[engine][name];
  let changed = 0,
    outside = 0,
    maxOutside = 0;
  const examples = [];
  for (let y = 0; y < 800; y++)
    for (let x = 0; x < 1280; x++) {
      const i = (y * 1280 + x) * 3,
        delta = Math.max(
          ...[0, 1, 2].map((c) => Math.abs(a[i + c] - b[i + c])),
        );
      if (delta <= 3) continue;
      changed++;
      if (
        !boxes.some(
          (box) =>
            x >= box.left && x <= box.right && y >= box.top && y <= box.bottom,
        )
      ) {
        outside++;
        maxOutside = Math.max(maxOutside, delta);
        if (examples.length < 16) examples.push({ x, y, delta });
      }
    }
  let colorMaxError = 0;
  const colorProbes = [];
  for (const control of report.scenes[engine][name].colorControls) {
    const c = control.color;
    let maxError = 0;
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++)
        for (let channel = 0; channel < 3; channel++) {
          const i = ((control.y + dy) * 1280 + control.x + dx) * 3 + channel;
          const predicted = Math.round(
            b[i] * (1 - c.alpha) +
              255 * [c.red, c.green, c.blue][channel] * c.alpha,
          );
          maxError = Math.max(maxError, Math.abs(a[i] - predicted));
        }
    colorMaxError = Math.max(colorMaxError, maxError);
    colorProbes.push({ ...control, maxError });
  }
  report.scenes[engine][name].colorProbes = colorProbes;
  check(
    `${engine}/${name}: known source RGBA predicts actual ground RGB within3`,
    colorProbes.length >= 5 && colorMaxError <= 3,
    { controls: colorProbes.length, maxError: colorMaxError },
  );
  const raster = { changed, outside, maxOutside, examples };
  report.scenes[engine][name].raster = raster;
  check(
    `${engine}/${name}: actual nonempty rectangle paint`,
    changed >= 100,
    raster,
  );
  check(
    `${engine}/${name}: no paint outside native source footprints plus2px`,
    outside === 0,
    raster,
  );
}
check('all four source scenes captured', images.length === 4, images.length);
check(
  'observed pages have no runtime errors',
  report.browserErrors.length === 0,
  report.browserErrors,
);
if (softCorners) {
  check(
    'actual soft-corner mutation injected once',
    report.mutations === 1,
    report.mutations,
  );
  check('diagnostic mutation is not acceptance', false);
}
report.pass = report.checks.every((c) => c.pass);
await fs.writeFile(out, JSON.stringify(report, null, 2) + '\n');
process.exitCode = report.pass ? 0 : 1;
