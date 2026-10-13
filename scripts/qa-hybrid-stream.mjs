#!/usr/bin/env node
/**
 * Deterministic streaming UI gate against the running hybrid (default :4173).
 * Only chat fetches are replaced by held synthetic NDJSON streams. No model
 * credentials or live completions are used. Artifacts: qa-artifacts/hybrid-stream/.
 * Run with Node 24; PUPPETEER_EXECUTABLE_PATH and QA_BASE_URL are optional.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import puppeteer from 'puppeteer';

const root = new URL('../', import.meta.url);
const output = new URL('../qa-artifacts/hybrid-stream/', import.meta.url);
await mkdir(output, { recursive: true });
const candidates = [
  process.env.PUPPETEER_EXECUTABLE_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  await puppeteer.executablePath().catch(() => null),
];
const executablePath = candidates.find((path) => path && existsSync(path));
const browser = await puppeteer.launch({
  headless: true,
  executablePath,
  args:
    process.platform === 'darwin'
      ? ['--use-angle=metal', '--enable-gpu']
      : ['--use-gl=angle', '--use-angle=swiftshader'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 1000 });
const report = {
  title: 'Synthetic streaming UI gate; no live model completions',
  synthetic: true,
  startedAt: new Date().toISOString(),
  commit: execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
  }).trim(),
  workingTreeChanged: Boolean(
    execFileSync('git', ['status', '--porcelain'], {
      cwd: root,
      encoding: 'utf8',
    }).trim(),
  ),
  checks: [],
  screenshots: [],
  errors: [],
  modelNetworkRequests: [],
};
page.on('pageerror', (error) => report.errors.push(error.message));
page.on('request', (request) => {
  const path = new URL(request.url()).pathname;
  if (['/api/local-model/chat', '/api/openai/hud-summary'].includes(path))
    report.modelNetworkRequests.push(path);
});
const check = (name) => report.checks.push({ name, passed: true });
await page.evaluateOnNewDocument(() => {
  const nativeFetch = window.fetch;
  const calls = [];
  const encoder = new TextEncoder();
  window.__hybridStreamFixture = {
    calls,
    emit(index, event) {
      calls[index].controller.enqueue(
        encoder.encode(JSON.stringify(event) + '\n'),
      );
    },
    finish(index, text, model) {
      this.emit(index, {
        type: 'complete',
        content: text,
        model,
        toolCalls: [],
        finishReason: 'stop',
      });
      calls[index].controller.close();
      calls[index].completed = true;
    },
  };
  window.fetch = function (input, options = {}) {
    const url = new URL(
      typeof input === 'string' ? input : input.url,
      location.href,
    );
    if (
      url.origin !== location.origin ||
      url.pathname !== '/api/local-model/chat'
    )
      return nativeFetch.call(this, input, options);
    const payload = JSON.parse(options.body);
    if (payload.stream !== true)
      throw new Error('Synthetic gate requires stream:true');
    const call = {
      stream: payload.stream,
      cancelled: false,
      aborted: false,
      completed: false,
    };
    calls.push(call);
    const response = new Response(
      new ReadableStream({
        start(controller) {
          call.controller = controller;
          options.signal?.addEventListener(
            'abort',
            () => {
              call.aborted = true;
              if (!call.completed && !call.cancelled)
                controller.error(
                  new DOMException('Synthetic stream aborted', 'AbortError'),
                );
            },
            { once: true },
          );
        },
        cancel() {
          call.cancelled = true;
        },
      }),
      { headers: { 'Content-Type': 'application/x-ndjson' } },
    );
    return Promise.resolve(response);
  };
});

async function submit(text, expectedCalls) {
  await page.waitForSelector(
    '.hybrid-chat-form button[type="submit"]:not([disabled])',
  );
  await page.$eval(
    '#hybrid-chat-question',
    (element, value) => {
      element.value = value;
    },
    text,
  );
  await page.$eval('.hybrid-chat-form button[type="submit"]', (element) =>
    element.scrollIntoView({ block: 'nearest' }),
  );
  await page.click('.hybrid-chat-form button[type="submit"]');
  await page.waitForFunction(
    (count) => window.__hybridStreamFixture.calls.length === count,
    {},
    expectedCalls,
  );
}

async function capture(name, state, expectedText) {
  const selector = `.hybrid-chat-message[data-role="assistant"][data-state="${state}"]`;
  await page.waitForSelector(selector);
  await page.evaluate((selector) => {
    const body = document.querySelector('.hybrid-intelligence-body');
    const transcript = document.querySelector('.hybrid-chat-transcript');
    body.scrollTop = body.scrollHeight;
    transcript.scrollTop = transcript.scrollHeight;
    document.querySelector(selector).scrollIntoView({ block: 'nearest' });
    document
      .querySelector('.hybrid-chat-actions')
      .scrollIntoView({ block: 'nearest' });
  }, selector);
  const visible = await page.evaluate((selector) => {
    const panel = document
      .querySelector('#hybrid-intelligence')
      .getBoundingClientRect();
    const body = document
      .querySelector('.hybrid-intelligence-body')
      .getBoundingClientRect();
    const transcript = document
      .querySelector('.hybrid-chat-transcript')
      .getBoundingClientRect();
    const row = document.querySelector(selector);
    const bounds = row.getBoundingClientRect();
    const actions = document
      .querySelector('.hybrid-chat-actions')
      .getBoundingClientRect();
    const viewport = { width: innerWidth, height: innerHeight };
    const inside = (rect, clip) =>
      rect.left >= Math.max(0, clip.left) - 1 &&
      rect.right <= Math.min(innerWidth, clip.right) + 1 &&
      rect.top >= Math.max(0, clip.top) - 1 &&
      rect.bottom <= Math.min(innerHeight, clip.bottom) + 1;
    return {
      text: row.innerText,
      state: row.dataset.state,
      busy: document
        .querySelector('.hybrid-chat-form')
        .getAttribute('aria-busy'),
      rowVisible: inside(bounds, body) && inside(bounds, transcript),
      controlsVisible: inside(actions, body),
      panelWithinViewport: panel.left >= 0 && panel.right <= innerWidth,
      row: { top: bounds.top, bottom: bounds.bottom },
      controls: { top: actions.top, bottom: actions.bottom },
      viewport,
    };
  }, selector);
  assert.ok(
    visible.text.includes(expectedText),
    'Expected synthetic text must be rendered',
  );
  assert.equal(
    visible.rowVisible,
    true,
    `${name}: assistant row must be fully visible`,
  );
  assert.equal(
    visible.controlsVisible,
    true,
    `${name}: chat controls must be visible`,
  );
  assert.equal(
    visible.panelWithinViewport,
    true,
    `${name}: panel must fit viewport`,
  );
  // Let scroll/focus compositing settle before capturing text on the GPU canvas.
  await page.evaluate(
    () =>
      new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(resolve));
      }),
  );
  await page.screenshot({ path: new URL(name, output).pathname });
  report.screenshots.push({ file: name, ...visible });
  return visible;
}

try {
  await page.goto(process.env.QA_BASE_URL || 'http://127.0.0.1:4173', {
    waitUntil: 'domcontentloaded',
    timeout: 20000,
  });
  await page.waitForSelector('#hybrid-intelligence-toggle', {
    visible: true,
    timeout: 60000,
  });
  await page.waitForSelector('#first-run-launcher:not([hidden])', {
    visible: true,
  });
  await page.click('[data-first-run-choice="explore"]');
  await page.waitForSelector('#first-run-launcher', { hidden: true });
  await page.click('#hybrid-intelligence-toggle');
  await page.waitForSelector('#hybrid-intelligence', { visible: true });

  await submit('SYNTHETIC QA: hold this response for Stop.', 1);
  await page.evaluate(() =>
    window.__hybridStreamFixture.emit(0, {
      type: 'delta',
      content: 'Synthetic stream: the first words are visible.',
      model: 'synthetic/stream-fixture-a',
    }),
  );
  const partial = await capture(
    'desktop-partial.png',
    'receiving',
    'Synthetic stream: the first words are visible.',
  );
  assert.equal(partial.busy, 'true');
  assert.ok(partial.text.includes('Receiving…'));
  assert.equal(
    await page.$eval(
      '.hybrid-chat-form button[type="submit"]',
      (element) => element.disabled,
    ),
    true,
  );
  check('held-stream-text-visible-before-completion');

  await page.evaluate(() =>
    window.__hybridStreamFixture.emit(0, {
      type: 'delta',
      content: ' More synthetic text arrives before completion.',
      model: 'synthetic/stream-fixture-b',
    }),
  );
  await page.waitForFunction(() =>
    document
      .querySelector('.hybrid-chat-message[data-state="receiving"]')
      ?.innerText.includes('synthetic/stream-fixture-b'),
  );
  assert.equal(
    await page.$$eval(
      '.hybrid-chat-message[data-role="assistant"]',
      (rows) => rows.length,
    ),
    1,
  );
  check('progress-and-model-update-same-row');
  await page.click('.hybrid-chat-form button[type="button"]');
  await page.waitForFunction(
    () =>
      document.querySelector('.hybrid-chat-form')?.getAttribute('aria-busy') ===
      'false',
  );
  const incomplete = await capture(
    'desktop-incomplete.png',
    'incomplete',
    'More synthetic text arrives before completion.',
  );
  assert.ok(incomplete.text.includes('Incomplete'));
  check('stop-retains-partial-as-incomplete');

  await page.setViewport({ width: 390, height: 844 });
  await submit('SYNTHETIC QA: complete the next response.', 2);
  await page.evaluate(() => {
    const fixture = window.__hybridStreamFixture;
    fixture.emit(1, {
      type: 'delta',
      content: 'Synthetic recovery:',
      model: 'synthetic/recovery-draft',
    });
  });
  await page.waitForSelector('.hybrid-chat-message[data-state="receiving"]');
  await page.evaluate(() =>
    window.__hybridStreamFixture.finish(
      1,
      'Synthetic recovery: the new answer completed successfully.',
      'synthetic/recovery-final',
    ),
  );
  await page.waitForFunction(
    () =>
      document.querySelector('.hybrid-chat-form')?.getAttribute('aria-busy') ===
      'false',
  );
  const completed = await capture(
    'mobile-completed.png',
    'complete',
    'Synthetic recovery: the new answer completed successfully.',
  );
  assert.ok(completed.text.includes('synthetic/recovery-final'));
  assert.equal(completed.busy, 'false');
  assert.equal(
    await page.$eval(
      '.hybrid-chat-form button[type="submit"]',
      (element) => element.disabled,
    ),
    false,
  );
  assert.equal(
    await page.$$eval(
      '.hybrid-chat-message[data-state="incomplete"]',
      (rows) => rows.length,
    ),
    1,
  );
  check('new-session-recovers-and-keeps-prior-incomplete-row');
  check('mobile-completed-answer-and-controls-visible');
  report.syntheticCalls = await page.evaluate(() =>
    window.__hybridStreamFixture.calls.map(
      ({ stream, cancelled, aborted, completed }) => ({
        stream,
        cancelled,
        aborted,
        completed,
      }),
    ),
  );
  assert.equal(report.syntheticCalls.length, 2);
  assert.equal(
    report.syntheticCalls[0].aborted || report.syntheticCalls[0].cancelled,
    true,
  );
  assert.equal(report.syntheticCalls[1].completed, true);
  assert.deepEqual(report.modelNetworkRequests, []);
  check('no-live-model-network-requests');
} catch (error) {
  report.failure = error.message;
  await page.screenshot({ path: new URL('failure.png', output).pathname });
  process.exitCode = 1;
} finally {
  report.completedAt = new Date().toISOString();
  await writeFile(
    new URL('report.json', output),
    JSON.stringify(report, null, 2) + '\n',
  );
  await browser.close();
  console.log(JSON.stringify(report, null, 2));
}
