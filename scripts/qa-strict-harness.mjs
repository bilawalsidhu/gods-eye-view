// The strict acceptance harness shared by every browser scenario that
// qa-all-layer-switches.mjs runs.
//
// - Network: a default-deny request policy on every page, frame and worker
//   of the browser, installed before the target runs (CDP auto-attach with
//   waitForDebuggerOnStart). Paid hosts and paid preview routes are blocked,
//   then only the preview origin, the scenario's declared fixture URLs and
//   the free tile hosts (answered from a disk cache) are allowed. A blocked
//   request, a fixture or tile URL answered by the real network, or a socket
//   to another origin is a violation and fails the scenario with its URL.
// - Coverage: the runner passes the layer ids (--layers=a,b). The scenario
//   records each assertion it made per layer id and engine; finish() fails
//   when a declared layer has no assertion on either engine, and writes the
//   manifest (--evidence=FILE) the runner cross-checks against the catalog.
// - Engine picks: pickEngine() switches with real input on the picker (a
//   pointer click on its label, then keyboard type-ahead), never page.select.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer';
import os from 'node:os';
import {
  KEYLESS_PROBES,
  probePattern,
  strictBlockPatterns,
  STRICT_TILE_HOSTS,
} from './qa-map-policy.mjs';
import { createMissLoader, tileCacheFile } from './qa/tileCache.mjs';
import {
  closeBrowser,
  diagnoseExit,
  exitAfterFlush,
  qaAngle,
} from './qa/browser.mjs';
import { DAYTIME, shiftTime } from './qa/time.mjs';
import {
  PLANESPOTTERS_EMPTY_BODY,
  PLANESPOTTERS_ORIGIN,
} from './qa-photo-stub.mjs';
import { whenSettled } from './qa/ready.mjs';
import { drawLedger, compareLedgers } from './qa/ledger.mjs';
import { createContractMonitor } from '../src/globe/testing/contractMonitor.js';

// Tracking a civil flight asks Planespotters for its photo; strict runs
// answer every lookup with no photos instead of leaving the machine.
const PHOTO_ROUTE = Object.freeze({
  pattern: `${PLANESPOTTERS_ORIGIN}/*`,
  respond: () => ({
    contentType: 'application/json',
    body: PLANESPOTTERS_EMPTY_BODY,
  }),
});

const ledgerAllow = JSON.parse(
  fs.readFileSync(new URL('./qa-ledger-allow.json', import.meta.url), 'utf8'),
);
const drawComparisons = new WeakMap();
const pendingDraws = new WeakMap();

async function finishDrawComparison(page) {
  const pending = pendingDraws.get(page);
  if (!pending) return;
  const after = await drawLedger(page);
  const settledEngine = await page.evaluate(
    () => window.__godsEyeView.engine.kind,
  );
  pendingDraws.delete(page);
  for (const draw of pending) {
    draw.after = after;
    draw.settledEngine = settledEngine;
    draw.comparison = compareLedgers(draw.before, after, ledgerAllow);
  }
}

export const ENGINES = Object.freeze(['cesium', 'navara']);
/** What the Globe Engine picker offers: the engines and Navara HD. */
const CHOICES = Object.freeze([...ENGINES, 'navara-hd']);
/** Local ports that belong to the user's own servers: never a QA preview. */
export const RESERVED_PORTS = Object.freeze([
  '',
  ...(process.env.QA_RESERVED_PORTS ?? '4173,4174,4185,4186,4187,4188,4189,4194,4196')
    .split(',').map((port) => port.trim()).filter(Boolean),
]);
/** Chrome flags every scenario's browser starts with (the GPU path). */
export const CHROME_ARGS = Object.freeze([`--use-angle=${qaAngle()}`, '--enable-gpu']);

/** The values of --layers=a,b and --evidence=FILE (null when absent). */
export function strictArguments(argv = process.argv) {
  const value = (name) =>
    argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
  const layers = value('layers');
  return {
    layers: layers ? layers.split(',').filter(Boolean) : null,
    evidence: value('evidence') ?? process.env.QA_STRICT_EVIDENCE ?? null,
  };
}

/** Refuse anything but an unreserved local preview. */
export function localPreview(href) {
  const url = new URL(href);
  if (
    !['localhost', '127.0.0.1'].includes(url.hostname) ||
    RESERVED_PORTS.includes(url.port)
  )
    throw Error('Supply an unreserved local keyless preview URL');
  return url;
}

/** Refuse to start a preview over an existing local server. */
export async function assertPreviewPortAvailable(href, request = fetch) {
  const url = localPreview(href);
  let response;
  try {
    response = await request(url.origin, { signal: AbortSignal.timeout(1000) });
  } catch (error) {
    if (error.cause?.code === 'ECONNREFUSED') return;
    throw error;
  }
  if (response) throw new Error(`Preview port ${url.port} already answers`);
}

