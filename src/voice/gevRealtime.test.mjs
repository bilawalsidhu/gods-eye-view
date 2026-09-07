import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeDownscale,
  estimateDataUrlBytes,
  gateVoiceVisualizerLevel,
  isBenignViewportDeleteError,
  isPushToTalkKey,
  resolveVoiceControlHint,
  resolveVoiceVisualizerSpeaker,
  selectVoiceVisualizerSignal,
  shouldHandlePushToTalkKeyDown,
  shouldIgnoreVoiceButtonClick,
} from './gevRealtime.js';
import {
  FOUNDRY_REALTIME_INSTRUCTIONS,
  FOUNDRY_REALTIME_TOOLS,
} from './foundrySession.js';

test('push-to-talk accepts Space and ignores typing or modified shortcuts', () => {
  const target = { isContentEditable: false, closest: () => null };
  assert.equal(isPushToTalkKey({ code: 'Space' }), true);
  assert.equal(shouldHandlePushToTalkKeyDown({ code: 'Space', target }), true);
  assert.equal(shouldHandlePushToTalkKeyDown({ code: 'Space', target, ctrlKey: true }), false);
  assert.equal(shouldIgnoreVoiceButtonClick(true), true);
  assert.equal(resolveVoiceControlHint(true, true), 'Release Space to send');
});

test('visualizer selects the active speaker and applies a noise gate', () => {
  const input = { analyser: { id: 'mic' }, data: new Uint8Array([1]) };
  const output = { analyser: { id: 'speaker' }, data: new Uint8Array([2]) };
  assert.equal(selectVoiceVisualizerSignal('user', input, output), input);
  assert.equal(selectVoiceVisualizerSignal('ai', input, output), output);
  assert.equal(resolveVoiceVisualizerSpeaker('ai', 'idle', true), 'ai');
  assert.equal(gateVoiceVisualizerLevel(0.05, 0.12), 0);
  assert.ok(gateVoiceVisualizerLevel(0.5, 0.12) > 0);
});

test('viewport capture guards preserve aspect ratio under the payload budget', () => {
  const scaled = computeDownscale(3840, 2160, 1200 * 900);
  assert.ok(scaled.width * scaled.height <= 1200 * 900);
  assert.ok(Math.abs(scaled.width / scaled.height - 16 / 9) < 0.01);
  assert.equal(estimateDataUrlBytes('data:image/jpeg;base64,AAAA'), 3);
});

test('stale viewport delete errors remain non-fatal', () => {
  assert.equal(isBenignViewportDeleteError({
    type: 'error',
    error: { code: 'item_not_found' },
  }, new Set()), true);
  assert.equal(isBenignViewportDeleteError({
    type: 'error',
    event_id: 'other',
    error: { code: 'server_error' },
  }, new Set(['owned'])), false);
});

test('Foundry voice session exposes only supported map and annotation tools', () => {
  const names = FOUNDRY_REALTIME_TOOLS.map(({ name }) => name);
  assert.ok(names.includes('fly_to_location'));
  assert.ok(names.includes('set_map_stack'));
  assert.ok(names.includes('annotate_map'));
  assert.ok(!names.includes('control_drone_mission'), 'drone voice control is deferred');
  const mapTool = FOUNDRY_REALTIME_TOOLS.find(({ name }) => name === 'set_map_stack');
  assert.deepEqual(mapTool.parameters.properties.stack.enum, [
    'azure-satellite', 'azure-hybrid', 'azure-streets', 'osm',
  ]);
  assert.match(FOUNDRY_REALTIME_INSTRUCTIONS, /Azure Satellite/);
});
