import assert from 'node:assert/strict';
import test from 'node:test';
import { GevRealtimeController } from './realtimeController.js';

function fixture({ pointer = null, onUserSend = () => {} } = {}) {
  const sent = [];
  const executed = [];
  const rejectedTexts = new Set();
  let rejectResponse = false;
  const controller = new GevRealtimeController({
    runner: async (name) => {
      executed.push(name);
      return { ok: true };
    },
    backend: {},
    debugSink: null,
    pointer,
    ui: {
      root: {
        dataset: {},
        classList: { remove() {} },
        querySelectorAll: () => [],
      },
      status: {},
      detail: {},
    },
  });
  controller.dc = {
    readyState: 'open',
    send(body) {
      const value = JSON.parse(body);
      const text = value.item?.role === 'user' && value.item.content?.[0]?.text;
      if (value.item?.role === 'user') onUserSend();
      if (
        rejectedTexts.has(text) ||
        (rejectResponse && value.type === 'response.create')
      )
        throw new Error('Synthetic channel rejection');
      sent.push(value);
    },
    close() {
      this.readyState = 'closed';
    },
  };
  controller.status = 'listening';
  controller._turns.narration = null;
  const event = (payload) =>
    controller.handleRealtimeEvent({ data: JSON.stringify(payload) });
  const created = (id) => event({ type: 'response.created', response: { id } });
  const done = (id) =>
    event({
      type: 'response.done',
      response: { id, status: 'completed', output: [] },
    });
  const creates = () =>
    sent.filter(
      (x) =>
        x.type === 'response.create' &&
        x.response?.metadata?.gev !== 'progress',
    );
  const texts = () =>
    sent
      .filter((x) => x.item?.role === 'user')
      .map((x) => x.item.content[0].text);
  return {
    controller,
    sent,
    executed,
    rejectedTexts,
    event,
    created,
    done,
    creates,
    texts,
    rejectResponses(value) {
      rejectResponse = value;
    },
  };
}

test('rejected idle text schedules no answer, and a successful successor answers once', async () => {
  const f = fixture();
  try {
    f.rejectedTexts.add('rejected');
    assert.equal(f.controller.sendTextCommand('rejected'), undefined);
    assert.equal(f.creates().length, 0);
    assert.equal(f.controller.pendingUserTextResponse, false);
    assert.equal(f.controller.responseCreatePending, false);
    assert.equal(f.controller.sendTextCommand('successor'), undefined);
    assert.deepEqual(f.texts(), ['successor']);
    assert.equal(f.creates().length, 1);
    await f.created('successor');
    await f.done('successor');
    assert.equal(f.creates().length, 1);
  } finally {
    f.controller.stop();
  }
});

test('rejected text behind an active response cannot queue an answer', async () => {
  const f = fixture();
  try {
    await f.created('active');
    f.controller.queueResponseCreate('Old tool follow-up');
    assert.equal(
      f.controller.pendingResponseInstructions,
      'Old tool follow-up',
    );
    const runningTool = new AbortController();
    f.controller._turns.activeToolAbortControllers.add(runningTool);
    f.rejectedTexts.add('rejected');
    f.controller.sendTextCommand('rejected');
    assert.equal(f.controller.pendingUserTextResponse, false);
    assert.equal(f.controller.pendingResponseInstructions, null);
    assert.equal(f.controller._turns.isSupersededResponse('active'), true);
    assert.equal(runningTool.signal.aborted, true);
    const staleCall = {
      type: 'response.function_call_arguments.done',
      response_id: 'active',
      call_id: 'stale-call',
      name: 'fly_to_location',
      arguments: '{"query":"Paris"}',
    };
    await f.event(staleCall);
    await f.event(staleCall);
    assert.deepEqual(f.executed, []);
    const outputs = f.sent.filter(
      (x) => x.item?.type === 'function_call_output',
    );
    assert.equal(outputs.length, 1);
    assert.equal(outputs[0].item.call_id, 'stale-call');
    assert.equal(JSON.parse(outputs[0].item.output).superseded, true);
    await f.done('active');
    assert.equal(f.creates().length, 0);
  } finally {
    f.controller.stop();
  }
});

