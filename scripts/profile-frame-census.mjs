#!/usr/bin/node
/**
 * profile-frame-census.mjs — per-frame callback census for God's Eye View.
 *
 * Companion to docs/PLAN.md Phase 15B ("per-frame walk census"). It wraps the
 * live scene's frame events (preUpdate/preRender/postUpdate/postRender) in the
 * REAL running app and records, per consumer, how many times its callback ran
 * per rendered frame in two regimes:
 *
 *   parked  — no camera input; whatever the render governor produces on its own
 *   motion  — a scripted heading orbit, driven from Cesium's own preRender
 *
 * Attribution: a listener's own frame can never be captured from inside a
 * wrapper (at wrapper-call time the listener has not been entered — the stack
 * holds only probe + Cesium frames; verified empirically). So the census
 * attributes at REGISTRATION time: the patched addEventListener captures the
 * registering stack, whose first `/src/...` frame under the vite dev server
 * names the file, function, and line that owns the per-frame consumer.
 * Listeners already attached before install (baseline boot set) cannot be
 * attributed this way and are labeled by their function name instead.
 *
 * Known instrument limits, stated plainly:
 *   - Cesium's Event stores listeners in the private `_listeners` Map
 *     (Map<listener, Set<scope>>; verified against the installed
 *     @cesium/engine Event.js). The census re-keys existing entries in place
 *     AND re-patches addEventListener/removeEventListener, so mid-window
 *     (un)registration keeps working against the wrappers — including Cesium's
 *     deferred _toAdd/_toRemove flush, whose entries were already wrapped at
 *     the public API boundary. The app under test is a dev page; nothing here
 *     ships.
 *   - `calls/frame` > 1 means a consumer registers the same callback more than
 *     once (a leak signature), not a multi-tap within one frame.
 *   - Headless Chrome renders via SwiftShader; the census counts CALLBACKS,
 *     which are frame-rate independent, so absolute fps stays out (the
 *     standing docs/PERFORMANCE.md rule).
 *
 * Usage:
 *   node scripts/profile-frame-census.mjs                     # all scenes
 *   node scripts/profile-frame-census.mjs --scene baseline    # no extra layers
 *   node scripts/profile-frame-census.mjs --scene targets     # census cohort
 *   node scripts/profile-frame-census.mjs --url http://... --json out.json
 *
 * Scenes:
 *   baseline  boot layers only — the empty-canvas reference
 *   targets   radio + military-awareness + planets + rocket-launches enabled
 *             (docs/PLAN.md Phase 15B's cadence cohort)
 */

import fs from 'node:fs';
import puppeteer from 'puppeteer';

const args = process.argv.slice(2);
function argValue(flag, fallback) {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}
const BASE_URL = argValue('--url', 'http://localhost:4173');
const ONLY_SCENE = argValue('--scene', 'all');
const JSON_OUT = argValue('--json', null);
const PARKED_MS = Number(argValue('--parked-ms', '12000'));
const MOTION_MS = Number(argValue('--motion-ms', '12000'));

// The QA suites' launcher convention (scripts/qa-a11y.mjs): Puppeteer's own
// Chrome for Testing, overridable via env — the system chromium auto-updates
// under us and its newer protocol hangs puppeteer's browser-level attach.
const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH
  || await (async () => { try { return await puppeteer.executablePath(); } catch { return null; } })();
