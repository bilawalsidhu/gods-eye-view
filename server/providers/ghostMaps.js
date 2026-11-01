import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  GHOSTMAPS_MAX_FILE_BYTES,
  GHOSTMAPS_REPO,
  buildGhostMapsCatalog,
  ghostMapsRawUrl,
  parseGitRefAdvertisement,
} from '../../src/layers/ghostMaps/catalog.js';
import {
  readResponseBytesCapped,
  readResponseJsonCapped,
  readResponseTextCapped,
} from './common/http.js';

// S2 Underground GhostMaps (public GitHub repository of KMZ intel products).
// The repository is not ours, so there is no webhook: the watcher reads the
// branch head through git's smart-HTTP ref advertisement (~0.5 KB, outside the
// REST API rate limit) every few seconds, and only a new commit costs REST
// calls (tree + commit). Browsers hear about a new commit over server-sent
// events and fetch only the products whose blob changed. Files are fetched by
// commit-pinned raw URLs and kept on disk by blob sha.

const DEFAULT_POLL_MS = 15_000;
const MIN_POLL_MS = 5_000;
const FAILURE_BACKOFF_MS = [15_000, 30_000, 60_000, 120_000, 300_000];
const TIMEOUT_MS = 15_000;
const FILE_TIMEOUT_MS = 120_000;
const HEARTBEAT_MS = 25_000;
const MAX_SUBSCRIBERS = 64;
const MAX_REF_BYTES = 64 * 1024;
const MAX_TREE_BYTES = 16 * 1024 * 1024;
const MAX_COMMIT_BYTES = 2 * 1024 * 1024;
const USER_AGENT = 'gods-eye-view-ghostmaps/1.0';
const REPO_PATH = `${GHOSTMAPS_REPO.owner}/${GHOSTMAPS_REPO.name}`;

/** Poll interval from GHOSTMAPS_POLL_SECONDS, bounded below at 5 s. */
export function ghostMapsPollMs(raw = process.env.GHOSTMAPS_POLL_SECONDS) {
  const seconds = Number(raw);
  if (!raw || !Number.isFinite(seconds)) return DEFAULT_POLL_MS;
  return Math.max(MIN_POLL_MS, Math.round(seconds * 1000));
}

/**
 * The repository watcher and file cache, independent of HTTP routing.
 * @returns {{start: Function, stop: Function, catalog: Function,
 *   checkNow: Function, file: Function, subscribe: Function}}
 */
