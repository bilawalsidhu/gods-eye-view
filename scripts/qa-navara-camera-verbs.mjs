// Contract: the camera verbs (move_camera's orbit, pan, tilt, rotate,
// rotate_globe and stop, and fly_route) move the camera the same way on both
// globes. On Cesium each verb runs twice from the same pose: through the
// voice runner (the viewer's own camera) and through the globe contract
// (engineFromViewer); the two must land within tolerance of each other and
// of the verb's nominal size. On Navara each verb runs through the voice
// runner when its tools offer it, else through the verbs' development hook
// (window.__gevCameraVerbs) on the engine. Manual input on the canvas stops a
// running verb, a new verb replaces it, and an engine switch releases it.
//
// The hook exists in development builds only (import.meta.env.DEV), so serve
// a keyless development build:
//   NODE_ENV=development GOOGLE_MAPS_API_KEY= CESIUM_ION_TOKEN= \
//     npx vite build --outDir <scratch>/dist-dev
//   node scripts/qa-navara-camera-verbs.mjs http://127.0.0.1:<port>

import assert from 'node:assert/strict';
import { createStrict, localPreview } from './qa-strict-harness.mjs';
import { openApp } from './qa-strict-session.mjs';

const base = localPreview(process.argv[2]);
const ID = 'camera-verbs';
const strict = createStrict({ origin: base.origin, layers: [ID] });

/** Austin, 5 km up, looking north-east and down 45 degrees. */
const START = {
  lon: -97.74,
  lat: 30.27,
  height: 5000,
  heading: 30,
  pitch: -45,
};
const GLOBE = { lon: -97.74, lat: 30.27, height: 18e6, heading: 0, pitch: -90 };
const ROUTE = [
  {
    type: 'route',
    label: 'qa walk',
    path: [
      { lat: 30.265, lon: -97.745 },
      { lat: 30.272, lon: -97.745 },
      { lat: 30.272, lon: -97.737 },
    ],
  },
];

/** In-page helpers: place the camera, read it, run a verb and wait. */
async function installHelpers(page) {
  await page.evaluate(() => {
    const A = 6378137;
    const E2 = 6.69437999014e-3;
    const rad = (d) => (d * Math.PI) / 180;
    const fromDegrees = (lon, lat, h) => {
      const [l, p] = [rad(lon), rad(lat)];
      const n = A / Math.sqrt(1 - E2 * Math.sin(p) ** 2);
      return {
        x: (n + h) * Math.cos(p) * Math.cos(l),
        y: (n + h) * Math.cos(p) * Math.sin(l),
        z: (n * (1 - E2) + h) * Math.sin(p),
      };
    };
    const app = () => window.__godsEyeView;
    const verbs = () => window.__gevCameraVerbs;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const plain = (v) => ({ x: v.x, y: v.y, z: v.z });
    window.__qaVerbs = {
      fromDegrees,
      pose() {
        const p = app().engine.camera.pose();
        return {
          position: plain(p.position),
          direction: plain(p.direction),
          up: plain(p.up),
          right: plain(p.right),
          heading: p.heading,
          pitch: p.pitch,
          roll: p.roll,
          height: p.cartographic.height,
        };
      },
      async place(pose) {
        verbs().interruptCameraMotion('qa-place');
        const camera = app().engine.camera;
        camera.cancelFlight();
        camera.release();
        camera.setView({
          destination: fromDegrees(pose.lon, pose.lat, pose.height),
          orientation: {
            heading: rad(pose.heading),
            pitch: rad(pose.pitch),
            roll: 0,
          },
        });
        app().engine.render.request('qa');
        await sleep(400);
        return window.__qaVerbs.pose();
      },
      /** The orbit target: the voice tools' cascade (depth pick, then the
       *  ellipsoid) at the screen centre. */
      target() {
        const engine = app().engine;
        const { width, height } = engine.host.size();
        const center = { x: width / 2, y: height / 2 };
        let t = null;
        try {
          if (engine.picker.pickPositionSupported)
            t = engine.picker.pickPosition(center);
        } catch {
          t = null;
        }
        if (!t || !(Math.hypot(t.x, t.y, t.z) > 6e6))
          t = engine.camera.pickEllipsoid(center);
        return t ? plain(t) : null;
      },
      /** Install the contract camera of the running engine for the hook. */
      useEngine(target) {
        verbs().initCameraVerbs(app().engine, () => target);
      },
      async voice(name, args) {
        const result = await app().voiceCommands.runner(name, args);
        return JSON.parse(JSON.stringify(result ?? null));
      },
      run(name, args) {
        const result =
          name === 'fly_route'
            ? verbs().flyRoute(
                args.routes,
                args.args,
                app().surfaceServices?.groundFloor?.cachedGroundFloor ?? null,
                null,
                app().surfaceServices?.groundFloor?.warmGroundFloor ?? null,
              )
            : verbs().moveCamera(args);
        return JSON.parse(JSON.stringify(result));
      },
      motion: () => verbs().getActiveCameraMotion(),
      holds: () => app().getRenderGovernorDiagnostics().holds,
      async settle(timeoutMs = 6000) {
        const end = performance.now() + timeoutMs;
        while (verbs().getActiveCameraMotion() && performance.now() < end)
          await sleep(50);
        await sleep(100);
        return verbs().getActiveCameraMotion();
      },
      sleep,
    };
  });
}

