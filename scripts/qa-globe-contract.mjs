#!/usr/bin/env node
/**
 * Runs src/globe/testing/contractSuite.mjs against a real globe engine in
 * headless Chrome. Starts this checkout's Vite dev server on a free port and
 * runs every contract check, plus engine-specific checks. Cesium: waits for
 * the app to boot and checks the app's own engine (window.__godsEyeView.engine;
 * built in the page from the viewer when the app has none); a throwaway engine
 * checks that creating and destroying one leaves the scene as it was.
 * Navara: the engine on the dev-only harness page scripts/qa/navara-contract.html
 * (Google 3D tiles use the dev server's browser key). Exits 1 on any failure.
 *
 *   node scripts/qa-globe-contract.mjs [--engine=cesium|navara] [--base-url=URL]
 *
 * --base-url reuses a running server instead of starting one. Browsers are
 * always headless. Provider keys are never printed: server output is not
 * echoed and console text is redacted.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const argument = (name) =>
  process.argv
    .find((value) => value.startsWith(`--${name}=`))
    ?.slice(name.length + 3);

/**
 * Engines by flag. Cesium: the module the app page imports, its export, and
 * the engine-specific checks. Navara: the dev-only harness page that builds
 * the engine (scripts/qa/navara-contract.html), until the app has a Navara
 * mode.
 */
const ENGINES = {
  cesium: {
    module: '/src/globe/cesium/createCesiumEngine.js',
    factory: 'createCesiumEngine',
    extraChecks: 'cesium',
  },
  navara: { page: '/scripts/qa/navara-contract.html' },
};
const engineName = argument('engine') ?? 'cesium';
const engineSpec = ENGINES[engineName];
if (!engineSpec) {
  console.error(
    `Unknown engine "${engineName}"; known: ${Object.keys(ENGINES)}`,
  );
  process.exit(2);
}
const BOOT_TIMEOUT_MS = Number(process.env.QA_BOOT_TIMEOUT_MS || 180000);
const RESERVED_PORTS = new Set([4185, 4186]);

const redact = (text) =>
  String(text)
    .replace(/([?&](?:key|token|access_token|apiKey)=)[^&\s"')]+/gi, '$1…')
    .replace(/AIza[0-9A-Za-z_-]{20,}/g, 'AIza…')
    .replace(/eyJ[0-9A-Za-z_.-]{20,}/g, 'eyJ…');

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() =>
        RESERVED_PORTS.has(port) ? resolve(freePort()) : resolve(port),
      );
    });
  });
}

