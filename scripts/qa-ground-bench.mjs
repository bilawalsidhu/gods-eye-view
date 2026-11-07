#!/usr/bin/env node
/**
 * Measure engine.ground at Dubai (1280×800, keyless) with N polygons:
 * Cesium (GroundPrimitive), Navara's screen pass (engine.ground,
 * src/globe/navara/ground/pass.js) and the Navara vector-layer prototype
 * (src/globe/navara/ground/vector.js). For each N: the time from commit to
 * the first item drawn, the frame time with the camera still and turning
 * (preUpdate to postRender, closed by a 1-pixel readPixels so the GPU work
 * of the frame is in it), the JS heap after a GC and the WebGL bytes the
 * page allocated (a tally of bufferData, texImage/texStorage and
 * renderbuffer storage, less deletions), each against the empty scene; then
 * one polygon over the Hajar mountains, obliquely, for the edge quality.
 *
 *   GOOGLE_MAPS_API_KEY= CESIUM_ION_TOKEN= npm run dev -- --port 4271
 *   node scripts/qa-ground-bench.mjs http://localhost:4271 [--counts=10,1000,10000]
 *     [--paths=cesium,navara-pass,navara-vector] [--out=DIR]
 */
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer';

const BLOCKED_HOSTS =
  /(^|\.)(googleapis\.com|google\.com|gstatic\.com|cesium\.com)$/;
const args = process.argv.slice(2);
const origin = args.find((arg) => !arg.startsWith('--'));
const option = (name) =>
  args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
if (!origin) {
  console.error('Usage: node scripts/qa-ground-bench.mjs <origin> [options]');
  process.exit(2);
}
const counts = (option('counts') ?? '10,1000,10000').split(',').map(Number);
// polygons: N small polygons; corridors: N 40-point lines across the view,
// 2.5 px; outline: one polygon of N vertices round the view.
const shape = option('shape') ?? 'polygons';
const paths = (option('paths') ?? 'cesium,navara-pass,navara-vector').split(
  ',',
);
const out = option('out') ?? null;
if (out) fs.mkdirSync(out, { recursive: true });