const call = (page, fn, ...args) =>
  page.evaluate((fn, args) => window.__qaVerbs[fn](...args), fn, args);

// Vector maths on the Node side.
const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
const len = (a) => Math.sqrt(dot(a, a));
const deg = (r) => (r * 180) / Math.PI;
const angle = (a, b) =>
  deg(Math.acos(Math.max(-1, Math.min(1, dot(a, b) / (len(a) * len(b))))));
const wrapDeg = (d) => ((((d + 180) % 360) + 360) % 360) - 180;

/** What a once verb did to the camera, in the units its contract names. */
function effect(kind, before, after, target) {
  const moved = sub(after.position, before.position);
  switch (kind) {
    case 'pan':
      return {
        movedM: len(moved),
        alongRight: dot(moved, before.right) / Math.max(1e-9, len(moved)),
        alongUp: dot(moved, before.up) / Math.max(1e-9, len(moved)),
        nominalM: 0.25 * Math.max(50, before.height),
      };
    case 'tilt':
      return {
        movedM: len(moved),
        pitchDeg: deg(after.pitch - before.pitch),
      };
    case 'rotate':
      return {
        movedM: len(moved),
        turnDeg: angle(before.direction, after.direction),
        towardRight: dot(after.direction, before.right),
      };
    case 'orbit': {
      const r0 = sub(before.position, target);
      const r1 = sub(after.position, target);
      const up = { ...target };
      const n = len(up);
      const flat = (v) => {
        const k = dot(v, up) / (n * n);
        return { x: v.x - up.x * k, y: v.y - up.y * k, z: v.z - up.z * k };
      };
      return {
        rangeRatio: len(r1) / len(r0),
        turnDeg: angle(flat(r0), flat(r1)),
      };
    }
    default:
      return {};
  }
}

/** The nominal outcome of each once verb (cameraVerbs.js ONCE). */
function nominal(kind, args, e) {
  const close = (a, b, tol) => Math.abs(a - b) <= tol;
  switch (kind) {
    case 'pan': {
      const sign =
        args.direction === 'left' || args.direction === 'down' ? -1 : 1;
      const axis =
        args.direction === 'left' || args.direction === 'right'
          ? e.alongRight
          : e.alongUp;
      return (
        close(e.movedM, e.nominalM, e.nominalM * 0.1) && axis * sign > 0.95
      );
    }
    case 'tilt':
      return (
        e.movedM < 1 &&
        close(e.pitchDeg, args.direction === 'up' ? 15 : -15, 0.5)
      );
    case 'rotate':
      return (
        e.movedM < 1 &&
        close(e.turnDeg, 15, 0.3) &&
        (args.direction === 'left' ? e.towardRight < 0 : e.towardRight > 0)
      );
    case 'orbit':
      return close(e.rangeRatio, 1, 0.01) && close(e.turnDeg, 30, 1);
    default:
      return false;
  }
}

const ONCE = [
  { motion: 'pan', direction: 'left' },
  { motion: 'pan', direction: 'up' },
  { motion: 'tilt', direction: 'up' },
  { motion: 'tilt', direction: 'down' },
  { motion: 'rotate', direction: 'left' },
  { motion: 'rotate', direction: 'right' },
  { motion: 'orbit', direction: 'right' },
];

/** Run one once verb from START by `path` ('voice' or 'engine'). */
async function onceVerb(page, args, path) {
  const before = await call(page, 'place', START);
  const target = await call(page, 'target');
  if (path === 'engine') await call(page, 'useEngine', target);
  const result =
    path === 'voice'
      ? await call(page, 'voice', 'move_camera', { ...args, mode: 'once' })
      : await call(page, 'run', 'move_camera', { ...args, mode: 'once' });
  const left = await call(page, 'settle');
  const after = await call(page, 'pose');
  return {
    result,
    left,
    effect: effect(args.motion, before, after, target),
    holds: await call(page, 'holds'),
  };
}