/** Check the running page before any scenario touches its layers. */
export async function assertKeylessPreview(page) {
  await page.evaluate(
    (fixturePath) => {
      const app = window.__godsEyeView;
      const source = app.engine?.maps?.current()?.photoreal;
      const fixture =
        new URLSearchParams(location.search).get('qaTileset') === fixturePath &&
        source?.tilesetUrl === fixturePath &&
        (!source.tileset ||
          new URL(source.tileset.resource?.url, location.href).href ===
            location.origin + fixturePath);
      if (
        window.__GOOGLE_MAPS_API_KEY__ ||
        (app.tileset && (!fixture || app.tileset !== source.tileset)) ||
        ((source || app.engine?.maps?.photorealActive()) && !fixture)
      )
        throw new Error('Keyless preview required');
    },
    TILES_FIXTURE_PATH,
  );
}

export const TILES_FIXTURE_PATH = '/__qa/tiles3d/tileset.json';

// CDP serves these exact same-origin URLs, including requests from workers.
// Keeping them in scripts/ avoids shipping fixture assets in normal builds.
export function tilesFixtureRoutes(origin) {
  return ['tileset.json', 'plate.glb', 'block50.glb', 'block200.glb', 'roof.glb'].map(
    (name) => ({
      pattern: new URL(`/__qa/tiles3d/${name}`, origin).href,
      respond: () => ({
        contentType: name.endsWith('.json')
          ? 'application/json'
          : 'model/gltf-binary',
        body: fs.readFileSync(
          new URL(`./fixtures/tiles3d/${name}`, import.meta.url),
        ),
      }),
    }),
  );
}

/** The URL with no remote IP: fulfilled by a fixture or a cache, or a data URL. */
const live = (response) => Boolean(response.remoteIPAddress);

/**
 * Follow every request of every target of `browser` under the strict policy.
 * Returns the ledger the policy fills in.
 */
