#!/usr/bin/env node
/** Temporary #1331 + #1425 integration: real app/console/runner, scripted inference.
 * No OAuth, microphone or paid model calls. Requires #1425 in the test tree.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createServer } from 'vite';
import puppeteer from 'puppeteer';
const artifacts = 'qa-artifacts/agent-right-rail';
await fs.mkdir(artifacts, { recursive: true });
const server = await createServer({
  cacheDir: `${artifacts}/vite-cache`,
  server: { host: '127.0.0.1', port: 0, hmr: false },
});
const ids = [
  'pp-toggles',
  'cctv-panel',
  'street-level-panel',
  'global-context-panel',
];
const labels = ['Display', 'CCTV', 'Street Level', 'Context'];
const panel = (panelId, open = true) => ({
  name: 'set_panel_open',
  args: { panelId, open },
});
const plans = Object.fromEntries(
  labels.flatMap((label, i) => [
    ['Open ' + label, [panel(ids[i])]],
    ['Close ' + label, [panel(ids[i], false)]],
  ]),
);
plans['Open all four'] = ids.map((id) => panel(id));
plans['Open CCTV then Context'] = [panel(ids[1]), panel(ids[3])];
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
        document.querySelector('#right-rail-tabs'),
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
  async function state(page) {
    return page.evaluate(
      (ids) =>
        ids.filter((id) => {
          const el = document.getElementById(id);
          return !el.hidden && !el.classList.contains('collapsed');
        }),
      ids,
    );
  }
  async function visible(page) {
    return page.evaluate(
      (ids) =>
        ids.filter((id) => {
          const el = document.getElementById(id);
          return (
            !el.hidden &&
            !el.classList.contains('collapsed') &&
            el.getClientRects().length &&
            getComputedStyle(el).display !== 'none'
          );
        }),
      ids,
    );
  }
  const page = await newPage();
  await page.setViewport({ width: 1440, height: 1000 });
  await boot(page);
  for (const layout of ['tactical', 'operator', 'minimal', 'cyber']) {
    await page.evaluate(
      (layout) => window.__godsEyeView.styleManager.setHudLayout(layout),
      layout,
    );
    for (let i = 0; i < ids.length; i++) {
      const reply = await send(page, 'Open ' + labels[i]);
      assert.deepEqual(await state(page), [ids[i]], layout);
      assert.deepEqual(await visible(page), [ids[i]], layout);
      assert.match(reply.content, new RegExp(labels[i] + '.*open'));
      assert.doesNotMatch(reply.content, /All requested panels/);
      assert.equal(reply.focus, 'agent-input');
    }
    for (const command of ['Open all four', 'Open CCTV then Context']) {
      const reply = await send(page, command);
      assert.deepEqual(await state(page), [ids[3]]);
      assert.match(reply.content, /Context.*open/);
    }
    await send(page, 'Close Context');
    assert.deepEqual(await state(page), []);
    console.log('PASS desktop ' + layout);
    report.push({
      layout,
      result:
        'PASS: sequential opens, batches, actual visibility, explicit close, focus',
    });
  }
  await send(page, 'Open Context');
  const link = await page.evaluate(() =>
    window.__godsEyeView.styleManager.shareLinkManager.buildLink(),
  );
  assert.ok(link?.includes('/share/'));
  await page.goto(server.resolvedUrls.local[0] + '?welcome=0', {
    waitUntil: 'domcontentloaded',
  });
  await page.waitForFunction(() => window.__godsEyeView?.agentConsole, {
    timeout: 90000,
  });
  await page.waitForFunction(
    () =>
      !document
        .getElementById('global-context-panel')
        .classList.contains('collapsed'),
  );
  assert.deepEqual(await state(page), [ids[3]], 'root reload restores Context');
  const storage = await page.evaluate(
    (ids) =>
      ids.map((id) =>
        localStorage.getItem('godsEyeView.v6.panelCollapsed.' + id),
      ),
    ids,
  );
  assert.deepEqual(storage, ['1', '1', '1', '0']);
  // A fresh browser context has no sender preferences; restore the real link.
  const receiverContext = await browser.createBrowserContext();
  const receiver = await receiverContext.newPage();
  receiver.setDefaultNavigationTimeout(90000);
  receiver.on('pageerror', (e) => errors.push(e.message));
  await receiver.setViewport({ width: 1440, height: 1000 });
  await boot(receiver, link);
  await receiver.waitForFunction(
    () =>
      !document
        .getElementById('global-context-panel')
        .classList.contains('collapsed'),
  );
  assert.deepEqual(
    await state(receiver),
    [ids[3]],
    'shared link restores sender owner',
  );
  await receiverContext.close();
  console.log('PASS preferences and shared link');
  report.push({
    result:
      'PASS: preferences survive reload; fresh-context share link restores Context',
  });
  // Exercise #1425 keyboard behavior after a command. Close the dialog first.
  await page.evaluate(() => window.__godsEyeView.agentConsole.close());
  const tab = (id) => `[data-rail-tab="${id}"]`;
  await page.focus(tab(ids[3]));
  await page.keyboard.press('Home');
  assert.equal(
    await page.evaluate(() => document.activeElement.dataset.railTab),
    ids[0],
  );
  await page.keyboard.press('ArrowUp');
  assert.equal(
    await page.evaluate(() => document.activeElement.dataset.railTab),
    ids[3],
  );
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  assert.deepEqual(await state(page), [ids[0]]);
  await page.keyboard.press('Tab');
  // The compact Radio launcher occupies #1425's tool slot before panel content.
  if (
    await page.evaluate(
      () => !!document.activeElement.closest('#right-rail-tools'),
    )
  )
    await page.keyboard.press('Tab');
  assert.equal(
    await page.evaluate(() =>
      document.getElementById('pp-toggles').contains(document.activeElement),
    ),
    true,
  );
  await page.keyboard.press('Escape');
  assert.deepEqual(await state(page), []);
  assert.equal(
    await page.evaluate(() => document.activeElement.dataset.railTab),
    ids[0],
  );
  await page.focus(tab(ids[0]));
  await page.keyboard.press('End');
  assert.equal(
    await page.evaluate(() => document.activeElement.dataset.railTab),
    ids[3],
  );
  report.push({
    result:
      'PASS: Home/End, Up/Down wrap, Enter, Tab through tool slot into panel, Escape closes and returns focus',
  });
  await page.screenshot({ path: `${artifacts}/desktop.png` });
  // The phone shell owns which sheet is visible; independent expansion is legal.
  await page.setViewport({ width: 390, height: 844 });
  await page.waitForFunction(() =>
    document.body.classList.contains('mobile-shell'),
  );
  await send(page, 'Open all four');
  assert.deepEqual(await state(page), ids, 'phone panels are independent');
  await send(page, 'Close CCTV');
  assert.deepEqual(await state(page), [ids[0], ids[2], ids[3]]);
  await page.evaluate(() => window.__godsEyeView.agentConsole.close());
  for (const sheet of ['cameras', 'context', 'more']) {
    await page.click(`#mobile-tab-bar [data-mobile-sheet="${sheet}"]`);
    assert.equal(
      await page.evaluate(() => document.body.dataset.mobileSheet),
      sheet,
    );
  }
  await page.screenshot({ path: `${artifacts}/mobile.png` });
  report.push({
    result:
      'PASS: mobile independent expansion/close and Cameras/Context/More sheets',
  });
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