// The page's WebGL allocations, before any script of the app runs.
function installGpuTally() {
  const proto = WebGL2RenderingContext.prototype;
  const sizes = new Map();
  let total = 0;
  const boundBuffers = new WeakMap();
  const boundTextures = new WeakMap();
  const boundRenderbuffers = new WeakMap();
  const set = (key, bytes) => {
    total += bytes - (sizes.get(key) ?? 0);
    sizes.set(key, bytes);
  };
  const drop = (key) => {
    total -= sizes.get(key) ?? 0;
    sizes.delete(key);
  };
  const per = (map, gl) => {
    if (!map.has(gl)) map.set(gl, new Map());
    return map.get(gl);
  };
  const FLOAT = 0x1406;
  const HALF_FLOAT = 0x140b;
  const internalBytes = {
    0x8814: 16, // RGBA32F
    0x881a: 8, // RGBA16F
    0x8815: 12, // RGB32F
    0x822e: 4, // R32F
    0x8230: 8, // RG32F
    0x8058: 4, // RGBA8
    0x8c43: 4, // SRGB8_ALPHA8
    0x88f0: 4, // DEPTH24_STENCIL8
    0x8cad: 8, // DEPTH32F_STENCIL8
    0x8cac: 4, // DEPTH_COMPONENT32F
    0x81a6: 4, // DEPTH_COMPONENT24
    0x81a5: 2, // DEPTH_COMPONENT16
    0x8229: 1, // R8
    0x822b: 2, // RG8
  };
  const texelBytes = (internal, type) =>
    internalBytes[internal] ??
    (type === FLOAT ? 16 : type === HALF_FLOAT ? 8 : 4);
  const wrap = (name, after) => {
    const original = proto[name];
    proto[name] = function (...call) {
      const result = original.apply(this, call);
      try {
        after.call(this, call, result);
      } catch {
        // A tally error never breaks the page.
      }
      return result;
    };
  };
  wrap('bindBuffer', function ([target, buffer]) {
    per(boundBuffers, this).set(target, buffer);
  });
  wrap('bufferData', function ([target, data]) {
    const buffer = per(boundBuffers, this).get(target);
    if (buffer)
      set(buffer, typeof data === 'number' ? data : (data?.byteLength ?? 0));
  });
  wrap('deleteBuffer', ([buffer]) => drop(buffer));
  wrap('bindTexture', function ([target, texture]) {
    per(boundTextures, this).set(target, texture);
  });
  wrap('texImage2D', function (call) {
    const texture = per(boundTextures, this).get(call[0]);
    if (!texture || call[1] !== 0) return;
    let bytes;
    if (call.length >= 8 && typeof call[3] === 'number')
      bytes = call[3] * call[4] * texelBytes(call[2], call[7]);
    else {
      const source = call[5];
      bytes = (source?.width ?? 0) * (source?.height ?? 0) * 4;
    }
    set(texture, bytes);
  });
  wrap('texStorage2D', function ([target, levels, internal, width, height]) {
    const texture = per(boundTextures, this).get(target);
    if (texture)
      set(
        texture,
        width * height * texelBytes(internal) * (levels > 1 ? 4 / 3 : 1),
      );
  });
  wrap('texImage3D', function (call) {
    const texture = per(boundTextures, this).get(call[0]);
    if (texture && call[1] === 0)
      set(texture, call[3] * call[4] * call[5] * texelBytes(call[2], call[8]));
  });
  wrap('texStorage3D', function ([target, , internal, width, height, depth]) {
    const texture = per(boundTextures, this).get(target);
    if (texture) set(texture, width * height * depth * texelBytes(internal));
  });
  wrap('deleteTexture', ([texture]) => drop(texture));
  wrap('bindRenderbuffer', function ([, renderbuffer]) {
    boundRenderbuffers.set(this, renderbuffer);
  });
  wrap('renderbufferStorage', function ([, internal, width, height]) {
    const renderbuffer = boundRenderbuffers.get(this);
    if (renderbuffer) set(renderbuffer, width * height * texelBytes(internal));
  });
  wrap(
    'renderbufferStorageMultisample',
    function ([, samples, internal, width, height]) {
      const renderbuffer = boundRenderbuffers.get(this);
      if (renderbuffer)
        set(
          renderbuffer,
          width * height * texelBytes(internal) * Math.max(1, samples),
        );
    },
  );
  wrap('deleteRenderbuffer', ([renderbuffer]) => drop(renderbuffer));
  window.__gpuBytes = () => total;
}

const DUBAI = { lon: 55.27, lat: 25.15, alt: 70000 };

