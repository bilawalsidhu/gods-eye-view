/**
 * `Sphere.center` is `Ecef` (contract/common.d.ts). The Cesium camera also
 * takes lon, lat and height there, so a caller that gives them works on
 * Cesium and leaves a camera that reads the contract's type with no point
 * to fly to. The shared test camera (src/testSupport/fakeCameraPort.mjs)
 * refuses such a centre in every test that flies; this reads the source,
 * for callers no test reaches.
 *
 * A centre is geodetic when the sphere given to `flyToBounds` has a
 * `center` that is an object literal with a `lon` or `lat` key, directly
 * or through the plain local its name binds where it is written; the sphere
 * itself may be such a local too. Keys are read in order, as JavaScript
 * keeps them: the last one written wins, and a spread of a literal the scan
 * can read stands for that literal's keys. The nearest binding wins, so a
 * parameter shadows an outer local, and a `let` or `var` written to again
 * holds what was last written, which is not followed. A spread, call,
 * parameter or anything else the scan cannot read is taken as ECEF (so
 * `{ ...fromDegrees(lon, lat) }` is), and comments are not code.
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parsers } from 'prettier/plugins/babel.mjs';
import { parse as parseSfc } from 'vue/compiler-sfc';

const SRC = fileURLToPath(new URL('../../', import.meta.url));
const SKIPPED_KEYS = new Set(['loc', 'comments', 'tokens', 'extra']);

/** Every runtime source file under `dir`: tests and test support left out. */
function sources(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory())
      return entry.name === 'testSupport' ? [] : sources(path);
    return /\.([cm]?js|vue)$/.test(entry.name) && !/\.test\./.test(entry.name)
      ? [path]
      : [];
  });
}

/** Every node of `tree` with the node that holds it. */
function* nodesOf(node, parent = null) {
  if (Array.isArray(node)) {
    for (const child of node) yield* nodesOf(child, parent);
    return;
  }
  if (!node || typeof node !== 'object') return;
  const holder = typeof node.type === 'string' ? node : parent;
  if (holder === node) yield [node, parent];
  for (const [key, value] of Object.entries(node))
    if (!SKIPPED_KEYS.has(key)) yield* nodesOf(value, holder);
}

/** A property's name: an identifier, a string or number, or `['lon']`. */
function keyOf(property) {
  const key = property.key;
  if (!property.computed) return key?.name ?? key?.value ?? null;
  return key?.type === 'StringLiteral' ? key.value : null;
}

/** The names a binding pattern declares. */
function namesOf(pattern) {
  switch (pattern?.type) {
    case 'Identifier':
      return [pattern.name];
    case 'ObjectPattern':
      return pattern.properties.flatMap((p) =>
        namesOf(p.type === 'RestElement' ? p.argument : p.value),
      );
    case 'ArrayPattern':
      return pattern.elements.flatMap(namesOf);
    case 'AssignmentPattern':
      return namesOf(pattern.left);
    case 'RestElement':
      return namesOf(pattern.argument);
    default:
      return [];
  }
}

const FUNCTIONS = new Set([
  'FunctionDeclaration',
  'FunctionExpression',
  'ArrowFunctionExpression',
  'ObjectMethod',
  'ClassMethod',
  'ClassPrivateMethod',
]);
/** What declares a name but holds no literal we can read. */
const OPAQUE = Symbol('opaque');

/** What `statements` declare `name` as: a declarator, OPAQUE, or null. */
function declaredIn(statements, name) {
  for (const statement of statements) {
    const node =
      statement.type === 'ExportNamedDeclaration'
        ? statement.declaration
        : statement;
    if (node?.type === 'VariableDeclaration') {
      for (const declarator of node.declarations)
        if (namesOf(declarator.id).includes(name))
          return declarator.id.type === 'Identifier' ? declarator : OPAQUE;
    } else if (
      (node?.type === 'FunctionDeclaration' ||
        node?.type === 'ClassDeclaration') &&
      node.id?.name === name
    )
      return OPAQUE;
    else if (
      node?.type === 'ImportDeclaration' &&
      node.specifiers.some((s) => s.local.name === name)
    )
      return OPAQUE;
  }
  return null;
}

/**
 * The `var` declarations anywhere in `node`, short of nested functions:
 * JavaScript binds them to the function (or module) around them.
 */
function* hoistedVars(node) {
  if (Array.isArray(node)) {
    for (const child of node) yield* hoistedVars(child);
    return;
  }
  if (!node || typeof node !== 'object' || FUNCTIONS.has(node.type)) return;
  if (node.type === 'VariableDeclaration' && node.kind === 'var') yield node;
  for (const [key, value] of Object.entries(node))
    if (!SKIPPED_KEYS.has(key) && value && typeof value === 'object')
      yield* hoistedVars(value);
}

