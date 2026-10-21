import assert from 'node:assert/strict';
import test from 'node:test';
import { GevRealtimeController } from './realtimeController.js';
import {
  CALL_DEDUPE_MS,
  responseInstructionForToolResult,
} from './realtimeProtocol.js';

const refusal = {
  ok: false,
  action: 'move_camera',
  reason: 'globe-view-required',
};

function harness(result) {
  const sent = [];
  const calls = [];
  const controller = new GevRealtimeController({
    ui: {},
    runner: async (name, args, context) => {
      calls.push(name);
      return typeof result === 'function'
        ? result(name, args, context)
        : result;
    },
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
  return { controller, sent, calls };
}

async function invoke(
  controller,
  {
    responseId = 'rotation-response',
    callId = 'rotation-call',
    name = 'move_camera',
    args = { motion: 'rotate_globe' },
  } = {},
) {
  await controller.handleRealtimeEvent({
    data: JSON.stringify({
      type: 'response.function_call_arguments.done',
      response_id: responseId,
      item_id: `${callId}-item`,
      call_id: callId,
      name,
      arguments: JSON.stringify(args),
    }),
  });
}
function begin(controller, id = 'rotation-response') {
  controller.updateResponseState({
    type: 'response.created',
    response: { id },
  });
}
function complete(controller, id = 'rotation-response') {
  controller.updateResponseState({
    type: 'response.done',
    response: { id, status: 'completed' },
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
  const unavailable = responseInstructionForToolResult({
    ...refusal,
    reason: 'globe-reset-unavailable',
  });
  assert.doesNotMatch(unavailable, /Reset to Globe View and rotate\?/);
  assert.match(unavailable, /do not offer or perform a reset/i);
  assert.equal(
    responseInstructionForToolResult({
      ok: true,
      action: 'get_current_view_state',
    }),
    responseInstructionForToolResult({ ok: true, action: 'move_camera' }),
  );
});

test('globe refusal blocks same-response tools and preserves permission, but not the next response', async () => {
  const { controller, sent, calls } = harness((name) =>
    name === 'move_camera' ? refusal : { ok: true, action: name },
  );
  begin(controller);
  await invoke(controller);
  await invoke(controller, {
    callId: 'reset-call',
    name: 'zoom_to_globe',
    args: {},
  });
  // The second delivery of the original call must not produce another output.
  await invoke(controller);
  complete(controller);
  assert.deepEqual(calls, ['move_camera']);
  const outputs = sent.filter(
    (event) => event.item?.type === 'function_call_output',
  );
  assert.deepEqual(
    outputs.map((event) => event.item.call_id),
    ['rotation-call', 'reset-call'],
  );
  assert.equal(JSON.parse(outputs[1].item.output).ok, false);
  const replies = sent.filter((event) => event.type === 'response.create');
  assert.equal(replies.length, 1);
  assert.equal(replies[0].response.tool_choice, 'none');
  assert.match(replies[0].response.instructions, /ask/i);
  begin(controller, 'fresh-response');
  await invoke(controller, {
    responseId: 'fresh-response',
    callId: 'fresh-reset',
    name: 'zoom_to_globe',
    args: {},
  });
  complete(controller, 'fresh-response');
  assert.deepEqual(calls, ['move_camera', 'zoom_to_globe']);
  assert.equal(
    sent.filter((event) => event.type === 'response.create').at(-1).response
      .tool_choice,
    undefined,
  );
});

test('a reset arriving during pending globe admission cannot bypass the refusal', async () => {
  let finishRotation;
  const pending = new Promise((resolve) => {
    finishRotation = resolve;
  });
  const { controller, sent, calls } = harness((name) =>
    name === 'move_camera' ? pending : { ok: true, action: name },
  );
  begin(controller);
  const rotation = invoke(controller, { args: { motion: 'ROTATE_GLOBE' } });
  const reset = invoke(controller, {
    callId: 'overlap-reset',
    name: 'zoom_to_globe',
    args: {},
  });
  finishRotation(refusal);
  await Promise.all([rotation, reset]);
  complete(controller);
  assert.deepEqual(calls, ['move_camera']);
  const outputs = sent.filter(
    (event) => event.item?.type === 'function_call_output',
  );
  assert.equal(outputs.length, 2);
  assert.equal(
    JSON.parse(
      outputs.find((event) => event.item.call_id === 'overlap-reset').item
        .output,
    ).ok,
    false,
  );
  const replies = sent.filter((event) => event.type === 'response.create');
  assert.equal(replies.length, 1);
  assert.equal(replies[0].response.tool_choice, 'none');
  assert.match(replies[0].response.instructions, /ask/i);
});

test('successful pending globe admission releases a queued ordinary tool', async () => {
  let finishRotation;
  const pending = new Promise((resolve) => {
    finishRotation = resolve;
  });
  const { controller, sent, calls } = harness((name) =>
    name === 'move_camera' ? pending : { ok: true, action: name },
  );
  begin(controller);
  const rotation = invoke(controller);
  const reset = invoke(controller, {
    callId: 'allowed-reset',
    name: 'zoom_to_globe',
    args: {},
  });
  assert.deepEqual(calls, ['move_camera']);
  finishRotation({ ok: true, action: 'move_camera', motion: 'rotate_globe' });
  await Promise.all([rotation, reset]);
  complete(controller);
  assert.deepEqual(calls, ['move_camera', 'zoom_to_globe']);
  assert.equal(
    sent.filter((event) => event.type === 'response.create').at(-1).response
      .tool_choice,
    undefined,
  );
});

test('an earlier tool finishing late cannot replace the globe permission followup', async () => {
  let finishLookup;
  const pending = new Promise((resolve) => {
    finishLookup = resolve;
  });
  const { controller, sent, calls } = harness((name) =>
    name === 'move_camera' ? refusal : pending,
  );
  begin(controller);
  const lookup = invoke(controller, {
    callId: 'lookup-call',
    name: 'get_current_view_state',
    args: {},
  });
  await invoke(controller);
  finishLookup({ ok: true, action: 'get_current_view_state' });
  await lookup;
  complete(controller);
  assert.deepEqual(calls, ['get_current_view_state', 'move_camera']);
  assert.equal(
    sent.filter((event) => event.item?.type === 'function_call_output').length,
    2,
  );
  const replies = sent.filter((event) => event.type === 'response.create');
  assert.equal(replies.length, 1);
  assert.equal(replies[0].response.tool_choice, 'none');
  assert.match(replies[0].response.instructions, /ask/i);
});

test('a duplicate queued behind successive admissions cannot outlive the dedupe window', async (t) => {
  let clock = 0;
  t.mock.method(performance, 'now', () => clock);
  let finishFirst, finishSecond, secondStarted;
  const first = new Promise((resolve) => {
    finishFirst = resolve;
  });
  const second = new Promise((resolve) => {
    finishSecond = resolve;
  });
  const enteredSecond = new Promise((resolve) => {
    secondStarted = resolve;
  });
  let executions = 0;
  const { controller, sent, calls } = harness(() => {
    if (++executions === 1) return first;
    secondStarted();
    return second;
  });
  begin(controller);
  const original = invoke(controller);
  const queued = invoke(controller, { callId: 'queued-rotation' });
  const duplicate = controller.handleRealtimeEvent({
    data: JSON.stringify({
      type: 'response.output_item.done',
      response_id: 'rotation-response',
      item: {
        type: 'function_call',
        id: 'queued-rotation-item',
        call_id: 'queued-rotation',
        name: 'move_camera',
        arguments: JSON.stringify({ motion: 'rotate_globe' }),
      },
    }),
  });
  finishFirst({ ok: true, action: 'move_camera', motion: 'rotate_globe' });
  await enteredSecond;
  clock += CALL_DEDUPE_MS + 1;
  finishSecond({ ok: true, action: 'move_camera', motion: 'rotate_globe' });
  await Promise.all([original, queued, duplicate]);
  complete(controller);
  assert.deepEqual(calls, ['move_camera', 'move_camera']);
  const outputs = sent.filter(
    (event) => event.item?.type === 'function_call_output',
  );
  assert.deepEqual(
    outputs.map((event) => event.item.call_id),
    ['rotation-call', 'queued-rotation'],
  );
  assert.equal(
    sent.filter((event) => event.type === 'response.create').length,
    1,
  );
});

test(
  'Stop releases an admission waiter and stale completion cannot affect its replacement',
  { timeout: 1000 },
  async () => {
    let finishRotation;
    const pending = new Promise((resolve) => {
      finishRotation = resolve;
    });
    const { controller, sent, calls } = harness((name) =>
      name === 'move_camera' ? pending : { ok: true, action: name },
    );
    const oldChannel = controller.dc;
    oldChannel.close = () => {
      oldChannel.readyState = 'closed';
    };
    begin(controller);
    const rotation = invoke(controller);
    const queued = invoke(controller, {
      callId: 'stopped-reset',
      name: 'zoom_to_globe',
      args: {},
    });
    controller.stop();
    await queued; // Must settle even though the original runner has not completed.
    assert.equal(oldChannel.readyState, 'closed');
    assert.deepEqual(calls, ['move_camera']);
    assert.equal(sent.length, 0);
    controller.dc = { readyState: 'open' };
    begin(controller); // Reuse the id to expose any leaked old refusal state.
    finishRotation(refusal);
    await rotation;
    assert.equal(sent.length, 0);
    await invoke(controller, {
      callId: 'replacement-reset',
      name: 'zoom_to_globe',
      args: {},
    });
    complete(controller);
    assert.deepEqual(calls, ['move_camera', 'zoom_to_globe']);
    const outputs = sent.filter(
      (event) => event.item?.type === 'function_call_output',
    );
    assert.deepEqual(
      outputs.map((event) => event.item.call_id),
      ['replacement-reset'],
    );
    assert.equal(JSON.parse(outputs[0].item.output).ok, true);
    assert.equal(
      sent.find((event) => event.type === 'response.create').response
        .tool_choice,
      undefined,
    );
  },
);

test('a newer typed turn aborts pending admission and retires its queued sibling', async () => {
  let finishRotation;
  let oldSignal;
  let abortObserved = false;
  const pending = new Promise((resolve) => {
    finishRotation = resolve;
  });
  const { controller, sent, calls } = harness((name, args, context) => {
    if (args.motion === 'rotate_globe') {
      oldSignal = context.signal;
      oldSignal.addEventListener('abort', () => {
        abortObserved = true;
      });
      return pending;
    }
    return { ok: true, action: name };
  });
  // Use the actual cancellation owner rather than the lightweight harness stub.
  delete controller.cancelRadioHandoff;
  begin(controller);
  const rotation = invoke(controller);
  const sibling = invoke(controller, {
    callId: 'stale-reset',
    name: 'zoom_to_globe',
    args: {},
  });
  controller.sendTextCommand('pan left');
  assert.equal(oldSignal.aborted, true);
  assert.equal(abortObserved, true);
  finishRotation(refusal);
  await Promise.all([rotation, sibling]);
  complete(controller);
  const outputs = sent.filter(
    (event) => event.item?.type === 'function_call_output',
  );
  assert.deepEqual(
    outputs.map((event) => event.item.call_id),
    ['rotation-call', 'stale-reset'],
  );
  assert.equal(JSON.parse(outputs[1].item.output).superseded, true);
  assert.deepEqual(calls, ['move_camera']);
  const replies = sent.filter((event) => event.type === 'response.create');
  assert.equal(replies.length, 1);
  assert.equal(replies[0].response?.tool_choice, undefined);
  assert.equal(controller.pendingResponseInstructions, null);
  begin(controller, 'new-turn-response');
  await invoke(controller, {
    responseId: 'new-turn-response',
    callId: 'new-pan',
    args: { motion: 'pan', direction: 'left' },
  });
  complete(controller, 'new-turn-response');
  assert.deepEqual(calls, ['move_camera', 'move_camera']);
  const finalOutput = sent
    .filter((event) => event.item?.type === 'function_call_output')
    .at(-1);
  assert.equal(finalOutput.item.call_id, 'new-pan');
  assert.equal(JSON.parse(finalOutput.item.output).ok, true);
  assert.equal(
    sent.filter((event) => event.type === 'response.create').at(-1).response
      ?.tool_choice,
    undefined,
  );
});

test('a newer typed turn during visual context cannot revive the old permission followup', async () => {
  let finishContext;
  let enterContext;
  const entered = new Promise((resolve) => {
    enterContext = resolve;
  });
  const pending = new Promise((resolve) => {
    finishContext = resolve;
  });
  const { controller, sent } = harness(refusal);
  controller.setStatus = (status) => {
    controller.status = status;
  };
  delete controller.cancelRadioHandoff;
  controller.sendVisualContextIfUseful = async () => {
    enterContext();
    await pending;
  };
  begin(controller);
  const rotation = invoke(controller);
  await entered;
  controller.sendTextCommand('pan left');
  finishContext();
  await rotation;
  complete(controller);
  assert.equal(controller.status, 'listening');
  assert.equal(
    sent.filter((event) => event.item?.type === 'function_call_output').length,
    1,
  );
  const replies = sent.filter((event) => event.type === 'response.create');
  assert.equal(replies.length, 1);
  assert.equal(replies[0].response?.tool_choice, undefined);
  assert.equal(controller.pendingResponseInstructions, null);
});

test('stale globe completion preserves a newer tool status until that tool finishes', async () => {
  let finishContext;
  let enterContext;
  let finishPan;
  const entered = new Promise((resolve) => {
    enterContext = resolve;
  });
  const pendingContext = new Promise((resolve) => {
    finishContext = resolve;
  });
  const pendingPan = new Promise((resolve) => {
    finishPan = resolve;
  });
  const { controller, sent } = harness((name, args) =>
    args.motion === 'rotate_globe' ? refusal : pendingPan,
  );
  controller.setStatus = (status) => {
    controller.status = status;
  };
  delete controller.cancelRadioHandoff;
  controller.sendVisualContextIfUseful = async (result) => {
    if (result === refusal) {
      enterContext();
      await pendingContext;
    }
  };
  begin(controller);
  const rotation = invoke(controller);
  await entered;
  controller.sendTextCommand('pan left');
  complete(controller);
  begin(controller, 'new-pan-response');
  const pan = invoke(controller, {
    responseId: 'new-pan-response',
    callId: 'new-pan-call',
    args: { motion: 'pan', direction: 'left' },
  });
  assert.equal(controller.status, 'executing');
  finishContext();
  await rotation;
  assert.equal(controller.status, 'executing');
  assert.equal(controller.pendingResponseInstructions, null);
  finishPan({ ok: true, action: 'move_camera', motion: 'pan' });
  await pan;
  complete(controller, 'new-pan-response');
  assert.equal(controller.status, 'listening');
  assert.equal(
    sent.filter((event) => event.item?.type === 'function_call_output').length,
    2,
  );
  assert.equal(
    sent
      .filter((event) => event.type === 'response.create')
      .every((event) => event.response?.tool_choice === undefined),
    true,
  );
});
