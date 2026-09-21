#!/usr/bin/env node
/** Browser proof of Layers panel search, focus, replacement and subscriptions.
 * Run against npm run dev: node scripts/qa-layer-panel.mjs (QA_BASE_URL optional).
 */
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
    () =>
      window.__godsEyeView?.dataManager &&
      document.querySelector('.data-toggle-row'),
    { timeout: 60000, polling: 200 },
  );
  // These assertions exercise DOM controls; continuous software globe rendering
  // need not compete with keyboard events on a headless machine.
  await page.evaluate(() => {
    window.__godsEyeView.viewer.useDefaultRenderLoop = false;
  });
  for (const modifier of ['Control', 'Meta']) {
    await page.evaluate(() => {
      window.__godsEyeView.styleManager.setPanelCollapsed('data-panel', true);
      document.getElementById('data-panel').classList.remove('active');
      document.activeElement?.blur();
    });
    await page.keyboard.down(modifier);
    await page.keyboard.press('k');
    await page.keyboard.up(modifier);
    check(
      `${modifier}+K opens and focuses finder`,
      await page.evaluate(
        () =>
          !document
            .getElementById('data-panel')
            .classList.contains('collapsed') &&
          document.activeElement === document.getElementById('layer-finder'),
      ),
    );
  }
  await page.type('#layer-finder', 'FiRe');
  check(
    'display label matches case-insensitively and hides empty groups',
    await page.evaluate(() => {
      const rows = [...document.querySelectorAll('.data-toggle-row')].filter(
        (row) => !row.hidden,
      );
      const headings = [
        ...document.querySelectorAll('.data-layer-group-heading'),
      ].filter((row) => !row.hidden);
      return (
        rows.some((row) => row.dataset.layerId === 'local-firms') &&
        rows.every((row) => getComputedStyle(row).display !== 'none') &&
        headings.length === 1 &&
        headings[0].textContent === 'Events' &&
        [...document.querySelectorAll('.data-toggle-row[hidden]')].every(
          (row) => getComputedStyle(row).display === 'none',
        )
      );
    }),
  );
  await page.keyboard.press('Tab');
  check(
    'Tab reaches only the matching layer control',
    await page.evaluate(
      () =>
        document.activeElement?.classList.contains('data-toggle-btn') &&
        document.activeElement.closest('.data-toggle-row')?.dataset.layerId ===
          'local-firms',
    ),
  );
  await page.keyboard.down('Shift');
  await page.keyboard.press('Tab');
  await page.keyboard.up('Shift');
  await page.keyboard.press('Escape');
  check(
    'Escape clears without collapsing or losing finder focus',
    await page.evaluate(
      () =>
        document.activeElement === document.getElementById('layer-finder') &&
        document.activeElement.value === '' &&
        !document.getElementById('data-panel').classList.contains('collapsed'),
    ),
  );
  await page.keyboard.press('Escape');
  check(
    'empty Escape uses panel disclosure and restores focus',
    await page.evaluate(
      () =>
        document.getElementById('data-panel').classList.contains('collapsed') &&
        document.activeElement?.dataset.collapseTarget === 'data-panel',
    ),
  );
  await page.keyboard.down('Control');
  await page.keyboard.press('k');
  await page.keyboard.up('Control');
  const results = await page.evaluate(async () => {
    const manager = window.__godsEyeView.dataManager;
    const entry = document.querySelector('script[src*="/src/main.js"]');
    const { application } = await import(entry.src);
    const { presentation } = application.getComponents().data;
    const container = document.getElementById('data-toggles');
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
      presentation.mount(container);
      const row = () => container.querySelector(`[data-layer-id="${id}"]`);
      const finder = document.getElementById('layer-finder');
      const search = (query) => {
        finder.value = query;
        finder.dispatchEvent(new Event('input', { bubbles: true }));
      };
      const visible = (selector) =>
        [...container.querySelectorAll(selector)].filter(
          (node) => !node.hidden,
        );
      const allRows = visible('.data-toggle-row').map(
        (node) => node.dataset.layerId,
      );
      const allGroups = visible('.data-layer-group-heading').map(
        (node) => node.textContent,
      );
      const enabledBefore = manager
        .getAll()
        .map(({ id, enabled }) => [id, enabled]);
      search('cam');
      result.push([
        'camera labels are discoverable',
        visible('.data-toggle-row').some(
          (node) => node.dataset.layerId === 'cctv',
        ),
      ]);
      search('CCTV');
      result.push([
        'underlying name remains searchable',
        visible('.data-toggle-row').some(
          (node) => node.dataset.layerId === 'cctv',
        ),
      ]);
      search('LOCAL FIXTURE');
      result.push([
        'source search preserves the matching row',
        visible('.data-toggle-row').length === 1 && !row().hidden,
      ]);
      search('no-layer-matches-this-query');
      result.push([
        'no matches hides all rows and groups',
        visible('.data-toggle-row').length === 0 &&
          visible('.data-layer-group-heading').length === 0,
      ]);
      search('');
      result.push([
        'clearing restores all rows and groups in order',
        JSON.stringify(
          visible('.data-toggle-row').map((node) => node.dataset.layerId),
        ) === JSON.stringify(allRows) &&
          JSON.stringify(
            visible('.data-layer-group-heading').map(
              (node) => node.textContent,
            ),
          ) === JSON.stringify(allGroups),
      ]);
      result.push([
        'search never changes enabled state',
        JSON.stringify(
          manager.getAll().map(({ id, enabled }) => [id, enabled]),
        ) === JSON.stringify(enabledBefore),
      ]);
      search('local fixture');
      finder.focus();
      finder.setSelectionRange?.(1, 3);
      presentation.refresh();
      result.push([
        'refresh preserves finder focus and query',
        document.activeElement === finder && finder.value === 'local fixture',
      ]);
      presentation.mount(container);
      result.push([
        'remount preserves finder and query',
        document.activeElement === finder &&
          visible('.data-toggle-row').length === 1,
      ]);
      const filteredToggle = row().querySelector('.data-toggle-btn');
      filteredToggle.focus();
      filteredToggle.click();
      for (let attempt = 0; attempt < 100 && !manager.isEnabled(id); attempt++)
        await new Promise((resolve) => setTimeout(resolve, 10));
      presentation.refresh();
      result.push([
        'filtered toggle acts on the correct layer and preserves focus',
        manager.isEnabled(id) &&
          enabled === 1 &&
          document.activeElement === filteredToggle &&
          manager
            .getAll()
            .filter((layer) => layer.id !== id)
            .every(
              (layer) =>
                enabledBefore.find(([key]) => key === layer.id)?.[1] ===
                layer.enabled,
            ),
      ]);
      await manager.setEnabled(id, false);
      enabled = 0;
      search('');
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
      presentation.mount(container);
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
      presentation.panel.destroy();
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
      presentation._panel?.destroy();
      presentation._panel = null;
      await window.__gevQaUnregisterLayer(manager, id);
      presentation.mount(container);
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