async function waitForHttp(url, child, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child?.exitCode != null)
      throw new Error(`dev server exited with ${child.exitCode}`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      /* not listening yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`dev server did not answer ${url}`);
}

async function startServer() {
  const port = await freePort();
  const child = spawn(
    process.execPath,
    [
      path.join(repoRoot, 'node_modules/vite/bin/vite.js'),
      '--port',
      String(port),
      '--strictPort',
      '--host',
      'localhost',
    ],
    { cwd: repoRoot, stdio: ['ignore', 'ignore', 'pipe'] },
  );
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr = (stderr + chunk).slice(-4000);
  });
  const url = `http://localhost:${port}/`;
  try {
    await waitForHttp(url, child, 60000);
  } catch (error) {
    child.kill('SIGTERM');
    throw new Error(`${error.message}\n${redact(stderr)}`);
  }
  return { url, stop: () => child.kill('SIGTERM') };
}

const executablePath =
  process.env.PUPPETEER_EXECUTABLE_PATH ||
  (await puppeteer.executablePath().catch(() => null));
if (!executablePath || !fs.existsSync(executablePath))
  throw new Error('Puppeteer Chrome for Testing is unavailable');

/** The app's Cesium engine, after the boot flight has come to rest. */
async function runCesium(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => Boolean(window.__godsEyeView?.viewer), {
    timeout: BOOT_TIMEOUT_MS,
  });

  // The app opens with a 0.5 s pause and a 4 s fly-in (src/camera.js
  // flyToAustin). Checks start once the camera has been still for 1.5 s, so
  // the boot flight cannot keep moving the camera under them.
  await page.evaluate(async () => {
    const { camera } = window.__godsEyeView.viewer;
    const pose = () => [
      ...Object.values(camera.positionWC),
      ...Object.values(camera.directionWC),
    ];
    let last = pose();
    let stillSince = performance.now();
    const deadline = performance.now() + 60000;
    while (performance.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      const now = pose();
      if (now.some((value, index) => Math.abs(value - last[index]) > 1e-6)) {
        stillSince = performance.now();
        last = now;
      } else if (performance.now() - stillSince >= 1500) return;
    }
    throw new Error('the camera never came to rest after boot');
  });

  return page.evaluate(
    async ({ spec, kind }) => {
      const debug = window.__godsEyeView;
      const { viewer } = debug;
      // The page cannot resolve the bare 'cesium' specifier; take the
      // optimized-dependency URL Vite gave the app's own modules, so the
      // checks see the same Cesium instance.
      const transformed = await (
        await fetch('/src/globe/cesium/convert.js')
      ).text();
      const cesiumUrl = transformed.match(
        /from\s+["']([^"']*\/cesium\.js[^"']*)["']/,
      )?.[1];
      if (!cesiumUrl) throw new Error('cannot find the Cesium module URL');
      const Cesium = await import(cesiumUrl);
      const factories = await import(spec.module);
      const { runContractSuite } =
        await import('/src/globe/testing/contractSuite.mjs');
      const geo = await import('/src/geo/index.js');

      const { scene } = viewer;
      const sceneState = () => ({
        requestRenderMode: scene.requestRenderMode,
        maximumRenderTimeChange: scene.maximumRenderTimeChange,
        globeShow: scene.globe.show,
        enableInputs: scene.screenSpaceCameraController.enableInputs,
        percentageChanged: scene.camera.percentageChanged,
        imageryLayers: viewer.imageryLayers.length,
        primitives: scene.primitives.length,
        listeners: [
          scene.camera.changed,
          scene.camera.moveStart,
          scene.camera.moveEnd,
          scene.preUpdate,
          scene.preRender,
          scene.postRender,
        ].map((event) => event.numberOfListeners),
      });
      const build = () =>
        factories[spec.factory](viewer, {
          tilesetRef: () => debug.tileset ?? null,
          requestRender: debug.requestRender,
        });
      const appEngine = debug.engine ?? null;
      // A throwaway engine: creating it must change nothing, and destroying
      // it after subscribing must remove every Cesium listener it added. It
      // takes no render hold, so the app's engine stays the one that does.
      const before = JSON.stringify(sceneState());
      const probe = build();
      const after = JSON.stringify(sceneState());
      const noop = () => {};
      probe.camera.changed.addEventListener(noop);
      probe.camera.moveEnd.addEventListener(noop);
      probe.frames.preRender.addEventListener(noop);
      probe.frames.postRender.addEventListener(noop);
      probe.input.on('click', noop);
      const subscribed = JSON.stringify(sceneState().listeners);
      probe.destroy();
      const probeDestroyed = JSON.stringify(sceneState().listeners);
      const engine = appEngine ?? build();

      // Resolves after `count` rendered frames; a stalled renderer fails.
      const waitFrames = (count) =>
        new Promise((resolve, reject) => {
          let seen = 0;
          const timer = setTimeout(() => {
            remove();
            reject(new Error(`no frame within 5 s (${seen}/${count})`));
          }, 5000);
          const remove = scene.postRender.addEventListener(() => {
            if (++seen < count) return;
            clearTimeout(timer);
            remove();
            resolve();
          });
          scene.requestRender();
        });

      // The maps checks need a photoreal source the engine can show: the
      // app's startup tileset (a prebuilt Cesium source). The map stack the
      // app had is reapplied afterwards.
      const mapSources = debug.tileset
        ? {
            imagery: [{ kind: 'osm' }, { kind: 'esri-imagery' }],
            photoreal: { kind: 'photoreal', tileset: debug.tileset },
          }
        : null;
      const results = (
        await runContractSuite(engine, { waitFrames, mapSources })
      ).map(({ name, ok, error }) => ({ name, ok, error: error?.message }));
      // Reapplying the active stack sends its sources to the engine again.
      if (debug.mapStackController)
        await debug.mapStackController.setStack(
          debug.mapStackController.getActiveId(),
          { silent: true },
        );

      const extra = [];
      const check = async (name, run) => {
        try {
          await run();
          extra.push({ name, ok: true });
        } catch (error) {
          extra.push({ name, ok: false, error: error.message });
        }
      };
      const ensure = (condition, message) => {
        if (!condition) throw new Error(message);
      };
      const settle = async () => {
        for (let index = 0; index < 2; index++) {
          engine.render.request();
          await waitFrames(1);
        }
      };

      await check(
        'app: window.__godsEyeView.engine is the engine',
        async () => {
          ensure(appEngine, 'the app exposes no engine');
          ensure(
            appEngine.kind === kind,
            `engine kind ${appEngine.kind} != ${kind}`,
          );
        },
      );
      await check('the contract suite left no scene listeners', async () => {
        const now = JSON.stringify(sceneState().listeners);
        const original = JSON.stringify(JSON.parse(before).listeners);
        ensure(now === original, `listener counts ${original} became ${now}`);
      });

      if (spec.extraChecks === 'cesium') {
        await check('cesium: creating the engine changed nothing', async () => {
          ensure(before === after, `scene state ${before} became ${after}`);
        });
        await check('cesium: no Cesium instance leaks out', async () => {
          const pose = engine.camera.pose();
          const centre = geo.cartesian2.create(
            engine.host.size().width / 2,
            engine.host.size().height / 2,
          );
          const values = {
            position: pose.position,
            cartographic: pose.cartographic,
            direction: pose.direction,
            up: pose.up,
            right: pose.right,
            pickEllipsoid: engine.camera.pickEllipsoid(centre),
            pickRayOrigin: engine.camera.pickRay(centre)?.origin,
            worldToWindow: engine.projector.worldToWindow(
              geo.cartesian3.add(
                pose.position,
                geo.cartesian3.multiplyByScalar(
                  pose.direction,
                  1000,
                  geo.cartesian3.create(),
                ),
                geo.cartesian3.create(),
              ),
            ),
            transform: engine.camera.transform(),
            viewProjection: engine.projector.viewProjection(),
            viewRectangle: engine.camera.viewRectangle(),
          };
          const cesiumTypes = [
            Cesium.Cartesian2,
            Cesium.Cartesian3,
            Cesium.Cartographic,
            Cesium.Matrix4,
            Cesium.Rectangle,
          ];
          for (const [name, value] of Object.entries(values))
            if (value != null)
              ensure(
                !cesiumTypes.some((type) => value instanceof type),
                `${name} is a Cesium instance`,
              );
        });
        await check(
          "cesium: viewProjection matches Cesium's x/y/w rows after a render",
          async () => {
            engine.camera.setView({
              destination: geo.cartesian3.fromDegrees(20, 10, 30000),
              orientation: { heading: 0.6, pitch: -0.5, roll: 0.1 },
            });
            await settle();
            const matrix = engine.projector.viewProjection();
            const own = Cesium.Matrix4.multiply(
              scene.camera.frustum.projectionMatrix,
              scene.camera.viewMatrix,
              new Cesium.Matrix4(),
            );
            // The renderer's last-frustum matrix differs only in near/far (z row).
            const rendered = scene.context.uniformState.viewProjection;
            for (let column = 0; column < 4; column++)
              for (const row of [0, 1, 3]) {
                const index = column * 4 + row;
                ensure(
                  matrix[index] === own[index],
                  `[${index}] ${matrix[index]} != frustum×view ${own[index]}`,
                );
                const scale = Math.max(1, Math.abs(rendered[index]));
                ensure(
                  Math.abs(matrix[index] - rendered[index]) <= 1e-9 * scale,
                  `[${index}] ${matrix[index]} != rendered ${rendered[index]}`,
                );
              }
          },
        );
        await check(
          'cesium: lookAtTransform/transform round-trip, including a non-ENU frame',
          async () => {
            const target = geo.cartesian3.fromDegrees(-0.12, 51.5, 0);
            const enu = geo.transforms.eastNorthUpToFixedFrame(
              target,
              geo.ellipsoid.WGS84,
            );
            engine.camera.lookAtTransform(enu, {
              heading: 0.4,
              pitch: -0.7,
              range: 2000,
            });
            await settle();
            const held = engine.camera.transform();
            const cesiumHeld = Cesium.Matrix4.toArray(scene.camera.transform);
            for (let index = 0; index < 16; index++) {
              ensure(
                Math.abs(held[index] - enu[index]) <= 1e-6,
                `transform[${index}] ${held[index]} != ${enu[index]}`,
              );
              ensure(
                held[index] === cesiumHeld[index],
                `transform[${index}] differs from Cesium's`,
              );
            }
            // A frame rotated 30° about its own +Z with a Cartesian offset.
            const angle = Math.PI / 6;
            const rotation = geo.matrix4.fromRotationTranslation(
              geo.matrix3.fromRotationZ(angle),
              geo.cartesian3.create(),
            );
            const frame = geo.matrix4.multiply(
              enu,
              rotation,
              geo.matrix4.create(),
            );
            const offset = geo.cartesian3.create(300, -400, 500);
            engine.camera.lookAtTransform(frame, offset);
            await settle();
            const pose = engine.camera.pose();
            const expected = geo.matrix4.multiplyByPoint(
              frame,
              offset,
              geo.cartesian3.create(),
            );
            ensure(
              geo.cartesian3.distance(pose.position, expected) < 1e-3,
              'camera is not at frame × offset',
            );
            const toOrigin = geo.cartesian3.normalize(
              geo.cartesian3.subtract(
                target,
                pose.position,
                geo.cartesian3.create(),
              ),
              geo.cartesian3.create(),
            );
            ensure(
              geo.cartesian3.dot(toOrigin, pose.direction) > 1 - 1e-9,
              'camera does not look at the frame origin',
            );
            const frameUp = geo.cartesian3.create(
              frame[8],
              frame[9],
              frame[10],
            );
            ensure(
              geo.cartesian3.dot(pose.up, frameUp) > 0,
              'up does not follow the frame +Z',
            );
            const again = engine.camera.transform();
            for (let index = 0; index < 16; index++)
              ensure(
                Math.abs(again[index] - frame[index]) <= 1e-6,
                `rotated transform[${index}] ${again[index]} != ${frame[index]}`,
              );
            engine.camera.release();
            await settle();
            const released = engine.camera.transform();
            ensure(
              released.every(
                (value, index) => value === Cesium.Matrix4.IDENTITY[index],
              ),
              'release did not restore the identity',
            );
            ensure(
              geo.cartesian3.distance(
                engine.camera.pose().position,
                pose.position,
              ) < 0.01,
              'release moved the camera',
            );
          },
        );
        await check(
          'cesium: destroy leaves the scene as it found it',
          async () => {
            const original = JSON.stringify(JSON.parse(before).listeners);
            ensure(
              subscribed !== original,
              `subscribing added no Cesium listener (${subscribed})`,
            );
            ensure(
              probeDestroyed === original,
              `listener counts ${original} became ${probeDestroyed}`,
            );
          },
        );
      }
      // The app owns its engine; only a self-built one is destroyed here.
      if (!appEngine) engine.destroy();
      return { results, extra };
    },
    { spec: engineSpec, kind: engineName },
  );
}