if (!executablePath || !fs.existsSync(executablePath)) {
  throw new Error('Puppeteer Chrome for Testing is unavailable (set PUPPETEER_EXECUTABLE_PATH)');
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The census probe itself, stringified so it can be installed via
// page.evaluate. Wraps the four scene events; see the module docblock.
const CENSUS_INSTALL = `
  (() => {
    if (window.__gevFrameCensus) return window.__gevFrameCensus.summary();
    const scene = window.__godsEyeView.viewer.scene;
    const EVENT_NAMES = ['preUpdate', 'preRender', 'postUpdate', 'postRender'];
    const census = { events: {} };

    const ownerFromStack = (stack) => {
      if (!stack) return { file: '(native)', fn: '(unknown)', line: 0 };
      const lines = stack.split('\\n');
      // The innermost frames are the probe's own wrapper (evaluated from this
      // script, so its frame URL is a pptr:evaluate blob naming this file) —
      // skip them or every listener gets attributed to the census itself.
      const isProbeFrame = (line) => /pptr:evaluate|profile-frame-census\\.mjs|evalmachine/.test(line);
      for (const line of lines) {
        if (isProbeFrame(line)) continue;
        const m = line.match(/at\\s+([^\\s(]+)?\\s*\\(?(https?:[^)\\s]+|file:[^)\\s]+):(\\d+):(\\d+)\\)?/);
        if (!m) continue;
        const url = m[2];
        const pathIdx = url.indexOf('/src/');
        if (pathIdx === -1) continue;
        const file = url.slice(pathIdx + 1).split('?')[0];
        let fn = m[1] || '(anonymous)';
        if (fn === 'new' || fn === 'Array') fn = '(constructor)';
        return { file, fn, line: Number(m[3]) };
      }
      // No /src/ frame: attribute to the first non-Cesium, non-probe frame if
      // any, else Cesium.
      for (const line of lines) {
        if (isProbeFrame(line)) continue;
        const m = line.match(/at\\s+([^\\s(]+)?\\s*\\(?(.+):(\\d+):(\\d+)\\)?/);
        if (!m) continue;
        if (/cesium|node_modules/.test(m[2])) continue;
        return { file: m[2].split('/').slice(-1)[0], fn: m[1] || '(anonymous)', line: Number(m[3]) };
      }
      return { file: '(cesium internal)', fn: '(unknown)', line: 0 };
    };

    for (const name of EVENT_NAMES) {
      const ev = scene[name];
      if (!ev || !(ev._listeners instanceof Map)) continue;
      const rec = { raises: 0 };
      const wrapOf = new Map();   // original fn -> wrapped fn
      const infoOf = new Map();   // wrapped fn -> { calls, owner }

      const wrap = (fn, owner) => {
        if (typeof fn !== 'function' || wrapOf.has(fn)) return fn;
        const info = {
          calls: 0,
          // Pre-attached listeners (installed before the probe) carry no
          // registration stack — label them by function name so the report
          // still separates them per function.
          owner: owner || { file: '(pre-attached)', fn: fn.name || '(anonymous)', line: 0 },
        };
        const wrapped = function (...cbArgs) {
          info.calls += 1;
          return fn.apply(this, cbArgs);
        };
        wrapOf.set(fn, wrapped);
        infoOf.set(wrapped, info);
        return wrapped;
      };

      // Wrap listeners already installed (re-key in place — raiseEvent walks
      // _listeners.entries(), so the Map keys ARE the call targets).
      for (const [fn, scopes] of [...ev._listeners.entries()]) {
        const wrapped = wrap(fn);
        if (wrapped !== fn) {
          ev._listeners.set(wrapped, scopes);
          ev._listeners.delete(fn);
        }
      }
      // Keep mid-window registration/removal correct against wrappers. The
      // remover returned by the original addEventListener closes over the
      // (wrapped) listener + scope it was given, so it needs no re-wrap here.
      // Cesium's deferred _toAdd/_toRemove flush only receives listeners that
      // already passed through this public boundary, so they are wrapped too.
      // The registration-time stack is the ONLY place the owning app frame is
      // observable (see the module docblock) — capture it here.
      const origAdd = ev.addEventListener.bind(ev);
      const origRemove = ev.removeEventListener.bind(ev);
      ev.addEventListener = (fn, scope) => origAdd(wrap(fn, ownerFromStack(new Error().stack)), scope);
      ev.removeEventListener = (fn, scope) => origRemove(wrapOf.get(fn) || fn, scope);

      // Count rendered frames: one raiseEvent call == one frame through this event.
      const origRaise = ev.raiseEvent.bind(ev);
      ev.raiseEvent = (...raiseArgs) => {
        rec.raises += 1;
        return origRaise(...raiseArgs);
      };

      census.events[name] = {
        snapshot() {
          // Aggregate per owner. Same-file-same-fn duplicates are KEPT and
          // summed — calls/frame > 1 for one owner is a double-registration
          // leak signature, which the report surfaces instead of hiding.
          const merged = new Map();
          let silent = 0;
          for (const info of infoOf.values()) {
            if (info.calls === 0) { silent += 1; continue; }
            // Key on file :: fn :: line so two same-named listeners at
            // different registration sites stay distinct rows (anonymous
            // callbacks would otherwise merge into one misleading count).
            const key = (info.owner?.file || '(unknown)') + ' :: '
              + (info.owner?.fn || '(unknown)') + ' @' + (info.owner?.line ?? '?');
            const entry = merged.get(key) || { calls: 0, registrations: 0 };
            entry.calls += info.calls;
            entry.registrations += 1;
            merged.set(key, entry);
          }
          return {
            raises: rec.raises,
            listeners: ev._listeners.size,
            silentWrapped: silent,
            consumers: [...merged.entries()]
              .map(([owner, v]) => ({
                owner,
                calls: v.calls,
                registrations: v.registrations,
                perFrame: rec.raises ? v.calls / rec.raises : 0,
              }))
              .sort((a, b) => b.calls - a.calls),
          };
        },
        reset() {
          rec.raises = 0;
          for (const info of infoOf.values()) info.calls = 0;
        },
      };
    }

    window.__gevFrameCensus = {
      reset() { for (const rec of Object.values(census.events)) rec.reset(); },
      summary() {
        const out = {};
        for (const [name, rec] of Object.entries(census.events)) out[name] = rec.snapshot();
        return out;
      },
    };
    return window.__gevFrameCensus.summary();
  })()
`;

const MOTION_DRIVER = `
  (() => {
    const viewer = window.__godsEyeView.viewer;
    const C3 = viewer.camera.positionWC.constructor;
    window.__gevCensusOrbit = {
      last: performance.now(),
      elapsed: 0,
      remove: null,
      // ~30° of heading per second — the profile-runtime storm orbit.
      listener: () => {
        const now = performance.now();
        window.__gevCensusOrbit.elapsed += now - window.__gevCensusOrbit.last;
        window.__gevCensusOrbit.last = now;
        viewer.camera.setView({
          destination: C3.fromDegrees(-97.66, 30.2, 2.2e6),
          orientation: { heading: (window.__gevCensusOrbit.elapsed / 1000) * (Math.PI / 6), pitch: -Math.PI / 2.4 },
        });
      },
    };
    window.__gevCensusOrbit.remove = viewer.scene.preRender.addEventListener(window.__gevCensusOrbit.listener);
  })()
`;

async function enableLayers(page, layerIds) {
  const perLayer = [];
  for (const id of layerIds) {
    const t0 = Date.now();
    let outcome;
    try {
      outcome = await Promise.race([
        page.evaluate(async (layerId) => {
          const dm = window.__godsEyeView?.dataManager;
          if (!dm || !dm.layers?.has(layerId)) return { outcome: 'missing' };
          // Record the transaction's own visibility notifications — the
          // failed/cancelled paths are silent in the console, so this is the
          // only place a `not-enabled` outcome names its cause.
          const notifications = [];
          const unsubscribe = dm.subscribe((change) => {
            if (change?.layerId !== layerId) return;
            notifications.push(change.type + (change.reason ? `:${change.reason}` : ''));
          });
          try {
            await dm.setEnabled(layerId, true, { origin: 'programmatic' });
            const entry = dm.layers.get(layerId);
            const state = {
              effective: dm.isEffectivelyEnabled(layerId),
              settled: dm.isEnabled(layerId),
              lifecycle: entry?.lifecycleState,
              uncertain: entry?.lifecycleUncertain,
            };
            const ok = state.effective && state.settled;
            return { outcome: ok ? 'enabled' : 'not-enabled', state, notifications };
          } finally {
            unsubscribe();
          }
        }, id),
        // rocket-launches enable awaits upstream feeds with fallbacks —
        // 45 s was not enough under host load; 90 s covers the observed
        // worst case (~60 s).
        new Promise((resolve) => setTimeout(() => resolve({ outcome: 'timeout:90s' }), 90_000)),
      ]).then((r) => (typeof r === 'string' ? { outcome: r } : r));
    } catch (error) {
      outcome = { outcome: `error:${String(error?.message || error).slice(0, 60)}` };
    }
    perLayer.push({ id, ms: Date.now() - t0, ...outcome });
    const detail = outcome.state
      ? ` [${JSON.stringify(outcome.state)}]${outcome.notifications?.length ? ` notif: ${outcome.notifications.join(',')}` : ''}`
      : '';
    console.log(`    enable ${id}: ${outcome.outcome} (${Date.now() - t0} ms)${detail}`);
  }
  return perLayer;
}

async function ensureLoaded(page) {
  const ready = await page
    .waitForFunction(
      () => window.__godsEyeView && window.__godsEyeView.viewer && window.__godsEyeView.dataManager,
      { timeout: 5_000, polling: 200 },
    )
    .then(() => true)
    .catch(() => false);
  if (ready) return;
  // Under heavy host load (documented QA environment: load average 45–190 on
  // this NAS) module-script execution can hold domcontentloaded for many
  // minutes even though the server answers instantly (measured 2026-10-03:
  // main.js 17 ms, cesium dep 5.6 MB in 5 s, yet 3×600 s DCL timeouts — the
  // stall is browser-side). A rejected goto does NOT cancel the navigation —
  // it keeps loading — so the pattern is: give the goto a short leash
  // (expected to time out), then wait for the app on the SAME page. Re-goto
  // would abort the in-flight boot and restart it, which never converges.
  try {
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 10_000 });
  } catch {
    // Navigation committed; the boot continues in the page. Fall through.
  }
  await page.waitForFunction(
    () => window.__godsEyeView && window.__godsEyeView.viewer && window.__godsEyeView.dataManager,
    { timeout: 900_000, polling: 1_000 },
  );
  await sleep(3_000);
}

