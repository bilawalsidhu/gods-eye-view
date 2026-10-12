#!/usr/bin/env node
/**
 * End-to-end share/reload proof for the first two-character token. The QA
 * layer and an exhausted-digit reservation scenario are injected into
 * dev-server responses in this isolated browser only. Neither belongs in a
 * production bundle or ledger.
 *
 * Run against a local Vite server: node scripts/qa-layer-token-twochar.mjs
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import puppeteer from 'puppeteer';
import {
  LAYER_STATE_TOKEN_RESERVATIONS,
  nextLayerStateToken,
  parseLayerStateTokenReservations,
  validateLayerStateAllocations,
} from '../src/data/layerState.js';

const base = new URL(process.env.QA_BASE_URL || 'http://127.0.0.1:4173');
if (!['127.0.0.1', 'localhost'].includes(base.hostname))
  throw new Error('The QA fixture requires a loopback-only dev server');
const origin = base.origin;
const fixtureId = 'qa-twochar-fixture';
const injections = { codec: 0, catalog: 0 };
const errors = [];
const reservations = JSON.parse(
  await readFile(
    new URL('../src/data/layerStateTokenReservations.json', import.meta.url),
    'utf8',
  ),
);
assert.equal(
  reservations.some(([, token]) => token === '00'),
  false,
  '00 must remain unallocated in the production ledger for this QA fixture',
);
const productionTokens = new Set(reservations.map(([, token]) => token));
const priorDigitRows = [...'0123456789']
  .filter((digit) => !productionTokens.has(digit))
  .map((digit) => [`qa-prior-digit-${digit}`, digit]);
const priorState = parseLayerStateTokenReservations([
  ...reservations,
  ...priorDigitRows,
]);
assert.equal(nextLayerStateToken(priorState), '00');
assert.equal(
  validateLayerStateAllocations(
    LAYER_STATE_TOKEN_RESERVATIONS,
    parseLayerStateTokenReservations([
      ...reservations,
      ...priorDigitRows,
      [fixtureId, '00'],
    ]),
  ),
  true,
);
console.log(
  'PASS: isolated fixture exhausts prior digits before allocating 00',
);
for (const source of [
  '../src/data/layerState.js',
  '../src/app/constructCatalog.js',
]) {
  assert.equal(
    (await readFile(new URL(source, import.meta.url), 'utf8')).includes(
      fixtureId,
    ),
    false,
    `${fixtureId} must not exist in production source`,
  );
}

function replaceOnce(source, from, to, label) {
  const first = source.indexOf(from);
  if (first < 0 || source.indexOf(from, first + from.length) >= 0)
    throw new Error(`QA fixture anchor changed: ${label}`);
  return source.replace(from, to);
}

function injectCodec(source) {
  const fixtureRows = JSON.stringify([...priorDigitRows, [fixtureId, '00']]);
  let result = replaceOnce(
    source,
    'parseLayerStateTokenReservations(reservationRows)',
    `parseLayerStateTokenReservations([...reservationRows, ...${fixtureRows}])`,
    'reservation',
  );
  result = replaceOnce(
    result,
    ']);\n\nexport const REGISTERED_LAYER_IDS',
    `  Object.freeze({ id: '${fixtureId}', token: '00', disposition: 'enabled-only' }),\n]);\n\nexport const REGISTERED_LAYER_IDS`,
    'registry',
  );
  injections.codec += 1;
  return result;
}

function injectCatalog(source) {
  const result = replaceOnce(
    source,
    '        createBhoteKoshiEventLayer(),',
    `        {
          id: '${fixtureId}',
          name: 'Synthetic two-character token',
          icon: '◆',
          source: 'QA-only fixture',
          async init() { return true; },
          async enable() { return true; },
          async update() { return true; },
          async disable() { return true; },
          async destroy() { return true; },
          getStats() { return { count: 0 }; },
        },
        createBhoteKoshiEventLayer(),`,
    'catalog',
  );
  injections.catalog += 1;
  return result;
}

const browser = await puppeteer.launch({
  headless: true,
  args: [
    '--no-sandbox',
    '--disable-dev-shm-usage',
    ...(process.platform === 'darwin'
      ? ['--use-angle=metal', '--enable-gpu']
      : ['--use-gl=angle', '--use-angle=swiftshader']),
  ],
});

async function newPage() {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setViewport({ width: 1280, height: 800 });
  await page.setCacheEnabled(false);
  await page.evaluateOnNewDocument(() => {
    window.__qaRestoreEvents = [];
    window.addEventListener('gev:initial-share-restore-settled', (event) => {
      window.__qaRestoreEvents.push(event.detail);
    });
  });
  await page.setRequestInterception(true);
  page.on('request', async (request) => {
    try {
      const url = new URL(request.url());
      if (url.origin !== origin) return await request.abort();
      const transform =
        url.pathname === '/src/data/layerState.js'
          ? injectCodec
          : url.pathname === '/src/app/constructCatalog.js'
            ? injectCatalog
            : null;
      if (!transform) return await request.continue();
      const response = await fetch(request.url());
      assert.equal(response.status, 200, `dev module ${url.pathname}`);
      await request.respond({
        status: 200,
        contentType: 'application/javascript',
        body: transform(await response.text()),
      });
    } catch (error) {
      errors.push(String(error?.stack || error));
      await request.abort().catch(() => {});
    }
  });
  return { context, page };
}

async function load(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForFunction(
    (id) => window.__godsEyeView?.dataManager?.layers?.has(id),
    { timeout: 60_000 },
    fixtureId,
  );
}

async function loadedState(page) {
  return page.evaluate((id) => {
    const manager = window.__godsEyeView.dataManager;
    return {
      enabled: manager.isEnabled(id),
      flights: manager.isEnabled('flights'),
      localStorage: localStorage.getItem('gev:layer-state:v2'),
      restoreEvents: window.__qaRestoreEvents,
      hash: location.hash,
    };
  }, fixtureId);
}

async function waitForRestore(page) {
  await page.waitForFunction(() => window.__qaRestoreEvents.length > 0, {
    timeout: 60_000,
  });
  return loadedState(page);
}

function withLayers(link, layers) {
  const url = new URL(link);
  const params = new URLSearchParams(url.hash.slice(1));
  params.set('l', layers);
  url.hash = params.toString();
  return url.href;
}

const contexts = [];
try {
  const sender = await newPage();
  contexts.push(sender.context);
  await load(sender.page, `${origin}/?welcome=0`);
  const toggled = await sender.page.evaluate(
    (id) =>
      window.__godsEyeView.dataManager.setEnabled(id, true, { origin: 'user' }),
    fixtureId,
  );
  assert.equal(toggled, true, 'synthetic layer enables through manager');
  await sender.page.waitForFunction(
    () => new URLSearchParams(location.hash.slice(1)).get('l') === '00',
    { timeout: 15_000 },
  );
  const sharedUrl = sender.page.url();
  const authored = new URLSearchParams(new URL(sharedUrl).hash.slice(1));
  assert.equal(authored.get('v'), '2');
  assert.equal(authored.get('l'), '00');
  assert.ok(authored.has('lat') && authored.has('lon'));
  console.log('PASS: real user-origin enable encoded 00 in a full share URL');

  const recipient = await newPage();
  contexts.push(recipient.context);
  await load(recipient.page, sharedUrl);
  const restored = await waitForRestore(recipient.page);
  assert.equal(restored.enabled, true);
  assert.equal(restored.localStorage, null);
  assert.equal(restored.restoreEvents.at(-1)?.status, 'settled');
  assert.ok(
    restored.restoreEvents
      .at(-1)
      ?.layers?.some(
        (layer) =>
          layer.layerId === fixtureId &&
          layer.targetEnabled === true &&
          layer.succeeded === true,
      ),
    'share coordinator restored the synthetic layer',
  );
  console.log(
    'PASS: cold recipient reload restored the 00 layer without writing local preferences',
  );

  await recipient.page.reload({
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
  });
  await recipient.page.waitForFunction(
    (id) => window.__godsEyeView?.dataManager?.layers?.has(id),
    { timeout: 60_000 },
    fixtureId,
  );
  const reloaded = await waitForRestore(recipient.page);
  assert.equal(reloaded.enabled, true);
  assert.equal(reloaded.localStorage, null);
  assert.equal(new URLSearchParams(reloaded.hash.slice(1)).get('l'), '00');
  console.log('PASS: a full recipient reload restores the same 00 layer state');

  const disabled = await recipient.page.evaluate(
    (id) =>
      window.__godsEyeView.dataManager.setEnabled(id, false, {
        origin: 'user',
      }),
    fixtureId,
  );
  assert.equal(disabled, true);
  await recipient.page.waitForFunction(
    () => new URLSearchParams(location.hash.slice(1)).get('l') === '',
    { timeout: 15_000 },
  );
  assert.equal((await loadedState(recipient.page)).enabled, false);
  console.log('PASS: explicit OFF removes 00 from the authored share URL');

  const legacy = await newPage();
  contexts.push(legacy.context);
  await load(legacy.page, withLayers(sharedUrl, 'f'));
  const legacyState = await waitForRestore(legacy.page);
  assert.equal(legacyState.flights, true);
  assert.equal(legacyState.enabled, false);
  assert.equal(legacyState.restoreEvents.at(-1)?.status, 'settled');
  console.log('PASS: a legacy one-character token still restores');

  const mixed = await newPage();
  contexts.push(mixed.context);
  await load(mixed.page, withLayers(sharedUrl, 'f.00'));
  const mixedState = await waitForRestore(mixed.page);
  assert.equal(mixedState.flights, true);
  assert.equal(mixedState.enabled, true);
  console.log('PASS: mixed legacy and two-character tokens restore together');

  const malformed = await newPage();
  contexts.push(malformed.context);
  await load(malformed.page, withLayers(sharedUrl, 'f..00'));
  const malformedState = await waitForRestore(malformed.page);
  assert.equal(malformedState.flights, false);
  assert.equal(malformedState.enabled, false);
  assert.equal(malformedState.localStorage, null);
  console.log(
    'PASS: malformed layer list is rejected without partial restoration',
  );

  const repeated = await newPage();
  contexts.push(repeated.context);
  const repeatedUrl = new URL(withLayers(sharedUrl, 'f'));
  const repeatedParams = new URLSearchParams(repeatedUrl.hash.slice(1));
  repeatedParams.append('l', '00');
  repeatedUrl.hash = repeatedParams.toString();
  await load(repeated.page, repeatedUrl.href);
  const repeatedState = await waitForRestore(repeated.page);
  assert.equal(repeatedState.flights, false);
  assert.equal(repeatedState.enabled, false);
  assert.equal(repeatedState.localStorage, null);
  console.log('PASS: repeated layer fields reject the entire share payload');

  assert.ok(injections.codec >= contexts.length);
  assert.ok(injections.catalog >= contexts.length);
  assert.deepEqual(errors, []);
  console.log(
    'PASS: QA-only codec and catalog injections reached every isolated session',
  );
  console.log(
    'Synthetic end-to-end evidence only; production 00 allocation remains pending.',
  );
  console.log('RESULT: 10 passed, 0 failed, 0 skipped');
} finally {
  await Promise.all(contexts.map((context) => context.close().catch(() => {})));
  await browser.close();
}