/** Whether the voice tools offer move_camera on the running engine. */
async function voiceOffers(page) {
  await call(page, 'place', START);
  const probe = await call(page, 'voice', 'move_camera', { motion: 'stop' });
  return probe?.ok === true;
}

async function continuous(page, args, seconds, path) {
  const result =
    path === 'voice'
      ? await call(page, 'voice', 'move_camera', args)
      : await call(page, 'run', 'move_camera', args);
  const before = await call(page, 'pose');
  await call(page, 'sleep', seconds * 1000);
  const running = await call(page, 'motion');
  const after = await call(page, 'pose');
  return { result, running, before, after };
}

async function engineChecks(page, engine, path) {
  const tag = `${engine}/${path}`;
  const effects = {};
  // Every once verb lands on its nominal size, then lets go of the camera
  // and of the continuous-render hold.
  for (const args of ONCE) {
    const run = await onceVerb(page, args, path);
    const name = `${args.motion} ${args.direction}`;
    effects[name] = run.effect;
    await strict.check(
      page,
      ID,
      `${tag}: ${name} once moves the camera by its nominal step and ends`,
      run.result?.ok === true &&
        run.left === null &&
        !run.holds.includes('camera-verb') &&
        nominal(args.motion, args, run.effect),
      { result: run.result, effect: run.effect, holds: run.holds },
    );
  }

  // Globe rotation: radius held, left and right turn opposite ways.
  const turns = {};
  for (const direction of ['left', 'right']) {
    await call(page, 'place', GLOBE);
    if (path === 'engine') await call(page, 'useEngine', null);
    const run = await continuous(
      page,
      { motion: 'rotate_globe', direction, mode: 'continuous' },
      1.2,
      path,
    );
    await call(page, path === 'voice' ? 'voice' : 'run', 'move_camera', {
      motion: 'stop',
    });
    const r0 = len(run.before.position);
    const r1 = len(run.after.position);
    const lon = (p) => deg(Math.atan2(p.y, p.x));
    turns[direction] = wrapDeg(
      lon(run.after.position) - lon(run.before.position),
    );
    await strict.check(
      page,
      ID,
      `${tag}: rotate_globe ${direction} turns the globe at a held radius`,
      run.result?.ok === true &&
        run.running?.kind === 'rotate_globe' &&
        Math.abs(r1 - r0) < 1 &&
        Math.abs(turns[direction]) > 2,
      { result: run.result, radiusDeltaM: r1 - r0, lonDeg: turns[direction] },
    );
  }
  await strict.check(
    page,
    ID,
    `${tag}: rotate_globe left and right are opposite`,
    Math.sign(turns.left) === -Math.sign(turns.right),
    turns,
  );

  // Manual input on the canvas stops a continuous orbit.
  await call(page, 'place', START);
  const target = await call(page, 'target');
  if (path === 'engine') await call(page, 'useEngine', target);
  const orbit = await continuous(
    page,
    { motion: 'orbit', direction: 'left', mode: 'continuous' },
    0.6,
    path,
  );
  const box = await page.evaluate(() => {
    const r = window.__godsEyeView.engine.host.canvas.getBoundingClientRect();
    return { x: r.left + r.width * 0.3, y: r.top + r.height * 0.7 };
  });
  await page.mouse.move(box.x, box.y);
  await page.mouse.down();
  await page.mouse.up();
  await call(page, 'sleep', 200);
  await strict.check(
    page,
    ID,
    `${tag}: a pointer press on the globe stops a running orbit`,
    orbit.running?.kind === 'orbit' &&
      (await call(page, 'motion')) === null &&
      !(await call(page, 'holds')).includes('camera-verb'),
    { orbit: orbit.result },
  );

  // A new verb replaces the running one; stop ends it.
  await call(page, 'place', START);
  if (path === 'engine') await call(page, 'useEngine', target);
  const first = await continuous(
    page,
    { motion: 'rotate', direction: 'left', mode: 'continuous' },
    0.3,
    path,
  );
  const second = await continuous(
    page,
    { motion: 'pan', direction: 'right', mode: 'continuous' },
    0.3,
    path,
  );
  const stop = await call(
    page,
    path === 'voice' ? 'voice' : 'run',
    'move_camera',
    { motion: 'stop' },
  );
  await strict.check(
    page,
    ID,
    `${tag}: a new verb replaces the running one and stop ends it`,
    first.running?.kind === 'rotate' &&
      second.running?.kind === 'pan' &&
      second.running.motionId !== first.running.motionId &&
      stop?.ok === true &&
      (await call(page, 'motion')) === null,
    { first: first.running, second: second.running, stop },
  );
  return effects;
}