/**
 * The Navara engine on the dev-only harness page (scripts/qa/navara-contract.html),
 * until the app has its own Navara mode. Besides the contract suite it checks
 * that Navara draws the engine's camera, render on demand, the canvas capture,
 * and live map sources (Google 3D tiles with the dev server's browser key).
 */
async function runNavara(page, url, consoleErrors) {
  await page.goto(new URL(engineSpec.page, url).href, {
    waitUntil: 'domcontentloaded',
  });
  // Vite may reload the page once while it optimizes dependencies it found.
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  for (;;) {
    try {
      await page.waitForFunction(() => window.__globeQa?.ready === true, {
        timeout: Math.max(1000, deadline - Date.now()),
      });
      break;
    } catch (error) {
      if (Date.now() >= deadline || !/destroyed|navigat/i.test(error.message))
        throw error;
    }
  }
  const failure = await page.evaluate(() => window.__globeQa.error);
  if (failure) throw new Error(`the Navara globe did not start: ${failure}`);

  const report = await page.evaluate(async () => {
    const qa = window.__globeQa;
    const { engine, view } = qa;
    const { runContractSuite } =
      await import('/src/globe/testing/contractSuite.mjs');
    const geo = await import('/src/geo/index.js');
    const { cartesian2, cartesian3, cartographic } = geo;

    // Resolves after `count` rendered frames; a stalled renderer fails.
    const waitFrames = (count) =>
      new Promise((resolve, reject) => {
        let seen = 0;
        const timer = setTimeout(() => {
          remove();
          reject(new Error(`no frame within 5 s (${seen}/${count})`));
        }, 5000);
        const remove = engine.frames.postRender.addEventListener(() => {
          if (++seen < count) return;
          clearTimeout(timer);
          remove();
          resolve();
        });
        engine.render.request();
      });
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const settle = async (count = 3) => {
      for (let index = 0; index < count; index++) await waitFrames(1);
    };

    // The maps checks with Google 3D tiles on the dev server's browser key.
    // The source holds the key: never print or serialise it (nor
    // maps.current(), which returns it).
    // The bare page shows no map, and depth picks need a drawn surface: OSM
    // on keyless terrain, as the app's globe stacks show.
    await engine.maps.setBaseImagery({ kind: 'osm' });
    await engine.maps.setTerrain({ kind: 'keyless' });
    const mapSources = qa.googleApiKey
      ? {
          imagery: [{ kind: 'osm' }, { kind: 'esri-imagery' }],
          photoreal: { kind: 'photoreal', googleApiKey: qa.googleApiKey },
        }
      : null;
    const results = (
      await runContractSuite(engine, { waitFrames, mapSources })
    ).map(({ name, ok, error }) => ({ name, ok, error: error?.message }));

    const extra = [];
    const check = async (name, run) => {
      try {
        await run();
        extra.push({ name, ok: true });
      } catch (error) {
        extra.push({ name, ok: false, error: error.message });
      }
    };
    const ensure = (condition, message) => {
      if (!condition) throw new Error(message);
    };

    await check('app: the engine is a Navara engine', async () => {
      ensure(engine.kind === 'navara', `engine kind ${engine.kind}`);
    });

    // Whether Navara draws what the engine projects: points along the
    // engine's pick rays project through Navara's drawn three camera to the
    // same window position (within 0.5 px).
    const drawnMatches = (label, distance) => {
      const raw = view.camera.raw;
      raw.updateMatrixWorld();
      const { width, height } = engine.host.size();
      const Vector = raw.position.constructor;
      for (const [x, y] of [
        [width / 2, height / 2],
        [width * 0.1, height * 0.2],
        [width * 0.9, height * 0.85],
      ]) {
        const ray = engine.camera.pickRay(cartesian2.create(x, y));
        const point = cartesian3.add(
          ray.origin,
          cartesian3.multiplyByScalar(
            ray.direction,
            distance,
            cartesian3.create(),
          ),
          cartesian3.create(),
        );
        const ndc = new Vector(point.x, point.y, point.z).project(raw);
        const drawn = [((ndc.x + 1) / 2) * width, ((1 - ndc.y) / 2) * height];
        ensure(
          Math.abs(drawn[0] - x) < 0.5 && Math.abs(drawn[1] - y) < 0.5,
          `${label}: (${x}, ${y}) is drawn at (${drawn.map((v) => v.toFixed(2))})`,
        );
      }
    };
    const untilMoveEnd = async (label) => {
      let ends = 0;
      const remove = engine.camera.moveEnd.addEventListener(() => ends++);
      try {
        for (let frame = 0; frame < 200 && !ends; frame++) {
          await waitFrames(1);
          await sleep(20);
        }
      } finally {
        remove();
      }
      ensure(ends > 0, `${label}: the camera never came to rest`);
      await settle();
    };

    await check(
      'navara: Navara draws the engine camera (pose and fov)',
      async () => {
        engine.camera.setView({
          destination: cartesian3.fromDegrees(20, 10, 30000),
          orientation: { heading: 0.6, pitch: -0.5, roll: 0.1 },
        });
        await settle();
        drawnMatches('tilted', 20000);
      },
    );

    await check(
      'navara: Navara draws the engine camera looking straight down (±89.99° clamp)',
      async () => {
        engine.camera.setView({
          destination: cartesian3.fromDegrees(20, 10, 1e6),
          orientation: { heading: 0.7, pitch: -Math.PI / 2, roll: 0 },
        });
        await settle();
        drawnMatches('nadir', 1e6);
        ensure(
          Math.abs(engine.camera.pose().pitch + Math.PI / 2) < 1e-9,
          'the clamped redraw replaced the exact pitch',
        );
      },
    );

    await check(
      'navara: Navara draws the engine camera after its flight lands',
      async () => {
        const destination = cartesian3.fromDegrees(-3.7, 40.4, 50000);
        let landed = false;
        engine.camera.flyTo({
          destination,
          orientation: { heading: 0.5, pitch: -0.8, roll: 0.1 },
          duration: 1,
          complete: () => (landed = true),
        });
        for (let frame = 0; frame < 300 && !landed; frame++) {
          await waitFrames(1);
          await sleep(10);
        }
        ensure(landed, 'the flight did not land');
        await settle();
        const pose = engine.camera.pose();
        ensure(
          cartesian3.distance(pose.position, destination) < 0.01,
          'the pose is not the destination',
        );
        drawnMatches('landed', 30000);
      },
    );

    await check(
      'navara: a mouse drag moves the camera and the pose follows what is drawn',
      async () => {
        engine.camera.setView({
          destination: cartesian3.fromDegrees(20, 10, 30000),
          orientation: { heading: 0.6, pitch: -0.5, roll: 0 },
        });
        await untilMoveEnd('before the drag');
        const before = engine.camera.pose();
        const canvas = engine.host.canvas;
        const rect = canvas.getBoundingClientRect();
        const fire = (type, x, y, buttons) =>
          canvas.dispatchEvent(
            new MouseEvent(type, {
              bubbles: true,
              cancelable: true,
              clientX: rect.left + x,
              clientY: rect.top + y,
              button: 0,
              buttons,
            }),
          );
        fire('mousedown', 640, 400, 1);
        for (let step = 1; step <= 10; step++) {
          fire('mousemove', 640 + step * 15, 400 + step * 5, 1);
          await sleep(30);
        }
        fire('mouseup', 790, 450, 0);
        await untilMoveEnd('after the drag');
        const after = engine.camera.pose();
        ensure(
          cartesian3.distance(before.position, after.position) > 100,
          'the drag did not move the camera',
        );
        drawnMatches('dragged', 20000);
      },
    );

    await check(
      'navara: render on demand draws nothing while idle (S5)',
      async () => {
        engine.render.setContinuous(false);
        engine.camera.setView({
          destination: cartesian3.fromDegrees(20, 10, 2e7),
        });
        await settle();
        let frames = 0;
        const remove = engine.frames.postRender.addEventListener(
          () => frames++,
        );
        try {
          // Let loading finish, then count frames nobody asked for.
          for (let waited = 0; waited < 15000; waited += 500) {
            frames = 0;
            await sleep(1500);
            if (frames === 0) break;
          }
          ensure(frames === 0, `${frames} frames in 1.5 s of idle`);
          await waitFrames(1);
          ensure(frames >= 1, 'a requested frame was not drawn');
          engine.render.setContinuous(true);
          frames = 0;
          await sleep(500);
          ensure(frames > 5, `only ${frames} frames in 0.5 s continuous`);
        } finally {
          engine.render.setContinuous(false);
          remove();
        }
      },
    );

    await check(
      'navara: setSharpen draws an unsharp mask after tone mapping, before anti-aliasing, not on the sky',
      async () => {
        engine.camera.setView({
          destination: cartesian3.fromDegrees(-74.0, 40.71, 3000),
          orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
        });
        await settle();
        for (let i = 0; i < 200 && !engine.surface.tilesLoaded(); i++)
          await sleep(100);
        await settle();
        // Mean absolute Laplacian of the luminance in the middle of the
        // frame: what an unsharp mask raises.
        const sharpness = async () => {
          await settle(2);
          const source = engine.host.canvas;
          const width = 320;
          const height = 200;
          const copy = document.createElement('canvas');
          copy.width = width;
          copy.height = height;
          const context = copy.getContext('2d');
          context.drawImage(
            source,
            (source.width - width) / 2,
            (source.height - height) / 2,
            width,
            height,
            0,
            0,
            width,
            height,
          );
          const { data } = context.getImageData(0, 0, width, height);
          const luma = (x, y) => {
            const i = 4 * (y * width + x);
            return 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
          };
          let sum = 0;
          for (let y = 1; y < height - 1; y++)
            for (let x = 1; x < width - 1; x++)
              sum += Math.abs(
                4 * luma(x, y) -
                  luma(x - 1, y) -
                  luma(x + 1, y) -
                  luma(x, y - 1) -
                  luma(x, y + 1),
              );
          return sum / ((width - 2) * (height - 2));
        };
        const previous = engine.render.sharpen();
        try {
          engine.render.setSharpen({ enabled: false });
          const off = await sharpness();
          engine.render.setSharpen({ enabled: true, amount: 1.7 });
          const on = await sharpness();
          // QA only: Navara's pass order is private (ThreeView's
          // renderPassOrchestrator).
          const names = view.renderPassOrchestrator?.getPassNames?.();
          ensure(Array.isArray(names), 'the pass order is unreadable');
          const at = names.indexOf('gevSharpen');
          const toneMapping = names.indexOf('toneMapping');
          const antiAliasing = names.findIndex(
            (name) => name === 'smaa' || name === 'fxaa',
          );
          ensure(
            at >= 0 &&
              toneMapping >= 0 &&
              at === toneMapping + 1 &&
              (antiAliasing < 0 || at < antiAliasing),
            `the sharpening is not between tone mapping and anti-aliasing: ${names.join(', ')}`,
          );
          ensure(
            on > off * 1.2,
            `sharpness ${on.toFixed(2)} with the mask is not above ${off.toFixed(2)} without`,
          );
          engine.render.setSharpen({ enabled: false });
          const offAgain = await sharpness();
          ensure(
            Math.abs(offAgain - off) <= off * 0.02,
            `sharpness off ${offAgain.toFixed(2)} is not back to ${off.toFixed(2)}`,
          );
          // The sky (and the clouds in it) is left alone: facing the
          // horizon, the top of the frame changes no more with the mask on
          // than between two frames without it.
          engine.camera.setView({
            destination: cartesian3.fromDegrees(-74.013, 40.706, 900),
            orientation: { heading: 0.52, pitch: -0.1, roll: 0 },
          });
          await settle();
          for (let i = 0; i < 200 && !engine.surface.tilesLoaded(); i++)
            await sleep(100);
          const sky = async () => {
            await settle(2);
            const source = engine.host.canvas;
            const width = source.width;
            const height = Math.round(source.height * 0.12);
            const copy = document.createElement('canvas');
            copy.width = width;
            copy.height = height;
            const context = copy.getContext('2d');
            context.drawImage(source, 0, 0, width, height, 0, 0, width, height);
            return context.getImageData(0, 0, width, height).data;
          };
          const difference = (a, b) => {
            let sum = 0;
            for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
            return sum / a.length;
          };
          const skyOff = await sky();
          engine.render.setSharpen({ enabled: true, amount: 2.1 });
          const skyOn = await sky();
          engine.render.setSharpen({ enabled: false });
          const skyOffAgain = await sky();
          const masked = difference(skyOff, skyOn);
          const noise = difference(skyOff, skyOffAgain);
          ensure(
            masked <= noise + 0.25,
            `the sky changed by ${masked.toFixed(3)} with the mask (frame noise ${noise.toFixed(3)})`,
          );
        } finally {
          engine.render.setSharpen(previous);
        }
      },
    );

    await check(
      'navara: render governor holds keep frames coming; releasing the last returns to idle',
      async () => {
        const governor = await import('/src/renderGovernor.js');
        governor.installRenderGovernor(engine);
        let frames = 0;
        const remove = engine.frames.postRender.addEventListener(
          () => frames++,
        );
        try {
          governor.holdContinuousRender('qa-a');
          governor.holdContinuousRender('qa-b');
          governor.releaseContinuousRender('qa-a');
          frames = 0;
          await sleep(1000);
          ensure(frames > 10, `only ${frames} frames in 1 s held, no input`);
          governor.releaseContinuousRender('qa-b');
          for (let waited = 0; waited < 15000; waited += 500) {
            frames = 0;
            await sleep(1500);
            if (frames === 0) break;
          }
          ensure(frames === 0, `${frames} frames in 1.5 s after release`);
          ensure(!engine.render.isContinuous(), 'still continuous');
        } finally {
          remove();
          governor.releaseContinuousRender('qa-a');
          governor.releaseContinuousRender('qa-b');
          governor.uninstallRenderGovernor(engine);
        }
      },
    );

    await check(
      'navara: a pointer gesture on the canvas raises no camera.commanded',
      async () => {
        let commanded = 0;
        const remove = engine.camera.commanded.addEventListener(
          () => commanded++,
        );
        try {
          const canvas = engine.host.canvas;
          const rect = canvas.getBoundingClientRect();
          const options = {
            bubbles: true,
            cancelable: true,
            clientX: rect.left + 100,
            clientY: rect.top + 100,
            button: 0,
            buttons: 1,
          };
          canvas.dispatchEvent(new PointerEvent('pointerdown', options));
          canvas.dispatchEvent(
            new PointerEvent('pointerup', { ...options, buttons: 0 }),
          );
          await settle();
          ensure(commanded === 0, `a gesture raised commanded ${commanded}x`);
        } finally {
          remove();
        }
      },
    );

    await check(
      'navara: maps — OSM, keyless terrain under Google 3D tiles, credits on screen; surface height at JFK (S2)',
      async () => {
        ensure(qa.googleApiKey, 'the dev server has no Google browser key');
        // JFK runway 13R/31L, looked at straight down from 800 m (S2).
        const lon = -73.7941;
        const lat = 40.6381;
        const place = cartographic.fromDegrees(lon, lat, 0);
        const untilLoaded = async () => {
          let loadedSince = null;
          const started = performance.now();
          while (performance.now() - started < 60000) {
            await waitFrames(1);
            await sleep(100);
            if (!engine.surface.tilesLoaded()) loadedSince = null;
            else if (loadedSince === null) loadedSince = performance.now();
            else if (performance.now() - loadedSince > 1500) return;
          }
        };
        // Photoreal right after the base imagery: the hidden (not deleted)
        // base layer keeps Navara loading terrain under the tiles.
        await engine.maps.setBaseImagery({ kind: 'osm' });
        await engine.maps.setTerrain({ kind: 'keyless' });
        engine.camera.setView({
          destination: cartesian3.fromDegrees(lon, lat, 800),
        });
        await engine.maps.setPhotorealTiles({ googleApiKey: qa.googleApiKey });
        ensure(engine.maps.photorealActive(), 'photoreal is not active');
        await untilLoaded();
        // Re:Earth terrain there: −29.66 m (S2).
        const terrain = engine.surface.terrainHeight(place);
        ensure(
          Number.isFinite(terrain) && Math.abs(terrain + 29.66) < 1,
          `terrainHeight ${terrain} under the tiles is not within 1 m of −29.66`,
        );
        const height = engine.surface.sampleHeight(place);
        // Cesium's sampleHeightMostDetailed there: −29.85 m (S2).
        ensure(
          Number.isFinite(height) && Math.abs(height + 29.85) < 2,
          `sampleHeight ${height} is not within 2 m of −29.85`,
        );
        const clamped = engine.surface.clampToHeight(
          cartesian3.fromDegrees(lon, lat, 500),
        );
        ensure(
          Math.abs(cartographic.fromCartesian(clamped).height - height) < 1e-6,
          'clampToHeight disagrees with sampleHeight',
        );
        const { width, height: tall } = engine.host.size();
        const picked = engine.picker.pickPosition(
          cartesian2.create(width / 2, tall / 2),
        );
        ensure(picked, 'pickPosition missed the tiles');
        const pickedHeight = cartographic.fromCartesian(picked).height;
        ensure(
          Math.abs(pickedHeight - height) < 3,
          `pickPosition height ${pickedHeight} is far from ${height}`,
        );
        ensure(
          document.querySelector('img[src*="google-credit"]'),
          'the Google logo is not on screen',
        );
        // Google's copyright lines are on screen, as Cesium shows them.
        const shownText = [...document.querySelectorAll('body *')]
          .filter((element) => {
            const box = element.getBoundingClientRect();
            const style = getComputedStyle(element);
            return (
              box.width > 0 &&
              box.height > 0 &&
              style.visibility !== 'hidden' &&
              Number(style.opacity) > 0 &&
              element.children.length === 0
            );
          })
          .map((element) => element.textContent.trim())
          .filter(Boolean);
        ensure(
          shownText.includes('Google') && shownText.length >= 3,
          `the copyright lines are not on screen (${shownText.join(' | ')})`,
        );
        // The canvas keeps its drawing buffer, so captures work any time (S4).
        const probe = document.createElement('canvas');
        probe.width = 64;
        probe.height = 40;
        const context = probe.getContext('2d');
        context.drawImage(engine.host.canvas, 0, 0, 64, 40);
        const pixels = context.getImageData(0, 0, 64, 40).data;
        const colours = new Set();
        for (let index = 0; index < pixels.length; index += 4)
          colours.add(pixels.slice(index, index + 3).join());
        ensure(colours.size > 50, `the capture has ${colours.size} colours`);
        await engine.maps.setPhotorealTiles(null);
        await settle();
        ensure(!engine.maps.photorealActive(), 'photoreal is still active');
        ensure(
          !document.querySelector('img[src*="google-credit"]'),
          'the Google logo stayed after the tiles went',
        );
      },
    );
    return { results, extra };
  });
  report.extra.push(await navaraLifecycleCheck(page, consoleErrors));
  return report;
}

