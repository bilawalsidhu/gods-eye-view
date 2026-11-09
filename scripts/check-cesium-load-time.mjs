// The production build replaces every `cesium` import with the global that
// /cesium/Cesium.js defines, and that script loads only when a Cesium globe
// first starts (src/app/loadCesium.js). A module that reads a Cesium binding
// while it loads would therefore throw on a page that starts on Navara. This
// check lists such reads: a reference to a binding imported from `cesium`, or
// to the `Cesium` global, that runs when its module is evaluated (top level,
// class heritage, static members, immediately invoked functions) rather than
// inside a function that runs later.
//
//   node scripts/check-cesium-load-time.mjs [--json]

import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { parse } from '@babel/parser';
import { vueScripts } from './vue-scripts.mjs';

const root = new URL('..', import.meta.url);

/** Files under src/ that the app ships (tests and test support excluded). */
export function sourceFiles() {
  return execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', 'src'], {
    cwd: root,
    encoding: 'utf8',
  })
    .split('\n')
    .filter(
      (path) =>
        /\.(?:js|mjs|vue)$/.test(path) &&
        !/\.test\.m?js$/.test(path) &&
        !path.startsWith('src/testSupport/') &&
        !path.includes('/testing/') &&
        existsSync(new URL(path, root)),
    );
}

const FUNCTION_TYPES = new Set([
  'FunctionDeclaration',
  'FunctionExpression',
  'ArrowFunctionExpression',
  'ObjectMethod',
  'ClassMethod',
  'ClassPrivateMethod',
]);

/** Names a module binds to `cesium` imports. */
function cesiumBindings(program) {
  const names = new Set();
  for (const node of program.body) {
    if (node.type !== 'ImportDeclaration' || node.source.value !== 'cesium')
      continue;
    for (const specifier of node.specifiers) names.add(specifier.local.name);
  }
  return names;
}

function isReference(node, parent, key) {
  if (node.type !== 'Identifier') return false;
  if (!parent) return true;
  if (
    (parent.type === 'MemberExpression' ||
      parent.type === 'OptionalMemberExpression') &&
    key === 'property' &&
    !parent.computed
  )
    return false;
  if (
    (parent.type === 'ObjectProperty' ||
      parent.type === 'ClassProperty' ||
      parent.type === 'ObjectMethod' ||
      parent.type === 'ClassMethod') &&
    key === 'key' &&
    !parent.computed
  )
    return false;
  if (
    parent.type === 'ImportSpecifier' ||
    parent.type === 'ImportNamespaceSpecifier' ||
    parent.type === 'ImportDefaultSpecifier' ||
    (parent.type === 'ExportSpecifier' && key !== 'local')
  )
    return false;
  if (parent.type === 'LabeledStatement' || parent.type === 'BreakStatement')
    return false;
  return true;
}

/**
 * Load-time references in one module. `deferred` is true below a function
 * body that runs later; an immediately invoked function and a class's static
 * members and heritage run at load and stay not deferred.
 */
export function loadTimeReferences(code, path = '<module>') {
  if (path.endsWith('.vue'))
    return vueScripts(code, path).flatMap((script) =>
      loadTimeReferences(script).map((reference) => ({ ...reference, path })),
    );
  const program = parse(code, {
    sourceType: 'module',
    plugins: ['classProperties', 'classStaticBlock', 'importAttributes'],
  }).program;
  const names = cesiumBindings(program);
  const found = [];
  // A re-export from `cesium` becomes a read of the global's property when
  // the module loads.
  for (const node of program.body)
    if (
      (node.type === 'ExportNamedDeclaration' ||
        node.type === 'ExportAllDeclaration') &&
      node.source?.value === 'cesium'
    )
      found.push({
        path,
        line: node.loc.start.line,
        name: 'export from cesium',
      });
  const hasGlobal = /\bCesium\b/.test(code);
  if (!names.size && !hasGlobal) return found;
  // A `Cesium` global reference counts when the module does not bind it.
  const watched = (name) =>
    names.has(name) || (name === 'Cesium' && !names.has('Cesium'));
  const visit = (node, parent, key, deferred) => {
    if (!node || typeof node.type !== 'string') return;
    if (node.type === 'ImportDeclaration') return;
    if (!deferred && isReference(node, parent, key) && watched(node.name))
      found.push({ path, line: node.loc.start.line, name: node.name });
    let childDeferred = deferred;
    if (FUNCTION_TYPES.has(node.type)) {
      const invoked =
        parent &&
        (parent.type === 'CallExpression' || parent.type === 'NewExpression') &&
        key === 'callee';
      childDeferred = deferred || !invoked;
    }
    if (
      (node.type === 'ClassProperty' || node.type === 'ClassPrivateProperty') &&
      !node.static
    )
      childDeferred = true;
    for (const [childKey, value] of Object.entries(node)) {
      if (
        childKey === 'loc' ||
        childKey === 'leadingComments' ||
        childKey === 'trailingComments' ||
        childKey === 'innerComments'
      )
        continue;
      // Computed keys and parameter defaults of a deferred function: its key
      // is evaluated with the enclosing scope, its body later.
      const keyDeferred =
        FUNCTION_TYPES.has(node.type) && childKey === 'key'
          ? deferred
          : childDeferred;
      if (Array.isArray(value))
        for (const child of value) visit(child, node, childKey, keyDeferred);
      else if (value && typeof value === 'object')
        visit(value, node, childKey, keyDeferred);
    }
  };
  visit(program, null, null, false);
  return found;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const found = [];
  for (const path of sourceFiles()) {
    const code = readFileSync(new URL(path, root), 'utf8');
    try {
      found.push(...loadTimeReferences(code, path));
    } catch (error) {
      console.error(`${path}: ${error.message}`);
      process.exitCode = 1;
    }
  }
  if (process.argv.includes('--json'))
    console.log(JSON.stringify(found, null, 2));
  else
    for (const { path, line, name } of found)
      console.log(`${path}:${line} reads ${name} while the module loads`);
  if (found.length) {
    console.error(
      `${found.length} load-time Cesium read(s); a page that starts on Navara has no Cesium global yet.`,
    );
    process.exitCode = 1;
  } else console.log('No module reads Cesium while it loads.');
}
