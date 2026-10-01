import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { build } from 'vite';
import { makeFixtureRoot } from './fixtureRoot.mjs';

const REPO_ROOT = path.resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '../..',
);
const PUBLIC_ROOT = path.join(REPO_ROOT, 'public');
const INDEX_HTML = readFileSync(path.join(REPO_ROOT, 'index.html'), 'utf8');

/** `public/` is served at the site root, so an index.html href maps to a file by dropping the leading slash. */
function publicFile(href) {
  assert.ok(href.startsWith('/'), `${href} must be a root-relative URL`);
  return path.join(PUBLIC_ROOT, href.slice(1));
}

const manifestHref = INDEX_HTML.match(
  /<link[^>]+rel="manifest"[^>]+href="([^"]+)"/,
)?.[1];

/**
 * Manifest URLs resolve against the manifest, not the page. Keeping them
 * relative is what lets a build served under a path prefix install inside it.
 */
function manifestFile(src) {
  assert.ok(
    !src.startsWith('/') && !/^[a-z][a-z\d+.-]*:/i.test(src),
    `${src} must be relative to the manifest`,
  );
  return path.join(path.dirname(publicFile(manifestHref)), src);
}

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
  assert.equal(manifest.start_url, '.');
  assert.equal(manifest.scope, '.');
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
    const meta = await sharp(manifestFile(icon.src)).metadata();
    const [width, height] = icon.sizes.split('x').map(Number);
    assert.equal(meta.format, 'png', `${icon.src} is not a PNG`);
    // A size the manifest overstates is worse than a missing one: the platform
    // trusts the declaration and scales whatever it finds.
    assert.equal(meta.width, width, `${icon.src} width`);
    assert.equal(meta.height, height, `${icon.src} height`);
  }
});

test('install assets stay inside a non-root Vite base', async (t) => {
  // The real index.html pulls the whole Cesium app into a build, so only its
  // install links are copied, verbatim, into a fixture page.
  const tags = INDEX_HTML.match(
    /<link[^>]+rel="(?:icon|apple-touch-icon|manifest)"[^>]*>/g,
  );
  assert.ok(tags?.length >= 3, 'index.html lost its install links');
  const root = await makeFixtureRoot('gev-webapp-icons-');
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(
    path.join(root, 'index.html'),
    `<!doctype html><html><head>${tags.join('')}</head><body></body></html>`,
  );
  const base = '/example/';
  const origin = 'https://host.test';
  const result = await build({
    root,
    configFile: false,
    envFile: false,
    logLevel: 'silent',
    base,
    publicDir: PUBLIC_ROOT,
    build: { write: false },
  });
  const html = result.output.find(
    (item) => item.fileName === 'index.html',
  ).source;
  const hrefs = [...html.matchAll(/<link[^>]+href="([^"]+)"/g)].map(
    (match) => match[1],
  );
  assert.equal(hrefs.length, tags.length);
  for (const href of hrefs) {
    assert.ok(href.startsWith(base), `${href} escapes ${base}`);
    assert.doesNotThrow(() =>
      readFileSync(path.join(PUBLIC_ROOT, href.slice(base.length))),
    );
  }

  // Vite copies public/ only when it writes, and copies it verbatim, so the
  // deployed manifest is the committed one, served at the emitted href.
  const manifestUrl = new URL(
    html.match(/<link[^>]+rel="manifest"[^>]+href="([^"]+)"/)[1],
    origin,
  );
  const manifest = JSON.parse(readFileSync(publicFile(manifestHref), 'utf8'));
  const inBase = (value) => {
    const url = new URL(value, manifestUrl);
    assert.ok(
      url.href.startsWith(origin + base),
      `${value} resolves to ${url.href}, outside ${base}`,
    );
    return url;
  };
  assert.equal(inBase(manifest.start_url).href, origin + base);
  assert.equal(inBase(manifest.scope).href, origin + base);
  for (const icon of manifest.icons) {
    const url = inBase(icon.src);
    assert.doesNotThrow(() =>
      readFileSync(path.join(PUBLIC_ROOT, url.pathname.slice(base.length))),
    );
  }
});