/** One census phase: reset counters, hold the regime, read back. */
async function samplePhase(page, label, ms, motion) {
  // A missing probe means the page navigated or reloaded mid-run (e.g. a
  // source edit triggered a vite full reload while the census was sampling).
  // Fail loudly — continuing would print empty tables that read as "no
  // per-frame consumers", the opposite of the truth.
  const alive = await page.evaluate(() => Boolean(window.__gevFrameCensus)).catch(() => false);
  if (!alive) throw new Error('census probe lost — the page navigated/reloaded mid-run; re-run without editing served sources');
  await page.evaluate(() => window.__gevFrameCensus.reset());
  if (motion) await page.evaluate(MOTION_DRIVER);
  await sleep(ms);
  if (motion) {
    await page.evaluate(() => {
      window.__gevCensusOrbit?.remove?.();
      window.__gevCensusOrbit = null;
    });
  }
  const summary = await page.evaluate(() => window.__gevFrameCensus.summary());
  return { label, wallMs: ms, motion, summary };
}

function printPhase(sceneName, phase) {
  console.log(`\n  ${sceneName} / ${phase.label} (${phase.wallMs / 1000}s ${phase.motion ? 'motion' : 'parked'}):`);
  for (const [eventName, snap] of Object.entries(phase.summary)) {
    const hz = (snap.raises / (phase.wallMs / 1000)).toFixed(1);
    console.log(`    ${eventName}: ${snap.raises} frames (${hz}/s), ${snap.listeners} listeners`
      + `${snap.silentWrapped ? `, ${snap.silentWrapped} never called` : ''}`);
    for (const consumer of snap.consumers) {
      const dup = consumer.registrations > 1 ? ` [${consumer.registrations} registrations!]` : '';
      console.log(`      ${consumer.calls.toString().padStart(6)} calls  ${consumer.perFrame.toFixed(2)}/frame  ${consumer.owner}${dup}`);
    }
  }
}