async function routeCheck(page, engine) {
  const before = await call(page, 'place', START);
  await call(page, 'useEngine', null);
  const result = await call(page, 'run', 'fly_route', {
    routes: ROUTE,
    args: { speed: 'fast' },
  });
  let motion = null;
  for (let i = 0; i < 80; i++) {
    await call(page, 'sleep', 100);
    motion = await call(page, 'motion');
    if (!motion || motion.progress > 0.25) break;
  }
  const mid = await call(page, 'pose');
  const stop = await call(page, 'run', 'move_camera', { motion: 'stop' });
  const after = await call(page, 'pose');
  const routeStart = await page.evaluate(
    (p) => window.__qaVerbs.fromDegrees(p.lon, p.lat, 0),
    ROUTE[0].path[1],
  );
  await strict.check(
    page,
    ID,
    `${engine}/engine: fly_route dollies along the route and stops level`,
    result?.ok === true &&
      motion?.kind === 'route' &&
      motion.progress > 0.25 &&
      len(sub(mid.position, before.position)) > 100 &&
      len(sub(mid.position, routeStart)) < 3000 &&
      stop?.stopped === true &&
      Math.abs(wrapDeg(deg(after.roll))) < 0.01 &&
      (await call(page, 'motion')) === null,
    {
      result,
      motion,
      heightM: mid.height,
      fromRouteM: len(sub(mid.position, routeStart)),
    },
  );
}

/** Start a continuous verb, switch engines, and check nothing is left. */
async function switchReleases(page, from, to, path) {
  await call(page, 'place', START);
  const target = await call(page, 'target');
  if (path === 'engine') await call(page, 'useEngine', target);
  const run = await continuous(
    page,
    { motion: 'orbit', direction: 'right', mode: 'continuous' },
    0.4,
    path,
  );
  await strict.switchTo(page, to);
  await installHelpers(page);
  const after = {
    motion: await call(page, 'motion'),
    holds: await call(page, 'holds'),
  };
  await strict.check(
    page,
    ID,
    `${from} -> ${to}: an engine switch releases the running verb`,
    run.running?.kind === 'orbit' &&
      after.motion === null &&
      !after.holds.includes('camera-verb'),
    { before: run.running, after },
  );
}

const compare = (a, b) =>
  Object.fromEntries(Object.keys(a).map((k) => [k, Math.abs(a[k] - b[k])]));

await strict.run(
  {
    headless: true,
    args: ['--use-angle=metal', '--enable-gpu'],
  },
  async (browser) => {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await openApp(page, base.origin, 'cesium');
    await installHelpers(page);
    assert.ok(
      await page.evaluate(() => Boolean(window.__gevCameraVerbs)),
      'serve a development build: the verbs hook is missing',
    );

    // Cesium: the voice runner (viewer camera), then the contract camera.
    assert.ok(await voiceOffers(page), 'Cesium voice offers move_camera');
    const viewer = await engineChecks(page, 'cesium', 'voice');
    const contract = await engineChecks(page, 'cesium', 'engine');
    const parity = Object.fromEntries(
      Object.keys(viewer).map((name) => [
        name,
        compare(viewer[name], contract[name]),
      ]),
    );
    await strict.check(
      page,
      ID,
      'cesium: every once verb lands alike through the viewer and through engineFromViewer',
      Object.values(parity).every((d) =>
        Object.entries(d).every(([k, v]) =>
          k.endsWith('M') ? v < 0.02 * 1250 : v < 0.1,
        ),
      ),
      parity,
    );
    await routeCheck(page, 'cesium');
    await switchReleases(page, 'cesium', 'navara', 'voice');

    // Navara: voice when its tools offer the verbs, else the hook.
    const navaraPath = (await voiceOffers(page)) ? 'voice' : 'engine';
    strict.extra.navaraPath = navaraPath;
    console.log(`navara verbs via ${navaraPath}`);
    const navara = await engineChecks(page, 'navara', navaraPath);
    strict.extra.effects = { viewer, contract, navara };
    await routeCheck(page, 'navara');
    await switchReleases(page, 'navara', 'cesium', 'engine');
    assert.deepEqual(errors, [], 'no page errors');
    console.log(JSON.stringify({ parity, navaraPath }, null, 1));
  },
);
console.log('qa-navara-camera-verbs: pass');