/**
 * The nearest binding of `name` in the scopes around `at`: its declarator
 * when it is a plain `const`/`let`/`var`, OPAQUE when something else binds
 * it (a parameter, a destructuring, a function, an import), or null when
 * nothing in the file does.
 */
function bindingOf(name, at, parents) {
  for (let scope = parents.get(at); scope; scope = parents.get(scope)) {
    let found = null;
    if (['Program', 'BlockStatement', 'StaticBlock'].includes(scope.type))
      found = declaredIn(scope.body, name);
    else if (scope.type === 'SwitchStatement')
      found = declaredIn(
        scope.cases.flatMap((c) => c.consequent),
        name,
      );
    else if (FUNCTIONS.has(scope.type)) {
      if (
        scope.params.some((param) => namesOf(param).includes(name)) ||
        (scope.type === 'FunctionExpression' && scope.id?.name === name)
      )
        found = OPAQUE;
    } else if (
      ['ForStatement', 'ForInStatement', 'ForOfStatement'].includes(scope.type)
    ) {
      const head = scope.init ?? scope.left;
      if (head?.type === 'VariableDeclaration')
        found = declaredIn([head], name);
    } else if (scope.type === 'CatchClause') {
      if (namesOf(scope.param).includes(name)) found = OPAQUE;
    }
    // A `var` in a block below is the function's or the module's.
    if (!found && (scope.type === 'Program' || FUNCTIONS.has(scope.type)))
      found = declaredIn([...hoistedVars(scope.body)], name);
    if (found) return found;
  }
  return null;
}

/**
 * The declarators a file writes to again (`x = …`, `x++`), each write
 * resolved to the binding it reaches where it is written.
 */
function writtenBindings(parents) {
  const written = new Set();
  for (const node of parents.keys()) {
    const target =
      node.type === 'AssignmentExpression'
        ? node.left
        : node.type === 'UpdateExpression'
          ? node.argument
          : null;
    for (const name of namesOf(target)) {
      const binding = bindingOf(name, node, parents);
      if (binding && binding !== OPAQUE) written.add(binding);
    }
  }
  return written;
}

/**
 * The object literals `node` may stand for, read where it is written
 * (`at`): itself; both sides of `a ? b : c`, `a || b` and `a ?? b`; or the
 * initial value of the plain local its name binds there. A `let` or `var`
 * the file writes to again holds what was last written, which is not
 * followed. Nothing that is not an object literal is returned.
 */
function literalsOf(node, at, ctx, seen = new Set()) {
  switch (node?.type) {
    case 'ObjectExpression':
      return [node];
    case 'ConditionalExpression':
      return [
        ...literalsOf(node.consequent, at, ctx, seen),
        ...literalsOf(node.alternate, at, ctx, seen),
      ];
    case 'LogicalExpression':
      return [
        ...literalsOf(node.left, at, ctx, seen),
        ...literalsOf(node.right, at, ctx, seen),
      ];
    case 'Identifier': {
      const declarator = bindingOf(node.name, at, ctx.parents);
      if (!declarator || declarator === OPAQUE || seen.has(declarator))
        return [];
      const declaration = ctx.parents.get(declarator);
      if (declaration?.kind !== 'const' && ctx.written.has(declarator))
        return [];
      seen.add(declarator);
      return literalsOf(declarator.init, declarator, ctx, seen);
    }
    default:
      return [];
  }
}

/** A value the scan cannot read: it may be anything. */
const UNREAD = Object.freeze({ value: null, at: null });

/**
 * The values key `name` of `object` may end up with, each with the node it
 * is written at, read in order as JavaScript does: a later key or spread
 * replaces an earlier one. A spread of literals the scan can read stands
 * for their keys; one it cannot read may replace the key with anything
 * (UNREAD). Empty when the key is never set.
 */
function valuesOfKey(object, name, ctx, seen = new Set()) {
  if (seen.has(object)) return [UNREAD];
  seen.add(object);
  let values = [];
  for (const property of object.properties) {
    if (property.type === 'SpreadElement') {
      const spread = literalsOf(property.argument, property, ctx);
      values = spread.length
        ? spread.flatMap((literal) => {
            const own = valuesOfKey(literal, name, ctx, new Set(seen));
            return own.length ? own : values;
          })
        : [UNREAD];
    } else if (
      (property.type === 'ObjectProperty' || property.type === 'Property') &&
      keyOf(property) === name
    )
      values = [{ value: property.value, at: property }];
  }
  return values;
}

/** Whether an object literal ends up with a `lon` or `lat` key. */
const isGeodetic = (literal, ctx) =>
  ['lon', 'lat'].some((key) =>
    valuesOfKey(literal, key, ctx).some((entry) => entry !== UNREAD),
  );

