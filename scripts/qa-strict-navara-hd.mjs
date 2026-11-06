// Contract: the two Navara choices on a 2x screen. Navara draws at CSS
// pixels, Navara HD at the device pixel ratio. A pick between them builds
// the other variant on the same session and releases the one it leaves (its
// WebGL context is lost: only one Navara holds memory), the new one draws a
// non-blank frame, the address and the stored choice follow the pick, and
// Cesium stays the warm, parked engine across them.
//
//   node scripts/qa-strict-navara-hd.mjs http://127.0.0.1:4208

import assert from 'node:assert/strict';
import {
  createStrict,
  localPreview,
  waitForEngine,
} from './qa-strict-harness.mjs';
import {
  installFirstFrameProbe,
  installSessionFixtures,
  openApp,
  rememberEngine,
  sessionState,
  startSession,
} from './qa-strict-session.mjs';

const base = localPreview(process.argv[2]);
const strict = createStrict({ origin: base.origin, layers: [] });
await strict.run({}, async (b) => {
  const p = await b.newPage();
  await p.setViewport({ width: 1280, height: 800, deviceScaleFactor: 2 });
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  await installSessionFixtures(p, { flights: 20 });
  await installFirstFrameProbe(p);
  await openApp(p, base.origin, 'navara');
  await startSession(p, ['earthquakes', 'flights']);
  const contract = (name, value, detail) => {
    assert.ok(value, name + ' ' + JSON.stringify(detail ?? ''));
    strict.extra.contracts ??= [];
    strict.extra.contracts.push({ name, pass: true, detail });
    console.log('PASS', name);
  };
  // The running engine's canvas: its pixel ratio, and whether the engine
  // remembered under `kind` still has a live context.
  const look = (kind) =>
    p.evaluate((kind) => {
      const { engine } = window.__godsEyeView;
      const canvas = engine.host.canvas;
      const old = window.__qaEngines.get(kind);
      const oldCanvas = old?.host.canvas;
      return {
        engine: engine.kind,
        ratio: Math.round((canvas.width / canvas.clientWidth) * 100) / 100,
        same: old === engine,
        oldLost:
          (
            oldCanvas?.getContext('webgl2') ?? oldCanvas?.getContext('webgl')
          )?.isContextLost() ?? null,
        stored: localStorage.getItem('gev.engine'),
      };
    }, kind);
  const draws = (kind) =>
    p.evaluate(
      (kind) =>
        Promise.race([
          window.__qaFirstFrame(kind).then(() => true),
          new Promise((resolve) => setTimeout(() => resolve(false), 15000)),
        ]),
      kind,
    );
  const session = async () => {
    const state = await sessionState(p);
    return state.manager && state.models && state.enabled ? state : null;
  };
  const pick = async (choice) => {
    await strict.pick(p, choice);
    await waitForEngine(p, choice);
  };

  const start = await look('navara');
  contract(
    'Navara draws at CSS pixels on a 2x screen',
    start.ratio === 1,
    start,
  );

  // Navara → Navara HD: a new engine at the device pixel ratio.
  await pick('navara-hd');
  const hd = await look('navara');
  const hdState = await session();
  contract(
    'Navara HD is a new Navara engine at the device pixel ratio; the Navara it left is released',
    hd.engine === 'navara' &&
      hd.ratio === 2 &&
      !hd.same &&
      hd.oldLost === true &&
      hdState?.address === 'navara-hd' &&
      hdState?.picker === 'navara-hd' &&
      hd.stored === 'navara-hd',
    { ...hd, address: hdState?.address, picker: hdState?.picker },
  );
  await rememberEngine(p);
  contract('Navara HD draws a non-blank frame', await draws('navara'));

  // Navara HD → Cesium → Navara HD: Cesium is built once, HD stays warm.
  await pick('cesium');
  await rememberEngine(p);
  await pick('navara');
  await pick('cesium');
  const cesium = await look('cesium');
  contract(
    'Cesium stays the warm parked engine across the Navara variants',
    cesium.same && cesium.ratio === 1,
    cesium,
  );

  // Back to Navara HD through Navara: each pick releases the other variant.
  await pick('navara');
  await rememberEngine(p);
  await pick('navara-hd');
  const again = await look('navara');
  contract(
    'a pick from Navara to Navara HD releases Navara and keeps the session',
    !again.same &&
      again.oldLost === true &&
      again.ratio === 2 &&
      (await session()) !== null,
    again,
  );
  await rememberEngine(p);
  await pick('navara');
  const back = await look('navara');
  const backState = await session();
  contract(
    'a pick from Navara HD to Navara draws at CSS pixels again, on the same session',
    !back.same &&
      back.oldLost === true &&
      back.ratio === 1 &&
      backState?.address === 'navara' &&
      back.stored === 'navara',
    back,
  );
  await rememberEngine(p);
  contract('Navara draws a non-blank frame again', await draws('navara'));
  contract('no uncaught page errors', errors.length === 0, errors);
});
