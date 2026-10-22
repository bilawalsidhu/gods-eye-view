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
/** A real user input boundary: the provider detected new speech. */
async function speak(controller) {
  await controller.handleRealtimeEvent({
    data: JSON.stringify({ type: 'input_audio_buffer.speech_started' }),
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

test('close-up rotation refusal instructs an explicit reset in a response with tools disabled', async () => {
  const { controller, sent } = harness(refusal);
  await invoke(controller);
  complete(controller);
  const response = sent.find(
    (event) => event.type === 'response.create',
  )?.response;
  assert.equal(response?.tool_choice, 'none');
  assert.equal(
    response.instructions,
    responseInstructionForToolResult(refusal),
  );
  assert.match(response.instructions, /do not ask a question/i);
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

test('a newer typed request drops the old refusal followup and its tool restriction', async () => {
  const { controller, sent } = harness(refusal);
  await invoke(controller);
  controller.sendTextCommand('turn the camera right');
  complete(controller);
  const responses = sent.filter((event) => event.type === 'response.create');
  assert.equal(responses.length, 1);
  assert.equal(responses[0].response?.tool_choice, undefined);
  assert.equal(controller.pendingResponseInstructions, null);
});

test('refusal instructions do not interpolate untrusted failure text or alter other tool results', () => {
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
  assert.doesNotMatch(unavailable, /Reset to Globe View and rotate the globe/);
  assert.match(unavailable, /do not offer or perform a reset/i);
  const completedReset = responseInstructionForToolResult({
    action: 'zoom_to_globe',
    ok: true,
  });
  assert.equal(
    completedReset,
    responseInstructionForToolResult({ ok: true, action: 'move_camera' }),
  );
  for (const outcome of [
    { action: 'zoom_to_globe', ok: false },
    { action: 'zoom_to_globe', ok: true, cancelled: true },
    { tool: 'zoom_to_globe', ok: false },
  ]) {
    const resetFailure = responseInstructionForToolResult({
      ...outcome,
      error: 'UNTRUSTED_ERROR',
      say: 'UNTRUSTED_SAY',
    });
    assert.notEqual(resetFailure, completedReset);
    assert.match(resetFailure, /did not finish/i);
    assert.doesNotMatch(resetFailure, /UNTRUSTED/);
  }
  assert.equal(
    responseInstructionForToolResult({
      ok: true,
      action: 'get_current_view_state',
    }),
    responseInstructionForToolResult({ ok: true, action: 'move_camera' }),
  );
});

test('globe refusal blocks same-response tools and preserves the reset instruction, but not the next response', async () => {
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
  assert.equal(
    replies[0].response.instructions,
    responseInstructionForToolResult(refusal),
  );
  // A fresh explicit reset request is a separate user input.
  await speak(controller);
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
  assert.equal(
    replies[0].response.instructions,
    responseInstructionForToolResult(refusal),
  );
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

test('rotation waits for an earlier reset before evaluating the globe', async () => {
  let finishReset;
  let atGlobe = false;
  const pending = new Promise((resolve) => {
    finishReset = resolve;
  });
  const { controller, sent, calls } = harness(async (name) => {
    if (name === 'zoom_to_globe') {
      await pending;
      atGlobe = true;
      return { ok: true, action: name };
    }
    return atGlobe
      ? { ok: true, action: name, motion: 'rotate_globe' }
      : refusal;
  });
  begin(controller);
  const reset = invoke(controller, {
    callId: 'first-reset',
    name: 'zoom_to_globe',
    args: {},
  });
  const rotation = invoke(controller);
  assert.deepEqual(calls, ['zoom_to_globe']);
  finishReset();
  await Promise.all([reset, rotation]);
  complete(controller);
  assert.deepEqual(calls, ['zoom_to_globe', 'move_camera']);
  const outputs = sent.filter(
    (event) => event.item?.type === 'function_call_output',
  );
  assert.deepEqual(
    outputs.map((event) => event.item.call_id),
    ['first-reset', 'rotation-call'],
  );
  assert.equal(JSON.parse(outputs[1].item.output).ok, true);
  const replies = sent.filter((event) => event.type === 'response.create');
  assert.equal(replies.length, 1);
  assert.equal(replies[0].response.tool_choice, undefined);
});

for (const outcome of [
  'cancelled',
  'thrown',
  'retry-refused',
  'settled-failure',
]) {
  test(`a ${outcome} reset sequence cannot suggest another reset`, async () => {
    let finishReset;
    const pending = new Promise((resolve) => {
      finishReset = resolve;
    });
    const { controller, sent, calls } = harness(async (name) => {
      if (name !== 'zoom_to_globe') return refusal;
      await pending;
      if (outcome === 'thrown') throw new Error('reset failed');
      return {
        ok: outcome === 'retry-refused',
        action: name,
        cancelled: outcome === 'cancelled',
      };
    });
    begin(controller);
    const reset = invoke(controller, {
      callId: 'failed-reset',
      name: 'zoom_to_globe',
      args: {},
    });
    if (outcome === 'settled-failure') {
      finishReset();
      await reset;
    }
    const rotation = invoke(controller);
    finishReset();
    await Promise.all([reset, rotation]);
    complete(controller);
    assert.deepEqual(
      calls,
      outcome === 'retry-refused'
        ? ['zoom_to_globe', 'move_camera']
        : ['zoom_to_globe'],
    );
    const outputs = sent.filter(
      (event) => event.item?.call_id === 'rotation-call',
    );
    assert.equal(outputs.length, 1);
    const result = JSON.parse(outputs[0].item.output);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'globe-reset-failed');
    const replies = sent.filter((event) => event.type === 'response.create');
    assert.equal(replies.length, 1);
    assert.equal(replies[0].response.tool_choice, 'none');
    assert.doesNotMatch(
      replies[0].response.instructions,
      /Reset to Globe View and rotate the globe/,
    );
  });
}

test(
  'Stop releases a rotation waiting for reset and isolates a reused response id',
  { timeout: 1000 },
  async () => {
    let finishOld, finishNew;
    const oldReset = new Promise((resolve) => {
      finishOld = resolve;
    });
    const newReset = new Promise((resolve) => {
      finishNew = resolve;
    });
    let resets = 0;
    const { controller, sent, calls } = harness((name) =>
      name === 'zoom_to_globe'
        ? ++resets === 1
          ? oldReset
          : newReset
        : { ok: true, action: name },
    );
    const oldChannel = controller.dc;
    oldChannel.close = () => {
      oldChannel.readyState = 'closed';
    };
    begin(controller);
    const old = invoke(controller, {
      callId: 'old-reset',
      name: 'zoom_to_globe',
      args: {},
    });
    const waiter = invoke(controller);
    controller.stop();
    await waiter;
    assert.deepEqual(calls, ['zoom_to_globe']);
    assert.equal(sent.length, 0);
    controller.dc = { readyState: 'open' };
    begin(controller);
    const replacement = invoke(controller, {
      callId: 'new-reset',
      name: 'zoom_to_globe',
      args: {},
    });
    const rotation = invoke(controller, { callId: 'new-rotation' });
    finishOld({ ok: false, action: 'zoom_to_globe' });
    await old;
    assert.deepEqual(calls, ['zoom_to_globe', 'zoom_to_globe']);
    assert.equal(sent.length, 0);
    finishNew({ ok: true, action: 'zoom_to_globe' });
    await Promise.all([replacement, rotation]);
    complete(controller);
    assert.deepEqual(calls, ['zoom_to_globe', 'zoom_to_globe', 'move_camera']);
    assert.deepEqual(
      sent
        .filter((event) => event.item?.type === 'function_call_output')
        .map((event) => event.item.call_id),
      ['new-reset', 'new-rotation'],
    );
  },
);

test(
  'a typed turn releases rotation without waiting for its reset runner',
  { timeout: 1000 },
  async () => {
    let finishReset;
    const pending = new Promise((resolve) => {
      finishReset = resolve;
    });
    const { controller, sent, calls } = harness(() => pending);
    delete controller.cancelRadioHandoff;
    begin(controller);
    const reset = invoke(controller, {
      callId: 'stale-first-reset',
      name: 'zoom_to_globe',
      args: {},
    });
    const rotation = invoke(controller);
    // The tool response can finish while its reset and rotation still wait.
    complete(controller);
    controller.sendTextCommand('pan left');
    await rotation;
    assert.deepEqual(calls, ['zoom_to_globe']);
    const output = sent.find(
      (event) => event.item?.call_id === 'rotation-call',
    );
    assert.equal(JSON.parse(output.item.output).superseded, true);
    assert.equal(controller.pendingResponseInstructions, null);
    begin(controller, 'typed-response');
    complete(controller, 'typed-response');
    const replies = sent.filter((event) => event.type === 'response.create');
    assert.equal(replies.length, 1);
    assert.equal(replies[0].response?.tool_choice, undefined);
    finishReset({ ok: false, action: 'zoom_to_globe' });
    await reset;
    // This protects rotation's cancellation only. Ordinary reset-result
    // follow-ups after supersession remain the inherited sibling-tool limit.
  },
);

test('an aborted reset still blocks a late same-response rotation', async () => {
  let finishReset;
  const pending = new Promise((resolve) => {
    finishReset = resolve;
  });
  const { controller, sent, calls } = harness((name) =>
    name === 'zoom_to_globe' ? pending : { ok: true, action: name },
  );
  delete controller.cancelRadioHandoff;
  begin(controller);
  const reset = invoke(controller, {
    callId: 'aborted-reset',
    name: 'zoom_to_globe',
    args: {},
  });
  try {
    await controller.handleRealtimeEvent({
      data: JSON.stringify({
        type: 'error',
        error: { code: 'conversation_already_has_active_response' },
      }),
    });
    await invoke(controller);
    assert.deepEqual(calls, ['zoom_to_globe']);
    const outputs = sent.filter(
      (event) => event.item?.call_id === 'rotation-call',
    );
    assert.equal(outputs.length, 1);
    const result = JSON.parse(outputs[0].item.output);
    assert.equal(result.skipped, true);
    assert.equal(result.reason, 'globe-reset-failed');
  } finally {
    finishReset({ ok: false, action: 'zoom_to_globe', cancelled: true });
    await reset;
  }
  complete(controller);
  assert.equal(
    sent.find((event) => event.type === 'response.create').response.tool_choice,
    'none',
  );
});

test('an earlier tool finishing late cannot replace the globe refusal followup', async () => {
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
  assert.equal(
    replies[0].response.instructions,
    responseInstructionForToolResult(refusal),
  );
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

for (const completedFirst of [false, true]) {
  test(`a newer typed turn retires its queued sibling after response completion: ${completedFirst}`, async () => {
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
    if (completedFirst) complete(controller);
    controller.sendTextCommand('pan left');
    assert.equal(oldSignal.aborted, true);
    assert.equal(abortObserved, true);
    finishRotation(refusal);
    await Promise.all([rotation, sibling]);
    if (!completedFirst) complete(controller);
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
}

test('a newer typed turn during visual context cannot revive the old refusal followup', async () => {
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

const rotated = {
  ok: true,
  action: 'move_camera',
  motion: 'rotate_globe',
  direction: 'right',
  mode: 'continuous',
};
/** A close-up camera that fits only after an executed reset. */
function closeUpCamera() {
  const state = { atGlobeView: false, resets: 0 };
  const result = (name) => {
    if (name === 'zoom_to_globe') {
      state.resets += 1;
      state.atGlobeView = true;
      return { ok: true, action: 'zoom_to_globe', cancelled: false };
    }
    return state.atGlobeView ? rotated : refusal;
  };
  return { state, result };
}
test('OpenAI: explicit reset and reset-then-rotate stay direct', async () => {
  const camera = closeUpCamera();
  const { controller, calls } = harness(camera.result);
  await speak(controller);
  begin(controller, 'reset');
  await invoke(controller, {
    responseId: 'reset',
    callId: 'explicit-reset',
    name: 'zoom_to_globe',
    args: {},
  });
  complete(controller, 'reset');
  assert.equal(camera.state.resets, 1);
  // A fresh "Reset Globe View and rotate" resets, then rotates in order.
  camera.state.atGlobeView = false;
  await speak(controller);
  begin(controller, 'both');
  await invoke(controller, {
    responseId: 'both',
    callId: 'reset-first',
    name: 'zoom_to_globe',
    args: {},
  });
  await invoke(controller, { responseId: 'both', callId: 'then-rotate' });
  complete(controller, 'both');
  assert.equal(camera.state.resets, 2);
  assert.deepEqual(calls, ['zoom_to_globe', 'zoom_to_globe', 'move_camera']);
});

test('a failed reset survives real tool followups and a rejected typed send', async () => {
  const { controller, sent, calls } = harness((name) =>
    name === 'zoom_to_globe' ? { ok: false, action: name } : rotated,
  );
  begin(controller, 'reset-response');
  await invoke(controller, {
    responseId: 'reset-response',
    callId: 'failed-reset',
    name: 'zoom_to_globe',
    args: {},
  });
  complete(controller, 'reset-response');
  assert.equal(
    sent.filter((event) => event.type === 'response.create').length,
    1,
  );
  for (const id of ['followup', 'after-rejected-text']) {
    if (id === 'after-rejected-text') {
      const send = controller.sendRealtimeEvent;
      controller.sendRealtimeEvent = (event, source) =>
        source === 'client.user_text' ? false : send(event, source);
      controller.sendTextCommand('rotate the globe');
      controller.sendRealtimeEvent = send;
    }
    begin(controller, id);
    await invoke(controller, { responseId: id, callId: `${id}-rotation` });
    complete(controller, id);
    const output = sent.find(
      (event) => event.item?.call_id === `${id}-rotation`,
    );
    assert.equal(JSON.parse(output.item.output).reason, 'globe-reset-failed');
    assert.equal(JSON.parse(output.item.output).skipped, true);
  }
  assert.deepEqual(calls, ['zoom_to_globe']);
  const reply = sent.filter((event) => event.type === 'response.create').at(-1);
  assert.equal(reply.response.tool_choice, 'none');
  assert.doesNotMatch(
    reply.response.instructions,
    /Reset to Globe View and rotate the globe/,
  );
});

test('failed reset skips waiting rotation without blocking queued Stop or lookup', async () => {
  let finishReset;
  const pending = new Promise((resolve) => {
    finishReset = resolve;
  });
  const { controller, sent, calls } = harness((name, args) =>
    name === 'zoom_to_globe'
      ? pending
      : { ok: true, action: name, motion: args.motion },
  );
  begin(controller);
  const reset = invoke(controller, {
    callId: 'pending-reset',
    name: 'zoom_to_globe',
    args: {},
  });
  const rotation = invoke(controller);
  const stop = invoke(controller, {
    callId: 'queued-stop',
    args: { motion: 'stop' },
  });
  const lookup = invoke(controller, {
    callId: 'queued-lookup',
    name: 'get_current_view_state',
    args: {},
  });
  finishReset({ ok: false, action: 'zoom_to_globe', cancelled: true });
  await Promise.all([reset, rotation, stop, lookup]);
  complete(controller);
  assert.deepEqual(calls, [
    'zoom_to_globe',
    'move_camera',
    'get_current_view_state',
  ]);
  for (const id of ['queued-stop', 'queued-lookup']) {
    const output = sent.find((event) => event.item?.call_id === id);
    assert.equal(JSON.parse(output.item.output).ok, true);
  }
  const output = sent.find((event) => event.item?.call_id === 'rotation-call');
  assert.equal(JSON.parse(output.item.output).skipped, true);
  const replies = sent.filter((event) => event.type === 'response.create');
  assert.equal(replies.length, 1);
  assert.equal(replies[0].response.tool_choice, 'none');
});

for (const input of ['text', 'speech']) {
  test(`aborted reset stays failed across followups; fresh ${input} isolates late settlement`, async () => {
    let finishReset;
    const pending = new Promise((resolve) => {
      finishReset = resolve;
    });
    const { controller, sent, calls } = harness((name) =>
      name === 'zoom_to_globe' ? pending : rotated,
    );
    delete controller.cancelRadioHandoff;
    begin(controller, 'old-reset');
    const reset = invoke(controller, {
      responseId: 'old-reset',
      callId: 'old-reset-call',
      name: 'zoom_to_globe',
      args: {},
    });
    await controller.handleRealtimeEvent({
      data: JSON.stringify({
        type: 'error',
        error: { code: 'conversation_already_has_active_response' },
      }),
    });
    complete(controller, 'old-reset');
    begin(controller, 'old-followup');
    await invoke(controller, {
      responseId: 'old-followup',
      callId: 'blocked-rotation',
    });
    assert.deepEqual(calls, ['zoom_to_globe']);
    const skipped = sent.find(
      (event) => event.item?.call_id === 'blocked-rotation',
    );
    assert.equal(JSON.parse(skipped.item.output).reason, 'globe-reset-failed');
    if (input === 'text') controller.sendTextCommand('rotate the globe');
    else await speak(controller);
    begin(controller, 'fresh');
    await invoke(controller, { responseId: 'fresh', callId: 'fresh-rotation' });
    finishReset({ ok: false, action: 'zoom_to_globe', cancelled: true });
    await reset;
    await invoke(controller, {
      responseId: 'fresh',
      callId: 'after-old-settlement',
    });
    assert.deepEqual(calls, ['zoom_to_globe', 'move_camera', 'move_camera']);
  });
}

test('a real tool followup waits for a reset still pending in the previous response', async () => {
  let finishReset;
  const pending = new Promise((resolve) => {
    finishReset = resolve;
  });
  const { controller, sent, calls } = harness((name) =>
    name === 'zoom_to_globe' ? pending : { ok: true, action: name },
  );
  begin(controller, 'reset-response');
  const reset = invoke(controller, {
    responseId: 'reset-response',
    callId: 'pending-reset',
    name: 'zoom_to_globe',
    args: {},
  });
  await invoke(controller, {
    responseId: 'reset-response',
    callId: 'fast-lookup',
    name: 'get_current_view_state',
    args: {},
  });
  complete(controller, 'reset-response');
  assert.equal(
    sent.filter((event) => event.type === 'response.create').length,
    1,
  );
  assert.equal(
    JSON.parse(
      sent.find((event) => event.item?.call_id === 'fast-lookup').item.output,
    ).ok,
    true,
  );
  begin(controller, 'followup');
  const rotation = invoke(controller, {
    responseId: 'followup',
    callId: 'waiting-rotation',
  });
  assert.deepEqual(calls, ['zoom_to_globe', 'get_current_view_state']);
  finishReset({ ok: true, action: 'zoom_to_globe' });
  await Promise.all([reset, rotation]);
  assert.deepEqual(calls, [
    'zoom_to_globe',
    'get_current_view_state',
    'move_camera',
  ]);
  assert.equal(
    sent.filter((event) => event.item?.call_id === 'waiting-rotation').length,
    1,
  );
});

test('a recoverable collision keeps a completed reset successful for its rotation', async () => {
  const { controller, sent, calls } = harness((name) =>
    name === 'zoom_to_globe'
      ? { ok: true, action: name }
      : { ok: true, action: name, motion: 'rotate_globe' },
  );
  delete controller.cancelRadioHandoff;
  begin(controller);
  await invoke(controller, {
    callId: 'done-reset',
    name: 'zoom_to_globe',
    args: {},
  });
  await controller.handleRealtimeEvent({
    data: JSON.stringify({
      type: 'error',
      error: { code: 'conversation_already_has_active_response' },
    }),
  });
  await invoke(controller);
  complete(controller);
  assert.deepEqual(calls, ['zoom_to_globe', 'move_camera']);
  const output = sent.find((event) => event.item?.call_id === 'rotation-call');
  assert.equal(JSON.parse(output.item.output).ok, true);
});

test('an old response reset cannot poison a fresh spoken rotation request', async () => {
  for (const lateReset of [false, true]) {
    const { controller, calls } = harness((name) =>
      name === 'zoom_to_globe'
        ? { ok: false, action: name }
        : { ok: true, action: name, motion: 'rotate_globe' },
    );
    // Use the production speech-start cancellation wiring, not the harness stub.
    delete controller.cancelRadioHandoff;
    begin(controller, 'old-reset-response');
    if (lateReset) await speak(controller);
    await invoke(controller, {
      responseId: 'old-reset-response',
      callId: 'old-reset',
      name: 'zoom_to_globe',
      args: {},
    });
    if (!lateReset) await speak(controller);
    begin(controller, 'fresh-rotation-response');
    await invoke(controller, {
      responseId: 'fresh-rotation-response',
      callId: 'fresh-rotation',
    });
    assert.deepEqual(
      calls,
      ['zoom_to_globe', 'move_camera'],
      lateReset
        ? 'late old reset must retain its original request'
        : 'fresh speech clears prior reset failure',
    );
  }
});

test('a late rotation without a reset retains existing arrival-time policy', async () => {
  const { controller, calls } = harness({
    ok: true,
    action: 'move_camera',
    motion: 'rotate_globe',
  });
  delete controller.cancelRadioHandoff;
  begin(controller, 'old-rotation-response');
  await speak(controller);
  await invoke(controller, {
    responseId: 'old-rotation-response',
    callId: 'late-rotation',
  });
  assert.deepEqual(calls, ['move_camera']);
});
