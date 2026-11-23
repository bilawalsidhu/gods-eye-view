import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parsers } from 'prettier/plugins/babel.mjs';
import { parse as parseSfc } from 'vue/compiler-sfc';

// Inspector and Finder ownership. Later migrations add their files here.
// This source ratchet checks direct bindings and writes, not aliased objects.
const modules = {
  'app/controls.js': [],
  'app/data.js': [],
  'app/layerPresentation.js': [],
  'ui/applicationShell.js': [],
  'ui/composition.js': [],
  'ui/contextRadius.js': ['contextRadiusKm'],
  'ui/contextSearch.js': ['contextSearchOpen', 'contextSearchText'],
  'ui/entityContextBridge.js': [],
  'ui/layerBindings.js': [],
  'ui/layerCounts.js': [],
  'ui/layerFinderFilter.js': [],
  'ui/layerPanel.js': [],
  'ui/layerPanel/LayerRows.vue': [],
  'ui/layerRowState.js': [],
  'ui/panelChrome.js': [],
  'ui/stores/entityCard.js': [],
  'ui/stores/layerCounts.js': [],
  'ui/stores/layerFinder.js': [],
  'ui/viewWeather.js': [],
  'ui/views/ContextView.vue': [],
  'ui/views/LayerPanelsView.vue': [],
  'ui/views/panels/LayerFinder.vue': [],
  'ui/views/panels/ViewContext.vue': [],
};
const reactiveFactories = new Set([
  'ref',
  'reactive',
  'shallowRef',
  'shallowReactive',
]);
const collections = new Set(['Map', 'Set', 'WeakMap', 'WeakSet']);
const mutatingMethods = new Set([
  'set',
  'add',
  'delete',
  'clear',
  'copyWithin',
  'fill',
  'pop',
  'push',
  'reverse',
  'shift',
  'sort',
  'splice',
  'unshift',
]);

function bindingOf(node) {
  while (node?.type === 'MemberExpression') node = node.object;
  return node?.type === 'Identifier' ? node.name : null;
}

function recordWrites(node, names) {
  if (!node || typeof node !== 'object') return;
  let write;
  if (node.type === 'AssignmentExpression') write = node.left;
  if (node.type === 'UpdateExpression' || node.operator === 'delete')
    write = node.argument;
  if (
    node.type === 'CallExpression' &&
    node.callee.type === 'MemberExpression'
  ) {
    const method = node.callee.computed
      ? node.callee.property.value
      : node.callee.property.name;
    if (mutatingMethods.has(method)) write = node.callee.object;
  }
  const name = bindingOf(write);
  if (name) names.add(name);
  for (const [key, child] of Object.entries(node)) {
    if (
      [
        'loc',
        'comments',
        'leadingComments',
        'trailingComments',
        'tokens',
      ].includes(key)
    )
      continue;
    if (Array.isArray(child))
      child.forEach((entry) => recordWrites(entry, names));
    else recordWrites(child, names);
  }
}

function moduleState(source) {
  const { program } = parsers.babel.parse(source, { filepath: 'owner.js' });
  const writes = new Set();
  recordWrites(program, writes);
  const factories = new Set(reactiveFactories);
  for (const node of program.body) {
    if (node.type !== 'ImportDeclaration' || node.source.value !== 'vue')
      continue;
    for (const specifier of node.specifiers)
      if (reactiveFactories.has(specifier.imported?.name))
        factories.add(specifier.local.name);
  }
  const found = [];
  for (const node of program.body) {
    const declaration = node.declaration ?? node;
    if (declaration.type !== 'VariableDeclaration') continue;
    for (const { id, init } of declaration.declarations) {
      if (id.type !== 'Identifier') continue;
      const collection =
        init?.type === 'NewExpression' && collections.has(init.callee.name);
      const container =
        collection ||
        ['ObjectExpression', 'ArrayExpression'].includes(init?.type);
      // An exported collection can be updated by callers in other modules.
      if (
        declaration.kind === 'let' ||
        (init?.type === 'CallExpression' && factories.has(init.callee.name)) ||
        (container && writes.has(id.name)) ||
        (collection && node.type === 'ExportNamedDeclaration')
      )
        found.push(id.name);
    }
  }
  return found.sort();
}

test('shared UI modules only retain the documented module-level state', () => {
  const actual = {};
  for (const name of Object.keys(modules)) {
    const file = readFileSync(new URL(name, import.meta.url), 'utf8');
    const source = name.endsWith('.vue')
      ? parseSfc(file, { filename: name }).descriptor.script?.content
      : file;
    actual[name] = source ? moduleState(source) : [];
  }
  assert.deepEqual(actual, modules);
});
