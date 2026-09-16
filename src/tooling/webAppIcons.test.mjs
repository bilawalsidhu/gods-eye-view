import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const REPO_ROOT = path.resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '../..',
);
const PUBLIC_ROOT = path.join(REPO_ROOT, 'public');
const INDEX_HTML = readFileSync(path.join(REPO_ROOT, 'index.html'), 'utf8');

/** `public/` is served at the site root, so a manifest href maps to a file by dropping the leading slash. */
function publicFile(href) {
  assert.ok(href.startsWith('/'), `${href} must be a root-relative URL`);
  return path.join(PUBLIC_ROOT, href.slice(1));
}

const manifestHref = INDEX_HTML.match(
  /<link[^>]+rel="manifest"[^>]+href="([^"]+)"/,
)?.[1];

test('index.html links a web app manifest', () => {
  assert.ok(manifestHref, 'no <link rel="manifest"> in index.html');
});

test('iOS gets a raster home-screen icon', () => {
  // Safari ignores SVG for apple-touch-icon and falls back to a screenshot of
  // the page, which is the blank tile this whole file exists to prevent. The
  // existing `rel="icon"` SVG covers the browser tab and nothing else.
  const href = INDEX_HTML.match(
    /<link[^>]+rel="apple-touch-icon"[^>]+href="([^"]+)"/,
  )?.[1];
  assert.ok(href, 'no <link rel="apple-touch-icon"> in index.html');
  assert.match(href, /\.png$/, 'apple-touch-icon must be a PNG');
  assert.doesNotThrow(() => readFileSync(publicFile(href)));
});

test('the manifest declares a standalone installable app', () => {
  const manifest = JSON.parse(readFileSync(publicFile(manifestHref), 'utf8'));
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.start_url, '/');
  for (const field of ['name', 'short_name', 'background_color', 'theme_color'])
    assert.ok(manifest[field], `manifest is missing ${field}`);
  // Android's install prompt needs both, and uses the 512 for the splash screen.
  const sizes = new Set(manifest.icons.map((icon) => icon.sizes));
  for (const required of ['192x192', '512x512'])
    assert.ok(sizes.has(required), `manifest declares no ${required} icon`);
  // Without a maskable icon Android pads the square into a circle and clips
  // the mark; with one it crops to the safe zone instead.
  assert.ok(
    manifest.icons.some((icon) => icon.purpose?.includes('maskable')),
    'manifest declares no maskable icon',
  );
});

test('every declared icon is a square PNG at its declared size', async () => {
  const manifest = JSON.parse(readFileSync(publicFile(manifestHref), 'utf8'));
  for (const icon of manifest.icons) {
    const meta = await sharp(publicFile(icon.src)).metadata();
    const [width, height] = icon.sizes.split('x').map(Number);
    assert.equal(meta.format, 'png', `${icon.src} is not a PNG`);
    // A size the manifest overstates is worse than a missing one: the platform
    // trusts the declaration and scales whatever it finds.
    assert.equal(meta.width, width, `${icon.src} width`);
    assert.equal(meta.height, height, `${icon.src} height`);
  }
});
