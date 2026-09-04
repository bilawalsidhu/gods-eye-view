#!/usr/bin/env node
/**
 * Smoke test: start dev server, open in Puppeteer, assert core UI elements render,
 * then shut down the server.
 *
 * Usage: node scripts/test-smoke.mjs
 */
import child_process from 'child_process';
import path from 'path';
import puppeteer from 'puppeteer';

const cwd = path.resolve(new URL('.', import.meta.url).pathname, '..');

function startDevServer() {
  return new Promise((resolve, reject) => {
    const proc = child_process.spawn('npm', ['run', 'dev'], { cwd, shell: true });
    let url = null;
    const onData = (chunk) => {
      const s = String(chunk);
      process.stdout.write(s);
      // Vite prints a "Local: http://localhost:5173/" line
      const m = s.match(/Local:\s+(https?:\/\/[^\s]+)/);
      if (m) url = m[1];
      if (url) {
        proc.stdout.off('data', onData);
        proc.stderr.off('data', onData);
        resolve({ proc, url });
      }
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('error', reject);
    // safety timeout
    setTimeout(() => {
      if (!url) reject(new Error('Dev server did not announce URL in time')); 
    }, 30000);
  });
}

(async () => {
  console.log('Starting dev server...');
  const { proc, url } = await startDevServer();
  console.log('Dev server URL:', url);
  let browser = null;
  try {
    browser = await puppeteer.launch({ headless: true });
    const page = await browser.newPage();
    page.setDefaultNavigationTimeout(30000);
    await page.goto(url, { waitUntil: 'networkidle2' });
    // Assert presence of core elements
    const selectors = ['#cesiumContainer', '#loading-screen', '#data-panel', '#key-setup'];
    for (const sel of selectors) {
      const exists = await page.$(sel) !== null;
      console.log(sel, exists ? 'OK' : 'MISSING');
      if (!exists) throw new Error(`Missing expected element: ${sel}`);
    }
    // Assert no runtime errors
    const errors = [];
    page.on('pageerror', (err) => errors.push(String(err)));
    const consoleErrors = [];
    page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
    await page.waitForTimeout(1500);
    if (errors.length || consoleErrors.length) {
      console.error('Runtime errors:', errors, consoleErrors);
      throw new Error('Runtime errors on page');
    }
    console.log('Smoke test passed');
  } catch (error) {
    console.error('Smoke test failed:', error);
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
    // Kill dev server
    try { proc.kill(); } catch {}
  }
})();
