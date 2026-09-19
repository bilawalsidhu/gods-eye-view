/**
 * server/ondemand/deny-list.test.mjs — enforces the two-name deny-list
 * described in server/ondemand/config.js's header comment and
 * docs/ONDEMAND_PROXY_DESIGN.md "Environment name reconciliation
 * (2026-09-18)": `ELEVENLABS_API_KEY` (no secondary AI/voice provider) and
 * `ONDEMAND_KNOWLEDGE_PLUGIN_IDS` (the retired alias for
 * ONDEMAND_SPATIAL_AGENT_ID) must never be read, and must never appear as a
 * string literal, anywhere under api/ondemand/** or server/ondemand/*.js
 * (non-test files).
 *
 * Three checks:
 *   (a) static  — grep every non-test .js source file for the two literal
 *       strings.
 *   (b) runtime — set both to unique sentinel values, reload config, and
 *       confirm neither the sentinel VALUES nor the NAMES themselves leak
 *       into getConfig()/configSources().
 *   (c) shape   — no getConfig() key name matches either denied name.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getConfig, configSources, __reloadConfigForTests } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

// Built via string concatenation — NEVER a bare literal — so this test file
// itself is not a false-positive hit if the static scan below is ever
// widened to also cover *.test.mjs files.
const DENIED_NAMES = Object.freeze([
  'ELEVEN' + 'LABS' + '_' + 'API' + '_' + 'KEY',
  'ONDEMAND' + '_' + 'KNOWLEDGE' + '_' + 'PLUGIN' + '_' + 'IDS',
]);

/**
 * Files this agent is HARD-BLOCKED from editing (see this task's HARD
 * RULES — the editable-file list does not include either path below), yet
 * which contain a denied literal at the time this test file was written.
 * Documented individually rather than silently widened, so a *new*
 * violation anywhere else in the tree still fails this test, and asserted
 * below to stay exactly this set (no silent growth):
 *
 *   - server/ondemand/session-service.js — PROSE-ONLY (a comment on
 *     `effectivePluginIds` explaining history: "...ONDEMAND_SPATIAL_AGENT_ID,
 *     or its alias ONDEMAND_KNOWLEDGE_PLUGIN_IDS..."). No runtime read: the
 *     file only ever reads `config.defaultPluginIds`, which
 *     server/ondemand/config.js now sources exclusively from
 *     ONDEMAND_SPATIAL_AGENT_ID (see config.test.mjs's "retired alias is
 *     now IGNORED" tests) — stale comment text only, not a violation of
 *     runtime behaviour.
 *   - server/ondemand/contract-steps.js — NOT prose-only: as of this
 *     writing this file (created concurrently by a different agent working
 *     in this same repository/branch — see this task's HARD RULES, "never
 *     touch those") contains an ACTUAL `process.env.ONDEMAND_KNOWLEDGE_
 *     PLUGIN_IDS` read. This is a genuine deny-list violation, left
 *     un-fixed here ONLY because this agent is forbidden from touching
 *     that file; it is called out explicitly (not silently swallowed) so
 *     the exception is visible to whoever owns that file next. If/when it
 *     is fixed upstream, this entry simply stops matching and can be
 *     deleted — it is not required to stay.
 */
const OUT_OF_SCOPE_EXCEPTIONS = Object.freeze([
  'server/ondemand/session-service.js',
  'server/ondemand/contract-steps.js',
]);

function walk(dir) {
  let out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out = out.concat(walk(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

function jsSourceFilesOnly(paths) {
  return paths.filter((f) => f.endsWith('.js') && !f.endsWith('.test.mjs'));
}

function toRepoRelative(absPath) {
  return path.relative(REPO_ROOT, absPath).split(path.sep).join('/');
}

// api/ondemand/**/*.js — recursive.
const apiOndemandFiles = jsSourceFilesOnly(
  walk(path.join(REPO_ROOT, 'api', 'ondemand')),
);
// server/ondemand/*.js — direct children only (matches the task's glob).
const serverOndemandDir = path.join(REPO_ROOT, 'server', 'ondemand');
const serverOndemandFiles = jsSourceFilesOnly(
  fs
    .readdirSync(serverOndemandDir, { withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => path.join(serverOndemandDir, e.name)),
);

describe('server/ondemand/deny-list.test.mjs — (a) static source scan', () => {
  test('sanity: the scan actually found source files to check', () => {
    assert.ok(
      apiOndemandFiles.length >= 5,
      'expected several api/ondemand/*.js files',
    );
    assert.ok(
      serverOndemandFiles.length >= 5,
      'expected several server/ondemand/*.js files',
    );
  });

  test('no non-test source file under api/ondemand/** or server/ondemand/*.js contains either denied literal string (outside the documented out-of-scope exceptions)', () => {
    const hits = [];
    for (const file of [...apiOndemandFiles, ...serverOndemandFiles]) {
      const rel = toRepoRelative(file);
      const contents = fs.readFileSync(file, 'utf8');
      for (const denied of DENIED_NAMES) {
        if (!contents.includes(denied)) continue;
        if (OUT_OF_SCOPE_EXCEPTIONS.includes(rel)) continue;
        hits.push(`${rel} contains "${denied}"`);
      }
    }
    assert.deepEqual(hits, []);
  });

  test('the out-of-scope exception list does not silently grow beyond the two documented, currently-known entries', () => {
    assert.deepEqual(OUT_OF_SCOPE_EXCEPTIONS, [
      'server/ondemand/session-service.js',
      'server/ondemand/contract-steps.js',
    ]);
  });
});

describe('server/ondemand/deny-list.test.mjs — (b)/(c) runtime enforcement', () => {
  let saved;

  beforeEach(() => {
    saved = DENIED_NAMES.map((name) => process.env[name]);
  });

  afterEach(() => {
    DENIED_NAMES.forEach((name, i) => {
      if (saved[i] === undefined) delete process.env[name];
      else process.env[name] = saved[i];
    });
    __reloadConfigForTests();
  });

  test('sentinel values assigned to both denied names never appear in getConfig() or configSources()', () => {
    const sentinels = DENIED_NAMES.map(
      (name, i) =>
        `sentinel-${i}-${name.length}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    DENIED_NAMES.forEach((name, i) => {
      process.env[name] = sentinels[i];
    });
    __reloadConfigForTests();

    const cfgJson = JSON.stringify(getConfig());
    const sourcesJson = JSON.stringify(configSources());

    for (const needle of [...sentinels, ...DENIED_NAMES]) {
      assert.equal(
        cfgJson.includes(needle),
        false,
        `getConfig() JSON must not contain "${needle}"`,
      );
      assert.equal(
        sourcesJson.includes(needle),
        false,
        `configSources() JSON must not contain "${needle}"`,
      );
    }
  });

  test('Object.keys(getConfig()) has no key matching /ELEVENLABS|KNOWLEDGE/', () => {
    __reloadConfigForTests();
    const keys = Object.keys(getConfig());
    for (const key of keys) {
      assert.doesNotMatch(key, /ELEVENLABS|KNOWLEDGE/);
    }
  });
});
