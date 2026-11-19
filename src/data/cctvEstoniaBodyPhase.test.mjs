// A body-phase failure of one Tarktee DATEX feed must abort the sibling that is
// still waiting for headers instead of leaving it until the 30 s deadline.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  TARKTEE_IMAGES_URL,
  TARKTEE_LOCATIONS_URL,
  TARKTEE_MAX_CATALOG_BYTES,
} from '../../server/providers/cctv/constants.js';
import { loadTarkteeSourcesFromDatex } from '../../server/providers/cctv/sources.js';

/** The sibling sends its headers this late; the loader must not wait for it. */
const SIBLING_HEADER_DELAY_MS = 2000;
/** Generous bound for "at once" on a loaded CI machine. */
const FAIL_FAST_MS = 1000;

function startServer(handlers) {
  const server = http.createServer((req, res) => handlers[req.url](req, res));
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

/** Send the two DATEX URLs to the local server through the real fetch. */
function routeFetchTo(t, port) {
  const realFetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', (url, init) => {
    const path =
      String(url) === TARKTEE_LOCATIONS_URL
        ? '/loc'
        : String(url) === TARKTEE_IMAGES_URL
          ? '/img'
          : null;
    assert.ok(path, `unexpected url ${url}`);
    return realFetch(`http://127.0.0.1:${port}${path}`, init);
  });
}

/** The sibling answers late and reports whether it was cut off before headers. */
function slowSibling() {
  const arrived = Promise.withResolvers();
  const closed = Promise.withResolvers();
  return {
    arrived: arrived.promise,
    closed: closed.promise,
    handler(req, res) {
      arrived.resolve();
      const timer = setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/xml' });
        res.end('<d2LogicalModel/>');
      }, SIBLING_HEADER_DELAY_MS);
      res.on('close', () => {
        clearTimeout(timer);
        closed.resolve({ beforeHeaders: !res.headersSent });
      });
    },
  };
}

const failingBodies = {
  'declares a body over the byte cap': (req, res) => {
    res.writeHead(200, {
      'content-type': 'application/xml',
      'content-length': String(TARKTEE_MAX_CATALOG_BYTES + 1),
    });
    res.write('<d2LogicalModel>');
  },
  'resets the connection mid-body': (req, res) => {
    res.writeHead(200, { 'content-type': 'application/xml' });
    res.write('<d2LogicalModel><payloadPublication>');
    setTimeout(() => res.socket.destroy(), 20);
  },
};

for (const [label, failingFeed] of Object.entries(failingBodies)) {
  for (const [failing, pending] of [
    ['/loc', '/img'],
    ['/img', '/loc'],
  ]) {
    test(`Tarktee aborts ${pending} pending headers when ${failing} ${label}`, { timeout: 10_000 }, async (t) => {
      t.mock.method(console, 'log', () => {});
      t.mock.method(console, 'warn', () => {});
      const sibling = slowSibling();
      const server = await startServer({
        [failing]: (req, res) =>
          sibling.arrived.then(() => failingFeed(req, res)),
        [pending]: sibling.handler,
      });
      t.after(() => {
        server.closeAllConnections();
        server.close();
      });
      routeFetchTo(t, server.address().port);

      const started = Date.now();
      const cameras = await loadTarkteeSourcesFromDatex();
      const elapsed = Date.now() - started;

      assert.deepEqual(cameras, []);
      assert.ok(
        elapsed < FAIL_FAST_MS,
        `loader waited ${elapsed} ms for the sibling's headers instead of aborting it`,
      );
      assert.deepEqual(
        await sibling.closed,
        { beforeHeaders: true },
        `${pending} was not aborted`,
      );
    });
  }
}
