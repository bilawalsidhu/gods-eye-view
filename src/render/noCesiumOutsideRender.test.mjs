/**
 * The ratchet: outside `src/render/cesium/`, only the files on
 * `cesiumAllowList.json` may reach Cesium, and every file on it must still
 * do so. Porting a file to the renderer contract removes it from the list;
 * nothing is ever added (checked against the list on `origin/main`).
 *
 * A file reaches Cesium when it:
 * - imports `cesium` or `@cesium/*`, by name or by a path into
 *   `node_modules` (relative or Vite root-relative `/x`, any query ignored);
 * - imports the Cesium adapter (`src/render/cesium/`);
 * - is handed the namespace: a parameter or binding named `Cesium`/`cesium`
 *   however destructured, a property of that name (`deps.cesium`,
 *   `window.Cesium`), or member access on an unbound `Cesium`;
 * - in a `.vue` file, does any of these in a script block, or names Cesium
 *   in `<script src>`.
 *
 * Not caught: a Cesium value (a colour, a constant) exported from a listed
 * module and used elsewhere; each phase 2 port removes those along with its
 * file. Any name `cesium` counts, so a config field of that name would
 * over-report rather than slip through.
 *
 * Runtime code is every `.js`, `.mjs`, `.cjs` and `.vue` file under `src/`,
 * `server/` and `dev/`, except tests and test support. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parsers } from 'prettier/plugins/babel.mjs';
import { parse as parseSfc } from 'vue/compiler-sfc';

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);
const LIST = 'src/render/cesiumAllowList.json';
const allowList = JSON.parse(readFileSync(path.join(root, LIST), 'utf8'));

const SCOPES = ['src', 'server', 'dev'];
/** Not runtime code, though not named `.test`: imported by tests only. */
const TEST_ONLY = new Set([
  'src/layers/recentImagery/testDoubles.mjs',
  'src/layers/weather/shellFixture.mjs',
  'src/overlays/worldOverlayAllocation.worker.mjs',
]);
const isTestSupport = (file) =>
  /\.test\.[cm]?js$/.test(file) ||
  file.startsWith('src/testSupport/') ||
  file.startsWith('src/tooling/') ||
  TEST_ONLY.has(file);
const isAdapter = (file) => file.startsWith('src/render/cesium/');

const git = (...args) =>
  execFileSync('git', args, { cwd: root, encoding: 'utf8' });
const tracked = git(
  'ls-files',
  '-z',
  '--cached',
  '--others',
  '--exclude-standard',
  '--',
  ...SCOPES,
)
  .split('\0')
  .filter(Boolean);
const runtimeFiles = tracked.filter(
  (file) =>
    /\.(?:[cm]?js|vue)$/.test(file) && !isTestSupport(file) && !isAdapter(file),
);