export async function installStrictNetwork(
  browser,
  {
    origin,
    fixtures = [],
    routes = [],
    tileHosts = STRICT_TILE_HOSTS,
    ledger,
    time = DAYTIME,
  },
) {
  const preview = new URL(origin);
  routes = [...routes, PHOTO_ROUTE];
  fixtures = [...fixtures, ...routes.map((route) => route.pattern)];
  const urlPatterns = strictBlockPatterns(origin, { fixtures, tileHosts });
  const answers = routes.map((route) => ({
    ...route,
    test: new URLPattern(route.pattern),
  }));
  const fixturePatterns = fixtures.map((p) => new URLPattern(p));
  const isFixture = (url) => fixturePatterns.some((p) => p.test(url));
  const root = await browser.target().createCDPSession();
  const connection = root.connection();
  const probes = KEYLESS_PROBES.map((probe) => ({
    ...probe,
    test: new URLPattern(probePattern(origin, probe)),
  }));
  const misses = createMissLoader();
  const cacheDir = path.join(os.tmpdir(), 'gev-qa-tiles');
  fs.mkdirSync(cacheDir, { recursive: true });
  const tiles = ledger.tileCache;
  // One CDP Fetch handler per target: the keyless probes and the tile hosts
  // (from the disk cache, filled on a miss). Nothing else is paused, so
  // workers' own requests are never held.
  const intercept = async (session, type) => {
    session.on('Fetch.requestPaused', async ({ requestId, request }) => {
      // Every answer allows any origin; `noStore` keeps it out of the cache.
      const fulfil = (status, contentType, body, { noStore = false } = {}) =>
        session.send('Fetch.fulfillRequest', {
          requestId,
          responseCode: status,
          responseHeaders: [
            ...(contentType
              ? [{ name: 'Content-Type', value: contentType }]
              : []),
            ...(noStore ? [{ name: 'Cache-Control', value: 'no-store' }] : []),
            { name: 'Access-Control-Allow-Origin', value: '*' },
          ],
          ...(body == null
            ? {}
            : { body: Buffer.from(body).toString('base64') }),
        });
      try {
        const route = answers.find((r) => r.test.test(request.url));
        if (route) {
          ledger.routes[route.pattern] =
            (ledger.routes[route.pattern] ?? 0) + 1;
          const answer = await route.respond(request);
          return await fulfil(
            answer.status ?? 200,
            answer.contentType,
            answer.body ?? '',
          );
        }
        const probe = probes.find((p) => p.test.test(request.url));
        if (probe) {
          if (request.method !== probe.method && request.method !== 'HEAD') {
            violation('probe-method', request.url, { method: request.method });
            return await session.send('Fetch.failRequest', {
              requestId,
              errorReason: 'BlockedByClient',
            });
          }
          ledger.probes[probe.pattern] =
            (ledger.probes[probe.pattern] ?? 0) + 1;
          return await fulfil(
            probe.status,
            probe.contentType,
            probe.body ?? null,
            { noStore: true },
          );
        }
        const accept = Object.entries(request.headers ?? {}).find(
          ([name]) => name.toLowerCase() === 'accept',
        )?.[1];
        const file =
          request.method === 'GET'
            ? tileCacheFile(request.url, accept, cacheDir, tileHosts)
            : null;
        if (!file) {
          violation('unhandled-intercept', request.url, { target: type });
          return await session.send('Fetch.failRequest', {
            requestId,
            errorReason: 'BlockedByClient',
          });
        }
        let entry;
        if (fs.existsSync(`${file}.json`)) {
          entry = {
            ...JSON.parse(fs.readFileSync(`${file}.json`, 'utf8')),
            body: fs.readFileSync(file),
          };
          tiles.hits++;
        } else {
          entry = await misses.load(request.url, accept);
          if (entry.status === 200) {
            fs.writeFileSync(file, entry.body);
            fs.writeFileSync(
              `${file}.json`,
              JSON.stringify({ status: 200, contentType: entry.contentType }),
            );
            tiles.fetched++;
          } else tiles.failed++;
          const host = new URL(request.url).host;
          tiles.fetchedByHost[host] = (tiles.fetchedByHost[host] ?? 0) + 1;
        }
        await fulfil(entry.status, entry.contentType, entry.body);
      } catch (error) {
        if (
          /Invalid InterceptionId|closed|detached/i.test(String(error?.message))
        )
          return void tiles.cancelled++;
        tiles.failed++;
        await session
          .send('Fetch.failRequest', { requestId, errorReason: 'Failed' })
          .catch(() => {});
      }
    });
    await session
      .send('Fetch.enable', {
        patterns: [
          ...probes.map((probe) => ({
            urlPattern: probePattern(origin, probe).replace(/\*$/, '') + '*',
          })),
          ...tileHosts.map((host) => ({ urlPattern: `https://${host}/*` })),
          ...routes.map((route) => ({ urlPattern: route.pattern })),
        ],
      })
      .catch((error) =>
        ledger.setupErrors.push(
          type + ' Fetch.enable: ' + String(error?.message).slice(0, 120),
        ),
      );
  };
  const violation = (kind, url, detail = {}) => {
    ledger.violations.push({ kind, url: String(url).slice(0, 300), ...detail });
  };
  const setup = async (session, info) => {
    const type = info.type;
    const urls = new Map();
    session.on('Network.requestWillBeSent', (event) => {
      const { url } = event.request;
      urls.set(event.requestId, url);
      if (!/^https?:/.test(url)) return;
      ledger.requests++;
      const address = new URL(url);
      if (address.origin === preview.origin) {
        ledger.preview++;
        if (address.pathname.startsWith('/api/')) {
          const route = address.pathname.split('/').slice(0, 4).join('/');
          ledger.previewApi[route] = (ledger.previewApi[route] ?? 0) + 1;
        }
      } else {
        ledger.external[address.host] =
          (ledger.external[address.host] ?? 0) + 1;
      }
    });
    session.on('Network.loadingFailed', (event) => {
      if (!event.blockedReason) return;
      violation('blocked', urls.get(event.requestId) ?? '?', {
        reason: event.blockedReason,
        target: type,
        resource: event.type,
      });
    });
    session.on('Network.responseReceived', ({ response, type: resource }) => {
      if (!/^https?:/.test(response.url)) return;
      const address = new URL(response.url);
      if (probes.some((p) => p.test.test(response.url)) && live(response))
        violation('probe-live', response.url, { target: type });
      if (address.origin === preview.origin) return;
      if (!live(response)) {
        if (isFixture(response.url)) ledger.fixtureResponses++;
        return;
      }
      // A fixture or tile URL answered by the real network, or any other
      // external host that slipped past the block (a frame navigation).
      violation('live', response.url, {
        remote: response.remoteIPAddress,
        target: type,
        resource,
      });
    });
    session.on('Network.webSocketCreated', ({ url }) => {
      const address = new URL(url);
      if (address.host !== preview.host)
        violation('socket', url, { target: type });
    });
    session.on('Target.attachedToTarget', (event) =>
      attach(event.sessionId, event.targetInfo, event.waitingForDebugger),
    );
    const steps = [
      session.send('Network.enable'),
      session.send('Network.setBlockedURLs', { urlPatterns }),
      session
        .send('Target.setAutoAttach', {
          autoAttach: true,
          waitForDebuggerOnStart: true,
          flatten: true,
        })
        .catch(() => {}),
    ];
    // Workers have no Fetch domain; the page's interception answers their
    // requests, and a live answer would still show up as a violation.
    if (type === 'page' || type === 'iframe')
      steps.push(intercept(session, type));
    if (type === 'page') steps.push(trapCesiumGlobal(session, ledger, time));
    await Promise.all(steps);
  };
  const attach = async (sessionId, info, waiting) => {
    const session = connection.session(sessionId);
    if (!session) return;
    try {
      await setup(session, info);
    } catch (error) {
      // A target that closes while it attaches has nothing left to load.
      if (!/closed|detached|not found/i.test(String(error?.message)))
        ledger.setupErrors.push(String(error?.message ?? error).slice(0, 200));
    } finally {
      if (waiting)
        await session.send('Runtime.runIfWaitingForDebugger').catch(() => {});
    }
  };
  root.on('Target.attachedToTarget', (event) =>
    attach(event.sessionId, event.targetInfo, event.waitingForDebugger),
  );
  await root.send('Target.setAutoAttach', {
    autoAttach: true,
    waitForDebuggerOnStart: true,
    flatten: true,
    filter: [
      { type: 'page' },
      { type: 'iframe' },
      { type: 'worker' },
      { type: 'shared_worker' },
      { type: 'service_worker' },
      { type: 'tab', exclude: true },
      { type: 'browser', exclude: true },
    ],
  });
  return ledger;
}

