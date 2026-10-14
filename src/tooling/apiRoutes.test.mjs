import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  API_FALLBACK_MOUNT,
  API_ROUTES,
  matchApiRoute,
} from '../../server/apiRoutes.js';
import { localProviderPlugins } from '../../server/providers/local.js';
import { apiNotFoundPlugin } from '../../server/standalone/api-not-found.js';
import { headlessProviderPlugins } from '../../server/standalone/headless.mjs';

const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));

/**
 * Install the real plugin chain against a stub that records what it mounts.
 *
 * `apply` is honoured rather than bypassed: skipping it would install plugins
 * Vite would have excluded, and the dev and preview surfaces genuinely differ.
 */
function installedMounts(hook, context) {
  const mounts = [];
  const plugins = [localProviderPlugins(), apiNotFoundPlugin()].flat(Infinity);
  for (const plugin of plugins) {
    const { apply } = plugin;
    if (typeof apply === 'function' && !apply({}, context)) continue;
    if (typeof apply === 'string' && apply !== context.command) continue;
    plugin[hook]?.({
      middlewares: { use: (mount) => mounts.push({ mount, plugin: plugin.name }) },
      httpServer: null,
      config: { root: repositoryRoot },
    });
  }
  return mounts;
}

const DEV = ['configureServer', { command: 'serve', isPreview: false }];
const PREVIEW = ['configurePreviewServer', { command: 'serve', isPreview: true }];

/**
 * Paths the client asks for knowing that no bundled provider serves them.
 * Each one degrades gracefully when the fallback answers 404; keep the reason
 * next to the entry so a removal is a deliberate decision.
 */
const OPTIONAL_CLIENT_PATHS = new Set([
  // src/maps/googleTokens.js: a deployment's own server *may* mint Google
  // tile tokens here; any other answer means "use the browser key instead".
  '/api/google/tiles-token',
]);

/** Every `/api/...` path the browser bundle asks for, as written in source. */
function clientApiPaths() {
  const paths = new Set();
  // A path ends in a name character, so prose in doc comments such as
  // `/api/...` or `/api/google/*` is not mistaken for a request.
  const reference = /['"`](\/api\/[A-Za-z0-9_./-]*[A-Za-z0-9_-])(?=['"`?])/g;
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile() && entry.name.endsWith('.js')) {
        const source = readFileSync(absolute, 'utf8');
        for (const [, reference_] of source.matchAll(reference)) paths.add(reference_);
      }
    }
  };
  visit(path.join(repositoryRoot, 'src'));
  return [...paths].sort();
}

test('the manifest is the mount list the dev server actually installs', () => {
  // Compare the sequences, not their lengths: when they drift the assertion
  // names the route that moved instead of reporting two different counts.
  assert.deepEqual(
    API_ROUTES.map(({ mount, plugin }) => ({ mount, plugin })),
    installedMounts(...DEV),
  );
});

test('the preview server installs the same chain minus the serveOnly mounts', () => {
  // `npm run preview` is a different surface, not a copy of the dev one: the
  // key-setup plugin excludes itself there, so two /api/setup mounts do not
  // exist. A table that claimed one surface would be wrong about the other.
  assert.deepEqual(
    API_ROUTES.filter((route) => !route.serveOnly).map(({ mount, plugin }) => ({
      mount,
      plugin,
    })),
    installedMounts(...PREVIEW),
  );
  const serveOnly = API_ROUTES.filter((route) => route.serveOnly);
  assert.deepEqual(
    serveOnly.map(({ mount }) => mount),
    ['/api/setup/status', '/api/setup/keys'],
  );
});

test('the headless server is a third surface: the preview chain, by a different route', () => {
  // server/standalone/headless.mjs calls every plugin's configureServer hook
  // directly and ignores `apply`; it keeps key setup out by plugin *name*
  // instead (headlessProviderPlugins). Its /api surface therefore has to be
  // checked on its own rather than assumed from either Vite surface. Today
  // it matches preview exactly: every row except the serveOnly ones.
  const mounts = [];
  const recorder = {
    middlewares: { use: (mount) => mounts.push(mount) },
    httpServer: null,
    config: { root: repositoryRoot },
  };
  for (const plugin of [...headlessProviderPlugins(), apiNotFoundPlugin()]) {
    plugin.configureServer?.(recorder);
  }
  assert.deepEqual(
    mounts,
    API_ROUTES.filter((route) => !route.serveOnly).map(({ mount }) => mount),
  );
});

test('both guards that keep key setup out of preview are still in place', () => {
  // The exclusion is redundant on purpose — the plugin notes that a bare
  // apply:'serve' would still configure under preview, so it also never
  // defines the preview hook. Because either guard alone produces the same 32
  // mounts, the chain comparison above cannot notice one of them going
  // missing; assert them separately so a later edit cannot drop one silently.
  const keySetup = [localProviderPlugins(), apiNotFoundPlugin()]
    .flat(Infinity)
    .find((plugin) => plugin.name === 'gev-key-setup');
  assert.ok(keySetup, 'the key setup plugin is part of the chain');
  assert.equal(keySetup.apply({}, { command: 'serve', isPreview: false }), true);
  assert.equal(keySetup.apply({}, { command: 'serve', isPreview: true }), false);
  assert.equal(keySetup.apply({}, { command: 'build', isPreview: false }), false);
  assert.equal(keySetup.configurePreviewServer, undefined);
});

