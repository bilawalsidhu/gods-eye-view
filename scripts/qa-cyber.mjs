#!/usr/bin/env node
/**
 * Headless browser acceptance gate for Cyber Activity.
 * Usage: start the app, then run `QA_BASE_URL=http://localhost:4173 npm run qa:cyber`.
 * Provider API responses are replaced with fixed fixtures; no provider keys are needed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const baseUrl = process.env.QA_BASE_URL || 'http://localhost:4173';
const screenshots = process.env.QA_SHOTS_DIR || path.join(repoRoot, 'qa-shots', 'cyber');
const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH ||
  await puppeteer.executablePath().catch(() => null);

if (!executablePath || !fs.existsSync(executablePath)) {
  throw new Error('Puppeteer Chrome for Testing is unavailable');
}

const fetchedAt = '2026-09-24T12:00:00.000Z';
const windowStart = '2026-09-23T12:00:00.000Z';
const windowEnd = '2026-09-24T12:00:00.000Z';
const fixtures = {
  '/api/cyber/radar': {
    schemaVersion: 1,
    provider: 'cloudflare-radar',
    attribution: 'Cloudflare Radar',
    fetchedAt,
    windowStart,
    windowEnd,
    observations: [
      {
        id: 'qa:radar:origin:US',
        provider: 'cloudflare-radar',
        category: 'layer7-attack-origin',
        source: 'Cloudflare Radar',
        observedAt: fetchedAt,
        latitude: 39.8,
        longitude: -98.6,
        geographicPrecision: 'country',
        geographicMethod: 'Country reference point',
        geographicProvenance: 'United States country aggregate',
        locationCode: 'US',
        locationName: 'United States',
        share: 12.5,
        rank: 1,
      },
      {
        id: 'qa:radar:target:CA',
        provider: 'cloudflare-radar',
        category: 'layer7-attack-target',
        source: 'Cloudflare Radar',
        observedAt: fetchedAt,
        latitude: 56.1,
        longitude: -106.3,
        geographicPrecision: 'country',
        geographicMethod: 'Country reference point',
        geographicProvenance: 'Canada country aggregate',
        locationCode: 'CA',
        locationName: 'Canada',
        share: 8.2,
        rank: 1,
      },
    ],
    flows: [
      {
        id: 'qa:radar:flow:US:CA',
        provider: 'cloudflare-radar',
        origin: {
          code: 'US',
          name: 'United States',
          latitude: 39.8,
          longitude: -98.6,
        },
        target: {
          code: 'CA',
          name: 'Canada',
          latitude: 56.1,
          longitude: -106.3,
        },
        share: 4.2,
        rank: 1,
        observedAt: fetchedAt,
        windowStart,
        windowEnd,
        geographicMethod: 'Country reference coordinates',
        geographicProvenance: 'Cloudflare Radar reported country pair',
      },
    ],
  },
  '/api/cyber/dshield': {
    schemaVersion: 1,
    provider: 'dshield',
    attribution: 'SANS Internet Storm Center / DShield',
    fetchedAt,
    observations: [
      {
        id: 'qa:dshield:source:1',
        provider: 'dshield',
        category: 'reported-top-source-ip',
        source: 'SANS ISC / DShield',
        observedAt: fetchedAt,
        indicator: { type: 'ipv4', value: '198.51.100.42' },
      },
    ],
    ports: [
      { rank: 1, port: 443, protocol: 'tcp', label: 'https', sources: null },
    ],
  },
  '/api/cyber/kev': {
    provider: 'cisa-kev',
    fetchedAt,
    dateReleased: fetchedAt,
    catalogVersion: 'qa-fixture',
    attribution: 'CISA Known Exploited Vulnerabilities Catalog',
    count: 1,
    vulnerabilities: [
      {
        cveId: 'CVE-2024-12345',
        vendor: 'QA Vendor',
        product: 'QA Product',
        name: 'QA vulnerability',
        dateAdded: '2024-01-01',
        shortDescription: 'QA-only catalog fixture.',
        requiredAction: 'Apply the vendor update.',
        dueDate: '2024-02-01',
        ransomware: 'Unknown',
      },
    ],
  },
  '/api/cyber/ioda': {
    provider: 'ioda',
    fetchedAt,
    events: [
      {
        countryCode: 'US',
        countryName: 'United States',
        datasource: 'bgp',
        method: 'bgp',
        start: Math.floor(Date.parse(fetchedAt) / 1000) - 600,
        duration: 600,
      },
    ],
  },
};

fs.mkdirSync(screenshots, { recursive: true });
const browser = await puppeteer.launch({
  headless: 'new',
  executablePath,
  args: [
    ...(process.platform === 'darwin'
      ? ['--use-angle=metal', '--enable-gpu']
      : ['--use-gl=angle', '--use-angle=swiftshader']),
    '--no-sandbox',
  ],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const failures = [];
const consoleErrors = [];
const checks = [];
const check = (name, passed, detail = '') => {
  console.log(`[${passed ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`);
  checks.push({ name, passed, detail });
  if (!passed) failures.push(name);
};

page.on('console', (message) => {
  if (message.type() === 'error' && !/Failed to load resource.*404/i.test(message.text()))
    consoleErrors.push(message.text());
});
page.on('pageerror', (error) => consoleErrors.push(error.message));
await page.setRequestInterception(true);
page.on('request', (request) => {
  const url = new URL(request.url());
  const fixture = fixtures[url.pathname];
  if (!fixture) return request.continue();
  return request.respond({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(fixture),
  });
});

try {
  const response = await page.goto(baseUrl, {
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
  });
  check('app responds successfully', response?.ok() === true, `HTTP ${response?.status()}`);
  await page.waitForFunction(() => window.__godsEyeView?.dataManager, {
    timeout: 60_000,
  });
  const initialEnabled = await page.evaluate(() =>
    window.__godsEyeView.dataManager.isEnabled('cyber'),
  );
  check('Cyber Activity is off on first launch', initialEnabled === false);

  const enabled = await page.evaluate(async () =>
    window.__godsEyeView.dataManager.setEnabled('cyber', true, { origin: 'user' }),
  );
  check('Cyber Activity can be enabled', enabled === true);
  await page.waitForFunction(() => {
    const intel = document.getElementById('cyber-intel-panel');
    const summary = document.getElementById('cyber-threat-summary-panel');
    return intel && !intel.hidden && summary && !summary.hidden;
  }, { timeout: 30_000 });
  await page.waitForFunction(() =>
    document.getElementById('cyber-threat-summary-content')?.textContent.includes('198.51.100.42'),
  { timeout: 30_000 });
  await page.waitForFunction(() =>
    document.getElementById('cyber-intel-body')?.textContent.includes('CVE-2024-12345'),
  { timeout: 30_000 });

  const rendered = await page.evaluate(() => {
    const manager = window.__godsEyeView.dataManager;
    const layer = manager.layers.get('cyber')?.module;
    const stats = layer?.getStats?.();
    return {
      stats,
      intelVisible: !document.getElementById('cyber-intel-panel')?.hidden,
      dshieldVisible: !document.getElementById('cyber-threat-summary-panel')?.hidden,
      legendVisible: !document.getElementById('cyber-intel-legend-panel')?.hidden,
      dshieldSource: document.getElementById('cyber-threat-summary-content')?.textContent.includes('198.51.100.42'),
      kevRecord: document.getElementById('cyber-intel-body')?.textContent.includes('CVE-2024-12345'),
      kevCollapsed: document.querySelector('[data-kev-results]')?.open === false,
      legendHasRadar: document.getElementById('cyber-intel-map-legend-content')?.textContent.includes('CloudFlare Radar'),
    };
  });
  check('Cyber Intel and DShield summary appear when enabled', rendered.intelVisible && rendered.dshieldVisible);
  check('Radar and IODA fixture data are received', rendered.stats?.radarCount === 2 && rendered.stats?.iodaEventCount === 1, JSON.stringify(rendered.stats));
  check('KEV data appears with results collapsed by default', rendered.kevRecord && rendered.kevCollapsed);
  check('the map legend is visible and labels Radar', rendered.legendVisible && rendered.legendHasRadar);
  check('DShield source is shown in the prominent threat summary', rendered.dshieldSource);

  await page.screenshot({ path: path.join(screenshots, 'cyber-layer-enabled.png'), fullPage: false });
  await page.evaluate(() =>
    window.__godsEyeView.dataManager.setEnabled('cyber', false, { origin: 'user' }),
  );
  await page.waitForFunction(() => {
    const intel = document.getElementById('cyber-intel-panel');
    const summary = document.getElementById('cyber-threat-summary-panel');
    const legend = document.getElementById('cyber-intel-legend-panel');
    return intel?.hidden && summary?.hidden && legend?.hidden;
  }, { timeout: 15_000 });
  check('Cyber panels hide when the layer is disabled', true);
  check('browser has no uncaught or console errors', consoleErrors.length === 0, consoleErrors.join(' | '));
} catch (error) {
  check('browser QA completes', false, error.stack || error.message);
} finally {
  await browser.close();
}

console.log(`CYBER QA: ${failures.length ? `FAIL (${failures.length} failed)` : 'PASS'}`);
process.exit(failures.length ? 1 : 0);