/**
 * The production build reads every `cesium` import from the global that
 * /cesium/Cesium.js defines, and the page loads that script only when a
 * Cesium globe first starts. A read of the global before then throws in the
 * app (a Navara page has no Cesium at all), wherever the app catches it, so
 * each page gets an accessor in place of the global: reads before the script
 * has assigned it are logged with their stack in `ledger.cesiumBeforeLoad`
 * and answer `undefined`, as production would.
 */
async function trapCesiumGlobal(session, ledger, time) {
  const binding = '__gevStrictCesiumRead';
  session.on('Runtime.bindingCalled', (event) => {
    if (event.name !== binding) return;
    const stack = String(event.payload).slice(0, 1500);
    const known = ledger.cesiumBeforeLoad.find((read) => read.stack === stack);
    if (known) known.count++;
    else if (ledger.cesiumBeforeLoad.length < 50)
      ledger.cesiumBeforeLoad.push({ stack, count: 1 });
  });
  const monitorBinding = '__gevStrictMonitor';
  const monitors = new Map();
  session.on('Runtime.bindingCalled', (event) => {
    if (event.name !== monitorBinding) return;
    const { id, kind, record, finished } = JSON.parse(event.payload);
    const key = `${event.executionContextId}:${id}`;
    let entry = monitors.get(key);
    if (!entry) {
      entry = { id: ledger.contractMonitors.length + 1, kind, records: [] };
      monitors.set(key, entry);
      ledger.contractMonitors.push(entry);
    }
    if (record) entry.records.push(record);
    if (finished) entry.finished = true;
  });
  await session.send('Runtime.enable');
  await session.send('Runtime.addBinding', { name: monitorBinding });
  await session.send('Runtime.addBinding', { name: binding });
  await session.send('Page.enable');
  await session.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `(${shiftTime})(${JSON.stringify(time)});
    (${installContractMonitors})(${createContractMonitor});
    (() => {
      if (window.top !== window) return;
      const seen = new Set();
      let sdk;
      const report = () => {
        const limit = Error.stackTraceLimit;
        Error.stackTraceLimit = 12;
        const stack = String(new Error('Cesium read before it loaded').stack);
        Error.stackTraceLimit = limit;
        const site = stack.split('\\n').slice(2, 6).join('\\n');
        if (seen.has(site)) return;
        seen.add(site);
        window.${binding}?.(stack);
      };
      Object.defineProperty(window, 'Cesium', {
        configurable: true,
        get() {
          if (sdk === undefined) report();
          return sdk;
        },
        set(value) {
          sdk = value;
        },
      });
    })();`,
  });
}

/** Injected before the app: follow the existing debug handle across attachments. */
export function installContractMonitors(createMonitor) {
  if (window.top !== window || typeof document === 'undefined') return;
  const entries = new WeakMap();
  const engines = [];
  const handles = new WeakSet();
  const attach = (engine) => {
    if (!engine || entries.has(engine)) return;
    const id = engines.length + 1;
    engines.push(new WeakRef(engine));
    const send = (value) =>
      window.__gevStrictMonitor?.(
        JSON.stringify({ id, kind: engine.kind, ...value }),
      );
    send({});
    const monitor = createMonitor(engine, (record) => send({ record }));
    entries.set(engine, { monitor, send });
  };
  const observe = (debug) => {
    if (!debug || handles.has(debug)) return;
    handles.add(debug);
    let engine = debug.engine;
    attach(engine);
    Object.defineProperty(debug, 'engine', {
      configurable: true,
      enumerable: true,
      get: () => engine,
      set(value) {
        engine = value;
        attach(value);
      },
    });
  };
  const arm = () => {
    const descriptor = Object.getOwnPropertyDescriptor(window, '__godsEyeView');
    if (descriptor?.get) return;
    let debug = window.__godsEyeView;
    observe(debug);
    Object.defineProperty(window, '__godsEyeView', {
      configurable: true,
      get: () => debug,
      set(value) {
        debug = value;
        observe(value);
      },
    });
  };
  arm();
  new MutationObserver(arm).observe(document, {
    childList: true,
    subtree: true,
  });
  let finishing;
  window.__qaFinishMonitors = () =>
    (finishing ??= Promise.all(
      engines.map(async (ref) => {
        const engine = ref.deref();
        if (!engine) return;
        const { monitor, send } = entries.get(engine);
        await monitor.finish({
          active: engine === window.__godsEyeView?.engine,
        });
        send({ finished: true });
      }),
    ));
  window.addEventListener('pagehide', window.__qaFinishMonitors);
}

