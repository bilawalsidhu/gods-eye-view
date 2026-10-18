import assert from 'node:assert/strict';
import test from 'node:test';
import { GevRealtimeController } from './realtimeController.js';
import { responseInstructionForToolResult } from './realtimeProtocol.js';

const refusal = {
  ok: false,
  action: 'move_camera',
  reason: 'globe-view-required',
};

function harness(result) {
  const sent = [];
  const controller = new GevRealtimeController({
    ui: {},
    runner: async () => result,
  });
  controller.dc = { readyState: 'open' };
  controller.sendRealtimeEvent = (event) => {
    sent.push(event);
    return true;
  };
  controller.debugLog = () => {};
  controller.setStatus = () => {};
  controller.setVoiceSpeaker = () => {};
  controller.recordUsage = () => {};
  controller.captureViewportScreenshot = async () => null;
  controller.cancelRadioHandoff = () => {};
  return { controller, sent };
}

async function invoke(controller) {
  await controller.handleRealtimeEvent({
    data: JSON.stringify({
      type: 'response.function_call_arguments.done',
      response_id: 'rotation-response',
      item_id: 'rotation-item',
      call_id: 'rotation-call',
      name: 'move_camera',
      arguments: JSON.stringify({ motion: 'rotate_globe' }),
    }),
  });
}
function complete(controller) {
  controller.updateResponseState({
    type: 'response.done',
    response: { id: 'rotation-response', status: 'completed' },
  });
}

test('close-up rotation refusal asks permission in a response with tools disabled', async () => {
  const { controller, sent } = harness(refusal);
  await invoke(controller);
  complete(controller);
  const response = sent.find(
    (event) => event.type === 'response.create',
  )?.response;
  assert.equal(response?.tool_choice, 'none');
  assert.match(response.instructions, /ask/i);
  assert.match(response.instructions, /wait for the user/i);
  assert.doesNotMatch(response.instructions, /confirm the completed/);
});

test('normal camera success retains the existing unrestricted followup', async () => {
  const { controller, sent } = harness({
    ok: true,
    action: 'move_camera',
    motion: 'rotate',
  });
  await invoke(controller);
  complete(controller);
  const response = sent.find(
    (event) => event.type === 'response.create',
  )?.response;
  assert.equal(typeof response?.instructions, 'string');
  assert.equal(Object.hasOwn(response, 'tool_choice'), false);
});

test('a newer typed request drops the old permission followup and its tool restriction', async () => {
  const { controller, sent } = harness(refusal);
  await invoke(controller);
  controller.sendTextCommand('turn the camera right');
  complete(controller);
  const responses = sent.filter((event) => event.type === 'response.create');
  assert.equal(responses.length, 1);
  assert.equal(responses[0].response?.tool_choice, undefined);
  assert.equal(controller.pendingResponseInstructions, null);
});

test('permission instructions do not interpolate untrusted failure text or alter other tool results', () => {
  const instruction = responseInstructionForToolResult({
    ...refusal,
    error: 'UNTRUSTED_ERROR',
    say: 'UNTRUSTED_SAY',
  });
  assert.doesNotMatch(instruction, /UNTRUSTED/);
  assert.equal(
    responseInstructionForToolResult({
      ok: true,
      action: 'get_current_view_state',
    }),
    responseInstructionForToolResult({ ok: true, action: 'move_camera' }),
  );
});