/**
 * The `flyToBounds` calls in `source` and the lines of those with a
 * geodetic centre.
 * @param {string} source JavaScript.
 * @param {number} [lineOffset] Lines before `source` in its file.
 * @returns {{ calls: number, geodetic: number[] }}
 */
export function geodeticCentres(source, lineOffset = 0) {
  const tree = parsers.babel.parse(source, {});
  const parents = new Map(nodesOf(tree.program));
  const ctx = { parents, written: writtenBindings(parents) };
  let calls = 0;
  const geodetic = [];
  for (const node of parents.keys()) {
    if (
      node.type !== 'CallExpression' &&
      node.type !== 'OptionalCallExpression'
    )
      continue;
    const callee = node.callee;
    const name = callee?.computed
      ? callee.property?.value
      : callee?.property?.name;
    if (!callee?.type?.endsWith('MemberExpression') || name !== 'flyToBounds')
      continue;
    calls += 1;
    const geodeticHere = literalsOf(node.arguments[0], node, ctx).some(
      (sphere) =>
        valuesOfKey(sphere, 'center', ctx).some(
          // Read where the sphere's literal says it, not where the call is.
          ({ value, at }) =>
            value &&
            literalsOf(value, at, ctx).some((centre) =>
              isGeodetic(centre, ctx),
            ),
        ),
    );
    if (geodeticHere) geodetic.push(node.loc.start.line + lineOffset);
  }
  return { calls, geodetic };
}

/** The expressions of a template: directives' values and `{{ }}`. */
function* templateExpressions(node) {
  if (node.type === 5) yield node.content;
  for (const prop of node.props ?? [])
    if (prop.type === 7 && prop.exp) yield prop.exp;
  for (const child of node.children ?? []) yield* templateExpressions(child);
}

/**
 * The calls in one source file. A component's script blocks are read
 * apart, as Vue scopes them, with their lines counted in the file; a name
 * one block takes from the other is not followed. A template expression
 * that names `flyToBounds` is not read and is reported as such; comments
 * and text are not expressions.
 */
function scanFile(path, source) {
  if (!path.endsWith('.vue')) return geodeticCentres(source);
  const { descriptor } = parseSfc(source, { filename: path });
  const result = { calls: 0, geodetic: [] };
  for (const block of [descriptor.script, descriptor.scriptSetup]) {
    if (!block) continue;
    const found = geodeticCentres(block.content, block.loc.start.line - 1);
    result.calls += found.calls;
    result.geodetic.push(...found.geodetic);
  }
  if (descriptor.template?.ast)
    for (const expression of templateExpressions(descriptor.template.ast))
      if (expression.content.includes('flyToBounds'))
        result.geodetic.push(
          `${expression.loc.start.line} (template, not scanned)`,
        );
  return result;
}

test('the scan finds a geodetic centre given inline, through a local, or in a local sphere', () => {
  const found = (code) => geodeticCentres(code).geodetic.length;
  assert.equal(found('camera.flyToBounds({ center: { lon: 1, lat: 2 } });'), 1);
  assert.equal(
    found(
      `function fly(camera, launch) {
        const center = { lon: launch.lon, lat: launch.lat };
        camera.flyToBounds({ center, radius: 0 });
      }`,
    ),
    1,
  );
  assert.equal(
    found(
      `const place = { lat: 2, lon: 1, height: 0 };
      function fly(camera) {
        const sphere = { center: place, radius: 10 };
        if (camera) camera?.flyToBounds?.(sphere);
      }`,
    ),
    1,
  );
  assert.equal(found("camera['flyToBounds']({ 'center': { 'lat': 2 } });"), 1);
  assert.equal(
    found("camera.flyToBounds({ center: { ['lon']: 1, ['lat']: 2 } });"),
    1,
  );
  assert.equal(
    found(
      'camera.flyToBounds(fallback ? ecef : { center: { lon, lat }, radius: 0 });',
    ),
    1,
  );
  assert.equal(
    found('camera.flyToBounds({ center: ecef, center: { lon, lat } });'),
    1,
  );
  assert.equal(
    found(
      `function fly(camera, ok) {
        if (ok) { var center = { lon: 1, lat: 2 }; }
        camera.flyToBounds({ center });
      }`,
    ),
    1,
  );
  // A spread that supplies the centre.
  assert.equal(
    found(
      `const geodeticBounds = { center: { lon: 1, lat: 2 } };
      camera.flyToBounds({ radius: 0, ...geodeticBounds });`,
    ),
    1,
  );
  assert.equal(
    found(
      `const place = { lon: 1, lat: 2 };
      camera.flyToBounds({ center: { ...place, height: 0 } });`,
    ),
    1,
  );
  // Another function writing to its own `center` leaves this one's read.
  assert.equal(
    found(
      `function fly(camera) {
        let center = { lon: 1, lat: 2 };
        camera.flyToBounds({ center });
      }
      function move(center) { center = fromDegrees(1, 2); }`,
    ),
    1,
  );
  // The sphere holds the outer centre, whatever the calling function names.
  assert.equal(
    found(
      `const center = { lon: 1, lat: 2 };
      const sphere = { center, radius: 0 };
      function fly(camera) {
        const center = fromDegrees(1, 2);
        camera.flyToBounds(sphere);
      }`,
    ),
    1,
  );
});

