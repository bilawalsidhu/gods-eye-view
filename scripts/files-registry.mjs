// Compare docs/migration/planet-separation/files.tsv with the tracked tree.
//
// The registry routes every tracked path of the base commit, and every path
// added since, to a work package. A row whose path ends with "/" covers the
// whole subtree: bundled data and migration documents are registered that way,
// source and test files one by one.
//
//   node scripts/files-registry.mjs           print unregistered paths with a proposed row
//   node scripts/files-registry.mjs --write   insert the proposed rows into files.tsv
//   node scripts/files-registry.mjs --check   exit 1 when a tracked path is unregistered
//                                             or a row names a path that was never tracked
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const BASE_COMMIT = '9824bbba0a8f6c8ab6dc7ebd3768ca0cbc4721a1';
export const REGISTRY_PATH = 'docs/migration/planet-separation/files.tsv';
export const REGISTRY_HEADER = [
  'путь',
  'пакет_работ',
  'семейство_слоя',
  'прямые_SDK_импорты',
  'операция',
  'первый_владелец_из_package_boundaries',
];
const NO_OWNER = '—';
const SDK_PATTERN = /^(cesium|three|postprocessing|@navaramap\/)/;

/** Tracked paths of one revision. */
export function gitPaths(root, revision) {
  const out = execFileSync(
    'git',
    ['ls-tree', '-r', '--name-only', '-z', revision],
    { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  return out.split('\0').filter(Boolean);
}

/** The base tree plus every path tracked at HEAD, sorted by code unit. */
export function trackedPaths(root) {
  return [
    ...new Set([...gitPaths(root, BASE_COMMIT), ...gitPaths(root, 'HEAD')]),
  ].sort(compareCodeUnits);
}

export function compareCodeUnits(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function parseRegistry(text) {
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  const header = lines.shift()?.split('\t') ?? [];
  if (header.join('\t') !== REGISTRY_HEADER.join('\t')) {
    throw new Error(`Unexpected files.tsv header: ${header.join(' | ')}`);
  }
  const rows = lines.map((line, index) => {
    const fields = line.split('\t');
    if (fields.length !== REGISTRY_HEADER.length) {
      throw new Error(
        `files.tsv line ${index + 2}: expected ${REGISTRY_HEADER.length} fields`,
      );
    }
    return fields;
  });
  return { header, rows };
}

export function serializeRegistry({ header, rows }) {
  return [header, ...rows].map((fields) => fields.join('\t')).join('\n') + '\n';
}

export function isDirectoryRow(registryPath) {
  return registryPath.endsWith('/');
}

/** Index rows by exact path and collect the directory rows. */
export function indexRegistry(rows) {
  const exact = new Map();
  const directories = [];
  for (const fields of rows) {
    if (isDirectoryRow(fields[0])) directories.push(fields[0]);
    else exact.set(fields[0], fields);
  }
  return { exact, directories };
}

export function isRegistered(filePath, index) {
  return (
    index.exact.has(filePath) ||
    index.directories.some((directory) => filePath.startsWith(directory))
  );
}

/** Tracked paths without a row, and rows that match no tracked path. */
export function compareRegistry(rows, tracked) {
  const index = indexRegistry(rows);
  const trackedSet = new Set(tracked);
  const unregistered = tracked.filter(
    (filePath) => !isRegistered(filePath, index),
  );
  const orphans = rows
    .map((fields) => fields[0])
    .filter((registryPath) =>
      isDirectoryRow(registryPath)
        ? !tracked.some((filePath) => filePath.startsWith(registryPath))
        : !trackedSet.has(registryPath),
    );
  return { unregistered, orphans };
}

/** Bare specifiers of the rendering SDKs a module imports directly. */
export function sdkImports(source) {
  const specifiers = new Set();
  const patterns = [
    /\bimport\s+(?:[^'"`;]*?\sfrom\s*)?['"]([^'"]+)['"]/g,
    /\bexport\s+[^'"`;]*?\sfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      if (SDK_PATTERN.test(match[1])) specifiers.add(match[1]);
    }
  }
  return [...specifiers].sort(compareCodeUnits).join(',');
}

/** First package-boundaries group whose module list contains the path. */
export function firstBoundaryOwner(filePath, boundaries) {
  for (const [name, group] of Object.entries(boundaries)) {
    if ((group.modules || []).includes(filePath)) return name;
  }
  return NO_OWNER;
}

function fileKind(filePath, sdk) {
  if (/\.test\.m?js$/.test(filePath)) return 'test';
  if (sdk) return 'sdk';
  return 'source';
}

function mostCommon(values) {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) || 0) + 1);
  return [...counts.entries()].sort(
    (a, b) => b[1] - a[1] || compareCodeUnits(a[0], b[0]),
  )[0]?.[0];
}

/**
 * Propose a row from the registered neighbours: the nearest directory that has
 * registered files decides the package, family and operation, preferring
 * neighbours of the same kind (test, SDK-importing module, other source).
 */
export function proposeRow(
  filePath,
  rows,
  { sdk = '', owner = NO_OWNER } = {},
) {
  const kind = fileKind(filePath, sdk);
  const registered = rows.filter((fields) => !isDirectoryRow(fields[0]));
  let directory = path.posix.dirname(filePath);
  for (;;) {
    const prefix = directory === '.' ? '' : `${directory}/`;
    const siblings = registered.filter((fields) =>
      prefix
        ? fields[0].startsWith(prefix) &&
          !fields[0].slice(prefix.length).includes('/')
        : !fields[0].includes('/'),
    );
    if (siblings.length) {
      const sameKind = siblings.filter(
        (fields) => fileKind(fields[0], fields[3]) === kind,
      );
      const pool = sameKind.length ? sameKind : siblings;
      const pick = mostCommon(
        pool.map((fields) => `${fields[1]}\t${fields[2]}\t${fields[4]}`),
      );
      const [workPackage, family, operation] = pick.split('\t');
      return [filePath, workPackage, family, sdk, operation, owner];
    }
    if (!prefix) break;
    directory = path.posix.dirname(directory);
  }
  return [filePath, 'VERIFY', '', sdk, '', owner];
}

function readSource(root, filePath) {
  try {
    return readFileSync(path.join(root, filePath), 'utf8');
  } catch {
    return '';
  }
}

export function proposeRows(root, rows, unregistered) {
  const boundaries = JSON.parse(
    readFileSync(path.join(root, 'scripts/package-boundaries.json'), 'utf8'),
  );
  return unregistered.map((filePath) => {
    const sdk = /\.(m?js|vue|ts)$/.test(filePath)
      ? sdkImports(readSource(root, filePath))
      : '';
    return proposeRow(filePath, rows, {
      sdk,
      owner: firstBoundaryOwner(filePath, boundaries),
    });
  });
}

export function insertRows(rows, additions) {
  return [...rows, ...additions].sort((a, b) => compareCodeUnits(a[0], b[0]));
}

export function main(argv = process.argv.slice(2), root = process.cwd()) {
  const registryFile = path.join(root, REGISTRY_PATH);
  const registry = parseRegistry(readFileSync(registryFile, 'utf8'));
  const tracked = trackedPaths(root);
  const { unregistered, orphans } = compareRegistry(registry.rows, tracked);
  const proposals = proposeRows(root, registry.rows, unregistered);

  if (argv.includes('--write')) {
    if (proposals.length) {
      writeFileSync(
        registryFile,
        serializeRegistry({
          ...registry,
          rows: insertRows(registry.rows, proposals),
        }),
      );
    }
    console.log(`files.tsv: inserted ${proposals.length} rows`);
    return 0;
  }

  console.log(
    `files.tsv: ${registry.rows.length} rows, ${tracked.length} tracked paths ` +
      `(base ${BASE_COMMIT.slice(0, 8)} plus HEAD), ${unregistered.length} unregistered, ` +
      `${orphans.length} rows without a tracked path`,
  );
  for (const fields of proposals) console.log(`+\t${fields.join('\t')}`);
  for (const orphan of orphans) console.log(`?\t${orphan}`);
  if (argv.includes('--check') && (unregistered.length || orphans.length)) {
    console.error(
      'files.tsv is out of date: register the paths above (--write proposes rows).',
    );
    return 1;
  }
  return 0;
}

const invokedPath = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : '';
if (import.meta.url === invokedPath) process.exitCode = main();