/** A new, empty network ledger. */
export function networkLedger() {
  return {
    requests: 0,
    preview: 0,
    previewApi: {},
    external: {},
    fixtureResponses: 0,
    probes: {},
    routes: {},
    tileCache: {
      hits: 0,
      fetched: 0,
      failed: 0,
      cancelled: 0,
      fetchedByHost: {},
    },
    violations: [],
    setupErrors: [],
    cesiumBeforeLoad: [],
    contractMonitors: [],
  };
}

/**
 * Switch to `kind` with real input on the Globe Engine picker: a pointer
 * click on its label (which focuses the select without opening its menu)
 * and keyboard type-ahead. Opens the control panel with a pointer click if
 * it is collapsed and collapses it again once the switch has settled
 * (`settle: false` returns as soon as the picker reports the change;
 * `afterInput` runs right after the key, before anything is read back).
 */
export async function pickEngine(
  page,
  kind,
  { settle = true, afterInput = null } = {},
) {
  assert.ok(CHOICES.includes(kind), kind);
  const expanded = () =>
    page.$eval(
      '#control-panel-toggle',
      (el) => el.getAttribute('aria-expanded') === 'true',
    );
  const opened = !(await expanded());
  if (opened) {
    await page.click('#control-panel-toggle').catch((error) => {
      throw Error(`cannot click the control panel toggle: ${error.message}`);
    });
    await page.waitForFunction(
      () =>
        document
          .querySelector('#control-panel-toggle')
          ?.getAttribute('aria-expanded') === 'true',
    );
  }
  // The picker stays focusable while busy: aria-busy marks a switch.
  await page.waitForSelector(
    '#globe-engine:not([disabled]):not([aria-busy="true"])',
    { visible: true, timeout: 90000 },
  );
  const from = await page.$eval('#globe-engine', (el) => el.value);
  assert.notEqual(from, kind, `the picker already shows ${kind}`);
  // The key typed below is `kind`'s first letter: it selects the next option
  // starting with it (after `from` when `from` starts with it too). Each key
  // is a change that starts a switch, so `kind` must be one key away
  // (Cesium → Navara HD goes through Navara).
  const values = await page.$$eval('#globe-engine option', (options) =>
    options.map((option) => option.value),
  );
  const matches = values.filter((value) => value[0] === kind[0]);
  assert.equal(
    from[0] === kind[0]
      ? matches[(matches.indexOf(from) + 1) % matches.length]
      : matches[0],
    kind,
    `${kind} is not one key away from ${from}`,
  );
  // Where a pointer can reach the picker: the label's own text (focuses the
  // select without opening its menu), else the select itself.
  const target = await page.$eval('#globe-engine', (el) => {
    const box = el.closest('label').getBoundingClientRect();
    const select = el.getBoundingClientRect();
    // at: the change event (the person's input reached the page);
    // idleAt: the picker enabled again after the switch.
    window.__qaPick = { busy: false, changed: false, at: null, idleAt: null };
    el.addEventListener(
      'change',
      () => {
        window.__qaPick.changed = true;
        window.__qaPick.at = performance.now();
      },
      { once: true },
    );
    window.__qaPickObserver?.disconnect();
    window.__qaPickObserver = new MutationObserver(() => {
      const disabled = document.querySelector(
        '#globe-engine:is([disabled], [aria-busy="true"])',
      );
      if (disabled) window.__qaPick.busy = true;
      else if (window.__qaPick.busy && window.__qaPick.idleAt == null)
        window.__qaPick.idleAt = performance.now();
    });
    window.__qaPickObserver.observe(document.body, {
      attributes: true,
      attributeFilter: ['disabled', 'aria-busy'],
      subtree: true,
    });
    const describe = (hit) =>
      hit
        ? `${hit.tagName.toLowerCase()}#${hit.id}.${String(hit.className).slice(0, 60)}`
        : 'nothing';
    const label = {
      x: box.left + Math.max(4, (select.left - box.left) / 2),
      y: box.top + box.height / 2,
    };
    const onLabel = document.elementFromPoint(label.x, label.y);
    if (
      onLabel === el.closest('label') ||
      (onLabel?.closest('label') === el.closest('label') && onLabel !== el)
    )
      return { ...label, via: 'label' };
    const middle = {
      x: select.left + select.width / 2,
      y: select.top + select.height / 2,
    };
    const onSelect = document.elementFromPoint(middle.x, middle.y);
    if (onSelect === el)
      return { ...middle, via: 'select', labelCoveredBy: describe(onLabel) };
    return { covered: describe(onLabel) + ' / ' + describe(onSelect) };
  });
  assert.ok(!target.covered, 'the picker is covered by ' + target.covered);
  await page.mouse.click(target.x, target.y);
  assert.equal(
    await page.evaluate(() => document.activeElement?.id),
    'globe-engine',
    'the click focuses the picker',
  );
  const draw = { from, to: kind, before: await drawLedger(page) };
  drawComparisons.get(page)?.push(draw);
  pendingDraws.set(page, [...(pendingDraws.get(page) ?? []), draw]);
  await page.keyboard.type(kind[0]);
  // Whatever the person does next, right after the key (no round trip to
  // the page in between).
  if (afterInput) await afterInput();
  // The change starts a cold switch at once: Cesium.js then runs as one
  // task, seconds long under CPU throttling, before the page answers.
  await page.waitForFunction(() => window.__qaPick?.changed, {
    timeout: 30000,
    polling: 50,
  });
  // Headless Chrome opens no menu for a click on the select: the key
  // events above reached the page, so there is nothing to dismiss.
  const how = {
    opened,
    clicked: target.via,
    ...(target.labelCoveredBy ? { labelCoveredBy: target.labelCoveredBy } : {}),
  };
  if (!settle) return how;
  await page.waitForFunction(
    () =>
      (window.__qaPick.busy &&
        !document.querySelector(
          '#globe-engine:is([disabled], [aria-busy="true"])',
        )) || document.querySelector('.engine-switch-retry'),
    { timeout: 120000, polling: 50 },
  );
  if (!(await page.$('.engine-switch-retry'))) {
    const running = await page.$eval('#globe-engine', (el) => el.value);
    await waitForEngine(page, running);
  }
  await page.evaluate(() => window.__qaPickObserver?.disconnect());
  Object.assign(
    how,
    await page.evaluate(() => ({
      at: window.__qaPick.at,
      idleAt: window.__qaPick.idleAt,
    })),
  );
  if (opened && (await expanded().catch(() => false))) {
    await page.click('#control-panel-toggle');
    await page.waitForFunction(
      () =>
        document
          .querySelector('#control-panel-toggle')
          ?.getAttribute('aria-expanded') !== 'true',
    );
  }
  return how;
}