async function openEngine(browser, kind) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  page.on('pageerror', (error) => console.log('  page error:', error.message));
  await page.evaluateOnNewDocument(installGpuTally);
  await page.setRequestInterception(true);
  page.on('request', (request) => {
    if (BLOCKED_HOSTS.test(new URL(request.url()).hostname)) request.abort();
    else request.continue();
  });
  await page.goto(
    `${origin}/?welcome=0&engine=${kind}#v=2&lat=${DUBAI.lat}&lon=${DUBAI.lon}&alt=${DUBAI.alt}&heading=0&pitch=-90&map=osm&l=`,
  );
  await page.waitForFunction(
    (expected) =>
      window.__godsEyeView?.engine?.kind === expected &&
      document.getElementById('loading-screen')?.classList.contains('hidden'),
    { timeout: 300_000, polling: 250 },
    kind,
  );
  // Daylight in Dubai (Navara lights the scene with the app clock's sun).
  await page.evaluate(async () => {
    const { appClock } = await import('/src/time/clock.js');
    appClock.freeze(Date.UTC(2026, 10, 7, 8, 0));
    window.__godsEyeView.engine.render.request('ground-bench-daylight');
  });
  const cdp = await page.createCDPSession();
  await cdp.send('HeapProfiler.enable');
  // Helpers in the page: polygons, the approach under test, timing.
  await page.evaluate(() => {
    const { engine } = window.__godsEyeView;
    const random = (seed) => () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
    const PALETTE = [
      [1, 0.2, 0.2],
      [1, 0.6, 0],
      [1, 1, 0.2],
      [0.2, 0.9, 0.3],
      [0, 0.8, 1],
      [0.3, 0.4, 1],
      [0.7, 0.3, 1],
      [0.9, 0.9, 0.9],
    ];
    window.__bench = {
      engine,
      // N polygons over Dubai (deterministic): 10 vertices, 100–400 m;
      // item 0 a 3 km magenta polygon at the view centre.
      polygons(count) {
        const next = random(7);
        const items = [];
        for (let index = 0; index < count; index++) {
          const centre =
            index === 0
              ? [55.27, 25.15]
              : [54.95 + next() * 0.65, 24.95 + next() * 0.4];
          const radius = index === 0 ? 3000 : 100 + next() * 300;
          const ring = [];
          for (let k = 0; k < 10; k++) {
            const angle = (k / 10) * 2 * Math.PI;
            const r = radius * (0.75 + 0.25 * (index === 0 ? 1 : next()));
            ring.push([
              centre[0] +
                (r * Math.cos(angle)) /
                  (111320 * Math.cos((centre[1] * Math.PI) / 180)),
              centre[1] + (r * Math.sin(angle)) / 110540,
            ]);
          }
          items.push({
            rings: [ring],
            // Eight colours, as the layers use a handful (depth bands,
            // levels); the vector prototype makes one layer per style.
            fill:
              index === 0
                ? [1, 0, 1, 0.9]
                : [...PALETTE[Math.floor(next() * PALETTE.length)], 0.35],
            outline: { color: [1, 1, 1, 0.9], widthPx: 1 },
            pickId: index,
          });
        }
        return items;
      },
      // N - 1 lines, then the magenta mark on top of them.
      corridors(count) {
        const next = random(11);
        const items = [];
        for (let index = 1; index < count; index++) {
          let lon = 54.95 + next() * 0.65;
          let lat = 24.95 + next() * 0.4;
          const heading = next() * 2 * Math.PI;
          const positions = [];
          for (let k = 0; k < 40; k++) {
            positions.push([lon, lat]);
            const turn = heading + (next() - 0.5) * 1.2;
            lon += 0.004 * Math.cos(turn);
            lat += 0.004 * Math.sin(turn);
          }
          items.push({
            positions,
            color: [...PALETTE[Math.floor(next() * PALETTE.length)], 0.9],
            widthPx: 2.5,
            pickId: index,
          });
        }
        items.push(window.__bench.centreDisc());
        return items;
      },
      // The magenta mark of the corridors scenario: a 40 px corridor.
      centreDisc: () => ({
        positions: [
          [55.255, 25.15],
          [55.285, 25.15],
        ],
        color: [1, 0, 1, 0.9],
        widthPx: 40,
        pickId: 0,
      }),
      outline(count) {
        const ring = [];
        for (let k = 0; k < count; k++) {
          const angle = (k / count) * 2 * Math.PI;
          const wobble = 1 + 0.03 * Math.sin(angle * 37);
          ring.push([
            55.27 + 0.28 * wobble * Math.cos(angle),
            25.15 + 0.2 * wobble * Math.sin(angle),
          ]);
        }
        return [
          {
            rings: [ring],
            fill: [1, 0, 1, 0.5],
            outline: { color: [1, 1, 1, 1], widthPx: 2 },
            pickId: 0,
          },
        ];
      },
      async ground(kind) {
        if (kind !== 'navara-vector') return engine.ground;
        const { createNavaraVectorGround } =
          await import('/src/globe/navara/ground/vector.js');
        window.__bench.vector ??= createNavaraVectorGround(
          engine.extensions.navara.view,
        );
        return window.__bench.vector.ground;
      },
      frame: () =>
        new Promise((resolve) => {
          const remove = engine.frames.postRender.addEventListener(() => {
            remove();
            resolve();
          });
          engine.render.request('ground-bench');
        }),
      // Frame times in ms (preUpdate → postRender + 1 px readPixels).
      async frameTimes(frames, turn = false) {
        const gl = engine.host.canvas.getContext('webgl2');
        const pixel = new Uint8Array(4);
        const times = [];
        let start = 0;
        const removeStart = engine.frames.preUpdate.addEventListener(() => {
          start = performance.now();
        });
        const removeEnd = engine.frames.postRender.addEventListener(() => {
          gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
          times.push(performance.now() - start);
        });
        const pose = engine.camera.pose();
        try {
          for (let index = 0; index < frames; index++) {
            if (turn)
              engine.camera.setView({
                destination: pose.position,
                orientation: {
                  heading: pose.heading + (index % 2 ? 0.002 : -0.002),
                  pitch: pose.pitch,
                  roll: 0,
                },
              });
            await window.__bench.frame();
          }
        } finally {
          removeStart();
          removeEnd();
          engine.camera.setView({
            destination: pose.position,
            orientation: { heading: pose.heading, pitch: pose.pitch, roll: 0 },
          });
        }
        times.sort((a, b) => a - b);
        const mean = times.reduce((a, b) => a + b, 0) / times.length;
        return {
          mean,
          median: times[Math.floor(times.length / 2)],
          p95: times[Math.floor(times.length * 0.95)],
        };
      },
      // The centre pixel shows the magenta item.
      centreMagenta() {
        const canvas = engine.host.canvas;
        const c = document.createElement('canvas');
        c.width = 4;
        c.height = 4;
        const context = c.getContext('2d');
        context.drawImage(
          canvas,
          canvas.width / 2 - 2,
          canvas.height / 2 - 2,
          4,
          4,
          0,
          0,
          4,
          4,
        );
        const [r, g, b] = context.getImageData(1, 1, 1, 1).data;
        // Lit (the vector layers) or exact (the pass, Cesium).
        return r > 150 && b > 150 && g < Math.min(r, b) - 60;
      },
    };
  });
  return { page, cdp };
}

