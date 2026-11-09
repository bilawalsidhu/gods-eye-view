import { parsers } from 'prettier/plugins/babel.mjs';
import { vueScripts } from './vue-scripts.mjs';

const browserGlobals = new Set([
  'window',
  'document',
  'navigator',
  'HTMLElement',
  'HTMLCanvasElement',
  'Image',
  'Audio',
  'localStorage',
  'sessionStorage',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'getComputedStyle',
]);

/**
 * Inspect literal module dependencies and browser-platform references without
 * executing code. With `dynamic`, also list the static (not import())
 * specifiers apart.
 */
export function analyzeModule(source, { dynamic = false, filename = '' } = {}) {
  const imports = [];
  const staticImports = [];
  const browser = new Set();
  function walk(node, parent, field) {
    if (!node || typeof node !== 'object') return;
    if (
      [
        'ImportDeclaration',
        'ExportNamedDeclaration',
        'ExportAllDeclaration',
        'ImportExpression',
      ].includes(node.type) &&
      node.source
    ) {
      if (node.source.type !== 'StringLiteral')
        throw new Error(
          'Computed module imports are not allowed in runtime code',
        );
      imports.push(node.source.value);
      if (node.type !== 'ImportExpression')
        staticImports.push(node.source.value);
    }
    if (node.type === 'CallExpression' && node.callee?.name === 'require')
      throw new Error('Runtime modules must use ES imports');
    if (node.type === 'Identifier' && browserGlobals.has(node.name)) {
      const property =
        (parent?.type === 'MemberExpression' ||
          parent?.type === 'OptionalMemberExpression') &&
        field === 'property' &&
        !parent.computed;
      const key =
        ['ObjectProperty', 'ObjectMethod', 'ClassMethod'].includes(
          parent?.type,
        ) &&
        field === 'key' &&
        !parent.computed;
      const declaration =
        field === 'id' ||
        field === 'params' ||
        parent?.type?.startsWith('Import');
      if (!property && !key && !declaration) browser.add(node.name);
    }
    if (
      ['MemberExpression', 'OptionalMemberExpression'].includes(node.type) &&
      ['globalThis', 'self'].includes(node.object?.name)
    ) {
      const name = node.computed ? node.property?.value : node.property?.name;
      if (browserGlobals.has(name)) browser.add(name);
    }
    for (const [key, value] of Object.entries(node)) {
      if (['loc', 'comments', 'tokens', 'extra'].includes(key)) continue;
      if (Array.isArray(value))
        value.forEach((child) => walk(child, node, key));
      else if (value && typeof value === 'object') walk(value, node, key);
    }
  }
  for (const script of filename.endsWith('.vue')
    ? vueScripts(source, filename)
    : [source])
    walk(parsers.babel.parse(script));
  return {
    imports,
    browser: [...browser],
    ...(dynamic && { staticImports }),
  };
}

/** Return static imports, literal dynamic imports and re-exports. */
export function moduleImports(source) {
  return analyzeModule(source).imports;
}
