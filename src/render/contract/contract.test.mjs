import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import {
  CAPABILITIES,
  CONTRACT_VERSION,
  FRAME_STEPS,
  PORTS,
  ROLES,
  roleOf,
  QUALITY_KEYS,
  checkPortShape,
  checkRendererShape,
} from './index.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const INDEX = path.join(DIR, 'index.d.ts');

const program = ts.createProgram([INDEX], {
  strict: true,
  noEmit: true,
  target: ts.ScriptTarget.ES2022,
  lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'],
  skipLibCheck: false,
  types: [],
});
const checker = program.getTypeChecker();
const contractFiles = program
  .getSourceFiles()
  .filter((file) => path.dirname(file.fileName) === DIR);

/** The named interface or type alias declared in the contract files. */
function declared(name) {
  for (const file of contractFiles)
    for (const statement of file.statements)
      if (
        (ts.isInterfaceDeclaration(statement) ||
          ts.isTypeAliasDeclaration(statement)) &&
        statement.name.text === name
      )
        return statement;
  throw new Error(`${name} is not declared in the contract`);
}

const PORT_INTERFACES = {
  renderer: 'Renderer',
  frame: 'FramePort',
  globe: 'GlobePort',
  draw: 'DrawPort',
  camera: 'CameraPort',
  query: 'QueryPort',
  input: 'InputPort',
  effects: 'EffectsPort',
  credits: 'CreditsPort',
  quality: 'QualityPort',
  drawSet: 'DrawSet',
  imageryLayer: 'ImageryLayer',
  flight: 'Flight',
  lease: 'Lease',
};
const PORT_NAMES = new Set(Object.values(PORT_INTERFACES));

/** Whether a property's type is one of the contract's own object shapes to list member by member. */
function nestedShape(type) {
  if (type.isUnion() || type.getCallSignatures().length) return null;
  const symbol = type.aliasSymbol ?? type.getSymbol();
  const declaration = symbol?.declarations?.[0];
  if (!declaration) return null;
  const inContract = path.dirname(declaration.getSourceFile().fileName) === DIR;
  if (!inContract) return null;
  if (ts.isTypeLiteralNode(declaration)) return type;
  if (ts.isInterfaceDeclaration(declaration))
    return PORT_NAMES.has(declaration.name.text) ? null : type;
  return null;
}

/**
 * `[member, optional]` for every member, nested shapes dotted; a member of
 * an optional shape is as optional as the shape.
 */
function members(type, prefix = '', inOptional = false) {
  const out = [];
  for (const property of checker.getPropertiesOfType(type)) {
    const name = `${prefix}${property.name}`;
    const optional =
      inOptional || Boolean(property.flags & ts.SymbolFlags.Optional);
    out.push([name, optional]);
    const declaration = property.valueDeclaration ?? property.declarations?.[0];
    const declared = checker.getTypeOfSymbolAtLocation(property, declaration);
    // An optional member's shape, without the `undefined` its `?` adds.
    const propertyType =
      property.flags & ts.SymbolFlags.Optional
        ? checker.getNonNullableType(declared)
        : declared;
    const nested = nestedShape(propertyType);
    if (nested) out.push(...members(nested, `${name}.`, optional));
  }
  return out;
}

function unionLiterals(name) {
  const type = checker.getTypeAtLocation(declared(name).name);
  return (type.isUnion() ? type.types : [type]).map((t) => t.value).sort();
}

test('the contract type-checks under strict TypeScript', () => {
  const diagnostics = ts.getPreEmitDiagnostics(program).map((d) => {
    const where = d.file
      ? `${path.relative(DIR, d.file.fileName)}:${d.file.getLineAndCharacterOfPosition(d.start).line + 1}`
      : '';
    return `${where} ${ts.flattenDiagnosticMessageText(d.messageText, '\n')}`;
  });
  assert.deepEqual(diagnostics, []);
});

test('PORTS lists every member of every port, required exactly when the type requires it', () => {
  for (const [port, interfaceName] of Object.entries(PORT_INTERFACES)) {
    const type = checker.getTypeAtLocation(declared(interfaceName).name);
    const typed = Object.fromEntries(members(type));
    const described = PORTS[port];
    assert.deepEqual(
      Object.keys(described).sort(),
      Object.keys(typed).sort(),
      `${port} members`,
    );
    for (const [member, capability] of Object.entries(described))
      assert.equal(
        capability !== null,
        typed[member],
        `${port}.${member}: optional in the type exactly when a capability adds it`,
      );
  }
});

