#!/usr/bin/env node
/**
 * Accessibility audit for God's Eye View (WCAG 2.1 A/AA/AAA + best practice).
 *
 * Loads the running dev server headlessly, injects axe-core from node_modules,
 * and scans the app chrome in two states: the settled boot state and the
 * boot state with the control panel expanded. Violations are grouped by rule
 * with impact and sample selectors, and the full result is written to
 * qa-shots/a11y/report.json.
 *
 * This is an AUDIT tool: it reports and exits non-zero when violations exist
 * (unless --report-only) so it can gate, but fixing belongs to the source
 * tree — do not silence rules from the page; fix the markup/styles.
 *
 * Usage:
 *   node scripts/qa-a11y.mjs                 # gate: exit 1 on violations
 *   node scripts/qa-a11y.mjs --report-only   # always exit 0
 *   QA_BASE_URL=http://localhost:4173 node scripts/qa-a11y.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(repoRoot, 'qa-shots', 'a11y');
const appUrl = process.env.QA_BASE_URL || 'http://localhost:4173';
const reportOnly = process.argv.includes('--report-only');
const axePath = require.resolve('axe-core/axe.min.js');

const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH
  || (() => { try { return puppeteer.executablePath(); } catch { return null; } })();
if (!executablePath || !fs.existsSync(executablePath)) {
  throw new Error('Puppeteer Chrome for Testing is unavailable');
}
fs.mkdirSync(outDir, { recursive: true });

const browser = await puppeteer.launch({
  headless: 'new',
  executablePath,
  // The globe itself is irrelevant to this audit (axe reads DOM chrome), so
  // GPU is off entirely — software GL hangs some CI/container environments.
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
});

const failures = [];
try {
  const page = await browser.newPage();
  page.on('pageerror', (error) => console.error(`  [pageerror] ${error.message}`));

  await page.goto(appUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  // The audit targets app chrome (HUD, panels, launcher), which exists once
  // the style manager is up; live feeds are irrelevant to a11y and stay
  // unnetworked in keyless runs.
  await page
    .waitForFunction(() => Boolean(window.__godsEyeView?.styleManager), { timeout: 60000 })
    .catch(() => console.error('  [warn] __godsEyeView.styleManager never appeared; auditing whatever rendered'));
  await new Promise((resolve) => setTimeout(resolve, 4000));

  await page.addScriptTag({ path: axePath });

  const scan = async (stateLabel, prepare) => {
    if (prepare) await prepare();
    const results = await page.evaluate(() => window.axe.run(document, {
      resultTypes: ['violations'],
      runOnly: {
        type: 'tags',
        values: ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag2aaa', 'wcag21aaa', 'best-practice'],
      },
    }));
    return { stateLabel, url: appUrl, timestamp: new Date().toISOString(), results };
  };

  const expandPanel = async () => {
    await page.evaluate(() => {
      const toggle = document.getElementById('panel-toggle')
        || document.querySelector('[data-panel-toggle], .pp-toggles-head, #pp-toggles-head');
      if (toggle && toggle.getBoundingClientRect().height > 0) toggle.click();
    }).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 800));
  };

  const scans = [];
  scans.push(await scan('boot'));
  scans.push(await scan('panel-expanded', expandPanel));

  const report = { appUrl, generatedAt: new Date().toISOString(), scans: [] };
  let total = 0;

  for (const { stateLabel, results } of scans) {
    const violations = (results.violations || []).map((v) => ({
      id: v.id,
      impact: v.impact,
      help: v.help,
      wcag: (v.tags || []).filter((t) => t.startsWith('wcag')).join(','),
      nodes: v.nodes.length,
      sample: v.nodes.slice(0, 4).map((n) => n.target.join(' ')),
    }));
    report.scans.push({ state: stateLabel, violationCount: violations.length, violations });
    total += violations.length;
    console.log(`\n── ${stateLabel}: ${violations.length} rule violations`);
    for (const v of violations) {
      console.log(`  [${(v.impact || 'unknown').toUpperCase()}] ${v.id} (${v.wcag}) — ${v.help} — ${v.nodes} node(s)`);
      for (const sel of v.sample) console.log(`        ${sel}`);
    }
  }

  // Incomplete checks are manual-review candidates, not failures; record them.
  report.incomplete = scans.map(({ stateLabel, results }) => ({
    state: stateLabel,
    count: (results.incomplete || []).length,
    ids: (results.incomplete || []).map((v) => v.id),
  }));

  fs.writeFileSync(path.join(outDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`\nreport: qa-shots/a11y/report.json — ${total} rule violations across ${scans.length} states`);
  if (total > 0 && !reportOnly) {
    failures.push(`${total} accessibility violations`);
  }
} finally {
  await browser.close();
}

if (failures.length) {
  console.error(`\nA11Y AUDIT FAILED: ${failures.join('; ')}`);
  process.exit(1);
}
console.log('\nA11Y AUDIT PASSED');
