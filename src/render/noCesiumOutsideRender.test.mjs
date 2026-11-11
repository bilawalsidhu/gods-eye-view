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
 * Two files name the adapter by design and are not on the list:
 * `ADAPTER_ENTRIES` below allows each exactly the adapter modules it needs.
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
  'src/input/testDoubles.mjs',
  'src/layers/recentImagery/testDoubles.mjs',
  'src/voice/voiceWorkflowHarness.mjs',
  'src/layers/weather/shellFixture.mjs',
  'src/overlays/worldOverlayAllocation.worker.mjs',
]);
const isTestSupport = (file) =>
  /\.test\.[cm]?js$/.test(file) ||
  file.startsWith('src/testSupport/') ||
  file.startsWith('src/tooling/') ||
  TEST_ONLY.has(file);
const isAdapter = (file) => file.startsWith('src/render/cesium/');

/**
 * The two places outside the adapter that name it by design, each limited
 * to the adapter modules listed here; any other way they reach Cesium
 * counts as above. Neither is a file still to port, so neither is on the
 * allow-list; this list is never grown.
 * - The application scene is the composition root: it picks the Cesium
 *   renderer as the default, loading the adapter's application module only
 *   when it is given no renderer (`DYNAMIC_ENTRIES`).
 * - The conformance page runs the suite on the Cesium adapter's harness
 *   and draws the reference scenes on its scene renderer.
 */
const ADAPTER_ENTRIES = {
  'src/app/scene.js': ['src/render/cesium/application.js'],
  'dev/conformance/main.js': [
    'src/render/cesium/harness.js',
    'src/render/cesium/sceneRenderer.js',
  ],
};

/**
 * The entries that load their adapter modules on demand: `import()`, its
 * result awaited and destructured by name, never kept whole or forwarded.
 */
const DYNAMIC_ENTRIES = new Set(['src/app/scene.js']);

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

/**
 * The repository path a relative or root-relative specifier names. Vite
 * reads `/x` from the project root, not the filesystem's.
 */
