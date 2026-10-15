import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// controls.js and the shell import browser-only UI modules, so these read the
// source: the scene engine is threaded to the shell, which hands it (not the
// viewer) to the world overlay. initWorldOverlay itself is tested on the fake
// engine without a viewer (src/overlays/worldOverlay.test.mjs).
const read = (relative) =>
  readFileSync(new URL(relative, import.meta.url), 'utf8');

test('the controls pass the scene engine to the shell', () => {
  const controls = read('./controls.js');
  assert.match(controls, /scene: \{ viewer, engine, mapStackController, operations \}/);
  assert.match(controls, /new Controls\(viewer, \{[\s\S]*?\n\s+engine,\n/);
});

test('the shell initializes the world overlay on its engine', () => {
  const shell = read('../ui/applicationShell.js');
  assert.match(
    shell,
    /\{\n\s+engine = engineFromViewer\(viewer\),\n\s+mapStackController = null,/,
  );
  assert.match(shell, /initWorldOverlay\(engine\);/);
  assert.doesNotMatch(shell, /initWorldOverlay\(viewer\)/);
});
