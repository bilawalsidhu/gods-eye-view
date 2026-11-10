// Contract: a switch picked just before the tab is hidden finishes in the
// hidden tab without waiting for a frame (a hidden tab draws nothing) and
// without a rollback, keeps the session and adds one history entry; once the
// tab is shown again the new engine draws a non-blank first frame and the
// layers' timers poll again. Both directions, cold and then warm.
//
//   node scripts/qa-strict-hidden-switch.mjs http://127.0.0.1:4208

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
  sessionState,
  startSession,
} from './qa-strict-session.mjs';

const base = localPreview(process.argv[2]);
const strict = createStrict({ origin: base.origin, layers: [] });
await strict.run({}, async (b) => {
  const p = await b.newPage();
  await p.setViewport({ width: 1280, height: 800 });
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  await installSessionFixtures(p, { flights: 20 });
  await installFirstFrameProbe(p);
  await openApp(p, base.origin, 'navara');
  await startSession(p, ['earthquakes', 'flights']);
  const cdp = await p.createCDPSession();
  // Another tab of the same window: bringing it to the front hides ours.
  const other = await b.newPage();
  await other.goto('about:blank');
  await p.bringToFront();
  const visibility = () => p.evaluate(() => document.visibilityState);
  assert.equal(await visibility(), 'visible');
  const results = [];
  for (const [kind, temperature] of [
    ['cesium', 'cold'],
    ['navara', 'warm'],
    ['cesium', 'warm'],
  ]) {
    const before = await sessionState(p);
    await p.evaluate((kind) => {
      window.__qaHidden = { frame: window.__qaFirstFrame(kind), shown: [] };
      window.__qaHidden.frame.then((t) => (window.__qaHidden.drawn = t));
      // When the tab is hidden, as the page sees it: the time and whether
      // the switch (busy picker) still runs.
      document.addEventListener('visibilitychange', () =>
        window.__qaHidden.shown.push({
          state: document.visibilityState,
          at: performance.now(),
          busy: Boolean(
            document.querySelector(
              '#globe-engine:is([disabled], [aria-busy="true"])',
            ),
          ),
        }),
      );
    }, kind);
    // The person picks, then switches tabs before the globe changes: the
    // other tab comes to the front right after the key. A slow CPU (20x)
    // keeps the switch running past the tab change.
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 20 });
    await strict.pick(p, kind, {
      settle: false,
      afterInput: () => other.bringToFront(),
    });
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
    // rAF does not run in a hidden tab: poll on a timer.
    await p.waitForFunction(
      (kind) =>
        window.__godsEyeView?.engine?.kind === kind &&
        !document.querySelector(
          '#globe-engine:is([disabled], [aria-busy="true"])',
        ) &&
        !document.querySelector('.engine-switch-frame'),
      { polling: 250, timeout: 60000 },
      kind,
    );
    const hidden = await p.evaluate(() => ({
      state: document.visibilityState,
      hide: window.__qaHidden.shown.find((e) => e.state === 'hidden') ?? null,
      pick: { at: window.__qaPick.at, idleAt: window.__qaPick.idleAt },
      drawn: window.__qaHidden.drawn ?? null,
      coverPath:
        window.__godsEyeView.engine.host.canvas.dataset.firstFrameOutcome,
    }));
    await assertSession(
      p,
      kind,
      `${temperature} switch to ${kind} while hidden`,
    );
    const after = await sessionState(p);
    // Shown again: the first frame arrives, the timers poll again.
    const reads = await p.evaluate(() => ({ ...window.__qaReads }));
    await p.bringToFront();
    assert.equal(await visibility(), 'visible');
    // A non-blank frame of the new engine once the tab shows again.
    const shown = await p.evaluate(async (kind) => {
      const at = performance.now();
      const frame = await Promise.race([
        window.__qaFirstFrame(kind),
        new Promise((resolve) => setTimeout(() => resolve(null), 10000)),
      ]);
      return frame && Math.round(frame.presented - at);
    }, kind);
    await p.waitForFunction(
      (reads) => window.__qaReads.flights > reads.flights,
      { polling: 250, timeout: 30000 },
      reads,
    );
    await waitForEngine(p, kind);
    await rememberEngine(p);
    const row = {
      kind,
      temperature,
      coverPath: hidden.coverPath,
      hiddenWhileBusy: Boolean(hidden.hide?.busy),
      settledWhileHidden: hidden.state === 'hidden',
      // From the tab being hidden to the picker being idle again.
      settleAfterHideMs:
        hidden.hide && hidden.pick.idleAt
          ? Math.round(hidden.pick.idleAt - hidden.hide.at)
          : null,
      // Observed: an engine may draw while hidden (Navara renders a requested
      // frame without an animation frame); not part of the contract.
      frameWhileHidden: hidden.drawn !== null,
      firstFrameAfterShownMs: shown,
      history: after.history - before.history,
    };
    results.push(row);
    assert.ok(row.hiddenWhileBusy, 'the tab is hidden while the switch runs');
    assert.ok(row.settledWhileHidden, 'the switch settles in the hidden tab');
    // The cover must leave by a frame or visibility change, never its timeout.
    assert.ok(
      ['frame', 'hidden'].includes(row.coverPath),
      JSON.stringify(row),
    );
    assert.equal(row.history, 1, 'one history entry');
    assert.ok(
      row.firstFrameAfterShownMs !== null,
      'a non-blank frame within 10 s of the tab showing',
    );
    console.log('PASS', JSON.stringify(row));
  }
  strict.extra.contracts = results;
  assert.deepEqual(errors, []);
});
