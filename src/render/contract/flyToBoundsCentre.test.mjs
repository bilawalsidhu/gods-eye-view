/**
 * `Sphere.center` is `Ecef` (contract/common.d.ts). The Cesium camera also
 * takes lon, lat and height there, so a caller that gives them works on
 * Cesium and leaves a camera that reads the contract's type with no point
 * to fly to. The shared test camera (src/testSupport/fakeCameraPort.mjs)
 * refuses such a centre in every test that flies, and is the guard for
 * centres built at run time; this reads the source, for callers no test
 * reaches, and flags only what the call site settles.
 *
 * A centre is geodetic when the sphere given to `flyToBounds` may have a
 * `center` that is an object literal with a `lon` or `lat` key and not all
 * of `x`, `y` and `z` (an ECEF point may carry its latitude too). The sphere
 * and the centre are read as written at the call, or through a `const`
 * whose initializer is read where it is declared; the nearest binding
 * wins, so a parameter shadows an outer `const`. `a ? b : c` may be either
 * branch; `a && b` is `b`, or a falsy `a`, which has no keys; `a || b` and
 * `a ?? b` are `a`, and `b` only when `a` may be something other than an
 * object literal. Keys are read in order, as JavaScript keeps them: the
 * last one written wins, a spread of a literal stands for its keys, and a
 * spread of `null`, `undefined` or another primitive keeps the keys before
 * it. Anything else is unknown and not flagged: a `let` or `var`, a
 * parameter, a call (so `fromDegrees(lon, lat)` is ECEF), a spread the scan
 * cannot read, and a `const` whose members the file writes to anywhere
 * (`sphere.center = …`, `delete`, `Object.assign(sphere, …)`). Comments are
 * not code.
 */
import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
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
/** What binds a name to something the scan does not read. */
const OPAQUE = Symbol('opaque');