test('the catch-all is installed last, so it cannot swallow a provider', () => {
  const last = API_ROUTES.at(-1);
  assert.equal(last.mount, API_FALLBACK_MOUNT);
  const earlier = API_ROUTES.slice(0, -1);
  assert.equal(
    earlier.some(({ mount }) => mount === API_FALLBACK_MOUNT),
    false,
    'the fallback mount appears once, at the end',
  );
  // Every provider sits below the fallback's prefix, so install order is the
  // only thing keeping them reachable at all.
  for (const { mount } of earlier) {
    assert.ok(mount.startsWith(`${API_FALLBACK_MOUNT}/`), `${mount} is under the fallback`);
  }
});

test('mounts are unique, so no route is shadowed by an identical earlier one', () => {
  const seen = new Set();
  for (const { mount } of API_ROUTES) {
    assert.equal(seen.has(mount), false, `${mount} is mounted twice`);
    seen.add(mount);
  }
});

test('matching ends a mount at a segment boundary, where a dot also counts', () => {
  assert.equal(matchApiRoute('/api/gbfs')?.mount, '/api/gbfs');
  assert.equal(matchApiRoute('/api/gbfs/station_information')?.mount, '/api/gbfs');
  // A dot ends the segment too, so this reaches GBFS rather than the fallback.
  assert.equal(matchApiRoute('/api/gbfs.json')?.mount, '/api/gbfs');
  // Not a boundary: the name merely starts with a mount, so it falls through.
  assert.equal(matchApiRoute('/api/gbfsXYZ')?.mount, API_FALLBACK_MOUNT);
  assert.equal(matchApiRoute('/api/nope')?.mount, API_FALLBACK_MOUNT);
  // `/api/flights` is installed before its nested `/track` route, which is
  // reached only because the parent is exactOnly and passes it on.
  assert.equal(matchApiRoute('/api/flights/track')?.mount, '/api/flights/track');
  assert.equal(matchApiRoute('/api/flights')?.mount, '/api/flights');
  assert.equal(matchApiRoute('/api/flights/')?.mount, '/api/flights');
  assert.equal(matchApiRoute('/api/military/track')?.mount, '/api/military/track');
  // Anything else below an exactOnly parent falls through to the catch-all.
  assert.equal(matchApiRoute('/api/flights.json')?.mount, API_FALLBACK_MOUNT);
  assert.equal(matchApiRoute('/api/flights/other')?.mount, API_FALLBACK_MOUNT);
  assert.equal(matchApiRoute('not-a-path'), undefined);
});

test('exactOnly routes really hand nested paths on with next()', async () => {
  // The table's exactOnly flag is a claim about a handler's behavior; check
  // it against the handler itself, so the flag cannot outlive the code.
  const exactOnly = API_ROUTES.filter((route) => route.exactOnly);
  assert.ok(exactOnly.length > 0);
  const plugins = [localProviderPlugins()].flat(Infinity);
  for (const { mount, plugin: name } of exactOnly) {
    const handlers = new Map();
    const recorder = {
      middlewares: { use: (path, handler) => handlers.set(path, handler) },
      httpServer: null,
      config: { root: repositoryRoot },
    };
    plugins.find((plugin) => plugin.name === name).configureServer(recorder);
    const handler = handlers.get(mount);
    assert.ok(handler, `${name} mounts ${mount}`);
    let passed = false;
    const res = {
      setHeader() {},
      writeHead() {
        assert.fail(`${mount} answered a nested path itself`);
      },
      end() {
        assert.fail(`${mount} answered a nested path itself`);
      },
    };
    await handler({ url: '/track', method: 'GET', headers: {} }, res, () => {
      passed = true;
    });
    assert.equal(passed, true, `${mount} calls next() for /track`);
  }
});

test('matching is case-insensitive, as connect compares lowercased prefixes', () => {
  assert.equal(matchApiRoute('/API/Flights')?.mount, '/api/flights');
  assert.equal(matchApiRoute('/Api/Gbfs.json')?.mount, '/api/gbfs');
  assert.equal(matchApiRoute('/API/NOPE')?.mount, API_FALLBACK_MOUNT);
});

test('every /api path the client asks for reaches a provider, not the fallback', () => {
  const unreachable = clientApiPaths().filter(
    (pathname) =>
      !OPTIONAL_CLIENT_PATHS.has(pathname) &&
      matchApiRoute(pathname)?.mount === API_FALLBACK_MOUNT,
  );
  assert.deepEqual(
    unreachable,
    [],
    `client paths that would answer "Unknown API route": ${unreachable.join(', ')}`,
  );
});
