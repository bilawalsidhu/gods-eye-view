import test from 'node:test';
import assert from 'node:assert/strict';
import {
  realtimeDirectives,
  realtimeInstructions,
} from '../../server/providers/openai/instructions.js';
import {
  TEXT_ADAPTATIONS,
  adaptDirectives,
  agentDirectives,
  buildAgentInstructions,
} from '../../server/providers/agent/instructions.js';

test('voice keeps the manual it already had, as the same joined string', () => {
  const directives = realtimeDirectives();
  assert.ok(
    directives.length > 40,
    `expected the full manual, saw ${directives.length}`,
  );
  assert.equal(realtimeInstructions(), directives.join('\n'));
  assert.match(directives[0], /^You are GEV Voice Control,/);
});

test('every text adaptation matches exactly one voice directive', () => {
  const report = adaptDirectives(realtimeDirectives());
  assert.deepEqual(
    report.unmatched.map(String),
    [],
    'a voice directive was reworded; update its text adaptation',
  );
  assert.deepEqual(report.ambiguous.map(String), []);
  assert.equal(report.directives.length, realtimeDirectives().length);
});

test('the typed manual is the voice manual with only the channel lines changed', () => {
  const voice = realtimeDirectives();
  const text = agentDirectives();
  const changed = voice.filter((line, index) => line !== text[index]);
  assert.equal(changed.length, TEXT_ADAPTATIONS.length);
  // Everything else is shared verbatim: that is the point of reading voice's
  // list instead of keeping a copy.
  assert.equal(
    voice.filter((line, index) => line === text[index]).length,
    voice.length - TEXT_ADAPTATIONS.length,
  );
});

test('the typed manual never tells the model to speak into a microphone', () => {
  for (const line of agentDirectives()) {
    assert.doesNotMatch(line, /voice controller/i);
    assert.doesNotMatch(line, /spoken conversation/i);
    assert.doesNotMatch(line, /mic session/i);
    assert.doesNotMatch(line, /without speaking first/i);
  }
});

test('the typed manual keeps the product contracts voice encodes', () => {
  const instructions = buildAgentInstructions();
  assert.match(instructions, /^You are GEV Command,/);
  assert.match(instructions, /COUNTING CONTRACT/);
  assert.match(instructions, /WHITEBOARD THE WORLD/);
  assert.match(instructions, /Never claim an action without ok=true/);
  assert.match(instructions, /NAMED VIEWS/);
});

test('annotation guidance passes through to the typed manual', () => {
  const guidance = 'Mark only what the operator asked for.';
  assert.match(
    buildAgentInstructions({ annotationGuidance: guidance }),
    /Mark only what the operator asked for\./,
  );
});

test('adaptDirectives reports an anchor that matches nothing', () => {
  const report = adaptDirectives(
    ['a line'],
    [{ anchor: /^nothing here/, line: 'replacement' }],
  );
  assert.equal(report.unmatched.length, 1);
  assert.deepEqual(report.directives, ['a line']);
});

test('adaptDirectives reports an anchor that matches more than one line', () => {
  const report = adaptDirectives(
    ['PREFIX one', 'PREFIX two'],
    [{ anchor: /^PREFIX/, line: 'replacement' }],
  );
  assert.equal(report.ambiguous.length, 1);
  assert.deepEqual(report.directives, ['replacement', 'replacement']);
});

test('adaptDirectives tolerates a non-array input', () => {
  assert.deepEqual(adaptDirectives(null).directives, []);
});