/** Wait until `kind` runs, its picker is idle and its view is restored. */
export async function waitForEngine(page, kind, { timeout = 120000 } = {}) {
  // The engine picker's value: cesium, navara or a Navara variant.
  if (typeof kind !== 'string' || !kind)
    throw new TypeError('waitForEngine needs the engine picker value');
  const started = Date.now();
  await page.waitForFunction(
    (expected) =>
      window.__godsEyeView?.engine?.kind ===
        (expected === 'cesium' ? 'cesium' : 'navara') &&
      document.querySelector('#globe-engine')?.value === expected &&
      !document.querySelector(
        '#globe-engine:is([disabled], [aria-busy="true"])',
      ),
    { timeout },
    kind,
  );
  await whenSettled(page, {
    timeoutMs: Math.max(1, timeout - (Date.now() - started)),
  });
  await finishDrawComparison(page);
  await assertKeylessPreview(page);
}

/**
 * A new 1024×768 page of `browser` whose uncaught errors (and, with
 * `shaderErrors`, shader and WebGL program errors on the console) land in
 * `errors`; each uncaught error is also logged without its query string.
 */
export async function openPage(browser, { shaderErrors = false } = {}) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1024, height: 768 });
  const errors = [];
  page.on('pageerror', (e) => {
    errors.push(e.message);
    console.log('error', e.message.split('?')[0]);
  });
  if (shaderErrors)
    page.on('console', (msg) => {
      if (msg.type() === 'error' && /Shader|WebGLProgram/i.test(msg.text()))
        errors.push(msg.text());
    });
  return { page, errors };
}

/**
 * The strict context of one scenario run.
 *
 * @param {object} options
 * @param {string} options.origin The preview origin.
 * @param {string[]} options.layers The layer ids this scenario covers (the
 *   runner's --layers wins when given; both must agree).
 * @param {string[]} [options.fixtures] URLPattern strings for external
 *   requests the scenario answers itself.
 * @param {{pattern: string, respond: (request: object) => ({status?: number,
 *   contentType?: string, body?: string|Buffer}|Promise<object>)}[]} [options.routes]
 *   External URLs the harness answers for the scenario (the pattern is both
 *   a URLPattern and a CDP Fetch glob, e.g. `https://i.ytimg.com/*`).
 * @param {readonly string[]} [options.tileHosts] Hosts the disk cache
 *   answers (default STRICT_TILE_HOSTS).
 * @param {string} [options.name] Scenario name for the manifest.
 * @param {string} [options.time] ISO instant for the page clock, or 'real'.
 */
