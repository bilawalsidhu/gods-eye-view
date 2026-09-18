// Browser code must never touch the server's OnDemand key. The proxy reads
// ONDEMAND_API_KEY on the server (server/ondemand/config.js) and the browser
// only ever sends its OWN optional key as the `x-ondemand-key` header
// (src/ondemand/entityChat.js). This guard fails the moment any file under
// src/ mentions the server env var by name in a way that could read it.
// Run with: node --test src/ondemand/noKeyInBundle.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC_ROOT = fileURLToPath(new URL('..', import.meta.url));
// Assembled from parts so this file never contains the forbidden literals
// itself (it lives under src/ too).
const FORBIDDEN = [
  ['ONDEMAND', 'API', 'KEY'].join('_') + '=',
  'process.env.' + ['ONDEMAND', 'API', 'KEY'].join('_'),
  'import.meta.env.' + ['ONDEMAND', 'API', 'KEY'].join('_'),
  'import.meta.env.VITE_' + ['ONDEMAND', 'API', 'KEY'].join('_'),
];

// Node-only trees under src/ — the same set scripts/check-import-directions.mjs
// treats as tests (never part of the browser graph): *.test.mjs, src/tooling/
// (node:test harnesses for the server tools) and src/testSupport/.
const NODE_ONLY = (relative) =>
  relative.endsWith('.test.mjs') ||
  relative.startsWith('tooling/') ||
  relative.startsWith('testSupport/');

function sourceFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'fixtures') continue;
      files.push(...sourceFiles(absolute));
    } else if (/\.(?:m?js|css|html)$/.test(entry.name)) {
      files.push(absolute);
    }
  }
  return files.sort();
}

test('no browser-built file under src/ contains a server-key env read', () => {
  const offenders = [];
  let scanned = 0;
  for (const file of sourceFiles(SRC_ROOT)) {
    const relative = path.relative(SRC_ROOT, file).split(path.sep).join('/');
    if (NODE_ONLY(relative)) continue;
    scanned += 1;
    const source = readFileSync(file, 'utf8');
    for (const literal of FORBIDDEN) {
      if (source.includes(literal)) offenders.push(`${relative}: ${literal}`);
    }
  }
  assert.ok(scanned > 100, `scanned only ${scanned} files`);
  assert.deepEqual(offenders, [], `server key reachable from browser code:\n${offenders.join('\n')}`);
});

test('the entity chat only ever names the override header and the browser storage key', () => {
  const chat = readFileSync(new URL('./entityChat.js', import.meta.url), 'utf8');
  const context = readFileSync(new URL('./entityContext.js', import.meta.url), 'utf8');
  for (const source of [chat, context]) {
    assert.equal(source.includes('process.env'), false, 'no process.env in browser modules');
    assert.equal(source.includes('apikey:'), false, 'the upstream apikey header is the proxy\'s job');
  }
  assert.ok(chat.includes("'x-ondemand-key'"));
  assert.ok(chat.includes("'ondemand.apiKey'"));
  assert.equal(/console\.\w+\(/.test(chat), false, 'the controller never logs (a key could ride along)');
});