/**
 * Destroying a Navara globe stops it: its canvas leaves the page, no frame,
 * animation frame or worker outlives it, and a new globe starts and renders
 * on the same page. Runs last: it destroys the harness globe first.
 */
async function navaraLifecycleCheck(page, consoleErrors) {
  const name =
    'navara: create → destroy → create leaves no canvas, frames, workers or errors';
  const errorsBefore = consoleErrors.length;
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const settledWorkers = async () => {
    await pause(1500);
    return page.workers().length;
  };
  try {
    const ensure = (condition, message) => {
      if (!condition) throw new Error(message);
    };
    await page.evaluate(() => {
      window.__qaAnimationFrames = 0;
      const request = window.requestAnimationFrame.bind(window);
      window.requestAnimationFrame = (callback) => {
        window.__qaAnimationFrames++;
        return request(callback);
      };
      window.__globeQa.destroy();
    });
    ensure(
      (await settledWorkers()) === 0,
      'workers outlived the harness globe',
    );
    const cycle = () =>
      page.evaluate(async () => {
        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const container = document.createElement('div');
        container.style.cssText = 'position:absolute;inset:0';
        document.body.appendChild(container);
        const globe = await window.__globeQa.createGlobe({ container });
        let frames = 0;
        const remove = globe.engine.frames.postRender.addEventListener(
          () => frames++,
        );
        for (let tries = 0; tries < 50 && !frames; tries++) {
          globe.engine.render.request();
          await sleep(50);
        }
        remove();
        // Navara 0.2.1 warms its worker pool in the background after init;
        // a view disposed before that finishes leaks the late workers (see
        // the Tasks 6–7 report). Live past the warm-up, as the app does.
        await sleep(2000);
        let after = 0;
        globe.view.on('postRender', () => after++);
        globe.destroy();
        const animationFrames = window.__qaAnimationFrames;
        await sleep(1000);
        const result = {
          rendered: frames,
          framesAfter: after,
          animationFramesAfter: window.__qaAnimationFrames - animationFrames,
          canvases: container.querySelectorAll('canvas').length,
        };
        container.remove();
        return result;
      });
    for (const round of [1, 2]) {
      const result = await cycle();
      ensure(result.rendered > 0, `round ${round}: the new globe drew nothing`);
      ensure(result.canvases === 0, `round ${round}: the canvas stayed`);
      ensure(
        result.framesAfter === 0 && result.animationFramesAfter === 0,
        `round ${round}: ${result.framesAfter} frames and ` +
          `${result.animationFramesAfter} animation frames after destroy`,
      );
      ensure(
        (await settledWorkers()) === 0,
        `round ${round}: workers outlived the globe`,
      );
    }
    ensure(
      consoleErrors.length === errorsBefore,
      `console errors: ${consoleErrors.slice(errorsBefore).join(' | ')}`,
    );
    return { name, ok: true };
  } catch (error) {
    return { name, ok: false, error: error.message };
  }
}

