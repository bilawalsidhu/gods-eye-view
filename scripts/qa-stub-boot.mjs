#!/usr/bin/env node
/**
 * Boot the whole application on the stub renderer with only the contract's
 * required members (`dev/stub-app/main.js`), headless, and check that:
 *
 * - it starts, with no Cesium module requested at all (no script, no
 *   worker, no asset it would fetch; the one Cesium stylesheet the build's
 *   `vite-plugin-cesium` links into every page is reported, not failed);
 * - the credits show in the application's own line, and its list opens
 *   with the data credits;
 * - each data layer named below turns on, and off, without a page error or
 *   a console error (a feed's failed response is reported as the feed's,
 *   not failed: without network access or keys a feed answers with an
 *   error, and the layer must take that without one of its own; the dev
 *   server's client's own errors are reported as the tooling's);
 * - with `--strict`, each of them draws on the stub: items in its draw sets,
 *   imagery added through the globe port, or a field (`draw.field`).
 *
 * The page is the application's own (`index.html`), served with the stub
 * entry in place of `src/main.js`. Without `--url` it starts a Vite dev
 * server of this checkout on `--port` (default 5290) and stops it after.
 * Live feeds answer through the dev server's providers, so without network
 * access or keys a layer turns on with nothing to draw: the run says so,
 * and only `--strict` fails it.
 *
 * `--all-capabilities` gives the stub every capability instead, to see what
 * the layers draw where a renderer has them all.
 *
 *   npm run qa:stub-boot [-- --url http://127.0.0.1:5280] [--strict]
 *     [--settle-ms 20000] [--json path] [--all-capabilities]
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The data layers the stub must run, by catalog id. */
export const STUB_BOOT_LAYERS = Object.freeze([
  'flights',
  'military',
  'transit',
  'traffic',
  'cctv',
  'ais-live-vessels',
  'weather-radar',
  'weather-satellite',
  'wind',
  'satellites',
  'local-firms',
  'wildlife-sightings',
  'shipwrecks',
  'news',
]);

/** A request that is Cesium: the package, its pre-bundle, or its assets. */
export const isCesiumRequest = (url) =>
  /(?:^|[/._-])cesium(?:[/._-]|$)/i.test(new URL(url).pathname);

/** The stylesheet `vite-plugin-cesium` links into every page it serves. */
const isPluginStylesheet = (url, type) =>
  type === 'stylesheet' &&
  new URL(url).pathname === '/cesium/Widgets/widgets.css';

/**
 * A browser's line for a feed's response that failed: one of the dev
 * server's providers (`/api/`) or another origin's. The application's own
 * modules and assets failing are the page's.
 */
const isFailedResponse = (text, at, base) => {
  if (!/^Failed to load resource:/.test(text)) return false;
  try {
    const url = new URL(at);
    return (
      url.origin !== new URL(base).origin || url.pathname.startsWith('/api/')
    );
  } catch {
    return false;
  }
};

/**
 * An error the dev server's own client logs (its socket to the server, which
 * a headless browser can refuse): the tooling's, not the application's.
 */
const isDevClient = (at) => {
  try {
    return new URL(at).pathname === '/@vite/client';
  } catch {
    return false;
  }
};

