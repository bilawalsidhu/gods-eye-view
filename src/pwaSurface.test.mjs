// src/pwaSurface.test.mjs
// PWA surface contract. The 2026-09-23 idle-GPU audit caught a policy that
// had been writing a Cesium property NOBODY reads (`scene.sceneResolutionScale`)
// while its test asserted the same wrong property on a stub — green tests,
// silent no-op in production. The defense is contracts that read the REAL
// files: this suite validates public/manifest.json, index.html, and the
// vite-plugin-pwa config against each other and against files that must
// actually exist on disk.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

const manifest = JSON.parse(readFileSync('public/manifest.json', 'utf8'));
const html = readFileSync('index.html', 'utf8');
const viteConfig = readFileSync('vite.config.js', 'utf8');

test('manifest: identity fields an install prompt requires', () => {
  for (const key of ['name', 'short_name', 'id', 'start_url', 'scope', 'display']) {
    assert.ok(manifest[key], `manifest.${key} is required for installability`);
  }
  assert.equal(manifest.display, 'standalone');
  // Same app identity across deploys: start_url changes must not orphan the
  // installed app (that is what the id is for).
  assert.equal(manifest.id, '/');
});

test('manifest: launch handler focuses the existing console window', () => {
  // A geoconsole is a single long-lived workspace; launching should focus
  // the running instance, not pile up duplicate windows.
  assert.equal(manifest.launch_handler?.client_mode, 'focus-existing');
});

test('manifest: icon set covers install requirements, and the files exist', () => {
  const sizes = (purpose) => manifest.icons.filter((i) => i.purpose === purpose);
  // Chromium installability: at least 192px and 512px "any" icons.
  assert.ok(sizes('any').some((i) => i.sizes === '192x192'), 'needs a 192px any icon');
  assert.ok(sizes('any').some((i) => i.sizes === '512x512'), 'needs a 512px any icon');
  // Maskable uses the DEDICATED padded asset, not the square logo — the
  // regression this pins is the manifest once reusing icon-512 for maskable.
  assert.equal(sizes('maskable').length, 1, 'exactly one maskable icon');
  assert.equal(sizes('maskable')[0].src, '/icons/icon-maskable.png');
  for (const icon of manifest.icons) {
    const file = icon.src.replace(/^\//, '');
    assert.ok(existsSync(`public/${file}`), `${icon.src} must exist on disk`);
  }
});

test('manifest: shortcuts point at real app routes with existing icons', () => {
  assert.ok(manifest.shortcuts.length >= 1, 'at least one shortcut');
  for (const shortcut of manifest.shortcuts) {
    assert.match(shortcut.url, /^\/(#|$)/, `${shortcut.url} must be a same-origin path`);
    for (const icon of shortcut.icons ?? []) {
      const file = icon.src.replace(/^\//, '');
      assert.ok(existsSync(`public/${file}`), `shortcut icon ${icon.src} must exist`);
    }
  }
});

test('index.html: links the manifest and carries the iOS standalone meta set', () => {
  assert.match(html, /<link rel="manifest" href="\/manifest\.json" \/>/);
  // Safari ignores parts of the manifest; these meta tags are the iOS
  // standalone story (icon, display mode, status bar, home-screen title).
  assert.match(html, /<link rel="apple-touch-icon" sizes="180x180" href="\/icons\/icon-180\.png" \/>/);
  assert.match(html, /<meta name="apple-mobile-web-app-capable" content="yes" \/>/);
  assert.match(html, /<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" \/>/);
  assert.match(html, /<meta name="apple-mobile-web-app-title" content="GEV" \/>/);
  assert.ok(existsSync('public/icons/icon-180.png'), 'apple-touch-icon file must exist');
});

test('service worker: app-shell precache with an /api/ navigate fallback denylist', () => {
  // The plugin config is the source of truth for the SW (manifest: false
  // keeps public/manifest.json as the only manifest).
  assert.match(viteConfig, /VitePWA\(/, 'vite-plugin-pwa must be wired');
  assert.match(viteConfig, /registerType:\s*'autoUpdate'/);
  assert.match(viteConfig, /manifest:\s*false/, 'public/manifest.json is the only manifest');
  assert.match(viteConfig, /navigateFallback:\s*'\/index\.html'/);
  assert.match(viteConfig, /navigateFallbackDenylist:\s*\[\/\^\\\/api\\\//, 'API routes must bypass the app-shell fallback');
  // Precache is the shell only: entry chunk + css (the 6 MiB cap comment
  // documents why the ~5.8 MB shell chunk fits).
  assert.match(viteConfig, /globPatterns:\s*\['index\.html', 'assets\/index-\*\.js', 'assets\/\*\.css'\]/);
  assert.match(viteConfig, /maximumFileSizeToCacheInBytes:\s*6 \* 1024 \* 1024/);
  // Live APIs must be network-first so a stale cache never reads as fresh data.
  assert.match(viteConfig, /handler:\s*'NetworkFirst'/);
});
