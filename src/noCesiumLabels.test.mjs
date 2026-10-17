import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parsers } from 'prettier/plugins/babel.mjs';

// Existing entity graphics only. Remove entries as these callers migrate.
const legacyFiles = new Set([
  'src/scenes/dataPacks/presentation.js',
  'src/layers/directions/index.js',
]);
const root = fileURLToPath(new URL('../', import.meta.url));
const propertyName = (node) => node?.name ?? node?.value;
const memberName = (node) =>
  node?.type === 'MemberExpression' ? propertyName(node.property) : null;
const geometryKeys = new Set([
  'position',
  'point',
  'billboard',
  'polygon',
  'polyline',
  'rectangle',
  'ellipse',
  'ellipsoid',
  'model',
  'wall',
  'corridor',
  'box',
  'cylinder',
]);
const labelGraphicsKeys = new Set([
  'font',
  'fillColor',
  'outlineColor',
  'outlineWidth',
  'style',
  'pixelOffset',
  'heightReference',
  'showBackground',
  'backgroundColor',
  'scaleByDistance',
]);

/** Parse code, ignoring comments, strings, schemas and ordinary UI labels. */
function cesiumLabels(source) {
  const hits = [];
  const namespaces = new Set(['Cesium']);
  const constructors = new Set(['LabelCollection']);
  const ast = parsers.babel.parse(source);
  for (const node of ast.program.body) {
    if (node.type !== 'ImportDeclaration' || node.source.value !== 'cesium')
      continue;
    for (const spec of node.specifiers) {
      if (spec.type === 'ImportNamespaceSpecifier')
        namespaces.add(spec.local.name);
      else if (
        ['Label', 'LabelCollection', 'LabelStyle', 'LabelGraphics'].includes(
          propertyName(spec.imported),
        )
      )
        constructors.add(spec.local.name);
    }
  }
  const cesiumMember = (node, names) =>
    namespaces.has(node?.object?.name) && names.includes(memberName(node));
  function walk(node, parent, ancestors = []) {
    if (!node || typeof node !== 'object') return;
    let reason;
    if (node.type === 'Identifier' && constructors.has(node.name))
      reason = 'Cesium label API';
    if (cesiumMember(node, ['LabelCollection', 'LabelStyle']))
      reason = 'Cesium label API';
    if (
      node.type === 'NewExpression' &&
      cesiumMember(node.callee, ['Label', 'LabelGraphics'])
    )
      reason = 'Cesium text label';
    if (
      node.type === 'ObjectProperty' &&
      propertyName(node.key) === 'label' &&
      ['ObjectExpression', 'NewExpression'].includes(node.value.type)
    ) {
      const siblings = parent?.properties || [];
      const fields = node.value.properties || [];
      const graphicsOptions =
        siblings.some((prop) => geometryKeys.has(propertyName(prop.key))) ||
        fields.some((prop) => labelGraphicsKeys.has(propertyName(prop.key)));
      const entityOptions = ancestors.some(
        (ancestor) =>
          (ancestor.type === 'NewExpression' &&
            cesiumMember(ancestor.callee, ['Entity'])) ||
          (ancestor.type === 'CallExpression' &&
            memberName(ancestor.callee) === 'add' &&
            memberName(ancestor.callee.object) === 'entities'),
      );
      if (graphicsOptions || entityOptions) reason = 'entity label graphics';
    }
    if (reason) hits.push(`${node.loc.start.line}: ${reason}`);
    for (const [key, value] of Object.entries(node)) {
      if (['loc', 'comments', 'tokens', 'extra'].includes(key)) continue;
      if (Array.isArray(value))
        for (const child of value) walk(child, node, [...ancestors, node]);
      else if (value && typeof value === 'object')
        walk(value, node, [...ancestors, node]);
    }
  }
  walk(ast);
  return [...new Set(hits)];
}

test('runtime world text uses the world-overlay host, never new Cesium labels', () => {
  const violations = [];
  const legacySeen = new Set();
  function scan(directory) {
    for (const entry of readdirSync(root + directory, {
      withFileTypes: true,
    })) {
      const file = `${directory}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!['__tests__', 'testSupport'].includes(entry.name)) scan(file);
      } else if (
        entry.name.endsWith('.js') &&
        !/\.(?:test|spec)\.js$/.test(entry.name)
      ) {
        const hits = cesiumLabels(readFileSync(root + file, 'utf8'));
        if (!hits.length) continue;
        if (legacyFiles.has(file)) legacySeen.add(file);
        else violations.push(...hits.map((hit) => `${file}:${hit}`));
      }
    }
  }
  scan('src');
  assert.deepEqual(
    violations,
    [],
    `Cesium text labels are forbidden; use the world-overlay host.\n${violations.join('\n')}`,
  );
  assert.deepEqual(
    legacySeen,
    legacyFiles,
    'Remove stale or false-positive Cesium-label exceptions',
  );
});

test('the guard catches label APIs and entity graphics, including aliases and multiline options', () => {
  for (const source of [
    'new Cesium.LabelCollection();',
    'new Cesium.Label({ text: "name" });',
    'const style = Cesium.LabelStyle.FILL_AND_OUTLINE;',
    'import { LabelCollection as Labels } from "cesium"; new Labels();',
    'import * as C from "cesium"; new C.Label({});',
    'viewer.entities.add({ label: {} });',
    'new Cesium.Entity({ "label": {} });',
    'const options = { position: xyz, label:\n { text: title } };',
    'handle.add({ point: {}, label: new Cesium.LabelGraphics() });',
    'const options = { label: { font: "12px sans-serif", text: title } };',
  ])
    assert.ok(cesiumLabels(source).length > 0, source);
});

test('schemas, UI label lookups, comments and strings are not Cesium labels', () => {
  for (const source of [
    '// LabelCollection\nconst help = "new Cesium.Label";',
    'const schema = { properties: { label: { type: "string" } } };',
    'const control = { label: { none: "None", speed: "Speed" }[value] };',
    'const place = { label: { lat: 1, lon: 2 } };',
    readFileSync(root + 'src/voice/actionSchemas.js', 'utf8'),
    readFileSync(root + 'src/layers/wind/index.js', 'utf8'),
  ])
    assert.deepEqual(cesiumLabels(source), []);
});
