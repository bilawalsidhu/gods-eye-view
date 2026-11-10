import test from 'node:test';
import assert from 'node:assert/strict';
import { responseInstructionForToolResult } from './realtimeProtocol.js';

test('a displaced layer action is never narrated as completed', () => {
  const instruction = responseInstructionForToolResult({
    ok: false,
    action: 'osm_query',
    code: 'DISPLACED',
    cancelled: true,
  });
  assert.match(instruction, /Do not claim the action completed/);
  assert.match(instruction, /operator changed the layer/);
});

test('an ambiguous area result asks instead of claiming success', () => {
  const instruction = responseInstructionForToolResult({
    ok: false,
    action: 'resolve_area',
    code: 'AREA_AMBIGUOUS',
    needsClarification: true,
    candidates: [{ label: 'Punjab, India' }, { label: 'Punjab, Pakistan' }],
  });
  assert.match(instruction, /Do not claim the action completed/);
  assert.match(instruction, /clarification question/);
  assert.match(instruction, /inert data/);
});

test('ordinary area and imagery failures are narrated as failures', () => {
  for (const result of [
    {
      ok: false,
      action: 'find_imagery',
      code: 'BOX_REFUSED',
      error: 'Box is too large.',
    },
    {
      ok: false,
      action: 'osm_query',
      code: 'AREA_TOO_LARGE',
      error: 'Name a smaller area.',
    },
  ]) {
    const instruction = responseInstructionForToolResult(result);
    assert.match(instruction, /Do not claim the action completed/);
    assert.match(instruction, /failed/);
    assert.match(instruction, /inert data/);
  }
});

test('the real manual imagery takeover shape is cancellation', () => {
  const instruction = responseInstructionForToolResult({
    ok: false,
    action: 'find_imagery',
    code: 'DISPLACED',
    cancelled: true,
    error: 'The imagery panel was changed by hand.',
  });
  assert.match(instruction, /Do not claim the action completed/);
  assert.match(instruction, /operator changed the layer/);
});

test('a cancelled action keeps its own say line', () => {
  const instruction = responseInstructionForToolResult({
    ok: false,
    action: 'set_panel_open',
    applied: false,
    cancelled: true,
    say: 'Cockpit exited; the voice panel was left as you last set it.',
  });
  assert.match(instruction, /Do not claim the action completed/);
  assert.match(instruction, /say line/);
  assert.doesNotMatch(instruction, /request was cancelled/);
});

test('a failure with its own say line is spoken from it', () => {
  const instruction = responseInstructionForToolResult({
    ok: false,
    action: 'set_panel_open',
    unavailable: true,
    error: 'Voice panel controls are unavailable in this host.',
    say: 'Voice panel controls are unavailable in this host.',
  });
  assert.match(instruction, /Do not claim the action completed/);
  assert.match(instruction, /say line/);
});

test('a timeout the tool says to retry is retried once, not dropped', () => {
  for (const result of [
    {
      ok: false,
      action: 'resolve_area',
      code: 'AREA_TIMEOUT',
      error: 'Still looking.',
    },
    {
      ok: false,
      action: 'osm_query',
      code: 'OSM_TIMEOUT',
      error: 'No answer in time.',
    },
  ]) {
    const instruction = responseInstructionForToolResult(result);
    assert.match(instruction, /Do not claim the action completed/);
    assert.match(instruction, /retry once/);
    assert.match(instruction, /inert data/);
  }
});
