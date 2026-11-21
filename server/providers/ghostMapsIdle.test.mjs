// The GhostMaps watcher stops polling GitHub when nobody wants the catalog.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  createGhostMapsWatcher,
  ghostMapsIdleMs,
  ghostMapsProxy,
} from './ghostMaps.js';

const HEAD = '1'.repeat(40);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** True once `cond()` holds, false after `ms`. */
async function until(cond, ms = 3000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) return false;
    await sleep(5);
  }
  return true;
}

/** The poll count once no poll came for 50 ms (-1 if polling never stopped). */
async function quiet(polls) {
  for (let i = 0; i < 60; i += 1) {
    const n = polls();
    await sleep(50);
    if (polls() === n) return n;
  }
  return -1;
}

/** GitHub with one empty tree: the ref advertisement is the only call per poll. */
function fakeGitHub() {
  const calls = [];
  const body = (text) =>
    new Response(text, {
      headers: { 'content-length': String(Buffer.byteLength(text)) },
    });
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.endsWith('/info/refs?service=git-upload-pack'))
      return body(
        `001e# service=git-upload-pack\n0000\n003d${HEAD} refs/heads/main\n0000`,
      );
    if (/git\/trees\//.test(url)) return body(JSON.stringify({ tree: [] }));
    if (/\/commits\//.test(url))
      return body(
        JSON.stringify({
          commit: { message: 'x', committer: { date: '2026-10-18T00:00:00Z' } },
        }),
      );
    return new Response('nope', { status: 404 });
  };
  const refPolls = () =>
    calls.filter((url) => url.includes('/info/refs')).length;
  return { fetchImpl, refPolls };
}

async function harness(fn) {
  const cacheDir = await mkdtemp(path.join(os.tmpdir(), 'ghostmaps-idle-'));
  const clock = { t: 0 };
  const github = fakeGitHub();
  const watcher = createGhostMapsWatcher({
    fetchImpl: github.fetchImpl,
    cacheDir,
    now: () => clock.t,
    pollMs: 5,
    idleMs: 1000,
    log() {},
    warn() {},
  });
  try {
    await fn({ watcher, clock, refPolls: github.refPolls });
  } finally {
    watcher.stop();
    await rm(cacheDir, { recursive: true, force: true });
  }
}

test('with no viewer and no request for the idle window, polling stops; a request restarts it', () =>
  harness(async ({ watcher, clock, refPolls }) => {
    await watcher.start();
    assert.ok(await until(() => refPolls() >= 3), 'polling while wanted');
    clock.t = 1000;
    const stopped = await quiet(refPolls);
    assert.ok(stopped > 0, 'polling stopped');
    await sleep(150);
    assert.equal(refPolls(), stopped, 'no poll after the idle window');
    await watcher.start();
    assert.ok(
      await until(() => refPolls() >= stopped + 2),
      'the next request starts it again',
    );
  }));

test('a viewer keeps the watcher polling; the idle window starts when the last one leaves', () =>
  harness(async ({ watcher, clock, refPolls }) => {
    await watcher.start();
    const leave = watcher.subscribe(() => {});
    clock.t = 5000;
    let n = refPolls();
    assert.ok(
      await until(() => refPolls() >= n + 2),
      'a held event stream keeps it polling',
    );
    leave();
    clock.t = 5999;
    n = refPolls();
    assert.ok(
      await until(() => refPolls() >= n + 2),
      'inside the window after the viewer left',
    );
    clock.t = 6000;
    const last = await quiet(refPolls);
    assert.ok(last > 0, 'polling stopped');
    await sleep(150);
    assert.equal(refPolls(), last, 'stopped once the window passed');
  }));

test('GHOSTMAPS_IDLE_MS: 10 min by default, 0 never stops, junk falls back', () => {
  assert.equal(ghostMapsIdleMs(undefined), 600000);
  assert.equal(ghostMapsIdleMs(''), 600000);
  assert.equal(ghostMapsIdleMs('0'), 0);
  assert.equal(ghostMapsIdleMs('120000'), 120000);
  assert.equal(ghostMapsIdleMs('soon'), 600000);
  assert.equal(ghostMapsIdleMs('-5'), 600000);
});

test('a completed SSE GET keeps its viewer until the response closes', () =>
  harness(async ({ watcher, clock, refPolls }) => {
    let handler;
    ghostMapsProxy({ watcher }).configureServer({
      middlewares: { use: (_route, fn) => (handler = fn) },
    });
    let requestComplete = false;
    const server = createServer((req, res) => {
      req.once('close', () => {
        requestComplete = true;
      });
      // Node only closes the request once its body is read; drain it the way
      // a body-reading middleware would, so the GET completes while the
      // event stream stays open.
      req.resume();
      handler(req, res);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const controller = new AbortController();
    try {
      const response = await fetch(
        'http://127.0.0.1:' + server.address().port + '/events',
        { signal: controller.signal },
      );
      assert.equal(response.status, 200);
      assert.ok(
        await until(() => requestComplete),
        'the GET finishes while its event stream remains open',
      );
      assert.equal(
        watcher.subscribers(),
        1,
        'finishing the GET must not unsubscribe its live event stream',
      );

      clock.t = 1000;
      const before = refPolls();
      assert.ok(
        await until(() => refPolls() >= before + 2),
        'an open stream prevents idle polling shutdown',
      );

      controller.abort();
      assert.ok(
        await until(() => watcher.subscribers() === 0),
        'closing the response unsubscribes the viewer',
      );
      clock.t = 2000;
      assert.ok((await quiet(refPolls)) > 0, 'the watcher stops when idle');
    } finally {
      controller.abort();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  }));
