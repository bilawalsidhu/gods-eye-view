// Contract: a parked globe is released after ?parkedMs= (8 s here; three
// minutes by default). A switch back in time is warm (the same engine
// object); after the delay the parked engine's WebGL context is lost and a
// switch back builds a new engine on the same session that draws a
// non-blank frame. Both directions.
//
//   node scripts/qa-strict-parked-release.mjs http://127.0.0.1:4208

import assert from 'node:assert/strict';
import {
  createStrict,
  localPreview,
  waitForEngine,
} from './qa-strict-harness.mjs';
import {
  assertSession,
  installFirstFrameProbe,
  installSessionFixtures,
  openApp,
  rememberEngine,
  startSession,
} from './qa-strict-session.mjs';

// Room for a cold switch on a busy machine (2-3 s) before the switch back.
const PARKED_MS = 8000;
const base = localPreview(process.argv[2]);
const other = (kind) => (kind === 'navara' ? 'cesium' : 'navara');
const strict = createStrict({ origin: base.origin, layers: [] });
await strict.run({}, async (b) => {
  const p = await b.newPage();
  await p.setViewport({ width: 1280, height: 800 });
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  await installSessionFixtures(p, { flights: 20 });
  await installFirstFrameProbe(p);
  await openApp(p, base.origin, 'navara', undefined, `&parkedMs=${PARKED_MS}`);
  await startSession(p, ['earthquakes', 'flights']);
  const contract = (name, value, detail) => {
    assert.ok(value, name + ' ' + JSON.stringify(detail ?? ''));
    strict.extra.contracts ??= [];
    strict.extra.contracts.push({ name, pass: true, detail });
    console.log('PASS', name);
  };
  const pick = async (kind) => {
    const { at } = await strict.pick(p, kind);
    await waitForEngine(p, kind);
    return at;
  };
  // The running engine is the one remembered under its kind (warm), and
  // the context of `kind`'s remembered engine is lost or not.
  const engines = (kind) =>
    p.evaluate((kind) => {
      const engine = window.__qaEngines.get(kind);
      const canvas = engine?.host.canvas;
      const context =
        canvas?.getContext('webgl2') ?? canvas?.getContext('webgl');
      return {
        warm:
          window.__qaEngines.get(window.__godsEyeView.engine.kind) ===
          window.__godsEyeView.engine,
        lost: context?.isContextLost() ?? null,
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
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  for (const parked of ['navara', 'cesium']) {
    const running = other(parked);
    // Park `parked` afresh (either engine may have been released before).
    if ((await p.evaluate(() => window.__godsEyeView.engine.kind)) !== parked) {
      await pick(parked);
      await rememberEngine(p);
    }
    const parkedAt = await pick(running);
    await rememberEngine(p);
    // A switch back in time is warm.
    await wait(1000);
    const backAt = await pick(parked);
    const early = await engines(parked);
    await assertSession(p, parked, `a quick switch back to ${parked}`);
    contract(
      `a switch back to ${parked} within the delay reuses the parked engine`,
      early.warm && early.lost === false,
      { ...early, parkedMs: Math.round(backAt - parkedAt) },
    );
    // Parked past the delay: released, and the next switch back is cold.
    await pick(running);
    await wait(PARKED_MS + 1500);
    const released = await engines(parked);
    contract(
      `${parked} parked past the delay is released: its context is lost`,
      released.lost === true,
      released,
    );
    await pick(parked);
    const cold = await engines(parked);
    await assertSession(p, parked, `the cold switch back to ${parked}`);
    await rememberEngine(p);
    const drawn = await draws(parked);
    contract(
      `the switch back to a released ${parked} builds a new engine on the same session and draws`,
      !cold.warm && drawn,
      { ...cold, drawn },
    );
  }
  contract('no uncaught page errors', errors.length === 0, errors);
});