test('the scan leaves ECEF centres, spreads, other scopes and comments alone', () => {
  const found = (code) => geodeticCentres(code).geodetic.length;
  assert.equal(
    found(
      `camera.flyToBounds({ center: fromDegrees(lon, lat), radius: 0 });
      camera.flyToBounds({ center: { ...fromDegrees(lon, lat) }, radius: 0 });
      camera.flyToBounds({ center: sphere.center, radius: sphere.radius });
      camera.flyToBounds(bounds, { offset: { lon: 1 } });`,
    ),
    0,
  );
  assert.equal(
    found(
      `function a() { const center = { lon: 1, lat: 2 }; return center; }
      function b(camera, center) { camera.flyToBounds({ center }); }`,
    ),
    0,
  );
  assert.equal(
    found('// camera.flyToBounds({ center: { lon: 1, lat: 2 } });'),
    0,
  );
  // A parameter shadows an outer geodetic local of the same name.
  assert.equal(
    found(
      `const center = { lon: 1, lat: 2 };
      function fly(camera, center) {
        camera.flyToBounds({ center, radius: 0 });
      }`,
    ),
    0,
  );
  assert.equal(
    found("camera.flyToBounds({ center: { [key]: 1, ['x']: 2 } });"),
    0,
  );
  // A local written again holds what was written last, not followed.
  assert.equal(
    found(
      `let center = { lon: 1, lat: 2 };
      center = fromDegrees(1, 2);
      camera.flyToBounds({ center });`,
    ),
    0,
  );
  assert.equal(
    found('camera.flyToBounds({ center: { lon: 1 }, center: ecef });'),
    0,
  );
  // A spread after the centre replaces it, or may.
  assert.equal(
    found(
      `const ecefBounds = { center: fromDegrees(1, 2), radius: 5 };
      camera.flyToBounds({ center: { lon: 1, lat: 2 }, ...ecefBounds });
      camera.flyToBounds({ center: { lon: 1, lat: 2 }, ...options });`,
    ),
    0,
  );
});

test('a component is read block by block, with its own line numbers', () => {
  const vue = [
    '<template>',
    '  <div />',
    '</template>',
    '<script>',
    'const center = fromDegrees(1, 2);',
    '</script>',
    '<script setup>',
    'const center = { lon: 1, lat: 2 };',
    'camera.flyToBounds({ center });',
    '</script>',
  ].join('\n');
  assert.deepEqual(scanFile('Card.vue', vue).geodetic, [9]);
  const inTemplate = [
    '<template>',
    '  <button @click="camera.flyToBounds(sphere)" />',
    '</template>',
  ].join('\n');
  assert.deepEqual(scanFile('Card.vue', inTemplate).geodetic, [
    '2 (template, not scanned)',
  ]);
  const mentioned = [
    '<template>',
    '  <!-- Never call flyToBounds from here. -->',
    '  <p>flyToBounds</p>',
    '</template>',
  ].join('\n');
  assert.deepEqual(scanFile('Card.vue', mentioned).geodetic, []);
});

/** Callers the scan must read, so a scan that stops finding them fails. */
const KNOWN_CALLERS = [
  'annotations/annotationEngine.js',
  'layers/installations/controls.js',
  'layers/launches/policyHelpers.js',
  'layers/launches/selection.js',
  'layers/streetLevel/cameraFraming.js',
  'worldFocus.js',
  'locations.js',
];

test('no flyToBounds caller in src gives the sphere centre as lon, lat and height', () => {
  const geodetic = [];
  const scanned = new Set();
  for (const path of sources(SRC)) {
    const text = readFileSync(path, 'utf8');
    if (!text.includes('flyToBounds')) continue;
    const file = relative(SRC, path).split(sep).join('/');
    const found = scanFile(path, text);
    if (found.calls > 0) scanned.add(file);
    for (const line of found.geodetic) geodetic.push(`${file}:${line}`);
  }
  assert.deepEqual(
    KNOWN_CALLERS.filter((file) => !scanned.has(file)),
    [],
    'callers the scan did not find',
  );
  assert.deepEqual(geodetic, []);
});