test('every member of every port has one role, and each role names real members', () => {
  const ids = ROLES.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length);
  // No entry is claimed by two roles, so the most specific entry is never a tie.
  const entries = ROLES.flatMap((r) => r.members);
  assert.equal(new Set(entries).size, entries.length, 'an entry in two roles');
  for (const [port, members] of Object.entries(PORTS))
    for (const member of Object.keys(members))
      assert.ok(
        ids.includes(roleOf(port, member)),
        `${port}.${member} has no role`,
      );
  // An entry is a port, or a member (or a prefix of dotted members) of one.
  for (const role of ROLES)
    for (const entry of role.members) {
      const [port, ...rest] = entry.split('.');
      const member = rest.join('.');
      assert.ok(PORTS[port], `${role.id}: ${entry} names no port`);
      if (member)
        assert.ok(
          Object.keys(PORTS[port]).some(
            (m) => m === member || m.startsWith(`${member}.`),
          ),
          `${role.id}: ${entry} names no member`,
        );
    }
  // The most specific entry wins.
  assert.equal(roleOf('globe', 'setBase'), 'surface');
  assert.equal(roleOf('globe', 'sky.set'), 'look');
  assert.equal(roleOf('globe', 'setSurfaceShading'), 'look');
  assert.equal(roleOf('nowhere', 'x'), undefined);
  assert.equal(roleOf('globe', 'bogus'), undefined);
  assert.equal(roleOf('globe'), 'surface');
  assert.equal(roleOf('imageryLayer', 'lit'), 'look');
});

test('the capability and frame-step lists are the types’ own', () => {
  assert.deepEqual([...CAPABILITIES].sort(), unionLiterals('Capability'));
  assert.deepEqual([...FRAME_STEPS].sort(), unionLiterals('FrameStep'));
  for (const port of Object.values(PORTS))
    for (const capability of Object.values(port))
      if (capability !== null) assert.ok(CAPABILITIES.includes(capability));
  assert.equal(CONTRACT_VERSION, '0');
  const settings = checker.getTypeAtLocation(declared('QualitySettings').name);
  assert.deepEqual(
    [...QUALITY_KEYS].sort(),
    checker
      .getPropertiesOfType(settings)
      .map((p) => p.name)
      .sort(),
  );
});

test('a draw set’s events: ready with the id, loadFailed with the id and why', () => {
  const on = checker
    .getTypeAtLocation(declared('DrawSet').name)
    .getProperty('on');
  const signatures = checker
    .getTypeOfSymbolAtLocation(on, declared('DrawSet'))
    .getCallSignatures();
  const events = Object.fromEntries(
    signatures.map((signature) => {
      const [event, cb] = signature.getParameters();
      const callback = checker
        .getTypeOfSymbolAtLocation(cb, cb.valueDeclaration)
        .getCallSignatures()[0];
      return [
        checker.getTypeOfSymbolAtLocation(event, event.valueDeclaration).value,
        callback
          .getParameters()
          .map((p) =>
            checker.typeToString(
              checker.getTypeOfSymbolAtLocation(p, p.valueDeclaration),
            ),
          ),
      ];
    }),
  );
  assert.deepEqual(events, {
    ready: ['string'],
    loadFailed: ['string', 'string'],
  });
});

test('members added to version 0 later are optional, each behind its capability', () => {
  // A renderer conforms without them.
  assert.equal(PORTS.globe.isGlobeVisible, 'globeVisibility');
  assert.equal(PORTS.camera.followFrame, 'followFrame');
  // Item fields added later are optional too.
  const optional = (shape, field) =>
    Object.fromEntries(
      members(checker.getTypeAtLocation(declared(shape).name)),
    )[field];
  assert.equal(optional('LineItem', 'depthFail'), true);
  // And on one kind of a union: the rectangle's rotation.
  const rectangle = checker
    .getTypeAtLocation(declared('ShapeGeometry').name)
    .types.find((kind) => checker.getPropertyOfType(kind, 'rect'));
  assert.equal(Object.fromEntries(members(rectangle)).rotation, true);
});

test('the shape check names what is missing and what a capability does not allow', () => {
  assert.deepEqual(checkRendererShape(null), ['renderer is not an object']);
  assert.deepEqual(checkRendererShape({}), [
    'renderer.capabilities is not a Set',
  ]);
  const problems = checkRendererShape({
    capabilities: new Set(['warp']),
    contractVersion: '0',
  });
  assert.ok(problems.includes('unknown capability warp'));
  assert.ok(problems.includes('renderer.frame is missing'));
  const set = Object.fromEntries(
    Object.keys(PORTS.drawSet).map((member) => [member, () => {}]),
  );
  assert.deepEqual(checkPortShape(set, 'drawSet', new Set()), [
    'drawSet.setColumns is present without columns',
  ]);
  delete set.setColumns;
  assert.deepEqual(checkPortShape(set, 'drawSet', new Set(['columns'])), [
    'drawSet.setColumns is missing with columns',
  ]);
  assert.deepEqual(checkPortShape(set, 'drawSet', new Set()), []);
});
