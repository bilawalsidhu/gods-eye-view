import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/**
 * Ownership checks for the typed transport.
 *
 * The point of the typed agent is that it adds a transport, not a second copy
 * of anything: one action runner, one tool inventory, one operating manual.
 * These assertions are what stop a later change from quietly forking any of
 * the three.
 */

const read = (file) => readFileSync(new URL(file, import.meta.url), 'utf8');
const appTools = read('../app/tools.js');
const consoleSource = read('./agentConsole.js');
const loopSource = read('./agentLoop.js');
const routes = read('../../server/providers/agent/routes.js');

test('the console runs the same action runner voice and views already drive', () => {
  // src/app/tools.js composes voiceCommands once; the console takes its
  // runner rather than constructing an action runner of its own.
  assert.match(
    appTools,
    /mountAgentConsole\(\{\s*runAction: \(name, args\) => voiceCommands\.runner\(name, args, \{ signal \}\),/,
  );
  assert.doesNotMatch(consoleSource, /createGevActionRunner/);
  assert.doesNotMatch(loopSource, /createGevActionRunner/);
});

test('the console is torn down with the application that mounted it', () => {
  assert.match(appTools, /agentConsole\.destroy\(\)/);
});

test('the server owns the tool inventory, and the browser never declares one', () => {
  assert.match(routes, /GEV_REALTIME_TOOLS/);
  for (const source of [consoleSource, loopSource]) {
    assert.doesNotMatch(source, /GEV_REALTIME_TOOLS/);
    assert.doesNotMatch(source, /actionSchemas/);
  }
});

test('the browser never holds a credential, a base URL or the manual', () => {
  for (const source of [consoleSource, loopSource]) {
    assert.doesNotMatch(source, /API_KEY/);
    assert.doesNotMatch(source, /Authorization/);
    assert.doesNotMatch(source, /api\.openai\.com|openrouter\.ai|11434/);
    assert.doesNotMatch(source, /buildAgentInstructions|instructions:/);
  }
});

test('the typed manual is read from voice, never restated', () => {
  const instructions = read('../../server/providers/agent/instructions.js');
  assert.match(instructions, /from '\.\.\/openai\/instructions\.js'/);
  // No directive text of its own beyond the handful of channel rewrites.
  assert.equal(
    (instructions.match(/anchor: \//g) || []).length,
    (instructions.match(/\n    line: /g) || []).length,
  );
});
