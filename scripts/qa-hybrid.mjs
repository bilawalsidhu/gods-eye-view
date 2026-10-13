#!/usr/bin/env node
import puppeteer from 'puppeteer';
import { mkdir, writeFile } from 'node:fs/promises';
const output = new URL('../qa-artifacts/hybrid/', import.meta.url);
await mkdir(output, { recursive: true });
const browser = await puppeteer.launch({
  headless: true,
  executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
  args:
    process.platform === 'darwin'
      ? ['--use-angle=metal', '--enable-gpu']
      : ['--use-gl=angle', '--use-angle=swiftshader'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 1000 });
const report = {
  startedAt: new Date().toISOString(),
  errors: [],
  failedRequests: [],
  checks: [],
};
page.on('pageerror', (e) => report.errors.push(e.message));
page.on('requestfailed', (r) => {
  if (report.failedRequests.length < 30)
    report.failedRequests.push({
      url: r.url().split('?')[0],
      error: r.failure()?.errorText,
    });
});
try {
  await page.goto(process.env.QA_BASE_URL || 'http://127.0.0.1:4173', {
    waitUntil: 'domcontentloaded',
    timeout: 20000,
  });
  await page.waitForSelector('#hybrid-intelligence-toggle', {
    visible: true,
    timeout: 60000,
  });
  report.checks.push({ name: 'globe-and-panel-startup', passed: true });
  // The first-launch mission picker owns focus until dismissed.
  await page.waitForSelector('#first-run-launcher:not([hidden])', {
    visible: true,
  });
  await page.click('[data-first-run-choice="explore"]');
  await page.waitForSelector('#first-run-launcher', { hidden: true });
  await page.click('#hybrid-intelligence-toggle');
  await page.waitForSelector('#hybrid-intelligence', { visible: true });
  if (process.env.QA_LIVE_LOCAL_MODEL === '1') {
    report.modelResponses = [];
    report.hudResponses = [];
    page.on('response', async (response) => {
      if (response.url().endsWith('/api/openai/hud-summary')) {
        try {
          const data = await response.json();
          report.hudResponses.push({
            status: response.status(),
            summary: data.summary,
          });
        } catch {}
        return;
      }
      if (!response.url().endsWith('/api/local-model/chat')) return;
      try {
        const body = await response.text();
        const events = response
          .headers()
          ['content-type']?.includes('application/x-ndjson')
          ? body
              .trim()
              .split('\n')
              .map((line) => JSON.parse(line))
          : [];
        const data = events.length ? events.at(-1) : JSON.parse(body);
        report.modelResponses.push({
          streamed: events.some((event) => event.type === 'delta'),
          terminal: data.type || null,
          status: response.status(),
          model: data.model,
          toolNames: (data.toolCalls || []).map((call) => call.name),
          answered: Boolean(data.content),
        });
      } catch {}
    });
    await page.click('.hybrid-country-form button[type="submit"]');
    await page.waitForFunction(
      () =>
        document
          .querySelector('.hybrid-country-results')
          ?.getAttribute('aria-busy') === 'false',
      { timeout: 40000 },
    );
    report.countryText = await page.$eval('.hybrid-country-results', (e) =>
      e.innerText.slice(0, 300),
    );
    await page.waitForSelector(
      '.hybrid-chat-form button[type="submit"]:not([disabled])',
    );
    await page.type(
      '#hybrid-chat-question',
      'Call world_monitor_country_headlines for country US, then state its coverage status in one sentence. Use the tool before answering.',
    );
    await page.evaluate(() => {
      window.__hybridStreamTiming = { start: performance.now(), samples: [] };
      const observer = new MutationObserver(() => {
        const row = document.querySelector(
          '.hybrid-chat-message[data-state="receiving"]',
        );
        if (row)
          window.__hybridStreamTiming.samples.push({
            ms: Math.round(
              performance.now() - window.__hybridStreamTiming.start,
            ),
            characters: row.querySelector('p').textContent.length,
            busy: document
              .querySelector('.hybrid-chat-form')
              .getAttribute('aria-busy'),
          });
      });
      observer.observe(document.querySelector('.hybrid-chat-transcript'), {
        childList: true,
        subtree: true,
        characterData: true,
      });
    });
    await page.click('.hybrid-chat-form button[type="submit"]');
    await page.waitForSelector('.hybrid-chat-message[data-state="receiving"]', {
      timeout: 185000,
    });
    await page.screenshot({ path: new URL('streaming.png', output).pathname });
    await page.waitForFunction(
      () =>
        document
          .querySelector('.hybrid-chat-form')
          ?.getAttribute('aria-busy') === 'false',
      { timeout: 310000 },
    );
    const replies = await page.$$eval(
      '.hybrid-chat-message[data-role="assistant"]',
      (nodes) => nodes.map((e) => e.innerText),
    );
    if (!replies.length) throw new Error('No local assistant response');
    report.assistantReply = replies.at(-1);
    report.streaming = await page.evaluate(() => ({
      ...window.__hybridStreamTiming,
      completedMs: Math.round(
        performance.now() - window.__hybridStreamTiming.start,
      ),
    }));
    if (!report.streaming.samples.some((sample) => sample.busy === 'true'))
      throw new Error('No visible text before answer completion');
    report.checks.push({
      name: 'text-visible-during-generation',
      passed: true,
    });
    if (
      !report.modelResponses.some((response) =>
        response.toolNames.includes('world_monitor_country_headlines'),
      )
    )
      throw new Error(
        'Local model did not call the requested World Monitor tool',
      );
    report.checks.push({
      name: 'live-local-model-with-world-monitor-tool',
      passed: true,
    });
  }
  await page.screenshot({ path: new URL('desktop.png', output).pathname });
  report.panelText = await page.$eval(
    '#hybrid-intelligence',
    (e) => e.innerText,
  );
  await page.setViewport({ width: 390, height: 844 });
  await page.screenshot({ path: new URL('mobile.png', output).pathname });
  report.mobile = await page.$eval('#hybrid-intelligence', (e) => ({
    left: e.getBoundingClientRect().left,
    right: e.getBoundingClientRect().right,
    viewport: innerWidth,
  }));
  if (report.mobile.left < 0 || report.mobile.right > report.mobile.viewport)
    throw new Error('Mobile panel exceeds viewport');
  report.checks.push({ name: 'mobile-panel-bounds', passed: true });
  await page.keyboard.press('Escape');
  await page.waitForSelector('#hybrid-intelligence', { hidden: true });
  report.checks.push({ name: 'keyboard-dismissal', passed: true });
} catch (error) {
  report.failure = error.message;
  await page.screenshot({ path: new URL('failure.png', output).pathname });
  process.exitCode = 1;
} finally {
  await writeFile(
    new URL('report.json', output),
    JSON.stringify(report, null, 2) + '\n',
  );
  await browser.close();
  console.log(JSON.stringify(report, null, 2));
}
