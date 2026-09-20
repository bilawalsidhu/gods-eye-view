// src/data/dataCredits.test.mjs
//
// Pins the attribution surface. The credit registry is a legal-requirement
// index (DATA_SOURCES.md is the prose contract; this file is the mechanical
// one): every entry must be well-formed, every key must appear in
// DATA_SOURCES.md, and both registration entry points must be idempotent
// and defensive against a missing/odd credit display.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  DATA_CREDITS,
  TOMTOM_CREDIT,
  NATURAL_EARTH_CREDIT,
  registerDynamicCredit,
  registerDataCredits,
} from './dataCredits.js';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const dataSourcesMd = readFileSync(`${REPO_ROOT}DATA_SOURCES.md`, 'utf8');

/** Stand-in for viewer.creditDisplay capturing registered credits. */
function stubViewer() {
  const registered = [];
  return {
    registered,
    creditDisplay: {
      addStaticCredit(credit) { registered.push(credit); },
    },
  };
}

test('dataCredits: every static entry is well-formed with a unique key', () => {
  const keys = new Set();
  for (const credit of DATA_CREDITS) {
    assert.ok(credit.key, 'entry must have a key');
    assert.equal(typeof credit.html, 'string', `${credit.key} html must be a string`);
    assert.ok(credit.html.length > 10, `${credit.key} html must carry real credit text`);
    assert.ok(!keys.has(credit.key), `duplicate credit key: ${credit.key}`);
    keys.add(credit.key);
  }
  assert.ok(DATA_CREDITS.length >= 20, `expected the full attribution surface, got ${DATA_CREDITS.length}`);
});

test('dataCredits: every key is anchored in DATA_SOURCES.md, and vice versa (docs/code parity)', () => {
  // The module header's contract: "if you add a data source, add it there
  // AND here." DATA_SOURCES.md anchors each registry key as a backticked
  // "in-app credit key" on the source's row, making the doc the
  // machine-readable index of this registry. Both directions are enforced:
  // a credit without a doc anchor, or a doc anchor without a credit, fails.
  const unanchored = DATA_CREDITS.filter((c) => !dataSourcesMd.includes(`\`${c.key}\``))
    .map((c) => c.key);
  assert.deepEqual(unanchored, [],
    'credit keys with no backticked anchor in DATA_SOURCES.md — add "in-app credit key: `<key>`" to the source row');

  const anchoredKeys = [...dataSourcesMd.matchAll(/in-app credit key: `([a-z0-9-]+)`/g)]
    .map((m) => m[1]);
  const knownKeys = new Set(DATA_CREDITS.map((c) => c.key));
  const orphanAnchors = anchoredKeys.filter((key) => !knownKeys.has(key));
  assert.deepEqual(orphanAnchors, [],
    'DATA_SOURCES.md anchors credit keys that have no DATA_CREDITS entry — stale docs');
});

test('dataCredits: every outbound link is noopener-hardened', () => {
  // Credits render inside the app's popover; a missing rel on
  // target="_blank" is reverse-tabnabbing surface.
  for (const credit of [...DATA_CREDITS, TOMTOM_CREDIT, NATURAL_EARTH_CREDIT]) {
    for (const [idx, tag] of [...credit.html.matchAll(/<a\s[^>]*>/g)].entries()) {
      const anchor = tag[0];
      if (anchor.includes('target="_blank"')) {
        assert.ok(anchor.includes('rel="noopener"'),
          `${credit.key} link #${idx + 1} opens a new tab without rel="noopener"`);
      }
    }
  }
});

test('dataCredits: conditional credits are deliberately NOT in the always-on list', () => {
  // TomTom terms only require attribution when flow data is displayed, so
  // the credit must stay dynamic — a keyless install must never ship it.
  const keys = new Set(DATA_CREDITS.map((c) => c.key));
  assert.ok(!keys.has(TOMTOM_CREDIT.key), 'TOMTOM_CREDIT must stay conditional');
});

test('dataCredits: registerDynamicCredit registers new, dedupes repeat, rejects junk', () => {
  const viewer = stubViewer();
  const credit = { key: 'test-dynamic-unique-key', html: 'Test credit <em>html</em>' };

  assert.equal(registerDynamicCredit(viewer, credit), true, 'first registration returns true');
  assert.equal(viewer.registered.length, 1);

  assert.equal(registerDynamicCredit(viewer, credit), true,
    'repeat registration is idempotent-success');
  assert.equal(viewer.registered.length, 1, 'repeat must not double-register');

  const noDisplay = {};
  assert.equal(registerDynamicCredit(noDisplay, credit), false,
    'missing creditDisplay returns false');
  const junkDisplay = stubViewer();
  assert.equal(registerDynamicCredit(junkDisplay, { html: 'no key' }), false,
    'credit without a key is rejected');
  assert.equal(registerDynamicCredit(junkDisplay, { key: 'no-html' }), false,
    'credit without html is rejected');
  assert.equal(junkDisplay.registered.length, 0, 'rejected credits must not register');
});

test('dataCredits: registerDataCredits registers the full surface once, then no-ops on junk viewers', () => {
  const viewer = stubViewer();
  registerDataCredits(viewer);
  assert.equal(viewer.registered.length, DATA_CREDITS.length,
    'one registration per static credit entry');

  assert.equal(registerDataCredits({}), undefined,
    'viewer without creditDisplay is a silent no-op, not a throw');
  assert.equal(registerDataCredits(null), undefined,
    'null viewer is a silent no-op, not a throw');
});
