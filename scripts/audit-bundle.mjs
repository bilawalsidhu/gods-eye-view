import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';

const MANIFEST = '.vite/manifest.json';
const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const isText =
  /\.(?:[cm]?js|css|html|json|geojson|geojsonl|svg|xml|txt|glsl)$/i;

function kind(file) {
  if (/\.[cm]?js$/i.test(file)) return 'js';
  if (/\.css$/i.test(file)) return 'css';
  if (/\.html$/i.test(file)) return 'html';
  if (/\.(?:json|geojson|geojsonl|bin)$/i.test(file)) return 'data';
  return 'other';
}

function total(assets) {
  return {
    files: assets.length,
    rawBytes: assets.reduce((sum, asset) => sum + asset.rawBytes, 0),
    gzipTextBytes: assets.reduce(
      (sum, asset) => sum + (asset.gzipBytes ?? 0),
      0,
    ),
  };
}

// Only external script and stylesheet tags in Vite's generated HTML are used.
// Inline script bodies and comments cannot contribute spurious tag matches.
function htmlReferences(html) {
  const references = [];
  const tags =
    html
      .replace(/<!--[\s\S]*?-->/g, '')
      .match(/<script\b[^>]*>[\s\S]*?<\/script\s*>|<link\b[^>]*>/gi) || [];
  for (const tag of tags) {
    const attributes = {};
    const opening = tag.slice(0, tag.indexOf('>'));
    for (const match of opening.matchAll(
      /\s+([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g,
    )) {
      attributes[match[1].toLowerCase()] = match[2] ?? match[3];
    }
    const url = /^<script\b/i.test(tag)
      ? attributes.src
      : attributes.rel?.toLowerCase() === 'stylesheet'
        ? attributes.href
        : undefined;
    if (url) references.push(url.replace(/&amp;/g, '&'));
  }
  return references;
}

/** Measure a completed default Vite build without executing application code. */
export function auditBundle(directory) {
  const root = path.resolve(directory);
  const manifest = JSON.parse(readFileSync(path.join(root, MANIFEST), 'utf8'));
  if (!manifest || Array.isArray(manifest) || typeof manifest !== 'object') {
    throw new Error('Expected a Vite manifest object; run npm run build first');
  }
  const assets = [];
  function visit(directory, prefix = '') {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = prefix + entry.name;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute, `${file}/`);
      else if (!entry.isFile())
        throw new Error(`Unsupported build entry: ${file}`);
      else if (file !== MANIFEST) {
        const bytes = readFileSync(absolute);
        assets.push({
          file,
          kind: kind(file),
          load: 'unclassified',
          rawBytes: bytes.length,
          gzipBytes: isText.test(file)
            ? gzipSync(bytes, { level: 9 }).length
            : null,
        });
      }
    }
  }
  visit(root);
  assets.sort((a, b) => compare(a.file, b.file));
  const byFile = new Map(assets.map((asset) => [asset.file, asset]));
  function requireFile(file) {
    const asset = byFile.get(file);
    if (!asset)
      throw new Error(`Build asset missing: ${file}; run npm run build`);
    return asset;
  }
  const keysByFile = new Map();
  for (const [key, chunk] of Object.entries(manifest)) {
    if (!chunk || typeof chunk.file !== 'string')
      throw new Error(`Invalid manifest entry: ${key}`);
    const asset = requireFile(chunk.file);
    keysByFile.set(chunk.file, key);
    if (chunk.src) asset.source = chunk.src;
    for (const field of ['imports', 'dynamicImports', 'css', 'assets']) {
      if (
        chunk[field] !== undefined &&
        (!Array.isArray(chunk[field]) ||
          chunk[field].some((value) => typeof value !== 'string'))
      ) {
        throw new Error(`Invalid manifest ${field}: ${key}`);
      }
    }
    for (const dependency of [
      ...(chunk.imports || []),
      ...(chunk.dynamicImports || []),
    ]) {
      if (!Object.hasOwn(manifest, dependency))
        throw new Error(`Manifest dependency missing: ${dependency}`);
    }
    for (const file of [...(chunk.css || []), ...(chunk.assets || [])])
      requireFile(file);
  }
  if (manifest['index.html']?.isEntry !== true)
    throw new Error('Missing index.html entry in Vite manifest');

  const initialKeys = new Set();
  function markStatic(key, load, visited) {
    if (visited.has(key)) return;
    visited.add(key);
    const chunk = manifest[key];
    for (const file of [chunk.file, ...(chunk.css || [])]) {
      const asset = requireFile(file);
      if (asset.load !== 'initial') asset.load = load;
    }
    for (const dependency of chunk.imports || [])
      markStatic(dependency, load, visited);
  }
  const external = new Set();
  requireFile('index.html').load = 'initial';
  for (const reference of htmlReferences(
    readFileSync(path.join(root, 'index.html'), 'utf8'),
  )) {
    if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(reference)) {
      external.add(reference);
      continue;
    }
    const file = decodeURIComponent(reference.split(/[?#]/, 1)[0]).replace(
      /^\.?\//,
      '',
    );
    requireFile(file).load = 'initial';
    if (keysByFile.has(file))
      markStatic(keysByFile.get(file), 'initial', initialKeys);
  }
  if (!initialKeys.has('index.html'))
    throw new Error('index.html does not reference its manifest entry');
  const dynamicKeys = new Set();
  // Traverse dynamic edges separately: a dynamic import may execute at startup.
  const pending = [...initialKeys].flatMap(
    (key) => manifest[key].dynamicImports || [],
  );
  while (pending.length) {
    const key = pending.pop();
    if (dynamicKeys.has(key)) continue;
    dynamicKeys.add(key);
    const chunk = manifest[key];
    for (const file of [chunk.file, ...(chunk.css || [])]) {
      const asset = requireFile(file);
      if (asset.load !== 'initial') asset.load = 'dynamic';
    }
    pending.push(...(chunk.imports || []), ...(chunk.dynamicImports || []));
  }
  return {
    schemaVersion: 1,
    totals: total(assets),
    initial: Object.fromEntries(
      ['js', 'css', 'html'].map((type) => [
        type,
        total(
          assets.filter(
            (asset) => asset.load === 'initial' && asset.kind === type,
          ),
        ),
      ]),
    ),
    dynamic: total(assets.filter((asset) => asset.load === 'dynamic')),
    unclassified: total(
      assets.filter((asset) => asset.load === 'unclassified'),
    ),
    external: [...external].sort(compare),
    assets,
  };
}

/** Render stable integer byte counts and the largest costs, without locale formatting. */
export function formatBundleAudit(report) {
  const lines = [
    'Production bundle audit (bytes; text gzip level 9, each file compressed separately)',
    `All deployed files: ${report.totals.files}; raw ${report.totals.rawBytes}; text gzip ${report.totals.gzipTextBytes}`,
    'Initial = index.html script/stylesheet tags plus transitive static imports and CSS.',
  ];
  for (const [type, sizes] of Object.entries(report.initial)) {
    lines.push(
      `Initial ${type}: ${sizes.files} files; raw ${sizes.rawBytes}; gzip ${sizes.gzipTextBytes}`,
    );
  }
  lines.push(
    'Initial data: unknown (asset references do not prove request timing).',
  );
  function largest(title, candidates) {
    lines.push('', `${title} (raw | gzip | load | file):`);
    for (const asset of [...candidates]
      .sort((a, b) => b.rawBytes - a.rawBytes || compare(a.file, b.file))
      .slice(0, 10)) {
      lines.push(
        `${asset.rawBytes} | ${asset.gzipBytes ?? '-'} | ${asset.load} | ${asset.file}`,
      );
    }
  }
  largest('Largest deployed assets', report.assets);
  largest(
    'Largest dynamic JS chunks',
    report.assets.filter(
      (asset) => asset.load === 'dynamic' && asset.kind === 'js',
    ),
  );
  lines.push(
    '',
    'Dynamic describes import edges, not feature-demand timing. Unclassified includes copied files and referenced data.',
    `External script/stylesheets excluded: ${report.external.length}. Runtime requests, fonts, imagery and workers are not an initial-load measurement.`,
    'No payload budget enforced; see docs/BUNDLE-AUDIT.md.',
  );
  return `${lines.join('\n')}\n`;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  try {
    const args = process.argv.slice(2);
    const json = args.includes('--json');
    const directories = args.filter((arg) => arg !== '--json');
    if (
      directories.length > 1 ||
      directories.some((arg) => arg.startsWith('-'))
    )
      throw new Error('Usage: node scripts/audit-bundle.mjs [dist] [--json]');
    const report = auditBundle(directories[0] || 'dist');
    process.stdout.write(
      json ? `${JSON.stringify(report, null, 2)}\n` : formatBundleAudit(report),
    );
  } catch (error) {
    console.error(`Bundle audit: ${error.message}`);
    process.exitCode = 1;
  }
}
