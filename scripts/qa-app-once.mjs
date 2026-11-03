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
  previewBase,
  readSession,
  requestEngine,
  sessionAddress,
  switchEngine,
  waitReady,
} from './qa/appSessionHarness.mjs';

const base = previewBase(process.argv[2]);
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

const browser = await launch();
try {
  const { page, errors } = await openSessionPage(
    browser,
    sessionAddress(base, { engine: 'cesium' }),
  );
  await waitReady(page, 'cesium');
  // Let the first boot's deferred listeners land before counting.
  await new Promise((resolve) => setTimeout(resolve, 2000));
  const boot = await readSession(page);
  const bootListeners = await listenerCounts(page);
  report.boot = boot;

  await prepareUi(page);
  const escapeBefore = await escapeEffect(page);
  report.escapeBefore = escapeBefore;
  await prepareUi(page);
  const uiBefore = await readUi(page);
  report.uiBefore = uiBefore;

  const sequence = ['navara', 'cesium', 'navara', 'cesium', 'navara', 'cesium'];
  for (const kind of sequence) {
    const started = Date.now();
    await switchEngine(page, kind);
    const state = await readSession(page);
    const ui = await readUi(page);
    if (kind === 'navara')
      await page.evaluate(() => {
        window.__qaParkedNavara = window.__godsEyeView.engine;
      });
    if (report.switches.length === 1)
      report.firstRoundTripListeners = listenerDifference(
        bootListeners,
        await listenerCounts(page),
      );
    report.switches.push({
      kind,
      ms: Date.now() - started,
      ids: idDifference(boot.ids, state.ids),
      counters: state.counters,
      ui,
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
  const afterListeners = await listenerCounts(page);
  report.after = after;
  report.listeners = listenerDifference(bootListeners, afterListeners);
  check(
    Object.keys(report.listeners).length === 0,
    'window/document listeners changed after three round trips',
    report.listeners,
  );
  check(
    after.counters?.attachments === 1 + sequence.length &&
      after.counters?.detaches === sequence.length,
    'each switch detaches once and attaches once',
    after.counters,
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
    await waitReady(page, 'cesium');
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
  }
  report.errors = errors;
  check(errors.length === 0, 'page errors', errors);
  console.log(JSON.stringify(report, null, 2));
  if (!reportOnly) console.log('PASS application created once; session kept');
} finally {
  await browser.close();
}