test('rejected text still prepares narration and pointer context before sending', () => {
  const steps = [];
  const f = fixture({
    pointer: {
      beginTurn() {
        steps.push('pointer');
        return null;
      },
      clear() {},
    },
    onUserSend() {
      steps.push('send');
    },
  });
  f.controller._turns.narration = {
    cancel() {
      steps.push('cancel');
    },
    userTurnEnded() {
      steps.push('user-turn-ended');
    },
  };
  try {
    f.rejectedTexts.add('rejected');
    f.controller.sendTextCommand('rejected');
    assert.deepEqual(steps, ['cancel', 'user-turn-ended', 'pointer', 'send']);
    assert.equal(f.creates().length, 0);
  } finally {
    f.controller.stop();
  }
});

test('earlier accepted deferred input survives a newer failed send and answers once', async () => {
  const f = fixture();
  try {
    await f.created('active');
    f.controller.sendTextCommand('accepted');
    f.rejectedTexts.add('rejected');
    f.controller.sendTextCommand('rejected');
    assert.deepEqual(f.texts(), ['accepted']);
    assert.equal(f.controller.pendingUserTextResponse, true);
    assert.equal(f.creates().length, 0);
    await f.done('active');
    assert.equal(f.creates().length, 1);
    await f.done('active');
    assert.equal(f.creates().length, 1);
  } finally {
    f.controller.stop();
  }
});

test('rejected text preserves an outstanding create without adding deferred input', async () => {
  const f = fixture();
  try {
    f.controller.sendTextCommand('accepted');
    f.rejectedTexts.add('rejected');
    f.controller.sendTextCommand('rejected');
    assert.equal(f.controller.responseCreatePending, true);
    assert.equal(f.controller.pendingUserTextResponse, false);
    await f.created('accepted');
    await f.done('accepted');
    assert.equal(f.creates().length, 1);
  } finally {
    f.controller.stop();
  }
});

for (const acceptedFirst of [false, true]) {
  test(`progress completion answers only accepted deferred input (accepted first=${acceptedFirst})`, async () => {
    const f = fixture();
    try {
      assert.equal(
        f.controller._turns.speakProgressLine('Checking the map.'),
        true,
      );
      await f.event({
        type: 'response.created',
        response: { id: 'progress', metadata: { gev: 'progress' } },
      });
      if (acceptedFirst) f.controller.sendTextCommand('accepted');
      f.rejectedTexts.add('rejected');
      f.controller.sendTextCommand('rejected');
      assert.equal(f.controller.pendingUserTextResponse, acceptedFirst);
      await f.event({
        type: 'response.done',
        response: {
          id: 'progress',
          status: 'cancelled',
          metadata: { gev: 'progress' },
        },
      });
      assert.equal(f.creates().length, acceptedFirst ? 1 : 0);
    } finally {
      f.controller.stop();
    }
  });
}

test('accepted text with a rejected response.create releases the pending latch for a successor', async () => {
  const f = fixture();
  try {
    f.rejectResponses(true);
    f.controller.sendTextCommand('accepted without response');
    assert.equal(f.controller.responseCreatePending, false);
    assert.equal(f.creates().length, 0);
    f.rejectResponses(false);
    f.controller.sendTextCommand('successor');
    assert.deepEqual(f.texts(), ['accepted without response', 'successor']);
    assert.equal(f.creates().length, 1);
  } finally {
    f.controller.stop();
  }
});

test('successful deferred typed burst still retains both items and coalesces one answer', async () => {
  const f = fixture();
  try {
    await f.created('active');
    f.controller.sendTextCommand('first');
    f.controller.sendTextCommand('second');
    assert.deepEqual(f.texts(), ['first', 'second']);
    assert.equal(f.creates().length, 0);
    await f.done('active');
    await f.done('active');
    assert.equal(f.creates().length, 1);
  } finally {
    f.controller.stop();
  }
});
