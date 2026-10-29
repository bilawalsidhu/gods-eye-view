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

const rtlGate = process.argv.includes('--rtl');
const before = process.argv.includes('--record-before');
const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const template = await fs.readFile(
  path.join(root, 'src/ui/templates/agent-console.html'),
  'utf8',
);
const html = `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/style.css"></head><body>${template}
<script type="module">
import { mountAgentConsole } from '/src/agent/agentConsole.js';
import { setLocale, applyDocumentTranslations } from '/src/i18n/index.js';
import { resolveLocale, applyDocumentLanguage } from '/src/i18n/locale.js';
const locale = resolveLocale();
setLocale(locale);
applyDocumentLanguage(document, locale);
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
  if (url === '/api/agent/chatgpt/login') { pending = true; return Response.json({ path: '/api/agent/chatgpt/authorize?ticket=fixture-ticket' }); }
  if (url === '/api/agent/chatgpt/logout') { pending = false; active = null; binding = 'signed-out'; return Response.json({ ...state(), revoked: true }); }
  if (url === '/api/agent/command') {
    window.fixture.requests.push(body);
    if (body.messages.at(-1)?.content === 'wait') return new Promise((_, reject) => init.signal.addEventListener('abort', () => { window.fixture.aborted = true; reject(new DOMException('Stopped', 'AbortError')); }, { once: true }));
    if (body.messages.at(-1)?.role === 'user') return Response.json({ message: { role: 'assistant', content: '', tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'zoom_to_globe', arguments: '{}' } }] }, toolCalls: [{ id: 'call-1', name: 'zoom_to_globe', args: {} }] });
    return Response.json({ message: { role: 'assistant', content: new URLSearchParams(location.search).get('lang') === 'ar' ? 'تم الانتقال إلى الموقع ABC-123 عند الإحداثيات (-27.367, -55.896).' : 'Fixture action completed.' }, toolCalls: [] });
  }
  throw new Error('Unexpected fixture request');
};
window.consoleController = mountAgentConsole({ fetchImpl, runAction: async (name) => { window.fixture.actions.push(name); return { ok: true, coordinates: [-27.367, -55.896], code: 'HDG 68°', id: 'ABC-123' }; } });
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
  for (const locale of rtlGate
    ? ['ar', 'en']
    : process.env.QA_AGENT_LOCALES?.split(',') || [
        'en',
        'es',
        'ru',
        'zh-CN',
        'zh-Hant',
        'zh-TW',
      ])
    for (const [width, height] of rtlGate
      ? [
          [1440, 900],
          [800, 800],
          [390, 844],
          [320, 568],
          [844, 390],
          [932, 430],
        ]
      : [
          [1280, 800],
          [800, 800],
        ]) {
      const page = await browser.newPage();
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.setViewport({ width, height });
      await page.evaluateOnNewDocument(() => localStorage.clear());
      await page.goto(
        `http://127.0.0.1:${server.address().port}/?lang=${locale}`,
      );
      await page.waitForFunction(
        () => document.getElementById('agent-model').value === 'fixture-model',
      );
      if (locale === 'zh-Hant' || locale === 'zh-TW' || locale === 'zh-CN') {
        const traditional = locale !== 'zh-CN';
        assert.deepEqual(
          await page.evaluate(() => ({
            login: document.getElementById('agent-chatgpt-login').textContent,
            cost: document.getElementById('agent-cost').textContent,
            send: document.getElementById('agent-send').textContent,
            close: document
              .getElementById('agent-console-close')
              .getAttribute('aria-label'),
            placeholder: document.getElementById('agent-input').placeholder,
          })),
          traditional
            ? {
                login: '使用 ChatGPT 繼續',
                cost: 'ChatGPT 方案用量限制',
                send: '傳送',
                close: '關閉 GEV Command',
                placeholder: '縮小至完整地球視圖',
              }
            : {
                login: '使用 ChatGPT 继续',
                cost: 'ChatGPT 套餐限额',
                send: '发送',
                close: '关闭 GEV Command',
                placeholder: '缩小到整个地球视图',
              },
        );
      }
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
      if (rtlGate) {
        const sample = await page.evaluate(() => {
          const direction = (s) =>
            getComputedStyle(document.querySelector(s)).direction;
          const rect = document
            .querySelector('#agent-console')
            .getBoundingClientRect();
          return {
            html: document.documentElement.dir,
            input: document.querySelector('#agent-input').dir,
            user: direction('.agent-entry-user'),
            agent: direction('.agent-entry-agent'),
            tool: direction('.agent-entry-tool'),
            left: rect.left,
            right: rect.right,
            text: document.querySelector('.agent-entry-agent').textContent,
            login: document.querySelector('#agent-chatgpt-login').textContent,
          };
        });
        console.log(JSON.stringify({ locale, width, height, sample }));
        if (!before) {
          assert.equal(sample.input, 'auto');
          assert.equal(sample.user, 'ltr');
          assert.equal(sample.tool, 'ltr');
          assert.equal(sample.agent, locale === 'ar' ? 'rtl' : 'ltr');
          if (locale === 'ar') {
            assert.equal(sample.html, 'rtl');
            assert.match(sample.login, /[\u0600-\u06ff]/);
            const isolates = await page.$$eval('.agent-entry-agent bdi', (es) =>
              es.map((e) => ({
                text: e.textContent,
                dir: getComputedStyle(e).direction,
              })),
            );
            assert.ok(
              isolates.some(
                (e) => e.text === '(-27.367, -55.896)' && e.dir === 'ltr',
              ),
            );
            assert.ok(
              isolates.some((e) => e.text === 'ABC-123' && e.dir === 'ltr'),
            );
            assert.equal(
              sample.text,
              'تم الانتقال إلى الموقع ABC-123 عند الإحداثيات (-27.367, -55.896).',
            );
            assert.ok(Math.abs(width - sample.right - 14) <= 1 || width <= 500);
          }
          // Each command's direction follows its content, not the shell locale.
          await page.type(
            '#agent-input',
            'انتقل إلى ABC-123 (-27.367, -55.896)',
          );
          assert.equal(
            await page.$eval(
              '#agent-input',
              (e) => getComputedStyle(e).direction,
            ),
            'rtl',
          );
          await page.click('#agent-send');
          await page.waitForFunction(
            () => !window.consoleController.session.busy,
          );
          assert.equal(
            await page.$$eval(
              '.agent-entry-user',
              (es) => getComputedStyle(es.at(-1)).direction,
            ),
            'rtl',
          );
          assert.equal(
            await page.evaluate(
              () => window.fixture.requests[2].messages.at(-1).content,
            ),
            'انتقل إلى ABC-123 (-27.367, -55.896)',
          );
          // Clear the extra round trip so the shared account assertions stay exact.
          await page.evaluate(() => window.fixture.requests.splice(2));
        }
        if (!before) {
          const payload = await page.evaluate(() =>
            JSON.parse(
              window.fixture.requests[1].messages.find((m) => m.role === 'tool')
                .content,
            ),
          );
          assert.deepEqual(payload.coordinates, [-27.367, -55.896]);
          assert.equal(payload.id, 'ABC-123');
          assert.equal(payload.code, 'HDG 68°');
          await page.screenshot({
            path: path.join(
              artifactDir,
              `rtl-content-${locale}-${width}x${height}.png`,
            ),
          });
          const scrolling = await page.evaluate(() => {
            const list = document.querySelector('#agent-transcript');
            for (let i = 0; i < 40; i++) {
              const li = document.createElement('li');
              li.textContent = 'اختبار التمرير ABC-123';
              list.append(li);
            }
            list.scrollTop = 0;
            const first = list.scrollTop;
            list.scrollTop = list.scrollHeight;
            return { first, last: list.scrollTop };
          });
          assert.ok(
            scrolling.last > scrolling.first,
            'transcript scrolls in either direction',
          );
        }
        // Exercise physical geometry even though the content direction is RTL.
        const start = await page.$eval('#agent-console', (e) => {
          const r = e.getBoundingClientRect();
          return { left: r.left, top: r.top, width: r.width, height: r.height };
        });
        const title = await page.$('#agent-console-title');
        const tr = await title.boundingBox();
        await page.mouse.move(tr.x + 20, tr.y + 8);
        await page.mouse.down();
        await page.mouse.move(
          tr.x + 20 + (start.left > 45 ? -40 : 40),
          tr.y + 28,
          { steps: 6 },
        );
        await page.mouse.up();
        const moved = await page.$eval('#agent-console', (e) => {
          const r = e.getBoundingClientRect();
          return { left: r.left, top: r.top };
        });
        assert.ok(
          moved.left !== start.left ||
            moved.top !== start.top ||
            (start.width >= width - 12 && start.height >= height - 12),
          'drag moves the physical window or reaches viewport limits',
        );
        const grip = await page.$('#agent-console .agent-resize-grip');
        const gr = await grip.boundingBox();
        await page.mouse.move(gr.x + 7, gr.y + 7);
        await page.mouse.down();
        await page.mouse.move(gr.x - 33, gr.y - 33, { steps: 6 });
        await page.mouse.up();
        const size = await page.$eval('#agent-console', (e) => {
          const r = e.getBoundingClientRect();
          return { width: r.width, height: r.height };
        });
        assert.ok(
          size.width < start.width ||
            size.height < start.height ||
            width <= 340,
          'resize shrinks or reaches phone minimum',
        );
        await page.screenshot({
          path: path.join(
            artifactDir,
            `rtl-${before ? 'before' : 'after'}-${locale}-${width}x${height}.png`,
          ),
        });
      }
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
        path: path.join(artifactDir, `${locale}-${width}x${height}.png`),
      });
      assert.ok(
        geometry.fits && geometry.noOverflow && geometry.inputInside,
        `console layout ${locale} ${width}: ${JSON.stringify(geometry)}`,
      );
      assert.doesNotMatch(geometry.text, /\{envVar\}|\{count\}/);
      assert.deepEqual(errors, []);
      await page.screenshot({
        path: path.join(artifactDir, `${locale}-${width}x${height}.png`),
      });
      await page.click('#agent-chatgpt-logout');
      await page.waitForFunction(
        () =>
          document.getElementById('agent-model').options.length === 0 &&
          document.getElementById('agent-send').disabled,
      );
      await page.evaluate(() => {
        window.open = () => ({ location: {}, close() {} });
      });
      await page.click('#agent-chatgpt-login');
      await page.waitForFunction(
        () => document.getElementById('agent-chatgpt-login').disabled,
      );
      if (locale === 'ar') {
        await page.waitForFunction(
          () =>
            document.getElementById('agent-chatgpt-status').textContent ===
            'أكمل تسجيل الدخول في المتصفح.',
        );
      }
      if (locale === 'zh-Hant' || locale === 'zh-TW' || locale === 'zh-CN') {
        await page.waitForFunction(
          () =>
            document
              .getElementById('agent-chatgpt-status')
              .textContent.includes('瀏覽器') ||
            document
              .getElementById('agent-chatgpt-status')
              .textContent.includes('浏览器'),
        );
        assert.deepEqual(
          await page.evaluate(() => ({
            lang: document.documentElement.lang,
            status: document.getElementById('agent-chatgpt-status').textContent,
          })),
          locale === 'zh-CN'
            ? { lang: 'zh-CN', status: '请在浏览器中完成登录。' }
            : { lang: 'zh-Hant', status: '請在瀏覽器中完成登入。' },
        );
      }
      await page.close();
      console.log(
        `PASS ${locale} ${width}×${height}: tool round trip, account isolation, STOP, logout, sign-in copy, layout`,
      );
    }
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
