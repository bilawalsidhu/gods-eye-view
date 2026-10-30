#!/usr/bin/env node
/**
 * Prove no long-lived provider key reaches a browser. Crawls a RUNNING server
 * the way a browser would (HTML, every module/asset it references, same-origin
 * API JSON) and/or scans a production build directory, and fails if any of the
 * configured key VALUES, or a key-shaped string, appears. Prints counts only —
 * never a value.
 *
 *   node scripts/check-key-exposure.mjs --url http://127.0.0.1:4173 [--dist dist]
 *
 * Secret values come from the environment, else from .env in the cwd.
 * Cesium ion's endpoint documents legitimately carry Cesium's OWN provider
 * keys (Bing, Google); those responses are checked by exact value of our keys
 * only, and the pattern hits are reported separately.
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';

// GOOGLE_MAPS_API_KEY is the client-exposed browser key by design (SECURITY.md).
const KEY_NAMES = [
  'GOOGLE_MAPS_SERVER_API_KEY',
  'CESIUM_ION_TOKEN',
  'MAPILLARY_CLIENT_TOKEN',
];
// No AIza-shaped pattern: the Google browser key is expected in the bundle;
// the server key is still caught by exact value.
const PATTERNS = { 'MLY-shaped': /MLY\|\d{8,}\|[0-9a-f]{20,}/gi };

function loadSecrets() {
  const values = new Map();
  let dotenv = {};
  if (existsSync('.env')) {
    for (const line of readFileSync('.env', 'utf8').split('\n')) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (m && !line.trim().startsWith('#'))
        dotenv[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
  for (const name of KEY_NAMES) {
    const v = String(process.env[name] ?? dotenv[name] ?? '').trim();
    if (v.length >= 8) values.set(name, v);
  }
  return values;
}

const args = process.argv.slice(2);
const opt = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
const baseUrl = opt('--url');
const dist = opt('--dist');
const secrets = loadSecrets();
const report = {
  files: 0,
  bytes: 0,
  valueHits: {},
  patternHits: {},
  ionEndpointPatternHits: 0,
  errors: [],
};
for (const name of secrets.keys()) report.valueHits[name] = 0;
for (const name of Object.keys(PATTERNS)) report.patternHits[name] = 0;

function scan(text, { label, ionEndpoint = false }) {
  report.files += 1;
  report.bytes += text.length;
  for (const [name, value] of secrets) {
    // Also catch the URL-encoded form (MLY%7C...).
    for (const form of new Set([value, encodeURIComponent(value)]))
      if (text.includes(form))
        ((report.valueHits[name] += 1),
          (report.where ??= []).push(`${name}@${label}`));
  }
  for (const [name, re] of Object.entries(PATTERNS)) {
    const n = (text.match(re) ?? []).length;
    if (!n) continue;
    if (ionEndpoint) report.ionEndpointPatternHits += n;
    else
      ((report.patternHits[name] += n),
        (report.where ??= []).push(`${name}@${label}`));
  }
}

async function crawl() {
  const origin = new URL(baseUrl).origin;
  const queue = ['/'];
  const seen = new Set();
  const jsonRoutes = [
    '/api/setup/status',
    '/api/mapillary/status',
    '/api/ion/status',
    '/api/ion/v1/assets/1/endpoint',
    '/api/ion/v1/assets/2/endpoint',
    '/api/ion/v1/assets/3/endpoint',
    '/api/ion/v1/assets/2275207/endpoint',
    '/api/google/tiles-token',
    '/config',
    '/manifest.webmanifest',
  ];
  queue.push(...jsonRoutes);
  const ref =
    /(?:from\s*|import\s*\(\s*|import\s+|src=|href=|url\()["']?(\/[^"')\s>]+)/g;
  while (queue.length && seen.size < 1500) {
    const p = queue.shift();
    if (seen.has(p)) continue;
    seen.add(p);
    let res;
    try {
      res = await fetch(origin + p, { headers: { Accept: '*/*' } });
    } catch (e) {
      report.errors.push(`${p}: ${e.message}`);
      continue;
    }
    const type = res.headers.get('content-type') ?? '';
    if (!/text|json|javascript|xml|svg/.test(type)) {
      await res.body?.cancel();
      continue;
    }
    const text = await res.text();
    scan(text, { label: p, ionEndpoint: p.startsWith('/api/ion/v1/') });
    if (/javascript|html|css/.test(type))
      for (const m of text.matchAll(ref)) {
        const next = m[1].split('#')[0];
        if (!next.startsWith('//') && !next.startsWith('/api/'))
          queue.push(next);
      }
  }
  report.crawled = seen.size;
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const f = path.join(dir, name);
    if (statSync(f).isDirectory()) walk(f, out);
    else out.push(f);
  }
  return out;
}

if (!baseUrl && !dist) {
  console.error('usage: check-key-exposure.mjs --url <server> [--dist <dir>]');
  process.exit(2);
}
if (baseUrl) await crawl();
if (dist) {
  for (const file of walk(dist)) {
    if (
      /\.(png|jpe?g|gif|webp|ico|woff2?|ttf|glb|gltf|bin|wasm|mp3|mp4|pbf)$/i.test(
        file,
      )
    )
      continue;
    scan(readFileSync(file, 'utf8'), { label: file });
  }
}
const total =
  Object.values(report.valueHits).reduce((a, b) => a + b, 0) +
  Object.values(report.patternHits).reduce((a, b) => a + b, 0);
console.log(
  JSON.stringify(
    { ...report, secretsConfigured: [...secrets.keys()], leaks: total },
    null,
    2,
  ),
);
process.exit(total === 0 ? 0 : 1);
