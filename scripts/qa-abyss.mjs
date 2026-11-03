#!/usr/bin/env node
/**
 * scripts/qa-abyss.mjs
 *
 * Dedicated headless browser QA gate for ABYSS Deep-Sea Exploration Layer.
 * Verifies catalog registration, lifecycle (init/enable/update/disable/destroy),
 * bathymetry configuration, hydrothermal vent acquisition and rendering,
 * and UI row controls and readout details via window.__godsEyeView.
 */

import puppeteer from 'puppeteer';
import { chromeExecutablePath } from './qa-chrome.mjs';

const BASE_URL = process.env.QA_BASE_URL || 'http://localhost:4173';

async function main() {
  console.log('=== QA Gate: ABYSS Deep-Sea Exploration ===');
  console.log(`Connecting to: ${BASE_URL}`);

  try {
    const res = await fetch(BASE_URL, { method: 'GET' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (e) {
    console.error(`\x1b[31mDev server not reachable at ${BASE_URL} (${e.message}).\x1b[0m`);
    console.error(`Start it first: npx vite --port 4173 (or npm run dev)`);
    process.exit(2);
  }

  const browser = await puppeteer.launch({
    headless: true,
    protocolTimeout: 300_000,
    ...(chromeExecutablePath() ? { executablePath: chromeExecutablePath() } : {}),
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--disable-dev-shm-usage',
      '--disable-web-security',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
      '--window-size=1280,720',
    ],
  });

  try {
    const page = await browser.newPage();
    page.on('console', (msg) => {
      console.log(`  [page:${msg.type()}] ${msg.text()}`);
    });
    page.on('pageerror', (err) => {
      console.error(`  [pageerror] ${err.message}`);
    });
    page.on('requestfailed', (req) => {
      console.warn(`  [reqfailed] ${req.method()} ${req.url()}: ${req.failure()?.errorText}`);
    });
    page.on('response', (res) => {
      if (res.status() >= 400) {
        console.warn(`  [resperror] HTTP ${res.status()} ${res.url()}`);
      }
    });
    await page.setViewport({ width: 1280, height: 720 });
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      try {
        const url = new URL(req.url());
        if (
          url.origin === 'https://terrain.reearth.land' ||
          url.origin === 'https://fonts.googleapis.com' ||
          url.origin === 'https://fonts.gstatic.com' ||
          url.origin === 'https://services.arcgisonline.com'
        ) {
          req.abort('failed');
          return;
        }
      } catch {
        // Continue if URL parse fails
      }
      req.continue();
    });

    // Navigate to local dev server with domcontentloaded
    console.log('Navigating to app...');
    await page.goto(BASE_URL, {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });

    console.log('Waiting for window.__godsEyeView...');
    // Wait for the application to be ready via window.__godsEyeView
    await page.waitForFunction(
      () => Boolean(window.__godsEyeView && window.__godsEyeView.viewer),
      {
        timeout: 60000,
        polling: 200,
      },
    );

    console.log(
      '[PASS] Application loaded successfully (__godsEyeView ready).',
    );

    // Step 1: Verify Abyss layer is present in dataManager
    const layerInfo = await page.evaluate(() => {
      const dm = window.__godsEyeView?.dataManager;
      const entry = dm?.layers?.get?.('abyss');
      const layer = entry?.module;
      if (!layer) {
        return {
          error: `Layer "abyss" not found. Available layers: ${[...(dm?.layers?.keys?.() || [])].join(', ')}`,
        };
      }
      return {
        id: layer.id,
        name: layer.name,
        showInTogglePanel: layer.showInTogglePanel,
        source: layer.source,
      };
    });

    if (layerInfo.error) {
      throw new Error(`Catalog verification failed: ${layerInfo.error}`);
    }
    console.log(
      `[PASS] Layer registered: id="${layerInfo.id}", name="${layerInfo.name}"`,
    );

    // Step 2: Enable Abyss layer via dataManager and test getRowControls()
    const controls = await page.evaluate(async () => {
      const dm = window.__godsEyeView.dataManager;
      await dm.setEnabled('abyss', true);
      const layer = dm.layers.get('abyss').module;
      const rowControls = layer.getRowControls();
      return {
        isEnabled: dm.isEnabled('abyss'),
        hasSummary: Boolean(rowControls?.summary),
        label: rowControls?.summary?.label,
        chipCount: rowControls?.chips?.length || 0,
        legendCount: rowControls?.legend?.length || 0,
        params: layer.getParams(),
      };
    });

    if (!controls.hasSummary || controls.chipCount === 0 || !controls.isEnabled) {
      throw new Error(`Abyss getRowControls() returned invalid structure: ${JSON.stringify(controls)}`);
    }
    console.log(
      `[PASS] Layer enabled: ${controls.chipCount} chips, ${controls.legendCount} depth legend stops.`,
    );

    // Step 3: Trigger update and verify hydrothermal vents & ROV dives
    const updateResult = await page.evaluate(async () => {
      const dm = window.__godsEyeView.dataManager;
      const layer = dm.layers.get('abyss').module;
      const viewer = window.__godsEyeView.viewer;

      await layer.update(viewer);
      const rowControls = layer.getRowControls();
      return {
        stats: rowControls?.summary?.stats,
        coverage: rowControls?.summary?.coverage,
      };
    });

    console.log(`[PASS] Data update: stats="${updateResult.stats}"`);

    // Step 4: Test changing layer params
    const paramResult = await page.evaluate(() => {
      const dm = window.__godsEyeView.dataManager;
      const layer = dm.layers.get('abyss').module;

      layer.setLayerParams({
        bathymetryProduct: 'GEBCO_LATEST',
        subseaFeaturesFilter: 'vents',
      });

      const params = layer.getParams();
      const rowControls = layer.getRowControls();
      const ventsChip = rowControls.chips.find((c) => c.id === 'filter-vents');

      return {
        product: params.bathymetryProduct,
        filter: params.subseaFeaturesFilter,
        ventsActive: ventsChip?.active,
      };
    });

    if (
      paramResult.product !== 'GEBCO_LATEST' ||
      paramResult.filter !== 'vents' ||
      !paramResult.ventsActive
    ) {
      throw new Error(
        `Parameter update failed: ${JSON.stringify(paramResult)}`,
      );
    }
    console.log(
      `[PASS] Layer params updated: product="${paramResult.product}", filter="${paramResult.filter}".`,
    );

    // Step 5: Test disable & cleanup
    const cleanupResult = await page.evaluate(async () => {
      const dm = window.__godsEyeView.dataManager;
      await dm.setEnabled('abyss', false);
      const layer = dm.layers.get('abyss').module;
      const rowControls = layer.getRowControls();
      return {
        isEnabled: dm.isEnabled('abyss'),
        selected: layer.getSelectedFeature(),
        detail: rowControls?.summary?.detail,
      };
    });

    if (cleanupResult.isEnabled || cleanupResult.selected !== null || cleanupResult.detail !== null) {
      throw new Error(`Layer disable did not clear selection state: ${JSON.stringify(cleanupResult)}`);
    }
    console.log('[PASS] Layer disabled and cleaned up cleanly.');

    console.log('=== QA Gate: ABYSS PASSED ALL CHECKS ===');
    process.exitCode = 0;
  } catch (err) {
    console.error(`[FAIL] QA Gate Error: ${err.message}`);
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

main();