const server = argument('base-url')
  ? { url: argument('base-url'), stop: () => {} }
  : await startServer();
let browser;
let exitCode = 1;
try {
  browser = await puppeteer.launch({
    headless: 'new',
    executablePath,
    args: [
      ...(process.platform === 'darwin'
        ? ['--use-angle=metal', '--enable-gpu']
        : ['--use-gl=angle', '--use-angle=swiftshader']),
      '--no-sandbox',
      '--window-size=1280,800',
    ],
    defaultViewport: { width: 1280, height: 800 },
  });
  const page = await browser.newPage();
  const consoleErrors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(redact(message.text()));
  });
  page.on('pageerror', (error) => consoleErrors.push(redact(error.message)));

  console.log(`[qa-globe-contract] engine=${engineName} app=${server.url}`);
  const report =
    engineName === 'navara'
      ? await runNavara(page, server.url, consoleErrors)
      : await runCesium(page, server.url);

  const all = [...report.results, ...report.extra];
  for (const { name, ok, error } of all)
    console.log(
      `  [${ok ? 'PASS' : 'FAIL'}] ${name}${ok ? '' : ` — ${error}`}`,
    );
  const failed = all.filter(({ ok }) => !ok);
  console.log(
    `[qa-globe-contract] ${all.length - failed.length}/${all.length} passed` +
      ` (${report.results.length} contract, ${report.extra.length} engine)`,
  );
  if (consoleErrors.length) {
    console.log(
      `[qa-globe-contract] ${consoleErrors.length} console error(s):`,
    );
    for (const text of consoleErrors.slice(0, 20))
      console.log(`  ${text.slice(0, 300)}`);
  }
  exitCode = failed.length ? 1 : 0;
} catch (error) {
  console.error(`[qa-globe-contract] ${redact(error?.stack || error)}`);
  exitCode = 1;
} finally {
  await browser?.close();
  server.stop();
}
process.exit(exitCode);