const browser = await puppeteer.launch({
  executablePath,
  headless: 'new',
  timeout: 180_000,
  // 30 min: under heavy host load the renderer's main thread can block for
  // many minutes during SwiftShader boot (measured 2026-10-03: trivial
  // Runtime.callFunctionOn calls exceeded a 600 s protocol ceiling while the
  // page was booting), which would kill the session mid-wait.
  protocolTimeout: 1_800_000,
  args: [
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--enable-unsafe-swiftshader',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--window-size=1600,900',
  ],
});
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 900 });
  // Layer enable failures surface as `[Data] <layer> ... error:` console
  // warnings from the manager's transaction rollback — capture them so a
  // `not-enabled` outcome comes with its cause instead of a bare label.
  const consoleLines = [];
  const pageErrors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error' || msg.type() === 'warning') {
      consoleLines.push(`${msg.type()}: ${msg.text().slice(0, 300)}`);
    }
  });
  page.on('pageerror', (error) => pageErrors.push(String(error?.message || error).slice(0, 300)));
  await ensureLoaded(page);
  // Install the probe AFTER boot so it wraps the listeners the app already
  // registered (in place) and patches add/remove for anything attached later.
  const installed = await page.evaluate(CENSUS_INSTALL);
  // CENSUS_INSTALL returns summary()-shaped output (one key per event).
  console.log(`census probe installed: ${Object.keys(installed || {}).length} scene events wrapped`);

  const scenes = [];
  if (ONLY_SCENE === 'all' || ONLY_SCENE === 'baseline') scenes.push('baseline');
  if (ONLY_SCENE === 'all' || ONLY_SCENE === 'targets') scenes.push('targets');

  const results = [];
  for (const sceneName of scenes) {
    console.log(`\n scene ${sceneName}:`);
    if (sceneName === 'targets') {
      const enabled = await enableLayers(page, [
        'radio', 'military-awareness', 'planets', 'rocket-launches',
      ]);
      if (enabled.some((e) => e.outcome !== 'enabled')) {
        console.log('  (layer enable reported problems — counts below are still recorded as-is)');
      }
      await sleep(4_000); // first polls + cluster/declutter installs settle
    }
    const parked = await samplePhase(page, 'parked', PARKED_MS, false);
    printPhase(sceneName, parked);
    const motion = await samplePhase(page, 'motion', MOTION_MS, true);
    printPhase(sceneName, motion);
    results.push({ scene: sceneName, parked, motion });
  }

  if (JSON_OUT) {
    fs.writeFileSync(JSON_OUT, `${JSON.stringify(results, null, 2)}\n`);
    console.log(`\nJSON written: ${JSON_OUT}`);
  }
  const relevant = consoleLines.filter((l) => /\[Data\]|planets|census|uncaught/i.test(l));
  if (relevant.length > 0 || pageErrors.length > 0) {
    console.log(`\nconsole warnings/errors (${relevant.length} relevant of ${consoleLines.length} captured):`);
    for (const line of relevant.slice(0, 20)) console.log(`  ${line}`);
    for (const err of pageErrors.slice(0, 10)) console.log(`  pageerror: ${err}`);
  }
  console.log('\nFRAME CENSUS PASS');
} finally {
  await browser.close();
}
