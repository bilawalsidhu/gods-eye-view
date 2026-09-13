#!/usr/bin/env node
/** Browser proof of Layers panel replacement and subscription ownership. */
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
let failures = 0;
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
const check = (name, passed) => {
  console.log(`[${passed ? 'PASS' : 'FAIL'}] ${name}`);
  if (!passed) failures++;
};
try {
  await page.goto(
    `${process.env.QA_BASE_URL || 'http://localhost:4173'}/?welcome=0`,
    { waitUntil: 'domcontentloaded' },
  );
  await page.waitForFunction(
    () => window.__godsEyeView?.dataManager?._layerPanel,
    { timeout: 60000 },
  );
  const results = await page.evaluate(async () => {
    const manager = window.__godsEyeView.dataManager;
    const container = manager._toggleContainer;
    const id = 'qa-panel-lifecycle';
    let listener = null;
    let enabled = 0;
    window.__gevQaRegisterLayer(manager, {
      id,
      name: '<b>Literal layer</b>',
      icon: '◌',
      source: 'Local fixture',
      updateInterval: -1,
      init() {},
      enable() {
        enabled++;
      },
      disable() {},
      update() {},
      destroy() {},
      getStats: () => ({ count: 1250, lastUpdate: Date.now(), stale: true }),
      getRowControls: () => ({ chips: [] }),
      setRowControlsListener: (callback) => {
        listener = callback;
      },
    });
    const result = [];
    try {
      manager.buildTogglePanel(container);
      const row = () => container.querySelector(`[data-layer-id="${id}"]`);
      const first = row().querySelector('.data-toggle-btn');
      result.push([
        'descriptor text is literal content',
        row().querySelector('.data-name').textContent ===
          '<b>Literal layer</b>' && !row().querySelector('b'),
      ]);
      result.push([
        'row subscription is installed',
        typeof listener === 'function',
      ]);
      manager.buildTogglePanel(container);
      first.click();
      await Promise.resolve();
      result.push([
        'a detached row cannot issue an enable action',
        enabled === 0 && !manager.isEnabled(id),
      ]);
      await manager.setEnabled(id, true);
      result.push([
        'count is presented from the supplied snapshot',
        row().querySelector('.data-count').textContent === '1.3K',
      ]);
      result.push([
        'feed state reflects the settled layer snapshot',
        row().querySelector('.data-toggle-btn').dataset.feedState === 'stale',
      ]);
      const ui = window.__godsEyeView.styleManager;
      ui._clearSelectedLayersBtn.click();
      result.push([
        'native clear activation presents busy state',
        ui._clearSelectedLayersBtn.getAttribute('aria-busy') === 'true' &&
          !!ui._contextControls._clearSelectedLayersPromise,
      ]);
      await ui._contextControls._clearSelectedLayersPromise;
      result.push([
        'clear settles through the existing layer transaction',
        !manager.isEnabled(id) &&
          ui._clearSelectedLayersBtn.getAttribute('aria-busy') === 'false',
      ]);
      await manager.setEnabled(id, true);
      const final = row().querySelector('.data-toggle-btn');
      manager._layerPanel.destroy();
      final.click();
      await Promise.resolve();
      result.push([
        'destroyed panel releases row subscriptions',
        listener === null,
      ]);
      result.push([
        'destroyed controls cannot change the layer',
        manager.isEnabled(id),
      ]);
    } finally {
      manager._layerPanel?.destroy();
      manager._layerPanel = null;
      await window.__gevQaUnregisterLayer(manager, id);
      manager.buildTogglePanel(container);
    }
    result.push([
      'ordinary layer rows return after reassembly',
      container.querySelectorAll('.data-toggle-row').length > 10,
    ]);
    return result;
  });
  for (const [name, passed] of results) check(name, passed);
  check('no uncaught browser errors', errors.length === 0);
} finally {
  await browser.close();
}
console.log(`RESULT: ${failures} failures`);
process.exitCode = failures ? 1 : 0;