export function createStrict({
  origin,
  layers,
  fixtures = [],
  routes = [],
  tileHosts = STRICT_TILE_HOSTS,
  name = path.basename(process.argv[1] ?? 'scenario', '.mjs'),
  time = DAYTIME,
}) {
  assert.ok(
    typeof time === 'string' &&
      (time === 'real' || Number.isFinite(Date.parse(time))),
    'valid page time',
  );
  const browserPids = [];
  const args = strictArguments();
  if (args.layers)
    assert.deepEqual(
      [...args.layers].sort(),
      [...layers].sort(),
      `${name} covers ${layers.join(',')}, the runner passed ${args.layers.join(',')}`,
    );
  const declared = args.layers ?? layers;
  const ledger = networkLedger();
  const assertions = [];
  const picks = [];
  const draws = [];
  const timings = [];
  const extra = {};
  let finished = false;

  const record = (ids, engine, claim, detail) => {
    for (const id of [ids].flat()) {
      assert.ok(declared.includes(id), `${id} is not declared by ${name}`);
      assert.ok(ENGINES.includes(engine), `unknown engine ${engine}`);
      assertions.push({
        layer: id,
        engine,
        claim,
        ...(detail === undefined ? {} : { detail }),
      });
    }
  };
  const engineOf = (page) =>
    page.evaluate(() => window.__godsEyeView?.engine?.kind ?? null);

  const strict = {
    name,
    layers: declared,
    ledger,
    extra,
    timings,
    /**
     * Launch headless Chrome with the policy on every target; `args` adds
     * flags to CHROME_ARGS.
     */
    async launch({ args = [], ...options } = {}) {
      const browser = await puppeteer.launch({
        headless: true,
        ...options,
        args: [...CHROME_ARGS, ...args],
      });
      const pid = browser.process()?.pid;
      if (pid) browserPids.push(pid);
      try {
        await installStrictNetwork(browser, {
          origin,
          fixtures,
          routes,
          tileHosts,
          ledger,
          time,
        });
      } catch (error) {
        await closeBrowser(browser);
        throw error;
      }
      const newPage = browser.newPage.bind(browser);
      browser.newPage = async (...args) => {
        const page = await newPage(...args);
        drawComparisons.set(page, draws);
        const close = page.close.bind(page);
        page.close = async (...args) => {
          await page
            .evaluate(() => window.__qaFinishMonitors?.())
            .catch(() => {});
          return close(...args);
        };
        return page;
      };
      const close = browser.close.bind(browser);
      browser.close = async (...args) => {
        const pages = await browser.pages().catch(() => []);
        await Promise.all(
          pages.map((page) =>
            page.evaluate(() => window.__qaFinishMonitors?.()).catch(() => {}),
          ),
        );
        return close(...args);
      };
      return browser;
    },
    /** Launch with `options`, run `body(browser)`, close, then finish(). */
    async run(options, body) {
      let browser;
      let failed = null;
      try {
        browser = await strict.launch(options);
        await body(browser);
      } catch (error) {
        failed = error;
      } finally {
        await closeBrowser(browser);
      }
      await strict.finishAndExit({ failed });
    },
    async finishAndExit({ failed = null } = {}) {
      try {
        await strict.finish({ failed });
      } catch (error) {
        failed = error;
      }
      if (failed) console.error(failed);
      await exitAfterFlush(failed ? 1 : process.exitCode ?? 0);
    },
    /** Record an assertion that already passed. */
    record,
    /** Record a passed assertion on the engine the page runs now. */
    async passed(page, ids, claim, detail) {
      const engine = await engineOf(page);
      record(ids, engine, claim, detail);
    },
    /** Assert `value` and record it on the engine the page runs now. */
    async check(page, ids, claim, value, detail) {
      assert.ok(
        value,
        claim + (detail === undefined ? '' : ' ' + JSON.stringify(detail)),
      );
      await strict.passed(page, ids, claim, detail);
    },
    /** Switch with real input and log the pick. */
    async pick(page, kind, options) {
      const result = await pickEngine(page, kind, options);
      picks.push({ to: kind, via: 'pointer+keyboard', ...result });
      return result;
    },
    /**
     * Switch through the select element without input, only where no
     * person can reach the picker (`reason` says why); logged as such.
     */
    async selectEngine(page, kind, reason) {
      assert.ok(reason, 'say why the picker cannot be used');
      await page.select('#globe-engine', kind);
      picks.push({ to: kind, via: 'page.select', reason });
    },
    /**
     * Switch with real input in the same document and wait until `kind`
     * runs.
     */
    async switchTo(page, kind) {
      const origin = await page.evaluate(() => performance.timeOrigin);
      await strict.pick(page, kind);
      await waitForEngine(page, kind);
      assert.equal(
        await page.evaluate(() => performance.timeOrigin),
        origin,
        'same document after switching globes',
      );
    },
    /** Write the manifest; fail on violations or missing coverage. */
    async finish({ failed = null } = {}) {
      if (finished) return;
      finished = true;
      const coverage = Object.fromEntries(
        declared.map((id) => [
          id,
          Object.fromEntries(
            ENGINES.map((engine) => [
              engine,
              assertions.filter((a) => a.layer === id && a.engine === engine)
                .length,
            ]),
          ),
        ]),
      );
      const missing = Object.entries(coverage).flatMap(([id, byEngine]) =>
        ENGINES.filter((engine) => !byEngine[engine]).map(
          (engine) => `${id} on ${engine}`,
        ),
      );
      const network = {
        requests: ledger.requests,
        preview: ledger.preview,
        previewApi: ledger.previewApi,
        external: ledger.external,
        fixtureResponses: ledger.fixtureResponses,
        probes: ledger.probes,
        routes: ledger.routes,
        tileCache: ledger.tileCache,
        violations: ledger.violations,
        setupErrors: ledger.setupErrors,
        cesiumBeforeLoad: ledger.cesiumBeforeLoad,
        fixtures,
        tileHosts: [...tileHosts],
      };
      let validationError = null;
      if (!failed) {
        try {
          assert.equal(
            ledger.violations.length,
            0,
            'network policy violations: ' +
              JSON.stringify(ledger.violations.slice(0, 5)),
          );
          assert.deepEqual(
            ledger.cesiumBeforeLoad,
            [],
            'the page read the Cesium global before Cesium.js loaded',
          );
          assert.deepEqual(missing, [], 'layers without an assertion');
          assert.ok(
            picks.some((pick) => pick.via === 'pointer+keyboard'),
            'switch at least once with real input on the picker',
          );
        } catch (error) {
          validationError = error;
          failed = error;
        }
      }
      const manifest = {
        scenario: name,
        argv: process.argv.slice(2),
        status: failed ? 'fail' : 'pass',
        error: failed ? String(failed?.stack ?? failed).slice(0, 2000) : null,
        layers: declared,
        coverage,
        missing,
        picks,
        assertions,
        network,
        timings,
        drawLedgers: draws,
        contractMonitors: ledger.contractMonitors,
        ...extra,
      };
      if (args.evidence) {
        fs.mkdirSync(path.dirname(args.evidence), { recursive: true });
        fs.writeFileSync(
          args.evidence,
          JSON.stringify(manifest, null, 2) + '\n',
        );
      }
      console.log(
        'STRICT',
        JSON.stringify({
          scenario: name,
          assertions: assertions.length,
          coverage,
          picks: picks.length,
          requests: ledger.requests,
          violations: ledger.violations.length,
          cesiumBeforeLoad: ledger.cesiumBeforeLoad.length,
        }),
      );
      for (const v of ledger.violations.slice(0, 20))
        console.log('NETWORK VIOLATION', JSON.stringify(v));
      for (const read of ledger.cesiumBeforeLoad.slice(0, 10))
        console.log('CESIUM BEFORE LOAD', JSON.stringify(read));
      diagnoseExit(browserPids);
      if (validationError) throw validationError;
    },
  };
  return strict;
}

