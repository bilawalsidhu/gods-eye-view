/**
 * The Cesium-free modules the package exports: each
 * export names a module that imports no engine, has declarations beside it
 * that say every name it exports and no other, and type-checks when imported
 * through the package's exports.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);
const PKG = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

/** The Cesium-free exports, with declarations. */
const NEUTRAL = [
  './render/contract',
  './render/conformance',
  './render/input/router',
  './render/stub/camera',
  './render/stub/viewRectangle',
  './render/stub/harness',
  './render/motion',
  './render/iconSegment',
  './render/recession',
  './render/modelParts',
  './render/windStreamlines',
  './render/weather',
  './weather/effects',
  './geo/screenCluster',
  './fleet',
];

const fileOf = (key) => path.join(ROOT, PKG.exports[key]);
const declarationOf = (key) => fileOf(key).replace(/\.js$/, '.d.ts');

test('each Cesium-free export is declared, beside its module', () => {
  for (const key of NEUTRAL) {
    assert.equal(typeof PKG.exports[key], 'string', `${key} is exported`);
    assert.doesNotThrow(
      () => readFileSync(declarationOf(key)),
      `${key} has declarations`,
    );
  }
});

test('each one names in its declarations exactly what its module exports', async () => {
  for (const key of NEUTRAL) {
    const runtime = Object.keys(await import(pathToFileURL(fileOf(key)).href))
      .filter((name) => name !== 'default')
      .sort();
    const source = ts.createSourceFile(
      declarationOf(key),
      readFileSync(declarationOf(key), 'utf8'),
      ts.ScriptTarget.ES2022,
    );
    // Values only: types and interfaces have no runtime name. A module that
    // re-exports another's declarations (`export *`) is checked through it.
    if (
      source.statements.some(
        (s) => ts.isExportDeclaration(s) && !s.exportClause,
      )
    )
      continue;
    const declared = [];
    for (const s of source.statements) {
      const exported = s.modifiers?.some(
        (m) => m.kind === ts.SyntaxKind.ExportKeyword,
      );
      if (!exported) continue;
      if (
        ts.isFunctionDeclaration(s) ||
        ts.isClassDeclaration(s) ||
        ts.isModuleDeclaration(s)
      )
        declared.push(s.name.text);
      else if (ts.isVariableStatement(s))
        for (const d of s.declarationList.declarations)
          declared.push(d.name.text);
    }
    assert.deepEqual([...new Set(declared)].sort(), runtime, key);
  }
});

test('they type-check under strict TypeScript, imported by their package names', () => {
  const probe = path.join(ROOT, 'src/render/neutralExports.probe.ts');
  const lines = NEUTRAL.map(
    (key, i) =>
      `import * as m${i} from '${PKG.name}${key.slice(1)}';\nvoid m${i};`,
  );
  const host = ts.createCompilerHost({});
  const read = host.readFile;
  host.readFile = (file) =>
    path.resolve(file) === probe ? lines.join('\n') : read(file);
  const exists = host.fileExists;
  host.fileExists = (file) => path.resolve(file) === probe || exists(file);
  const program = ts.createProgram(
    [probe],
    {
      strict: true,
      noEmit: true,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'],
      types: [],
      allowJs: false,
    },
    host,
  );
  const problems = ts
    .getPreEmitDiagnostics(program)
    .map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'));
  assert.deepEqual(problems, []);
  // Each resolved to its declarations, not to an untyped module.
  for (const key of NEUTRAL)
    assert.ok(
      program.getSourceFile(declarationOf(key)),
      `${key} resolves to its declarations`,
    );
});

test('none of them reaches Cesium', () => {
  const engines = /from ['"]cesium['"]/;
  const seen = new Set();
  const walk = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    const text = readFileSync(file, 'utf8');
    assert.doesNotMatch(text, engines, path.relative(ROOT, file));
    for (const [, spec] of text.matchAll(
      /(?:from|import)\s*['"](\.[^'"]+)['"]/g,
    ))
      walk(path.resolve(path.dirname(file), spec));
  };
  for (const key of NEUTRAL) walk(fileOf(key));
});

test('a camera controller written against the contract reads its pointer events', () => {
  const probe = path.join(ROOT, 'src/render/controllerFactory.probe.ts');
  const text = `
import type { CameraControllerFactory, CameraPort } from '${PKG.name}/render/contract';
declare const port: CameraPort;
export const controller: CameraControllerFactory = ({ native, input }) => {
  const off = input?.on('move', (event) => {
    const [x, y] = [event.position.x, event.position.y];
    void [x, y, event.type, native.viewport().width];
  });
  return {
    port,
    frame: { beforeUpdate() {}, afterUpdate() {} },
    destroy: () => off?.(),
  };
};
`;
  const host = ts.createCompilerHost({});
  const read = host.readFile;
  host.readFile = (file) => (path.resolve(file) === probe ? text : read(file));
  const exists = host.fileExists;
  host.fileExists = (file) => path.resolve(file) === probe || exists(file);
  const program = ts.createProgram(
    [probe],
    {
      strict: true,
      noEmit: true,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'],
      types: [],
    },
    host,
  );
  const problems = ts
    .getPreEmitDiagnostics(program)
    .map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'));
  assert.deepEqual(problems, []);
});
