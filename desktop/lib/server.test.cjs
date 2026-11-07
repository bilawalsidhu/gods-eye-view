'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { parseReadyUrl, pickPort, portIsFree } = require('./server.cjs');

test('the ready line yields the served URL, and other output does not', () => {
  assert.equal(
    parseReadyUrl('x\n[GEV] Ready at http://127.0.0.1:47831/\n'),
    'http://127.0.0.1:47831/',
  );
  assert.equal(parseReadyUrl('  Local: http://localhost:5173/'), null);
  assert.equal(parseReadyUrl('[GEV] Ready at http://0.0.0.0:1/'), null);
});

test('pickPort prefers the stable port and walks forward when it is taken', async () => {
  assert.equal(await pickPort(5000, 5, async () => true), 5000);
  const taken = new Set([5000, 5001]);
  assert.equal(await pickPort(5000, 5, async (port) => !taken.has(port)), 5002);
  await assert.rejects(
    pickPort(5000, 2, async () => false),
    /No free local port/,
  );
});

test('portIsFree reflects a real listener', async () => {
  const blocker = net.createServer();
  await new Promise((resolve) => blocker.listen(0, '127.0.0.1', resolve));
  const { port } = blocker.address();
  assert.equal(await portIsFree(port), false);
  await new Promise((resolve) => blocker.close(resolve));
  assert.equal(await portIsFree(port), true);
});