/** Whether an import specifier from `file` reaches Cesium. */
function reachesCesium(file, specifier) {
  const bare = specifier.replace(/[?#].*$/, '');
  if (/^(?:cesium|@cesium\/[^/]+)(?:\/|$)/.test(bare)) return true;
  if (!bare.startsWith('.') && !bare.startsWith('/')) return false;
  // Vite reads `/x` from the project root, not the filesystem's.
  const from = bare.startsWith('/')
    ? root
    : path.join(root, path.dirname(file));
  const target = path
    .relative(root, path.join(from, bare))
    .split(path.sep)
    .join('/');
  return (
    isAdapter(target) ||
    /^node_modules\/(?:cesium|@cesium\/[^/]+)(?:\/|$)/.test(target)
  );
}

const NAMESPACE = new Set(['Cesium', 'cesium']);

/** The import specifiers of a module, and whether it takes the namespace. */
function scan(source) {
  const imports = [];
  const bound = new Set();
  let takesNamespace = false;
  let usesUnbound = false;
  const keyName = (property) =>
    property.computed
      ? property.key?.value
      : (property.key?.name ?? property.key?.value);
  /** Any name a binding pattern introduces, however nested or renamed. */
  const bindName = (node) => {
    if (!node) return;
    switch (node.type) {
      case 'Identifier':
        if (NAMESPACE.has(node.name)) {
          bound.add(node.name);
          takesNamespace = true;
        }
        break;
      case 'AssignmentPattern':
        bindName(node.left);
        break;
      case 'RestElement':
        bindName(node.argument);
        break;
      case 'ArrayPattern':
        node.elements.forEach(bindName);
        break;
      case 'ObjectPattern':
        for (const property of node.properties) {
          if (property.type === 'RestElement') bindName(property.argument);
          else {
            if (NAMESPACE.has(keyName(property))) takesNamespace = true;
            bindName(property.value);
          }
        }
        break;
    }
  };
  function walk(node) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach(walk);
    // Every function form (declarations, arrows, object, class and private
    // methods) carries its parameters as `params`.
    if (Array.isArray(node.params)) node.params.forEach(bindName);
    switch (node.type) {
      case 'ImportDeclaration':
      case 'ExportNamedDeclaration':
      case 'ExportAllDeclaration':
      case 'ImportExpression':
        if (node.source?.type === 'StringLiteral')
          imports.push(node.source.value);
        else if (node.source)
          throw new Error('Computed module imports are not allowed');
        if (node.type === 'ImportDeclaration')
          for (const s of node.specifiers) bound.add(s.local.name);
        break;
      case 'CallExpression':
        if (node.callee?.name === 'require')
          throw new Error('Runtime modules must use ES imports');
        break;
      case 'VariableDeclarator':
        bindName(node.id);
        break;
      case 'CatchClause':
        bindName(node.param);
        break;
      case 'AssignmentExpression':
        if (node.left?.type?.endsWith('Pattern')) bindName(node.left);
        break;
      case 'MemberExpression':
      case 'OptionalMemberExpression':
        if (node.object?.type === 'Identifier' && node.object.name === 'Cesium')
          usesUnbound = true;
        // The namespace as a property: `deps.cesium`, `window.Cesium`,
        // `globalThis['Cesium']`.
        if (
          NAMESPACE.has(
            node.computed ? node.property?.value : node.property?.name,
          )
        )
          takesNamespace = true;
        break;
    }
    for (const [key, value] of Object.entries(node)) {
      if (
        ['loc', 'comments', 'tokens', 'extra', 'leadingComments'].includes(key)
      )
        continue;
      if (value && typeof value === 'object') walk(value);
    }
  }
  walk(parsers.babel.parse(source));
  // Member access on `Cesium` that nothing in the file binds is a global.
  if (usesUnbound && !bound.has('Cesium')) takesNamespace = true;
  return { imports, takesNamespace };
}

/** The scripts of a single-file component, read by Vue's own parser. */
function vueScript(file, source) {
  const { descriptor, errors } = parseSfc(source, { filename: file });
  if (errors.length) throw errors[0];
  const blocks = [descriptor.script, descriptor.scriptSetup].filter(Boolean);
  return {
    code: blocks.map((block) => block.content).join('\n'),
    external: blocks.map((block) => block.src).filter(Boolean),
  };
}

function reachesCesiumFile(file) {
  const source = readFileSync(path.join(root, file), 'utf8');
  let code = source;
  let external = [];
  if (file.endsWith('.vue')) ({ code, external } = vueScript(file, source));
  const { imports, takesNamespace } = scan(code);
  return (
    takesNamespace ||
    [...imports, ...external].some((s) => reachesCesium(file, s))
  );
}

test('only allow-listed files outside the Cesium adapter reach Cesium', () => {
  const allowed = new Set(allowList);
  const offenders = runtimeFiles.filter(
    (file) => !allowed.has(file) && reachesCesiumFile(file),
  );
  assert.deepEqual(
    offenders,
    [],
    'Reach the renderer through its contract (src/render/contract) instead.',
  );
});

test('every allow-listed file still reaches Cesium', () => {
  const present = new Set(runtimeFiles);
  const stale = allowList.filter(
    (file) => !present.has(file) || !reachesCesiumFile(file),
  );
  assert.deepEqual(stale, [], `Remove these from ${LIST}.`);
});

test('the allow-list only shrinks', (t) => {
  // Any git failure fails the check: only the list's confirmed absence on
  // origin/main (before it lands) skips it.
  const base = git('merge-base', 'HEAD', 'origin/main').trim();
  const atBase = git('ls-tree', '--name-only', base, '--', LIST).trim();
  if (!atBase) {
    t.skip(`${LIST} is not on origin/main yet`);
    return;
  }
  const before = new Set(JSON.parse(git('show', `${base}:${LIST}`)));
  const added = allowList.filter((file) => !before.has(file));
  assert.deepEqual(
    added,
    [],
    `Files added to ${LIST} since ${base} (a moved file needs its old entry removed).`,
  );
});

test('the allow-list is sorted and has no duplicates', () => {
  assert.deepEqual(allowList, [...new Set(allowList)].sort());
});

test('no runtime file is in a language the ratchet cannot read', () => {
  const unread = tracked.filter(
    (file) =>
      /\.(?:[cm]?tsx?|jsx)$/.test(file) &&
      !/\.d\.[cm]?ts$/.test(file) &&
      !isTestSupport(file),
  );
  assert.deepEqual(unread, [], 'Teach the ratchet to read these first.');
});

test('the renderer contract, stub and conformance suite stay Cesium-free', () => {
  const engineFree = tracked.filter(
    (file) =>
      /^src\/render\/(?:contract|stub|conformance)\//.test(file) &&
      /\.[cm]?js$/.test(file) &&
      !/\.test\.[cm]?js$/.test(file),
  );
  assert.ok(engineFree.length > 0);
  assert.deepEqual(engineFree.filter(reachesCesiumFile), []);
});