/** Click uncovered canvas where the engine picks nothing within the radius. */
export async function clickEmptyGround(
  page,
  { left, top, right, bottom, step = 9, radius = 6 },
) {
  const handle = await page.waitForFunction(
    ({ left, top, right, bottom, step, radius }) => {
      const { engine } = window.__godsEyeView;
      const canvas = engine.host.canvas;
      const box = canvas.getBoundingClientRect();
      for (let y = top; y < bottom; y += step)
        for (let x = left; x < right; x += step) {
          if (
            !canvas.contains(
              document.elementFromPoint(box.left + x, box.top + y),
            )
          )
            continue;
          const free = [
            [0, 0],
            [radius, 0],
            [-radius, 0],
            [0, radius],
            [0, -radius],
          ].every(([dx, dy]) => !engine.picker.pick({ x: x + dx, y: y + dy }));
          if (free) return { x: box.left + x, y: box.top + y };
        }
      return false;
    },
    { timeout: 15000 },
    { left, top, right, bottom, step, radius },
  );
  try {
    const at = await handle.jsonValue();
    await page.mouse.click(at.x, at.y);
  } finally {
    await handle.dispose();
  }
}

/**
 * Wait until no flight holds the camera and it stays still. A selection's
 * camera transfer is a flight; on both engines a flight turns the camera
 * inputs off, and a click does not cut it short.
 */
export async function waitForCameraAtRest(page, { timeout = 15000 } = {}) {
  await whenSettled(page, { timeoutMs: timeout });
}
