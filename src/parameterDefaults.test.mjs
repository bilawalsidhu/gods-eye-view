import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const SRC_ROOT = fileURLToPath(new URL('.', import.meta.url));

/** Every module under src/ the build compiles: scripts and single-file
 * components, not the Node-only tests. */
function builtModules(directory = SRC_ROOT) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...builtModules(absolute));
    else if (
      entry.isFile() &&
      /\.(js|mjs|vue)$/.test(entry.name) &&
      !/\.test\.(js|mjs)$/.test(entry.name)
    )
      files.push(absolute);
  }
  return files.sort();
}

/** The code of `file` to parse: a component's script blocks in place (every
 * other character a space, so lines keep their numbers), else the file. */
function scriptOf(file) {
  const text = readFileSync(file, 'utf8');
  if (!file.endsWith('.vue')) return { code: text, kind: ts.ScriptKind.JS };
  const kept = text.replace(/[^\n]/g, ' ').split('');
  let kind = ts.ScriptKind.JS;
  for (const match of text.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) {
    if (/lang=["']ts["']/.test(match[1])) kind = ts.ScriptKind.TS;
    const start = match.index + match[0].indexOf('>') + 1;
    for (let i = 0; i < match[2].length; i += 1)
      kept[start + i] = text[start + i];
  }
  return { code: kept.join(''), kind };
}

/**
 * Whether `node` is an optional call of a method reached through an optional
 * chain: `a?.b?.()`, `a.b?.c?.()`, `f()?.g?.()`. Of these esbuild breaks the
 * ones whose optional property is read from a property or a call
 * (`a.b?.c?.()`, `f()?.g?.()`); the rule is kept stricter than that, as such a
 * value is as easily read in the body. `a?.b()` and `a.b?.()` are not matched.
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
  // esbuild compiles `a.b?.c?.()` in a parameter's default, for the browsers a
  // build still lowers optional chaining for (Chrome and Edge before 91), into
  // code that reads a variable out of its scope: the call throws a
  // ReferenceError in the built app, never under node:test. The weather shell
  // read its texture limit this way, so every satellite frame failed. Compute
  // such a value in the function's body instead.
  const offenders = [];
  for (const file of builtModules()) {
    const { code, kind } = scriptOf(file);
    const source = ts.createSourceFile(
      file,
      code,
      ts.ScriptTarget.Latest,
      true,
      kind,
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
