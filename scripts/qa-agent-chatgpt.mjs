#!/usr/bin/env node
/**
 * Deterministic browser gate for ChatGPT controls in the shipped GEV console.
 * Runs the real template, CSS, translations and controller against fixture API
 * responses. It does not exercise OAuth, a real model or the Cesium viewer.
 * No dev server or credentials needed: node scripts/qa-agent-chatgpt.mjs
 * PUPPETEER_EXECUTABLE_PATH may select an installed Chromium/headless-shell.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const template = await fs.readFile(
  path.join(root, 'src/ui/templates/agent-console.html'),
  'utf8',
);
const html = `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/style.css"></head><body>${template}
<script type="module">
import { mountAgentConsole } from '/src/agent/agentConsole.js';
import { setLocale, applyDocumentTranslations } from '/src/i18n/index.js';
setLocale(new URL(location.href).searchParams.get('lang') || 'en');
applyDocumentTranslations(document);
let active = 'account-one', binding = 'binding-one';
let pending = false;
const accounts = [{ id: 'account-one', label: 'fixture@example.test · one', signedIn: true }, { id: 'account-two', label: 'fixture@example.test · two', signedIn: true }];
const state = () => ({ active, binding, configured: Boolean(active), pending, accounts });
window.fixture = { requests: [], actions: [], aborted: false };
const fetchImpl = async (url, init = {}) => {
  const body = init.body && JSON.parse(init.body);
  if (url === '/api/agent/config') return Response.json({ providers: [{ id: 'chatgpt', authType: 'oauth', label: 'ChatGPT plan', configured: true }], defaultProvider: 'chatgpt' });
  if (url === '/api/agent/chatgpt/status') return Response.json(state());
  if (url.startsWith('/api/agent/models')) return Response.json({ binding, models: [{ id: 'fixture-model', label: 'Fixture model', costPerCommandUsd: null }] });
  if (url === '/api/agent/chatgpt/select') { active = body.account; binding = 'binding-two'; return Response.json(state()); }
  if (url === '/api/agent/chatgpt/logout') { active = null; binding = 'signed-out'; return Response.json({ ...state(), revoked: true }); }
  if (url === '/api/agent/command') {
    window.fixture.requests.push(body);
    if (body.messages.at(-1)?.content === 'wait') return new Promise((_, reject) => init.signal.addEventListener('abort', () => { window.fixture.aborted = true; reject(new DOMException('Stopped', 'AbortError')); }, { once: true }));
    if (body.messages.at(-1)?.role === 'user') return Response.json({ message: { role: 'assistant', content: '', tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'zoom_to_globe', arguments: '{}' } }] }, toolCalls: [{ id: 'call-1', name: 'zoom_to_globe', args: {} }] });
    return Response.json({ message: { role: 'assistant', content: 'Fixture action completed.' }, toolCalls: [] });
  }
  throw new Error('Unexpected fixture request');
};
window.consoleController = mountAgentConsole({ fetchImpl, runAction: async (name) => { window.fixture.actions.push(name); return { ok: true }; } });
window.consoleController.open();
</script></body></html>`;
const mime = {
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.json': 'application/json',
  '.css': 'text/css',
  '.woff2': 'font/woff2',
};
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/') {
      res.setHeader('Content-Type', 'text/html');
      res.end(html);
      return;
    }
    if (url.pathname === '/favicon.ico') {
      res.writeHead(204);
      res.end();
      return;
    }
    const filename = path.resolve(root, '.' + decodeURIComponent(url.pathname));
    if (!filename.startsWith(root + path.sep)) throw new Error('Invalid path');
    res.setHeader(
      'Content-Type',
      mime[path.extname(filename)] || 'application/octet-stream',
    );
    res.end(await fs.readFile(filename));
  } catch {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await puppeteer.launch({
    headless: true,
    executablePath:
      process.env.PUPPETEER_EXECUTABLE_PATH ||
      (await puppeteer.executablePath()),
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const artifactDir = path.join(root, 'qa-artifacts/agent-chatgpt');
  await fs.mkdir(artifactDir, { recursive: true });
  for (const locale of ['en', 'es', 'ru', 'zh-CN'])
    for (const width of [1280, 800]) {
      const page = await browser.newPage();
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.setViewport({ width, height: 800 });
      await page.goto(
        `http://127.0.0.1:${server.address().port}/?lang=${locale}`,
      );
      await page.waitForFunction(
        () => document.getElementById('agent-model').value === 'fixture-model',
      );
      await page.type('#agent-input', 'zoom out');
      await page.click('#agent-send');
      await page.waitForFunction(
        () =>
          window.fixture.requests.length === 2 &&
          !window.consoleController.session.busy,
      );
      assert.deepEqual(await page.evaluate(() => window.fixture.actions), [
        'zoom_to_globe',
      ]);
      await page.select('#agent-chatgpt-account', 'account-two');
      await page.waitForFunction(
        () =>
          document.getElementById('agent-input').disabled === false &&
          window.consoleController.session.transcript.length === 0,
      );
      await page.type('#agent-input', 'second account');
      await page.click('#agent-send');
      await page.waitForFunction(
        () =>
          window.fixture.requests.length === 4 &&
          !window.consoleController.session.busy,
      );
      assert.deepEqual(
        await page.evaluate(() => ({
          binding: window.fixture.requests[2].binding,
          messages: window.fixture.requests[2].messages,
        })),
        {
          binding: 'binding-two',
          messages: [{ role: 'user', content: 'second account' }],
        },
      );
      await page.type('#agent-input', 'wait');
      await page.click('#agent-send');
      await page.waitForFunction(() => window.consoleController.session.busy);
      await page.click('#agent-stop');
      await page.waitForFunction(
        () => window.fixture.aborted && !window.consoleController.session.busy,
      );
      const geometry = await page.evaluate(() => {
        const dialog = document.getElementById('agent-console');
        const d = dialog.getBoundingClientRect();
        const input = document
          .getElementById('agent-input')
          .getBoundingClientRect();
        const content = [...dialog.querySelectorAll('*')].filter(
          (e) =>
            !e.classList.contains('agent-resize-edge') &&
            !e.classList.contains('agent-resize-grip'),
        );
        const status = document
          .getElementById('agent-status')
          .getBoundingClientRect();
        return {
          fits:
            d.left >= 0 &&
            d.right <= innerWidth &&
            d.top >= 0 &&
            d.bottom <= innerHeight,
          noOverflow: content.every(
            (e) => e.getBoundingClientRect().right <= d.right + 1,
          ),
          inputInside:
            input.bottom <= d.bottom &&
            input.top >= d.top &&
            status.bottom <= d.bottom,
          text: dialog.textContent,
        };
      });
      await page.screenshot({
        path: path.join(artifactDir, `${locale}-${width}.png`),
      });
      assert.ok(
        geometry.fits && geometry.noOverflow && geometry.inputInside,
        `console layout ${locale} ${width}: ${JSON.stringify(geometry)}`,
      );
      assert.doesNotMatch(geometry.text, /\{envVar\}|\{count\}/);
      assert.deepEqual(errors, []);
      await page.screenshot({
        path: path.join(artifactDir, `${locale}-${width}.png`),
      });
      await page.click('#agent-chatgpt-logout');
      await page.waitForFunction(
        () =>
          document.getElementById('agent-model').options.length === 0 &&
          document.getElementById('agent-send').disabled,
      );
      await page.close();
      console.log(
        `PASS ${locale} ${width}×800: tool round trip, account isolation, STOP, logout, layout`,
      );
    }
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
