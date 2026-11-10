import assert from 'node:assert/strict';
import test from 'node:test';
import puppeteer from 'puppeteer';
import { launchBrowser } from './browser.mjs';

test('scenario launch uses the selected ANGLE backend and stays headless', async (t) => {
  const prior = process.env.QA_ANGLE;
  t.after(() => {
    if (prior === undefined) delete process.env.QA_ANGLE;
    else process.env.QA_ANGLE = prior;
  });
  process.env.QA_ANGLE = 'swiftshader';
  const browser = {};
  let options;
  t.mock.method(puppeteer, 'launch', async (value) => {
    options = value;
    return browser;
  });
  assert.equal(
    await launchBrowser({
      headless: false,
      args: ['--no-sandbox'],
      defaultViewport: { width: 800, height: 600 },
      protocolTimeout: 120000,
    }),
    browser,
  );
  assert.equal(options.headless, true);
  assert.deepEqual(options.args, [
    '--use-angle=swiftshader',
    '--enable-gpu',
    '--no-sandbox',
  ]);
  assert.deepEqual(options.defaultViewport, { width: 800, height: 600 });
  assert.equal(options.protocolTimeout, 120000);
  delete process.env.QA_ANGLE;
  await launchBrowser();
  assert.equal(options.args[0], '--use-angle=metal');
});