function targetOf(file, specifier) {
  const bare = specifier.replace(/[?#].*$/, '');
  if (!bare.startsWith('.') && !bare.startsWith('/')) return null;
  const from = bare.startsWith('/')
    ? root
    : path.join(root, path.dirname(file));
  return path.relative(root, path.join(from, bare)).split(path.sep).join('/');
}

/** Whether an import specifier from `file` reaches Cesium. */
function reachesCesium(file, specifier) {
  const allowed = ADAPTER_ENTRIES[file];
  if (allowed?.includes(targetOf(file, specifier))) return false;
  const bare = specifier.replace(/[?#].*$/, '');
  if (/^(?:cesium|@cesium\/[^/]+)(?:\/|$)/.test(bare)) return true;
  const target = targetOf(file, specifier);
  if (target === null) return false;
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

test('the scan still recognises each way of reaching Cesium', () => {
  // With the list empty, the check above passes vacuously unless the scan
  // still sees Cesium; these are the forms the header lists.
  const reaches = (code, file = 'src/x/y.js') => {
    const { imports, takesNamespace } = scan(code);
    return takesNamespace || imports.some((s) => reachesCesium(file, s));
  };
  for (const code of [
    "import * as C from 'cesium';",
    "import { Viewer } from '@cesium/engine';",
    "import x from '../../node_modules/cesium/Source/Cesium.js';",
    "import x from '/node_modules/cesium/index.js?v=1';",
    "import { draw } from '../render/cesium/draw.js';",
    "export * from '../render/cesium/draw.js';",
    "const m = import('cesium');",
    'function f(Cesium) {}',
    'const { cesium } = deps;',
    'const c = window.Cesium;',
    'Cesium.Color.RED;',
  ])
    assert.ok(reaches(code), code);
  for (const code of [
    "import { drawOf } from '../render/rendererOf.js';",
    'const cesiumLike = 1; Cesium2.x;',
  ])
    assert.ok(!reaches(code), code);
  assert.ok(
    vueScript(
      'a.vue',
      '<script src="../render/cesium/draw.js"></script>',
    ).external.some((s) => reachesCesium('src/ui/a.vue', s)),
  );
});

test('every allow-listed file still reaches Cesium', () => {
  const present = new Set(runtimeFiles);
  const stale = allowList.filter(
    (file) => !present.has(file) || !reachesCesiumFile(file),
  );
  assert.deepEqual(stale, [], `Remove these from ${LIST}.`);
});

test('the files that name the adapter by design import exactly what they are allowed', () => {
  const present = new Set(runtimeFiles);
  for (const [file, modules] of Object.entries(ADAPTER_ENTRIES)) {
    assert.ok(present.has(file), `${file} is gone: drop it from the list`);
    assert.ok(!allowList.includes(file), `${file} is on ${LIST} too`);
    const { imports } = scan(readFileSync(path.join(root, file), 'utf8'));
    const named = new Set(imports.map((s) => targetOf(file, s)));
    for (const module of modules)
      assert.ok(named.has(module), `${file} no longer imports ${module}`);
  }
});

/** Every node under `node`, with its parent. */
function* nodesOf(node, parent = null) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const child of node) yield* nodesOf(child, parent);
    return;
  }
  if (typeof node.type === 'string') yield [node, parent];
  for (const [key, value] of Object.entries(node))
    if (!['loc', 'comments', 'tokens', 'extra'].includes(key))
      yield* nodesOf(value, typeof node.type === 'string' ? node : parent);
}

test('the files that name the adapter by design take named exports, never Cesium itself', () => {
  for (const [file, modules] of Object.entries(ADAPTER_ENTRIES)) {
    const parsed = parsers.babel.parse(
      readFileSync(path.join(root, file), 'utf8'),
    );
    // A static import by name only: no namespace or default binding, no
    // dynamic import (but in DYNAMIC_ENTRIES, one destructured by name), and
    // no forwarding of the module.
    const parents = new Map(nodesOf(parsed.program));
    for (const [node, parent] of parents) {
      const source = node.source?.value;
      if (typeof source !== 'string') continue;
      if (!modules.includes(targetOf(file, source))) continue;
      if (node.type === 'ImportExpression' && DYNAMIC_ENTRIES.has(file)) {
        const declarator = parents.get(parent);
        assert.ok(
          parent?.type === 'AwaitExpression' &&
            declarator?.type === 'VariableDeclarator' &&
            declarator.id.type === 'ObjectPattern' &&
            declarator.id.properties.length > 0 &&
            declarator.id.properties.every(
              (p) =>
                p.type === 'ObjectProperty' &&
                !p.computed &&
                (p.key.name ?? p.key.value) !== 'default',
            ),
          `${file} must destructure import(${source}) by name`,
        );
        continue;
      }
      assert.equal(
        node.type,
        'ImportDeclaration',
        `${file} must import ${source} statically and not forward it`,
      );
      assert.deepEqual(
        node.specifiers
          .filter((s) => s.type !== 'ImportSpecifier')
          .map((s) => s.local.name),
        [],
        `${file} must import ${source} by name`,
      );
    }
    // The allowed modules hand out no Cesium namespace: no export from the
    // package, and no exported value that is the namespace itself (members
    // of it, such as `Cesium.Math`, are the adapter's own business).
    for (const module of modules) {
      const program = parsers.babel.parse(
        readFileSync(path.join(root, module), 'utf8'),
      ).program;
      const fromCesium = ({ source }) => {
        if (typeof source?.value !== 'string') return false;
        const bare = source.value.replace(/[?#].*$/, '');
        const target = targetOf(module, bare) ?? '';
        return /^(?:(?:node_modules\/)?(?:cesium|@cesium\/[^/]+))(?:\/|$)/.test(
          target || bare,
        );
      };
      const namespaces = new Set(
        program.body
          .filter((n) => n.type === 'ImportDeclaration' && fromCesium(n))
          .flatMap((n) => n.specifiers.map((s) => s.local.name)),
      );
      for (const node of program.body) {
        if (!node.type.startsWith('Export')) continue;
        assert.ok(!fromCesium(node), `${module} must not re-export Cesium`);
        for (const [inner, parent] of nodesOf(node)) {
          if (inner.type !== 'Identifier' || !namespaces.has(inner.name))
            continue;
          // Handing the namespace to the adapter's own functions is fine;
          // giving it out as a value is not.
          const handedOut =
            [
              'ExportSpecifier',
              'ExportDefaultDeclaration',
              'ReturnStatement',
              'SpreadElement',
              'ArrayExpression',
            ].includes(parent?.type) ||
            (parent?.type === 'VariableDeclarator' && parent.init === inner) ||
            (parent?.type === 'ObjectProperty' && parent.value === inner) ||
            (parent?.type === 'ArrowFunctionExpression' &&
              parent.body === inner) ||
            (parent?.type === 'AssignmentExpression' && parent.right === inner);
          assert.ok(
            !handedOut,
            `${module} must not export ${inner.name} itself`,
          );
        }
      }
    }
  }
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

test('the renderer contract, stub, input router and conformance suite stay Cesium-free', () => {
  const engineFree = tracked.filter(
    (file) =>
      /^src\/render\/(?:contract|stub|input|conformance)\//.test(file) &&
      /\.[cm]?js$/.test(file) &&
      !/\.test\.[cm]?js$/.test(file),
  );
  assert.ok(engineFree.length > 0);
  assert.deepEqual(engineFree.filter(reachesCesiumFile), []);
});