function parseArgs(argv) {
  const args = { strict: false, port: 5290, settleMs: 20_000 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--strict') args.strict = true;
    else if (arg === '--url') args.url = argv[++i];
    else if (arg === '--port') args.port = Number(argv[++i]);
    else if (arg === '--settle-ms') args.settleMs = Number(argv[++i]);
    else if (arg === '--json') args.json = argv[++i];
    else if (arg === '--all-capabilities') args.allCapabilities = true;
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

/**
 * In the page: what the stub renderer draws now, its draw sets with how many
 * items each holds and the globe port's imagery layers, and how many calls
 * it has had on each port member.
 */
function readDrawn() {
  const renderer = window.__stubBoot?.renderers?.[0];
  if (!renderer) return null;
  const testing = renderer.testing;
  const calls = {};
  for (const call of testing.calls) {
    const key = `${call.port}.${call.member}`;
    calls[key] = (calls[key] ?? 0) + 1;
  }
  return {
    sets: Object.fromEntries(
      testing.sets().map((id) => [id, testing.setRecord(id)?.items?.size ?? 0]),
    ),
    imagery: renderer.globe.imagery.list().length,
    calls,
  };
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
    protocolTimeout: 300_000,
    args: ['--no-sandbox'],
  });
  /** Every error the page reports, in order: `page`, `console` or `response`. */
  const errors = [];
  const cesiumRequests = [];
  const cesiumStylesheets = [];
  const report = { url: base, layers: {}, ok: false };
  try {
    const page = await browser.newPage();
    page.on('console', (message) => {
      if (message.type() !== 'error') return;
      const text = message.text();
      const at = message.location()?.url ?? null;
      errors.push({
        kind: isFailedResponse(text, at, base)
          ? 'response'
          : isDevClient(at)
            ? 'tooling'
            : 'console',
        text,
        at,
      });
    });
    page.on('pageerror', (error) =>
      errors.push({ kind: 'page', text: String(error?.stack || error) }),
    );
    await page.setRequestInterception(true);
    page.on('request', async (request) => {
      const url = request.url();
      if (url.startsWith(base) && isCesiumRequest(url))
        (isPluginStylesheet(url, request.resourceType())
          ? cesiumStylesheets
          : cesiumRequests
        ).push(url);
      // The application's page, with the stub entry in place of its own.
      if (request.isNavigationRequest() && url.startsWith(base)) {
        const response = await fetch(url);
        const html = (await response.text()).replace(
          'src="/src/main.js"',
          'src="/dev/stub-app/main.js"',
        );
        if (!html.includes('/dev/stub-app/main.js'))
          throw new Error('The page has no /src/main.js entry to replace');
        await request.respond({
          status: response.status,
          contentType: 'text/html',
          body: html,
        });
        return;
      }
      await request.continue();
    });
    await page.goto(
      `${base}/${args.allCapabilities ? '?capabilities=all' : ''}`,
      { waitUntil: 'load', timeout: 180_000 },
    );
    await page.waitForFunction(() => window.__stubBoot, { timeout: 180_000 });
    const started = await page.evaluate(() => window.__stubBoot.started);
    report.started = started;
    if (!started.ok) throw new Error(`Startup failed: ${started.error}`);
    await page.waitForFunction(() => window.__godsEyeView?.dataManager, {
      timeout: 60_000,
    });
    report.renderer = await page.evaluate(() => {
      const renderer = window.__stubBoot.renderers[0];
      return {
        id: renderer.id,
        capabilities: [...renderer.capabilities],
        canvasInPage: document.contains(renderer.canvas),
      };
    });
    report.startupErrors = errors.slice();
    // The credits show in the application's own line, with no Cesium: the
    // line is on screen and its list opens with the data credits in it.
    report.credits = await page.evaluate(async () => {
      const line = document.getElementById('gev-credits');
      const expand = line?.querySelector('.gev-credits-expand');
      const panel = document.getElementById('gev-credits-panel');
      const box = line?.getBoundingClientRect();
      const visible =
        Boolean(box && box.width > 0 && box.height > 0) &&
        getComputedStyle(line).visibility !== 'hidden';
      expand?.click();
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const listed =
        panel?.hidden === false ? panel.querySelectorAll('li').length : 0;
      expand?.click();
      return { visible, line: line?.textContent ?? null, listed };
    });
    console.log(
      `credits: ${report.credits.visible ? 'shown' : 'NOT shown'}; line "${report.credits.line}"; ${report.credits.listed} listed`,
    );
    const known = await page.evaluate(() =>
      window.__godsEyeView.dataManager.getAll().map((layer) => layer.id),
    );
    report.missingLayers = STUB_BOOT_LAYERS.filter((id) => !known.includes(id));
    for (const id of STUB_BOOT_LAYERS) {
      if (!known.includes(id)) continue;
      const errorsBefore = errors.length;
      const before = await page.evaluate(readDrawn);
      const enabled = await page.evaluate(
        (layerId) =>
          window.__godsEyeView.dataManager
            .setEnabled(layerId, true, { origin: 'user' })
            .then(
              // It can answer false rather than throw: on is what it says.
              (value) => ({
                ok:
                  value !== false &&
                  window.__godsEyeView.dataManager.isEnabled(layerId),
                value: value ?? null,
              }),
              (error) => ({ ok: false, error: String(error?.stack || error) }),
            ),
        id,
      );
      // Feeds load on their own schedule; keep ticking until they draw.
      const deadline = Date.now() + args.settleMs;
      let drawn = { sets: {}, imagery: 0, calls: {}, fields: 0 };
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        const now = await page.evaluate(readDrawn);
        drawn = {
          sets: Object.fromEntries(
            Object.entries(now.sets).filter(
              ([setId, items]) => items > 0 && before.sets[setId] !== items,
            ),
          ),
          imagery: Math.max(0, now.imagery - before.imagery),
          calls: Object.fromEntries(
            Object.entries(now.calls)
              .map(([key, n]) => [key, n - (before.calls[key] ?? 0)])
              .filter(([, n]) => n > 0),
          ),
        };
        drawn.fields = drawn.calls['draw.field'] ?? 0;
        if (Object.keys(drawn.sets).length || drawn.imagery || drawn.fields)
          break;
      }
      const stats = await page.evaluate((layerId) => {
        const row = window.__godsEyeView.dataManager
          .getAll()
          .find((layer) => layer.id === layerId);
        return {
          enabled: row?.enabled ?? null,
          count: row?.stats?.count ?? null,
          error: row?.stats?.error ?? null,
          source: row?.stats?.source ?? null,
        };
      }, id);
      const disabled = await page.evaluate(
        (layerId) =>
          window.__godsEyeView.dataManager
            .setEnabled(layerId, false, { origin: 'user' })
            .then(
              (value) => ({
                ok:
                  value !== false &&
                  !window.__godsEyeView.dataManager.isEnabled(layerId),
              }),
              (error) => ({ ok: false, error: String(error?.stack || error) }),
            ),
        id,
      );
      const layerErrors = errors.slice(errorsBefore);
      report.layers[id] = {
        enabled,
        disabled,
        stats,
        drawn,
        errors: layerErrors.filter(
          (error) => error.kind === 'page' || error.kind === 'console',
        ),
        failedResponses: layerErrors
          .filter((error) => error.kind === 'response')
          .map((error) => error.at),
      };
      const what = [
        ...Object.entries(drawn.sets).map(([setId, n]) => `${setId}=${n}`),
        ...(drawn.imagery ? [`${drawn.imagery} imagery layer(s)`] : []),
        ...(drawn.fields ? [`${drawn.fields} field(s)`] : []),
      ];
      console.log(
        `${id}: ${enabled.ok && disabled.ok ? 'ran' : 'FAILED'}; drew ${
          what.length ? what.join(', ') : 'nothing'
        }${stats.error ? `; feed: ${stats.error}` : ''}${
          report.layers[id].failedResponses.length
            ? `; ${report.layers[id].failedResponses.length} failed response(s)`
            : ''
        }`,
      );
    }
    report.ok = true;
  } catch (error) {
    // Reported with the rest below, so the report and errors are kept.
    report.failure = String(error?.stack || error);
  } finally {
    report.cesiumRequests = cesiumRequests;
    report.cesiumStylesheets = cesiumStylesheets;
    report.errors = errors;
    await browser.close();
  }
  const pageErrors = errors.filter((error) => error.kind === 'page');
  const consoleErrors = errors.filter((error) => error.kind === 'console');
  const failedResponses = errors.filter((error) => error.kind === 'response');
  const toolingErrors = errors.filter((error) => error.kind === 'tooling');
  const problems = [];
  if (report.failure) problems.push(`the run stopped: ${report.failure}`);
  if (!report.started?.ok) problems.push('the application did not start');
  if (!report.renderer?.canvasInPage)
    problems.push("the stub's canvas is not in the page");
  if (
    report.started?.ok &&
    (!report.credits?.visible || !report.credits.listed)
  )
    problems.push('the credits line is not shown, or its list is empty');
  if (cesiumRequests.length)
    problems.push(`Cesium was requested: ${cesiumRequests.join(', ')}`);
  if (pageErrors.length) problems.push(`${pageErrors.length} page error(s)`);
  if (consoleErrors.length)
    problems.push(`${consoleErrors.length} console error(s)`);
  if (report.missingLayers?.length)
    problems.push(`layers not in the catalog: ${report.missingLayers}`);
  for (const [id, layer] of Object.entries(report.layers)) {
    if (!layer.enabled.ok || !layer.disabled.ok)
      problems.push(`${id} failed to turn on or off`);
    if (
      args.strict &&
      !Object.keys(layer.drawn.sets).length &&
      !layer.drawn.imagery &&
      !layer.drawn.fields
    )
      problems.push(`${id} drew nothing`);
  }
  report.problems = problems;
  if (args.json) writeFileSync(args.json, JSON.stringify(report, null, 2));
  for (const error of [...pageErrors, ...consoleErrors])
    console.error(`${error.kind} error: ${error.text} (${error.at ?? '?'})`);
  if (cesiumStylesheets.length)
    console.log(
      `note: the build's Cesium plugin linked ${cesiumStylesheets.join(', ')}`,
    );
  if (toolingErrors.length)
    console.log(
      `note: the dev server's client logged ${toolingErrors.length} error(s): ${[
        ...new Set(toolingErrors.map((error) => error.text)),
      ].join(' | ')}`,
    );
  if (failedResponses.length)
    console.log(
      `note: ${failedResponses.length} feed response(s) failed (keys or network)`,
    );
  if (problems.length) {
    console.error(`FAIL: ${problems.join('; ')}`);
    process.exitCode = 1;
  } else console.log('ok: the application runs on the stub renderer');
}

if (import.meta.url === `file://${process.argv[1]}`)
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
