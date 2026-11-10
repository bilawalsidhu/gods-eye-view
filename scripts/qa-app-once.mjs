import { closeBrowser, exitAfterFlush } from './qa/browser.mjs';
import { localPreview, waitForEngine } from './qa-strict-harness.mjs';
// The application is created once per page: switching engines detaches and
// attaches only the engine-bound parts. This gate runs three Cesium→Navara→
// Cesium round trips and checks that every session object keeps its identity,
// an open panel, typed text and the focused field survive, Escape still does
// what it did before the switches, window/document listeners do not grow,
// and a failed candidate rolls back onto the same session objects.
//
// node scripts/qa-app-once.mjs http://127.0.0.1:<port>/ [--report]
// `--report` prints the measurements without asserting them.
import assert from 'node:assert/strict';
import {
  idDifference,
  launch,
  listenerCounts,
  listenerDifference,
  openSessionPage,
  readSession,
  requestEngine,
  sessionAddress,
  switchEngine,
} from './qa/appSessionHarness.mjs';

const base = localPreview(process.argv[2]);
const reportOnly = process.argv.includes('--report');
const report = { switches: [], failures: [] };
const check = (condition, message, detail) => {
  if (condition) return;
  report.failures.push({ message, detail });
  if (!reportOnly)
    assert.fail(`${message}${detail ? ` ${JSON.stringify(detail)}` : ''}`);
};

const FIELD = '#location-search';
const PANEL = 'data-panel';

// The page's visible UI state the switches must leave alone.
const readUi = (page) =>
  page.evaluate(
    (field, panel) => ({
      value: document.querySelector(field)?.value ?? null,
      focused: document.activeElement?.id || null,
      panelOpen: !document
        .getElementById(panel)
        ?.classList.contains('collapsed'),
    }),
    FIELD,
    PANEL,
  );

// Focus the field, press Escape and read what changed; then put the state
// back. The same press before and after the switches must have the same
// effect.
async function escapeEffect(page) {
  await page.focus(FIELD);
  const before = await readUi(page);
  await page.keyboard.press('Escape');
  await new Promise((resolve) => setTimeout(resolve, 400));
  const after = await readUi(page);
  return { before, after };
}

