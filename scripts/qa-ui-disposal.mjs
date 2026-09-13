#!/usr/bin/env node
/** Exercise the real UI disposal path, including unrelated resource owners. */
import puppeteer from 'puppeteer';
const browser = await puppeteer.launch({
  headless: true,
  args: [
    '--no-sandbox',
    ...(process.platform === 'darwin'
      ? ['--use-angle=metal', '--enable-gpu']
      : ['--use-gl=angle', '--use-angle=swiftshader']),
  ],
});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
let failures = 0;
function check(name, ok) {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}`);
  if (!ok) failures++;
}
try {
  await page.goto(
    `${process.env.QA_BASE_URL || 'http://localhost:4173'}/?welcome=0`,
    { waitUntil: 'domcontentloaded' },
  );
  await page.waitForFunction(
    () =>
      window.__godsEyeView?.styleManager?._dataManager &&
      document.getElementById('loading-screen')?.classList.contains('hidden'),
    { timeout: 60000 },
  );
  const result = await page.evaluate(async () => {
    const ui = window.__godsEyeView.styleManager;
    const counts = {};
    const watchObserver = (name) => {
      const observer = ui[name];
      if (!observer) return false;
      const disconnect = observer.disconnect.bind(observer);
      counts[name] = 0;
      observer.disconnect = () => {
        counts[name]++;
        return disconnect();
      };
      return true;
    };
    const observed = [
      '_commandDockTrayObserver',
      '_draggableResizeObserver',
      '_leftStackResizeObserver',
      '_rightStackResizeObserver',
      '_leftStackMutationObserver',
      '_rightStackMutationObserver',
    ].filter(watchObserver);
    const cctvUnsubscribe = ui._cctvControls._cctvUnsubscribe;
    counts.cctv = 0;
    if (cctvUnsubscribe)
      ui._cctvControls._cctvUnsubscribe = () => {
        counts.cctv++;
        return cctvUnsubscribe();
      };
    const contextFields = [
      '_contextManagerUnsubscribe',
      '_dataManagerVisibilityRequestUnsubscribe',
      '_dataManagerVisibilityGuardUnsubscribe',
      '_dataManagerBeforeDestroyUnsubscribe',
    ];
    const contextConnected = contextFields.every(
      (field) => typeof ui._contextControls[field] === 'function',
    );
    for (const field of contextFields) {
      const unsubscribe = ui._contextControls[field];
      counts[field] = 0;
      ui._contextControls[field] = () => {
        counts[field]++;
        return unsubscribe?.();
      };
    }
    const resizeHandler = ui._windowResizeHandler;
    const removeEventListener = window.removeEventListener;
    counts.resize = 0;
    window.removeEventListener = function (type, callback, options) {
      if (type === 'resize' && callback === resizeHandler) counts.resize++;
      return removeEventListener.call(this, type, callback, options);
    };
    try {
      await ui.dispose();
      const once = JSON.stringify(counts);
      await ui.dispose();
      window.dispatchEvent(new Event('resize'));
      await new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      );
      return {
        connected: Boolean(
          cctvUnsubscribe &&
          resizeHandler &&
          observed.includes('_commandDockTrayObserver'),
        ),
        contextReleased:
          contextConnected &&
          ui._contextControls.destroyed &&
          contextFields.every(
            (field) =>
              counts[field] === 1 && ui._contextControls[field] === null,
          ),
        observersReleased: observed.every(
          (name) => counts[name] === 1 && ui[name] === null,
        ),
        subscriptionReleased:
          counts.cctv === 1 && ui._cctvControls._cctvUnsubscribe === null,
        resizeReleased: counts.resize === 1 && ui._windowResizeHandler === null,
        controlsReleased:
          ui._radioControls.destroyed &&
          ui._locationControls.destroyed &&
          ui._cctvControls.destroyed,
        idempotent: once === JSON.stringify(counts),
      };
    } finally {
      window.removeEventListener = removeEventListener;
    }
  });
  check(
    'real UI has the expected live resources before disposal',
    result.connected,
  );
  check(
    'UI disposal releases all Context subscriptions and stops its controls',
    result.contextReleased,
  );
  check(
    'UI disposal disconnects each active panel observer once',
    result.observersReleased,
  );
  check(
    'UI disposal releases the CCTV state subscription',
    result.subscriptionReleased,
  );
  check(
    'UI disposal removes the registered window resize handler',
    result.resizeReleased,
  );
  check(
    'Radio, Location and CCTV controls are disposed with the UI',
    result.controlsReleased,
  );
  check('repeated UI disposal is inert', result.idempotent);
  check(
    'disposal and subsequent resize produce no uncaught browser errors',
    errors.length === 0,
  );
} finally {
  await browser.close();
}
if (failures) process.exitCode = 1;
