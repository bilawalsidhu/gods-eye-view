import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const SRC_ROOT = fileURLToPath(new URL('.', import.meta.url));

/** Every browser-built module under src/ — the test files are Node-only. */
function browserModules(directory = SRC_ROOT) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...browserModules(absolute));
    else if (
      entry.isFile() &&
      entry.name.endsWith('.js') &&
      !entry.name.endsWith('.test.js')
    )
      files.push(absolute);
  }
  return files.sort();
}

/**
 * Whether `node` is an optional call of a method reached through an optional
 * chain: `a?.b?.()`, `f()?.g?.h?.()`. The forms esbuild compiles correctly,
 * `a?.b()` and `a.b?.()`, are not.
 */
function optionalMethodCall(node) {
  if (!ts.isCallExpression(node) || !node.questionDotToken) return false;
  const callee = node.expression;
  const member =
    ts.isPropertyAccessExpression(callee) ||
    ts.isElementAccessExpression(callee);
  return member && (callee.flags & ts.NodeFlags.OptionalChain) !== 0;
}

/** Such calls in `node`, a default's expression, outside nested functions. */
function callsIn(node, found = []) {
  if (ts.isFunctionLike(node)) return found;
  if (optionalMethodCall(node)) found.push(node);
  ts.forEachChild(node, (child) => callsIn(child, found));
  return found;
}

/** The defaults of a parameter: its own and those inside a destructuring pattern. */
function defaultsOf(binding, found = []) {
  if (binding.initializer) found.push(binding.initializer);
  if (
    ts.isObjectBindingPattern(binding.name) ||
    ts.isArrayBindingPattern(binding.name)
  )
    for (const element of binding.name.elements)
      if (ts.isBindingElement(element)) defaultsOf(element, found);
  return found;
}

test('no parameter default calls a method through an optional chain', () => {
  // esbuild compiles `a?.b?.()` in a parameter's default, for the browsers a
  // build still lowers optional chaining for (Chrome and Edge before 91), into
  // code that reads a variable out of its scope: the call throws a
  // ReferenceError in the built app, never under node:test. The weather shell
  // read its texture limit this way, so every satellite frame failed. Compute
  // such a value in the function's body instead.
  const offenders = [];
  for (const file of browserModules()) {
    const source = ts.createSourceFile(
      file,
      readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS,
    );
    const visit = (node) => {
      if (ts.isFunctionLike(node))
        for (const parameter of node.parameters ?? [])
          for (const initializer of defaultsOf(parameter))
            for (const call of callsIn(initializer)) {
              const { line } = source.getLineAndCharacterOfPosition(
                call.getStart(source),
              );
              offenders.push(
                `${path.relative(SRC_ROOT, file)}:${line + 1} ${call.getText(source)}`,
              );
            }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  assert.deepEqual(offenders, []);
});