async function prepareUi(page) {
  await page.evaluate((panel) => {
    const style = window.__godsEyeView.styleManager;
    style.setPanelCollapsed(panel, false, { explicit: true });
    style.setPanelCollapsed('location-bar', false, { explicit: true });
  }, PANEL);
  await page.waitForFunction(
    (field) => document.querySelector(field)?.offsetParent !== null,
    {},
    FIELD,
  );
  await page.evaluate((field) => {
    const input = document.querySelector(field);
    input.focus();
    input.value = 'Reykjav';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, FIELD);
}

// The session's tools: a mark on the annotation board, an imported file and
// the Draw shape, set on Cesium before the switches.
async function prepareTools(page) {
  return page.evaluate(async () => {
    const annotated = await window.__gevAnnotations.annotate([
      { type: 'pin', latitude: 42.3554, longitude: -71.0605, label: 'QA mark' },
    ]);
    const file = new File(
      [
        JSON.stringify({
          type: 'FeatureCollection',
          features: [
            {
              type: 'Feature',
              properties: { name: 'QA area' },
              geometry: {
                type: 'Polygon',
                coordinates: [
                  [
                    [-71.07, 42.35],
                    [-71.05, 42.35],
                    [-71.05, 42.36],
                    [-71.07, 42.35],
                  ],
                ],
              },
            },
          ],
        }),
      ],
      'qa-area.geojson',
      { type: 'application/geo+json' },
    );
    const imported = await window.__gevGeoImport.importFiles([file]);
    window.__gevDrawTool.setShape('line');
    return { annotated: annotated.drawn, imported: imported[0]?.ok };
  });
}

const readTools = (page) =>
  page.evaluate(() => ({
    marks: window.__gevAnnotations?.count() ?? null,
    marksDrawn: window.__gevAnnotations?.attached ?? null,
    files: window.__gevGeoImport?.list().length ?? null,
    filesDrawn: window.__gevGeoImport?.diagnostics().drawn ?? null,
    drawShape: window.__gevDrawTool?.shape ?? null,
  }));

// Listeners whose difference is the parked renderer's: the Navara engine
// keeps its own input, resize and attribution listeners while it is parked
// for a switch back (scripts that are not the session's).
const PARKED_RENDERER = /@navara-engine\.js$/;

const browser = await launch();
try {
  const { page, errors } = await openSessionPage(
    browser,
    sessionAddress(base, { engine: 'cesium' }),
  );
  await waitForEngine(page, 'cesium', { timeout: 90_000 });
  // Let the first boot's deferred listeners land before counting.
  await new Promise((resolve) => setTimeout(resolve, 2000));
  const boot = await readSession(page);
  const bootListeners = await listenerCounts(page, { bySource: true });
  report.boot = boot;
  report.toolsPrepared = await prepareTools(page);
  check(
    report.toolsPrepared.annotated === 1 && report.toolsPrepared.imported,
    'the tools could not be prepared',
    report.toolsPrepared,
  );
  // Let the imported file finish drawing.
  await page.waitForFunction(
    () => window.__gevGeoImport.diagnostics().drawn === 1,
  );
  const toolsBefore = await readTools(page);
  report.toolsBefore = toolsBefore;

  await prepareUi(page);
  const escapeBefore = await escapeEffect(page);
  report.escapeBefore = escapeBefore;
  await prepareUi(page);
  const uiBefore = await readUi(page);
  report.uiBefore = uiBefore;

  const sequence = ['navara', 'cesium', 'navara', 'cesium', 'navara', 'cesium'];
  // Dev guard: once an engine is parked, nothing may move its camera or
  // ask it to draw until it is attached again (its own resume aside).
  await page.evaluate(() => {
    window.__qaParkedCalls = [];
    window.__qaWatchParked = (engine) => {
      if (!engine || engine.__qaWatched) return;
      engine.__qaWatched = true;
      const watch = (owner, names, label) => {
        for (const name of names) {
          const original = owner[name];
          if (typeof original !== 'function') continue;
          owner[name] = function (...args) {
            const parked = window.__godsEyeView?.engine !== engine;
            const resume = name === 'request' && args[0] === 'engine-resume';
            if (parked && !resume && !window.__qaSwitching)
              window.__qaParkedCalls.push({
                call: `${engine.kind}.${label}.${name}`,
                reason: typeof args[0] === 'string' ? args[0] : null,
                stack: new Error().stack.split('\n').slice(2, 6).join(' | '),
              });
            return original.apply(this, args);
          };
        }
      };
      watch(
        engine.camera,
        ['setView', 'flyTo', 'lookAt', 'flyToBoundingSphere', 'release'],
        'camera',
      );
      watch(engine.render, ['request', 'setContinuous'], 'render');
    };
    window.__qaWatchParked(window.__godsEyeView.engine);
  });
  for (const kind of sequence) {
    const started = Date.now();
    // The switch itself parks and resumes engines; only the time an engine
    // sits parked is watched.
    await page.evaluate(() => {
      window.__qaSwitching = true;
    });
    await switchEngine(page, kind);
    await page.evaluate(() => {
      window.__qaSwitching = false;
      window.__qaWatchParked(window.__godsEyeView.engine);
    });
    const state = await readSession(page);
    const ui = await readUi(page);
    if (kind === 'navara')
      await page.evaluate(() => {
        window.__qaParkedNavara = window.__godsEyeView.engine;
      });
    if (report.switches.length === 1) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      report.firstRoundTrip = await listenerCounts(page, { bySource: true });
    }
    // Both engines draw the session's marks and files (Navara included).
    await page.waitForFunction(
      () => window.__gevGeoImport.diagnostics().drawn === 1,
      { timeout: 30_000 },
    );
    const tools = await readTools(page);
    check(
      tools.marks === toolsBefore.marks &&
        tools.files === toolsBefore.files &&
        tools.drawShape === toolsBefore.drawShape &&
        tools.marksDrawn === true &&
        tools.filesDrawn === 1,
      `the session tools changed on the switch to ${kind}`,
      { toolsBefore, tools },
    );
    report.switches.push({
      kind,
      ms: Date.now() - started,
      ids: idDifference(boot.ids, state.ids),
      counters: state.counters,
      ui,
      tools,
    });
    check(
      Object.keys(idDifference(boot.ids, state.ids)).length === 0,
      `session ids changed on the switch to ${kind}`,
      idDifference(boot.ids, state.ids),
    );
    check(
      ui.value === uiBefore.value,
      `typed text lost on the switch to ${kind}`,
      ui,
    );
    check(ui.panelOpen, `open panel closed on the switch to ${kind}`, ui);
    check(
      ui.focused === uiBefore.focused,
      `focus moved on the switch to ${kind}`,
      ui,
    );
  }
  await new Promise((resolve) => setTimeout(resolve, 2000));
  const after = await readSession(page);
  const afterListeners = await listenerCounts(page, { bySource: true });
  report.after = after;
  // After three round trips the page holds exactly the listeners it held
  // after the first boot, apart from the parked Navara renderer's own (it
  // stays alive for the switch back), which the first round trip added and
  // the later ones did not grow.
  report.listeners = listenerDifference(bootListeners, afterListeners);
  report.listenersSinceFirstRoundTrip = listenerDifference(
    report.firstRoundTrip,
    afterListeners,
  );
  const sessionListeners = Object.keys(report.listeners).filter(
    (key) => !PARKED_RENDERER.test(key),
  );
  check(
    sessionListeners.length === 0,
    'session listeners on window/document changed after three round trips',
    report.listeners,
  );
  check(
    Object.keys(report.listenersSinceFirstRoundTrip).length === 0,
    'listeners on window/document grew after the first round trip',
    report.listenersSinceFirstRoundTrip,
  );
  check(
    after.counters?.attachments === 1 + sequence.length &&
      after.counters?.detaches === sequence.length,
    'each switch detaches once and attaches once',
    after.counters,
  );
  report.parkedEngineCalls = await page.evaluate(() => window.__qaParkedCalls);
  check(
    report.parkedEngineCalls.length === 0,
    'a parked engine had its camera moved or a frame requested',
    report.parkedEngineCalls,
  );
  check(
    after.counters?.applications === 1,
    'the application must be created once',
    after.counters,
  );

  const escapeAfter = await escapeEffect(page);
  report.escapeAfter = escapeAfter;
  check(
    JSON.stringify(escapeAfter) === JSON.stringify(escapeBefore),
    'Escape behaves differently after the switches',
    { escapeBefore, escapeAfter },
  );

  // A failed candidate: the parked Navara renderer refuses to resume (as in
  // qa-layer-handoff.mjs). The working Cesium attaches again on the same
  // session objects.
  await prepareUi(page);
  const beforeRollback = await readSession(page);
  const historyLength = await page.evaluate(() => history.length);
  await page.evaluate(() => {
    window.__qaRollback = false;
    const parked = window.__qaParkedNavara;
    const request = parked.render.request;
    parked.render.request = function (...args) {
      parked.render.request = request;
      window.__qaRollback = true;
      throw new Error('QA parked renderer failure');
    };
  });
  const sabotaged = true;
  if (sabotaged) {
    await requestEngine(page, 'navara');
    await page.waitForFunction(() => window.__qaRollback === true, {
      timeout: 60_000,
    });
    await waitForEngine(page, 'cesium', { timeout: 90_000 });
    const rolledBack = await readSession(page);
    const ui = await readUi(page);
    report.rollback = {
      ids: idDifference(beforeRollback.ids, rolledBack.ids),
      counters: rolledBack.counters,
      ui,
      history: (await page.evaluate(() => history.length)) - historyLength,
    };
    check(
      Object.keys(report.rollback.ids).length === 0,
      'a rollback changed session ids',
      report.rollback,
    );
    check(
      report.rollback.history === 0,
      'a rollback added a history entry',
      report.rollback,
    );
    check(
      ui.value === uiBefore.value && ui.panelOpen,
      'a rollback lost the UI state',
      ui,
    );
    // The page still switches after the rollback.
    await switchEngine(page, 'navara');
    await switchEngine(page, 'cesium');
    const final = await readSession(page);
    check(
      Object.keys(idDifference(boot.ids, final.ids)).length === 0,
      'ids changed after the rollback',
      idDifference(boot.ids, final.ids),
    );

    // A candidate failing after the shell attached to it: a layer's
    // drawing refuses to attach on Navara. The shell lets go of the failed
    // globe and Cesium attaches again; the next switch works.
    await page.evaluate(() => {
      window.__qaDataRefused = false;
      const module =
        window.__godsEyeView.dataManager.layers.get('earthquakes').module;
      const attach = module.attachRenderer;
      module.attachRenderer = function () {
        module.attachRenderer = attach;
        window.__qaDataRefused = true;
        return Promise.reject(new Error('QA data attach failure'));
      };
    });
    const beforeDataFailure = await page.evaluate(() => history.length);
    await requestEngine(page, 'navara');
    await page.waitForFunction(() => window.__qaDataRefused === true, {
      timeout: 60_000,
    });
    await waitForEngine(page, 'cesium', { timeout: 90_000 });
    const afterDataFailure = await readSession(page);
    report.dataFailure = {
      ids: idDifference(boot.ids, afterDataFailure.ids),
      counters: afterDataFailure.counters,
      history: (await page.evaluate(() => history.length)) - beforeDataFailure,
    };
    check(
      Object.keys(report.dataFailure.ids).length === 0 &&
        report.dataFailure.history === 0,
      'a candidate failing in the data part changed the session',
      report.dataFailure,
    );
    await switchEngine(page, 'navara');
    await switchEngine(page, 'cesium');
    check(
      Object.keys(idDifference(boot.ids, (await readSession(page)).ids))
        .length === 0,
      'ids changed after the data-part failure',
    );
  }
  report.errors = errors;
  check(errors.length === 0, 'page errors', errors);

  console.log(JSON.stringify(report, null, 2));
  if (!reportOnly) console.log('PASS application created once; session kept');
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await closeBrowser(browser);
}
await exitAfterFlush();
