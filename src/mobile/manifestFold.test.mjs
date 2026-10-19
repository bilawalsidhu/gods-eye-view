import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Static Fold resizability assertions over the committed manifest.
 *
 * Mirrors section 5 of `scripts/mobile/smoke-check.mjs` at unit level so the
 * no-locks contract is pinned in-diff: the manifest must carry no
 * `screenOrientation`, no `maxAspectRatio`, no `resizeableActivity="false"`,
 * and the launcher activity must declare `configChanges` with the tokens an
 * unfold/refold resize needs. Live resize behavior still needs a Fold device
 * or emulator and is asserted nowhere here.
 */
const manifestPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'android',
  'app',
  'src',
  'main',
  'AndroidManifest.xml',
);
const manifest = readFileSync(manifestPath, 'utf8');

test('manifest carries no orientation or aspect locks', () => {
  assert.doesNotMatch(manifest, /screenOrientation/);
  assert.doesNotMatch(manifest, /maxAspectRatio/);
  assert.doesNotMatch(manifest, /resizeableActivity\s*=\s*["']false["']/);
});

test('launcher activity declares configChanges with fold tokens', () => {
  const match = manifest.match(
    /<activity[\s\S]*?android:configChanges="([^"]*)"/,
  );
  assert.ok(match, 'activity needs android:configChanges');
  const tokens = match[1].split('|');
  for (const token of [
    'orientation',
    'screenSize',
    'smallestScreenSize',
    'screenLayout',
    'density',
  ]) {
    assert.ok(tokens.includes(token), `configChanges handles ${token}`);
  }
});