export function createGhostMapsWatcher({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
  pollMs = ghostMapsPollMs(),
  cacheDir = path.join(process.cwd(), '.gev-cache', 'ghostmaps'),
  token = () => String(process.env.GITHUB_TOKEN || '').trim(),
  log = (...args) => console.log(...args),
  warn = (...args) => console.warn(...args),
} = {}) {
  let state = {
    commit: null,
    committedAt: null,
    message: null,
    products: [],
    checkedAt: null,
    changedAt: null,
    error: null,
  };
  let timer = null;
  let running = false;
  let checking = null;
  let failures = 0;
  let diskLoaded = false;
  const listeners = new Set();
  const downloads = new Map();

  const apiHeaders = () => ({
    Accept: 'application/vnd.github+json',
    'User-Agent': USER_AGENT,
    ...(token() ? { Authorization: `Bearer ${token()}` } : {}),
  });

  async function get(url, headers, timeoutMs = TIMEOUT_MS) {
    const response = await fetchImpl(url, {
      headers,
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw Object.assign(new Error(`HTTP ${response.status} from ${url}`), {
        status: response.status,
      });
    }
    return response;
  }

  async function readHead() {
    const response = await get(
      `${GHOSTMAPS_REPO.url}.git/info/refs?service=git-upload-pack`,
      { 'User-Agent': USER_AGENT },
    );
    const sha = parseGitRefAdvertisement(
      await readResponseTextCapped(response, MAX_REF_BYTES),
    );
    if (!sha) throw new Error('GhostMaps branch head not advertised');
    return sha;
  }

  async function readCommit(sha) {
    const api = `https://api.github.com/repos/${REPO_PATH}`;
    const tree = await readResponseJsonCapped(
      await get(`${api}/git/trees/${sha}?recursive=1`, apiHeaders()),
      MAX_TREE_BYTES,
    );
    if (!Array.isArray(tree?.tree)) throw new Error('GhostMaps tree malformed');
    if (tree.truncated) warn('[ghostmaps] repository tree listing truncated');
    let committedAt = null;
    let message = null;
    try {
      const commit = await readResponseJsonCapped(
        await get(`${api}/commits/${sha}`, apiHeaders()),
        MAX_COMMIT_BYTES,
      );
      committedAt = Date.parse(commit?.commit?.committer?.date) || null;
      message = String(commit?.commit?.message || '')
        .split('\n')[0]
        .slice(0, 200);
    } catch {
      // The commit date is decoration; the tree is what matters.
    }
    return { products: buildGhostMapsCatalog(tree.tree), committedAt, message };
  }

  async function loadDisk() {
    if (diskLoaded) return;
    diskLoaded = true;
    try {
      const saved = JSON.parse(
        await fsp.readFile(path.join(cacheDir, 'catalog.json'), 'utf8'),
      );
      if (/^[0-9a-f]{40}$/.test(saved?.commit) && Array.isArray(saved.products))
        state = { ...state, ...saved, error: null };
    } catch {
      /* first run */
    }
  }

  async function saveDisk() {
    try {
      await fsp.mkdir(cacheDir, { recursive: true });
      const { commit, committedAt, message, products, changedAt } = state;
      await fsp.writeFile(
        path.join(cacheDir, 'catalog.json'),
        JSON.stringify({ commit, committedAt, message, products, changedAt }),
      );
    } catch (error) {
      warn('[ghostmaps] could not save catalog:', error.message);
    }
  }

  function emit() {
    const event = publicCatalog();
    for (const listener of listeners) {
      try {
        listener(event);
      } catch {
        /* a broken subscriber must not stop the rest */
      }
    }
  }

  async function check() {
    await loadDisk();
    const head = await readHead();
    state.checkedAt = now();
    if (head === state.commit) {
      if (state.error !== null) {
        state.error = null;
        emit();
      }
      return false;
    }
    const next = await readCommit(head);
    const previous = new Map(state.products.map((p) => [p.id, p.version]));
    const changed = next.products
      .filter((p) => previous.get(p.id) !== p.version)
      .map((p) => p.id);
    state = {
      ...state,
      ...next,
      commit: head,
      changedAt: now(),
      error: null,
    };
    log(
      `[ghostmaps] commit ${head.slice(0, 8)}${
        next.message ? ` "${next.message}"` : ''
      }; updated: ${changed.join(', ') || 'none'}`,
    );
    await saveDisk();
    emit();
    // Warm the default products so the first browser load is local.
    for (const product of state.products)
      if (product.defaultOn) file(product.id).catch(() => {});
    return true;
  }

  /** Run one check now, coalescing with one already in flight. */
  function checkNow() {
    if (!checking)
      checking = check()
        .then(
          (changed) => {
            failures = 0;
            return changed;
          },
          (error) => {
            failures += 1;
            state.error = error.message;
            state.checkedAt = now();
            warn('[ghostmaps] check failed:', error.message);
            emit();
            return false;
          },
        )
        .finally(() => {
          checking = null;
        });
    return checking;
  }

  function schedule() {
    clearTimeout(timer);
    if (!running) return;
    const delay = failures
      ? FAILURE_BACKOFF_MS[Math.min(failures, FAILURE_BACKOFF_MS.length) - 1]
      : pollMs;
    timer = setTimeout(async () => {
      await checkNow();
      schedule();
    }, delay);
    timer.unref?.();
  }

  /** Start watching (idempotent); the first check runs immediately. */
  function start() {
    if (running) return checking || Promise.resolve(false);
    running = true;
    const first = checkNow();
    first.then(schedule);
    return first;
  }

  function stop() {
    running = false;
    clearTimeout(timer);
    timer = null;
  }

  function publicCatalog() {
    return {
      repo: GHOSTMAPS_REPO.url,
      branch: GHOSTMAPS_REPO.branch,
      commit: state.commit,
      committedAt: state.committedAt,
      message: state.message,
      checkedAt: state.checkedAt,
      changedAt: state.changedAt,
      pollMs,
      error: state.error,
      products: state.products.map(
        ({
          id,
          title,
          defaultOn,
          fileName,
          fileTitle,
          version,
          size,
          dateMs,
        }) => ({
          id,
          title,
          defaultOn,
          fileName,
          fileTitle,
          version,
          size,
          dateMs,
        }),
      ),
    };
  }

  /**
   * The bytes of one product's current edition, from disk or a commit-pinned
   * download. Only catalog paths are ever fetched.
   */
  async function file(id) {
    const product = state.products.find((p) => p.id === id);
    if (!product) return null;
    const target = path.join(cacheDir, 'files', `${product.version}.kmz`);
    try {
      return { product, bytes: await fsp.readFile(target) };
    } catch {
      /* not cached yet */
    }
    const commit = state.commit;
    let pending = downloads.get(product.version);
    if (!pending) {
      pending = (async () => {
        const response = await get(
          ghostMapsRawUrl(commit, product.path),
          { 'User-Agent': USER_AGENT },
          FILE_TIMEOUT_MS,
        );
        const bytes = Buffer.from(
          await readResponseBytesCapped(response, GHOSTMAPS_MAX_FILE_BYTES),
        );
        await fsp.mkdir(path.dirname(target), { recursive: true });
        const temp = `${target}.${process.pid}.tmp`;
        await fsp.writeFile(temp, bytes);
        await fsp.rename(temp, target);
        await pruneFiles();
        return bytes;
      })().finally(() => downloads.delete(product.version));
      downloads.set(product.version, pending);
    }
    return { product, bytes: await pending };
  }

  /** Keep only files that a current product still points to. */
  async function pruneFiles() {
    const keep = new Set(state.products.map((p) => `${p.version}.kmz`));
    const dir = path.join(cacheDir, 'files');
    for (const name of await fsp.readdir(dir).catch(() => [])) {
      if (!keep.has(name) && !name.endsWith('.tmp'))
        await fsp.rm(path.join(dir, name), { force: true }).catch(() => {});
    }
  }

  function subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  return {
    start,
    stop,
    checkNow,
    catalog: publicCatalog,
    file,
    subscribe,
    subscribers: () => listeners.size,
  };
}

/** Same-origin GhostMaps routes for dev and preview. */
export function ghostMapsProxy({ watcher = createGhostMapsWatcher() } = {}) {
  const json = (res, status, value) => {
    if (res.destroyed) return;
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      ...(status === 405 ? { Allow: 'GET' } : {}),
    });
    res.end(JSON.stringify(value));
  };

  function events(req, res) {
    if (watcher.subscribers() >= MAX_SUBSCRIBERS)
      return json(res, 429, { error: 'too_many_subscribers' });
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const send = (catalog) =>
      res.write(`event: catalog\ndata: ${JSON.stringify(catalog)}\n\n`);
    res.write('retry: 5000\n\n');
    send(watcher.catalog());
    const unsubscribe = watcher.subscribe(send);
    const heartbeat = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS);
    heartbeat.unref?.();
    const close = () => {
      clearInterval(heartbeat);
      unsubscribe();
    };
    req.on('close', close);
    res.on('error', close);
  }

  async function handler(req, res) {
    if (req.method !== 'GET')
      return json(res, 405, { error: 'method_not_allowed' });
    const url = new URL(req.url || '/', 'http://local');
    const match = /^\/file\/([a-z0-9-]{1,40})$/.exec(url.pathname);
    if (!['/catalog', '/events'].includes(url.pathname) && !match)
      return json(res, 404, { error: 'unknown_route' });
    // Watching starts with the first request, so an install that never turns
    // the layer on never contacts GitHub.
    const first = watcher.start();
    if (url.pathname === '/catalog') {
      if (!watcher.catalog().commit) await first;
      return json(res, 200, watcher.catalog());
    }
    if (url.pathname === '/events') return events(req, res);
    try {
      if (!watcher.catalog().commit) await first;
      const found = await watcher.file(match[1]);
      if (!found) return json(res, 404, { error: 'unknown_product' });
      const pinned = url.searchParams.get('v') === found.product.version;
      res.writeHead(200, {
        'Content-Type': 'application/vnd.google-earth.kmz',
        'Content-Length': found.bytes.length,
        'X-GhostMaps-Version': found.product.version,
        // A versioned URL names one immutable blob.
        'Cache-Control': pinned
          ? 'private, max-age=31536000, immutable'
          : 'no-store',
      });
      return res.end(found.bytes);
    } catch {
      return json(res, 502, { error: 'ghostmaps_unavailable' });
    }
  }

  return {
    name: 'ghostmaps',
    configureServer({ middlewares }) {
      middlewares.use('/api/ghostmaps', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/ghostmaps', handler);
    },
  };
}
