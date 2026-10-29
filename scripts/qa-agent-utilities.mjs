#!/usr/bin/env node
/** Temporary #1331 + #1469 integration: real app/console/runner, scripted inference.
 * No OAuth, microphone or paid model calls. Requires #1469 in the test tree.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createServer } from 'vite';
import puppeteer from 'puppeteer';
const artifacts = 'qa-artifacts/agent-utilities';
await fs.mkdir(artifacts, { recursive: true });
const server = await createServer({
  cacheDir: `${artifacts}/vite-cache`,
  server: { host: '127.0.0.1', port: 0, hmr: false },
});
const commands = [
  'mostrame Indicaciones',
  'abrí Utilidades',
  'mostrame las herramientas para dibujar',
];
const reveal = {
  name: 'show_data_layers_menu',
  args: { layerId: 'directions' },
};
const plans = Object.fromEntries(commands.map((c) => [c, [reveal]]));
plans['invalid Utilities target'] = [
  { name: 'set_panel_open', args: { panelId: 'utilities-panel', open: true } },
];
const report = [],
  errors = [],
  posts = [];
let browser,
  callId = 0;
try {
  await server.listen();
  browser = await puppeteer.launch({
    headless: 'shell',
    pipe: true,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
    ],
  });
  async function newPage() {
    const page = await browser.newPage();
    page.setDefaultNavigationTimeout(90000);
    page.on('pageerror', (e) => errors.push(e.message));
    await page.setRequestInterception(true);
    page.on('request', async (req) => {
      const url = new URL(req.url());
      let payload;
      if (url.pathname === '/api/agent/config')
        payload = {
          providers: [
            {
              id: 'chatgpt',
              authType: 'oauth',
              label: 'Fixture',
              configured: true,
            },
          ],
          defaultProvider: 'chatgpt',
        };
      if (url.pathname === '/api/agent/chatgpt/status')
        payload = {
          configured: true,
          active: 'fixture',
          binding: 'fixture',
          accounts: [{ id: 'fixture', label: 'Fixture', signedIn: true }],
        };
      if (url.pathname === '/api/agent/models')
        payload = {
          binding: 'fixture',
          models: [{ id: 'fixture', label: 'Scripted model' }],
        };
      if (url.pathname === '/api/agent/command') {
        const body = JSON.parse(req.postData());
        posts.push(body);
        if (body.messages.at(-1).role === 'user') {
          const toolCalls = plans[body.messages.at(-1).content].map((c) => ({
            ...c,
            id: 'c' + ++callId,
          }));
          payload = {
            message: {
              role: 'assistant',
              content: 'All requested panels are open!',
              tool_calls: toolCalls.map((c) => ({
                id: c.id,
                type: 'function',
                function: { name: c.name, arguments: JSON.stringify(c.args) },
              })),
            },
            toolCalls,
          };
        } else
          payload = {
            message: {
              role: 'assistant',
              content: 'All requested panels are open!',
            },
            toolCalls: [],
          };
      }
      if (payload)
        return req.respond({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(payload),
        });
      // No real authorization/inference requests in this gate.
      if (url.pathname.startsWith('/api/agent/')) return req.abort();
      return req.continue();
    });
    await page.evaluateOnNewDocument(() =>
      sessionStorage.setItem('gev:first-run-mission-session:v1', 'dismissed'),
    );
    return page;
  }
  async function boot(
    page,
    href = server.resolvedUrls.local[0] + '?welcome=0',
  ) {
    await page.goto(href, { waitUntil: 'domcontentloaded', timeout: 90000 });
    await page.waitForFunction(
      () =>
        window.__godsEyeView?.agentConsole &&
        document.querySelector('#utilities-panel'),
      { timeout: 90000 },
    );
  }
  async function openConsole(page) {
    await page.evaluate(() => window.__godsEyeView.agentConsole.open());
    await page.waitForFunction(
      () => document.querySelector('#agent-model').value === 'fixture',
    );
  }
  async function send(page, command) {
    await openConsole(page);
    const before = await page.evaluate(
      () => window.__godsEyeView.agentConsole.session.transcript.length,
    );
    await page.$eval('#agent-input', (e) => (e.value = ''));
    await page.type('#agent-input', command);
    await page.keyboard.press('Enter');
    await page.waitForFunction(
      (n) =>
        !window.__godsEyeView.agentConsole.session.busy &&
        window.__godsEyeView.agentConsole.session.transcript.length > n,
      {},
      before,
    );
    return page.evaluate(() => ({
      content:
        window.__godsEyeView.agentConsole.session.transcript.at(-1).content,
      focus: document.activeElement?.id,
    }));
  }
  const page = await newPage();
  await page.setViewport({ width: 1440, height: 1000 });
  await boot(page);
  for (const layout of ['tactical', 'cyber']) {
    await page.evaluate(
      (layout) => window.__godsEyeView.styleManager.setHudLayout(layout),
      layout,
    );
    for (const command of commands) {
      await page.evaluate(() =>
        window.__godsEyeView.styleManager.setPanelCollapsed(
          'utilities-panel',
          true,
        ),
      );
      const before = await page.evaluate(
        () => window.__godsEyeView.dataManager.layers.get('directions').enabled,
      );
      const reply = await send(page, command);
      assert.match(reply.content, /^Utilities is open/);
      assert.doesNotMatch(reply.content, /All requested panels/);
      const state = await page.evaluate(() => {
        const panel = document.getElementById('utilities-panel');
        const row = document.querySelector('[data-layer-id="directions"]');
        return {
          collapsed: panel.classList.contains('collapsed'),
          visible:
            !!panel.getClientRects().length &&
            getComputedStyle(panel).display !== 'none',
          owner: row.closest('[data-panel-id]').id,
          enabled:
            window.__godsEyeView.dataManager.layers.get('directions').enabled,
        };
      });
      assert.equal(state.collapsed, false);
      assert.equal(state.visible, true);
      assert.equal(state.owner, 'utilities-panel');
      assert.equal(state.enabled, before, 'reveal must not enable Directions');
      report.push({ layout, command, reply: reply.content, state });
    }
  }
  // Bypass server schema validation deliberately: the real runner must reject it too.
  const invalid = await send(page, 'invalid Utilities target');
  assert.match(invalid.content, /not changed/);
  // A silent no-op owner must not be reported as a successful opening.
  await page.evaluate(() => {
    const owner = window.__godsEyeView.styleManager;
    owner.setPanelCollapsed('utilities-panel', true);
    window.__utilitiesOriginal = owner.setPanelCollapsed;
    owner.setPanelCollapsed = () => {};
  });
  const noop = await send(page, commands[1]);
  assert.match(noop.content, /could not be confirmed/);
  await page.evaluate(() => {
    window.__godsEyeView.styleManager.setPanelCollapsed =
      window.__utilitiesOriginal;
  });
  // Fresh explicit request recovers after refusal.
  assert.match((await send(page, commands[1])).content, /^Utilities is open/);
  await page.screenshot({ path: `${artifacts}/utilities.png` });
  assert.deepEqual(errors, [], 'no application page errors');
  await fs.writeFile(
    `${artifacts}/results.json`,
    JSON.stringify({ report, errors, posts: posts.length }, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser?.close();
  await server.close();
}
