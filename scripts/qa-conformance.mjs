#!/usr/bin/env node
/**
 * Run the renderer conformance logic suite on the Cesium renderer in
 * headless Chromium (`dev/conformance/`, `window.conformance.runLogic`),
 * and fail on any failed check, or on a skip that is not expected.
 *
 * Without `--url` it starts a Vite dev server of this checkout on `--port`
 * (default 5289) and stops it after. WebGL runs on SwiftShader, so the run
 * needs no GPU. `--only id,id` runs just those checks; `--json path` writes
 * the report.
 *
 *   npm run qa:conformance [-- --url http://127.0.0.1:5280] [--only ids]
 *     [--json path]
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Checks the run skips, with why: anything else skipped fails it. */
export const EXPECTED_SKIPS = Object.freeze({
  // The page scripts no heights for the Cesium renderer.
  'query.heights': 'no scripted heights in this harness',
});

/** A whole run has this long; a check that hangs fails it rather than CI. */
const RUN_TIMEOUT_MS = 15 * 60_000;

function parseArgs(argv) {
  const args = { port: 5289 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--url') args.url = argv[++i];
    else if (arg === '--port') args.port = Number(argv[++i]);
    else if (arg === '--only') args.only = argv[++i].split(',');
    else if (arg === '--json') args.json = argv[++i];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

async function startViteServer(port) {
  const { createServer } = await import('vite');
  const server = await createServer({
    root: ROOT,
    configFile: path.join(ROOT, 'vite.config.js'),
    // No hot reload: the page is loaded once and nothing edits it.
    server: { port, strictPort: true, host: '127.0.0.1', hmr: false },
    logLevel: 'warn',
  });
  await server.listen();
  return server;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const server = args.url ? null : await startViteServer(args.port);
  try {
    await run(args);
  } finally {
    await server?.close();
  }
}

async function run(args) {
  const base = (args.url ?? `http://127.0.0.1:${args.port}`).replace(/\/$/, '');
  const browser = await puppeteer.launch({
    headless: true,
    executablePath:
      process.env.PUPPETEER_EXECUTABLE_PATH ||
      (await puppeteer.executablePath()),
    defaultViewport: { width: 1280, height: 800 },
    protocolTimeout: RUN_TIMEOUT_MS,
    args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader'],
  });
  const pageErrors = [];
  let report;
  try {
    const page = await browser.newPage();
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.goto(`${base}/dev/conformance/`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.conformance?.runLogic, {
      timeout: 120_000,
    });
    report = await page.evaluate(
      (only) => window.conformance.runLogic('cesium', { only }),
      args.only ?? null,
    );
  } finally {
    await browser.close();
  }
  if (args.json) writeFileSync(args.json, JSON.stringify(report, null, 2));
  console.log(
    `cesium: ${report.passed} passed, ${report.failed} failed, ${report.skipped} skipped`,
  );
  const problems = [];
  for (const failure of report.failures) {
    console.error(`fail\t${failure.id}\t${failure.detail ?? ''}`);
    problems.push(failure.id);
  }
  for (const skip of report.skips) {
    const expected = EXPECTED_SKIPS[skip.id] === skip.detail;
    console.log(`skip\t${skip.id}\t${skip.detail ?? ''}`);
    if (!expected) problems.push(`${skip.id} skipped`);
  }
  if (!args.only && report.passed === 0) problems.push('nothing passed');
  if (problems.length) {
    console.error(`FAIL: ${problems.join('; ')}`);
    process.exitCode = 1;
  } else console.log('ok: the Cesium renderer passes the conformance suite');
}

if (import.meta.url === `file://${process.argv[1]}`)
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