/** What `statements` declare `name` as: a `const` declarator, OPAQUE, or null. */
function declaredIn(statements, name) {
  for (const statement of statements) {
    const node =
      statement.type === 'ExportNamedDeclaration'
        ? statement.declaration
        : statement;
    if (node?.type === 'VariableDeclaration') {
      for (const declarator of node.declarations)
        if (namesOf(declarator.id).includes(name))
          return node.kind === 'const' && declarator.id.type === 'Identifier'
            ? declarator
            : OPAQUE;
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

/** Whether `node`, short of nested functions, declares `var name`. */
function declaresVar(node, name) {
  if (Array.isArray(node))
    return node.some((child) => declaresVar(child, name));
  if (!node || typeof node !== 'object' || FUNCTIONS.has(node.type))
    return false;
  if (
    node.type === 'VariableDeclaration' &&
    node.kind === 'var' &&
    node.declarations.some((d) => namesOf(d.id).includes(name))
  )
    return true;
  return Object.entries(node).some(
    ([key, value]) =>
      !SKIPPED_KEYS.has(key) &&
      value &&
      typeof value === 'object' &&
      declaresVar(value, name),
  );
}

/**
 * The nearest binding of `name` in the scopes around `at`: its declarator
 * when it is a plain `const`, OPAQUE when anything else binds it, or null
 * when nothing in the file does.
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
    // A `var` in a block below belongs to the function or the module.
    if (
      !found &&
      (scope.type === 'Program' || FUNCTIONS.has(scope.type)) &&
      declaresVar(scope.body, name)
    )
      found = OPAQUE;
    if (found) return found;
  }
  return null;
}

/** The identifier a member chain (`a.b[c].d`) starts from, if any. */
function rootOf(node) {
  while (
    node?.type === 'MemberExpression' ||
    node?.type === 'OptionalMemberExpression'
  )
    node = node.object;
  return node?.type === 'Identifier' ? node : null;
}

/**
 * The `const` declarators whose objects the file changes: a member assigned
 * to, updated or deleted, or the object handed to `Object.assign` to fill.
 */
function mutatedBindings(parents) {
  const mutated = new Set();
  for (const node of parents.keys()) {
    let target = null;
    if (node.type === 'AssignmentExpression') target = node.left;
    else if (node.type === 'UpdateExpression') target = node.argument;
    else if (node.type === 'UnaryExpression' && node.operator === 'delete')
      target = node.argument;
    else if (
      node.type === 'CallExpression' &&
      node.callee?.type === 'MemberExpression' &&
      node.callee.object?.name === 'Object' &&
      node.callee.property?.name === 'assign'
    )
      target = { type: 'MemberExpression', object: node.arguments[0] };
    if (
      target?.type !== 'MemberExpression' &&
      target?.type !== 'OptionalMemberExpression'
    )
      continue;
    const root = rootOf(target);
    const binding = root && bindingOf(root.name, node, parents);
    if (binding && binding !== OPAQUE) mutated.add(binding);
  }
  return mutated;
}

/** A value that has no keys: `null`, `undefined`, a falsy `a` of `a && b`, a primitive. */
const EMPTY = Symbol('empty');
/** A value the scan cannot read: it may be anything. */
const UNKNOWN = Symbol('unknown');

const isLiteral = (value) => typeof value === 'object';

/**
 * What `node`, written at `at`, may evaluate to: object literals, EMPTY or
 * UNKNOWN.
 */
function possibilitiesOf(node, at, ctx, seen = new Set()) {
  switch (node?.type) {
    case 'ObjectExpression':
      return [node];
    case 'NullLiteral':
    case 'BooleanLiteral':
    case 'NumericLiteral':
    case 'StringLiteral':
    case 'BigIntLiteral':
    case 'TemplateLiteral':
      return [EMPTY];
    case 'SequenceExpression':
      return possibilitiesOf(node.expressions.at(-1), at, ctx, seen);
    case 'ConditionalExpression':
      return [
        ...possibilitiesOf(node.consequent, at, ctx, seen),
        ...possibilitiesOf(node.alternate, at, ctx, seen),
      ];
    case 'LogicalExpression': {
      const right = possibilitiesOf(node.right, at, ctx, seen);
      // An object is truthy: `a && b` is `b`, or a falsy `a` with no keys.
      if (node.operator === '&&') return [EMPTY, ...right];
      const left = possibilitiesOf(node.left, at, ctx, seen);
      if (left.every(isLiteral)) return left;
      // `a || b` passes over a falsy `a`; `a ?? b` keeps a falsy non-nullish one.
      const kept =
        node.operator === '||' ? left.filter((p) => p !== EMPTY) : left;
      return [...kept, ...right];
    }
    case 'Identifier': {
      const declarator = bindingOf(node.name, at, ctx.parents);
      if (declarator === null && node.name === 'undefined') return [EMPTY];
      if (
        !declarator ||
        declarator === OPAQUE ||
        !declarator.init ||
        seen.has(declarator) ||
        ctx.mutated.has(declarator)
      )
        return [UNKNOWN];
      return possibilitiesOf(
        declarator.init,
        declarator,
        ctx,
        new Set(seen).add(declarator),
      );
    }
    default:
      return [UNKNOWN];
  }
}

/** The object literals among what `node` may be. */
const literalsOf = (node, at, ctx) =>
  possibilitiesOf(node, at, ctx).filter(isLiteral);

/**
 * The values key `name` of `object` may end up with, each with the node it
 * is written at, read in order as JavaScript does: a later key or spread
 * replaces an earlier one. A spread of a literal stands for its keys, one of
 * EMPTY keeps the keys before it, and one the scan cannot read may replace
 * the key with anything (UNKNOWN). Empty when the key is never set.
 */
function valuesOfKey(object, name, ctx, seen = new Set()) {
  if (seen.has(object)) return [UNKNOWN];
  seen.add(object);
  let values = [];
  for (const property of object.properties) {
    if (property.type === 'SpreadElement') {
      const before = values;
      values = possibilitiesOf(property.argument, property, ctx).flatMap(
        (spread) => {
          if (spread === EMPTY) return before;
          if (spread === UNKNOWN) return [UNKNOWN];
          const own = valuesOfKey(spread, name, ctx, new Set(seen));
          return own.length ? own : before;
        },
      );
    } else if (
      (property.type === 'ObjectProperty' || property.type === 'Property') &&
      keyOf(property) === name
    )
      values = [{ value: property.value, at: property }];
  }
  return values;
}

/** Whether key `name` of `literal` is set to something on every path. */
const alwaysSet = (literal, name, ctx) => {
  const values = valuesOfKey(literal, name, ctx);
  return values.length > 0 && !values.includes(UNKNOWN);
};

/**
 * Whether an object literal may be a geodetic point: it ends up with a
 * `lon` or `lat` key, and is not an ECEF point (`x`, `y` and `z` all set).
 */
const isGeodetic = (literal, ctx) =>
  !['x', 'y', 'z'].every((key) => alwaysSet(literal, key, ctx)) &&
  ['lon', 'lat'].some((key) =>
    valuesOfKey(literal, key, ctx).some((entry) => entry !== UNKNOWN),
  );

/** The name of the method or function a call calls, if it has one. */
function calleeName(call) {
  const callee = call.callee;
  if (callee?.type === 'Identifier') return callee.name;
  if (!callee?.type?.endsWith('MemberExpression')) return null;
  return callee.computed ? callee.property?.value : callee.property?.name;
}

/**
 * The `flyToBounds` method calls in `source` and the lines of those with a
 * geodetic centre.
 * @param {string} source JavaScript.
 * @param {number} [lineOffset] Lines before `source` in its file.
 * @returns {{ calls: number, geodetic: number[] }}
 */
export function geodeticCentres(source, lineOffset = 0) {
  const tree = parsers.babel.parse(source, {});
  const parents = new Map(nodesOf(tree.program));
  const ctx = { parents, mutated: mutatedBindings(parents) };
  let calls = 0;
  const geodetic = [];
  for (const node of parents.keys()) {
    if (
      node.type !== 'CallExpression' &&
      node.type !== 'OptionalCallExpression'
    )
      continue;
    if (
      !node.callee?.type?.endsWith('MemberExpression') ||
      calleeName(node) !== 'flyToBounds'
    )
      continue;
    calls += 1;
    const geodeticHere = literalsOf(node.arguments[0], node, ctx).some(
      (sphere) =>
        valuesOfKey(sphere, 'center', ctx).some(
          // Read where the sphere's literal says it, not where the call is.
          (entry) =>
            entry !== UNKNOWN &&
            literalsOf(entry.value, entry.at, ctx).some((centre) =>
              isGeodetic(centre, ctx),
            ),
        ),
    );
    if (geodeticHere) geodetic.push(node.loc.start.line + lineOffset);
  }
  return { calls, geodetic };
}

/** The directives' values and `{{ }}` of a template, each with its directive. */
function* templateExpressions(node) {
  if (node.type === 5) yield { expression: node.content, directive: null };
  for (const prop of node.props ?? [])
    if (prop.type === 7 && prop.exp)
      yield { expression: prop.exp, directive: prop };
  for (const child of node.children ?? []) yield* templateExpressions(child);
}

/**
 * Whether a template expression calls `flyToBounds`: a call to it, or a
 * `v-on` handler that names it, which Vue calls. What does not parse as
 * JavaScript (a `v-for`'s `item in list`) is read as text for a call.
 */
function templateCallsFlyToBounds({ expression, directive }) {
  const code = expression.content;
  if (!code.includes('flyToBounds')) return false;
  for (const text of [`(${code})`, code]) {
    let tree;
    try {
      tree = parsers.babel.parse(text, {});
    } catch {
      continue;
    }
    const nodes = [...nodesOf(tree.program)].map(([node]) => node);
    if (
      nodes.some(
        (node) =>
          (node.type === 'CallExpression' ||
            node.type === 'OptionalCallExpression') &&
          calleeName(node) === 'flyToBounds',
      )
    )
      return true;
    if (directive?.name !== 'on') return false;
    const handler = tree.program.body[0]?.expression;
    return calleeName({ callee: handler }) === 'flyToBounds';
  }
  return /\bflyToBounds\s*\(/.test(code);
}

/**
 * The calls in one source file. A component's script blocks are read
 * apart, as Vue scopes them, with their lines counted in the file; a name
 * one block takes from the other is not followed. A template expression
 * that calls `flyToBounds` is not read and is reported as such; one that
 * only names it, comments and text are left alone.
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
    for (const entry of templateExpressions(descriptor.template.ast))
      if (templateCallsFlyToBounds(entry)) {
        result.calls += 1;
        result.geodetic.push(
          `${entry.expression.loc.start.line} (template, not scanned)`,
        );
      }
  return result;
}

/**
 * Scan every runtime source file under `root`: the files with a
 * `flyToBounds` call, and `file:line` of each geodetic centre.
 */
function scanTree(root) {
  const scanned = [];
  const geodetic = [];
  for (const path of sources(root)) {
    const text = readFileSync(path, 'utf8');
    if (!text.includes('flyToBounds')) continue;
    const file = relative(root, path).split(sep).join('/');
    const found = scanFile(path, text);
    if (found.calls > 0) scanned.push(file);
    for (const line of found.geodetic) geodetic.push(`${file}:${line}`);
  }
  return { scanned: scanned.sort(), geodetic };
}

const found = (code) => geodeticCentres(code).geodetic.length;

test('the scan finds a geodetic centre given inline, through a const, or in a const sphere', () => {
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

test('a spread that may add no keys keeps the centre before it', () => {
  for (const empty of ['{}', 'null', 'undefined', 'false', "''"])
    assert.equal(
      found(
        `camera.flyToBounds({
          center: { lon: 1, lat: 2 },
          ...(override ? { center: fromDegrees(1, 2) } : ${empty}),
        });`,
      ),
      1,
      empty,
    );
  assert.equal(
    found(
      `camera.flyToBounds({
        center: { lon: 1, lat: 2 },
        ...(override && { center: fromDegrees(1, 2) }),
      });`,
    ),
    1,
  );
  // On every path the spread replaces it.
  assert.equal(
    found(
      `camera.flyToBounds({
        center: { lon: 1, lat: 2 },
        ...(override ? { center: fromDegrees(1, 2) } : { center: ecef }),
      });`,
    ),
    0,
  );
});

test('logical operators give what they can return', () => {
  // An object literal is truthy: `&&` returns its right side.
  assert.equal(
    found(
      `const point = { lon: 1, lat: 2 };
      camera.flyToBounds({ center: point && fromDegrees(point.lon, point.lat) });`,
    ),
    0,
  );
  assert.equal(
    found('camera.flyToBounds({ center: ok && { lon: 1, lat: 2 } });'),
    1,
  );
  // `||` and `??` stop at an object literal, and reach past anything else.
  assert.equal(
    found('camera.flyToBounds({ center: fromDegrees(1, 2) || { lon: 1 } });'),
    1,
  );
  assert.equal(found('camera.flyToBounds({ center: ecef ?? { lat: 1 } });'), 1);
  assert.equal(
    found(
      `const ecef = { x: 1, y: 2, z: 3 };
      camera.flyToBounds({ center: ecef || { lon: 1, lat: 2 } });`,
    ),
    0,
  );
  assert.equal(found('camera.flyToBounds({ center: null ?? { lon: 1 } });'), 1);
});

test('an ECEF point that carries its latitude is ECEF', () => {
  assert.equal(found('camera.flyToBounds({ center: { x, y, z, lat } });'), 0);
  assert.equal(
    found(
      `const p = fromDegrees(lon, lat);
      camera.flyToBounds({ center: { x: p.x, y: p.y, z: p.z, lat, lon } });`,
    ),
    0,
  );
  // Without all three, or with one a spread may take away, it may not be.
  assert.equal(found('camera.flyToBounds({ center: { x, y, lat } });'), 1);
  assert.equal(
    found('camera.flyToBounds({ center: { x, y, z, ...extra, lat } });'),
    1,
  );
});

test('the scan leaves ECEF centres, unknowns, other scopes and comments alone', () => {
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
  // A parameter shadows an outer const of the same name.
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
  // A `let` or `var` may hold anything by the call.
  assert.equal(
    found(
      `let center = { lon: 1, lat: 2 };
      camera.flyToBounds({ center });
      function fly(camera) {
        if (ok) { var place = { lon: 1, lat: 2 }; }
        camera.flyToBounds({ center: place });
      }`,
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

test('an object written to after it is made is left to the test camera', () => {
  // Either way round: what the call sees is not what the literal says.
  assert.equal(
    found(
      `const sphere = { center: { lon: 1, lat: 2 }, radius: 0 };
      sphere.center = fromDegrees(1, 2);
      camera.flyToBounds(sphere);`,
    ),
    0,
  );
  assert.equal(
    found(
      `const sphere = { center: fromDegrees(1, 2), radius: 0 };
      sphere.center = { lon: 1, lat: 2 };
      camera.flyToBounds(sphere);`,
    ),
    0,
  );
  assert.equal(
    found(
      `const center = { lon: 1, lat: 2 };
      Object.assign(center, fromDegrees(1, 2));
      delete center.lon;
      camera.flyToBounds({ center });`,
    ),
    0,
  );
  // A write to another binding of the same name leaves this one read.
  assert.equal(
    found(
      `const sphere = { center: { lon: 1, lat: 2 } };
      camera.flyToBounds(sphere);
      function move(sphere) { sphere.center = fromDegrees(1, 2); }`,
    ),
    1,
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
});

test('a template call to flyToBounds is reported, and a name that only contains it is not', () => {
  const template = (...lines) =>
    ['<template>', ...lines, '</template>'].join('\n');
  assert.deepEqual(
    scanFile(
      'Card.vue',
      template('  <button @click="camera.flyToBounds(sphere)" />'),
    ).geodetic,
    ['2 (template, not scanned)'],
  );
  assert.deepEqual(
    scanFile('Card.vue', template('  <button @click="camera.flyToBounds" />'))
      .geodetic,
    ['2 (template, not scanned)'],
  );
  assert.deepEqual(
    scanFile('Card.vue', template('  <p>{{ flyToBounds(sphere) }}</p>'))
      .geodetic,
    ['2 (template, not scanned)'],
  );
  assert.deepEqual(
    scanFile(
      'Card.vue',
      template(
        '  <!-- Never call flyToBounds from here. -->',
        '  <p>flyToBounds</p>',
        '  <button :disabled="!flyToBoundsEnabled" :title="flyToBoundsLabel" />',
        '  <li v-for="flyToBoundsItem in items" />',
      ),
    ).geodetic,
    [],
  );
});

test('the tree scan finds callers wherever they are, and skips tests and test support', () => {
  const root = mkdtempSync(join(tmpdir(), 'fly-to-bounds-'));
  const write = (file, text) => {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  };
  try {
    write('a.js', 'camera.flyToBounds({ center: fromDegrees(1, 2) });');
    write(
      'deep/nested/b.mjs',
      'camera.flyToBounds({ center: { lon: 1, lat: 2 } });',
    );
    write(
      'ui/Card.vue',
      '<template>\n  <button @click="camera.flyToBounds(sphere)" />\n</template>\n',
    );
    write(
      'names.js',
      '// flyToBounds is the camera verb.\nexport const flyToBoundsLabel = 1;',
    );
    write('a.test.mjs', 'camera.flyToBounds({ center: { lon: 1 } });');
    write(
      'testSupport/fake.mjs',
      'camera.flyToBounds({ center: { lon: 1 } });',
    );
    write('notes.md', 'camera.flyToBounds({ center: { lon: 1 } });');
    assert.deepEqual(scanTree(root), {
      scanned: ['a.js', 'deep/nested/b.mjs', 'ui/Card.vue'],
      geodetic: [
        'deep/nested/b.mjs:1',
        'ui/Card.vue:2 (template, not scanned)',
      ],
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('no flyToBounds caller in src gives the sphere centre as lon, lat and height', () => {
  const { scanned, geodetic } = scanTree(SRC);
  assert.ok(scanned.length > 0, 'the scan found no flyToBounds call in src');
  assert.deepEqual(geodetic, []);
});