async function settleTiles(page) {
  await page.evaluate(async () => {
    const { engine, frame } = window.__bench;
    const started = performance.now();
    let loadedFrames = 0;
    while (performance.now() - started < 60000 && loadedFrames < 30) {
      await frame();
      loadedFrames = engine.surface.tilesLoaded() ? loadedFrames + 1 : 0;
    }
  });
}

async function memory(page, cdp) {
  await cdp.send('HeapProfiler.collectGarbage');
  await cdp.send('HeapProfiler.collectGarbage');
  return page.evaluate(() => ({
    js: performance.memory.usedJSHeapSize,
    gpu: window.__gpuBytes(),
    navara:
      window.__bench.engine.extensions?.navara?.view?.memoryStats?.()
        ?.gpuBytesEst ?? null,
  }));
}

const mb = (bytes) => (bytes / 2 ** 20).toFixed(2);
const rows = [];

async function measure(browser, kind) {
  const engineKind = kind === 'cesium' ? 'cesium' : 'navara';
  const { page, cdp } = await openEngine(browser, engineKind);
  const renderer = await page.evaluate(() => {
    const gl = window.__bench.engine.host.canvas.getContext('webgl2');
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    return info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : 'unknown';
  });
  console.log(`${kind}: ${renderer}`);
  await settleTiles(page);
  // Warm the approach (shader compile) with one item, then measure empty.
  await page.evaluate(async (kind) => {
    const ground = await window.__bench.ground(kind);
    const set = ground.createSet({ id: 'bench-warm', kind: 'polygon' });
    set.replace(window.__bench.polygons(1));
    set.commit();
    const started = performance.now();
    while (
      !window.__bench.centreMagenta() &&
      performance.now() - started < 30000
    )
      await window.__bench.frame();
    set.destroy();
    for (let index = 0; index < 10; index++) await window.__bench.frame();
  }, kind);
  const emptyFrames = {
    still: await page.evaluate(() => window.__bench.frameTimes(90)),
    turning: await page.evaluate(() => window.__bench.frameTimes(90, true)),
  };
  rows.push({ path: kind, shape, count: 0, ...emptyFrames });
  for (const count of counts) {
    const before = await memory(page, cdp);
    const built = await page.evaluate(
      async (kind, count, shape) => {
        const ground = await window.__bench.ground(kind);
        const items =
          shape === 'corridors'
            ? window.__bench.corridors(count)
            : shape === 'outline'
              ? window.__bench.outline(count)
              : window.__bench.polygons(count);
        const set = ground.createSet({
          id: 'bench',
          kind: shape === 'corridors' ? 'corridor' : 'polygon',
        });
        const started = performance.now();
        set.replace(items);
        set.commit();
        const committed = performance.now() - started;
        while (
          !window.__bench.centreMagenta() &&
          performance.now() - started < 120000
        )
          await window.__bench.frame();
        window.__bench.set = set;
        const drawnMs = performance.now() - started;
        for (let index = 0; index < 10; index++) await window.__bench.frame();
        return { commitMs: committed, drawnMs };
      },
      kind,
      count,
      shape,
    );
    // Right after the build, before tiles stream again.
    const loaded = await memory(page, cdp);
    const passBytes = await page.evaluate(
      () => window.__bench.engine.groundDiagnostics?.()?.textureBytes ?? null,
    );
    await settleTiles(page);
    const frames = {
      still: await page.evaluate(() => window.__bench.frameTimes(90)),
      turning: await page.evaluate(() => window.__bench.frameTimes(90, true)),
    };
    if (out)
      await page.screenshot({
        path: path.join(out, `dubai-${shape}-${kind}-${count}.png`),
      });
    await page.evaluate(async () => {
      window.__bench.set.destroy();
      for (let index = 0; index < 20; index++) await window.__bench.frame();
    });
    const released = await memory(page, cdp);
    const row = {
      path: kind,
      shape,
      count,
      ...built,
      ...frames,
      jsMB: mb(loaded.js - before.js),
      gpuMB: mb(loaded.gpu - before.gpu),
      navaraGpuMB:
        loaded.navara == null ? null : mb(loaded.navara - before.navara),
      passTexturesMB: passBytes == null ? null : mb(passBytes),
      jsAfterDestroyMB: mb(released.js - before.js),
      gpuAfterDestroyMB: mb(released.gpu - before.gpu),
    };
    rows.push(row);
    console.log(
      `  N=${count}: drawn ${row.drawnMs.toFixed(0)} ms (commit ${row.commitMs.toFixed(0)}), frame still ${frames.still.median.toFixed(2)} ms (empty ${emptyFrames.still.median.toFixed(2)}), turning ${frames.turning.median.toFixed(2)} ms (empty ${emptyFrames.turning.median.toFixed(2)}), JS +${row.jsMB} MB, WebGL +${row.gpuMB} MB${row.navaraGpuMB == null ? '' : `, Navara gpuBytesEst +${row.navaraGpuMB} MB`}${row.passTexturesMB == null || kind !== 'navara-pass' ? '' : `, pass textures ${row.passTexturesMB} MB`}; after destroy JS +${row.jsAfterDestroyMB}, WebGL +${row.gpuAfterDestroyMB} MB`,
    );
  }
  // Edge quality over terrain: one polygon on the Hajar mountains, oblique.
  if (out && shape === 'polygons') {
    await page.evaluate(async (kind) => {
      const { engine, frame } = window.__bench;
      const ground = await window.__bench.ground(kind);
      const geo = await import('/src/geo/index.js');
      engine.camera.setView({
        destination: geo.cartesian3.fromDegrees(56.05, 24.98, 9000),
        orientation: { heading: 0.5, pitch: -0.45, roll: 0 },
      });
      const set = ground.createSet({ id: 'bench-terrain', kind: 'polygon' });
      const ring = [];
      for (let k = 0; k < 24; k++) {
        const angle = (k / 24) * 2 * Math.PI;
        ring.push([
          56.12 + 0.03 * Math.cos(angle),
          25.07 + 0.022 * Math.sin(angle),
        ]);
      }
      set.replace([
        {
          rings: [ring],
          fill: [1, 0.3, 0, 0.45],
          outline: { color: [1, 1, 0, 1], widthPx: 2 },
        },
      ]);
      set.commit();
      for (let index = 0; index < 20; index++) await frame();
    }, kind);
    await settleTiles(page);
    await page.screenshot({ path: path.join(out, `terrain-${kind}.png`) });
  }
  await page.close();
}

const browser = await puppeteer.launch({ headless: true });
try {
  for (const kind of paths) await measure(browser, kind);
} finally {
  await browser.close();
}
if (out)
  fs.writeFileSync(
    path.join(out, `bench-${shape}.json`),
    JSON.stringify(rows, null, 2),
  );
