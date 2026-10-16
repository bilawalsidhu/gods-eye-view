import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, tick, deferred } from './geminiNativeHarness.mjs';
import { readVoiceUserTurnText } from './userTurnIntent.js';
import { withToolCatalog } from './gevRealtime.js';

const audioContent = (data) => ({
  modelTurn: {
    parts: [{ inlineData: { data, mimeType: 'audio/pcm;rate=24000' } }],
  },
});
const request = (ws, id, name = 'get_current_view_state', args = {}) =>
  ws.message({ toolCall: { functionCalls: [{ id, name, args }] } });
const responses = (ws) =>
  ws.sent.flatMap((m) => m.toolResponse?.functionResponses || []);
const onset = (ws) => {
  ws.message({ voiceActivity: { type: 'ACTIVITY_START' } });
  ws.message({ voiceActivity: { type: 'ACTIVITY_END' } });
};
const caption = (ws, text) =>
  ws.message({ serverContent: { inputTranscription: { text } } });

for (const [id, name, args] of [
  ['H01', 'get_entity_context', {}],
  ['H02', 'control_radio', { action: 'status' }],
]) {
  test(`${id} native: cancelling a current ${name} query preserves unrelated Radio preflight`, async () => {
    const ready = deferred(),
      query = deferred(),
      executions = [];
    const h = harness({
      runAction: (name, args, options) => {
        executions.push({ name, args, options });
        return args.action === 'play'
          ? Promise.resolve({
              ok: true,
              action: 'control_radio',
              radioAction: 'play',
              radioPlaybackRequested: true,
            })
          : query.promise;
      },
    });
    h.c.radio.radioLayer.playForVoice = () => ready.promise;
    try {
      await h.c.start();
      h.c.sendTextCommand('Play radio');
      const ws = h.sockets[0];
      request(ws, 'owner', 'control_radio', { action: 'play' });
      await h.c.toolQueue;
      ws.message({
        serverContent: { ...audioContent('confirmation'), turnComplete: true },
      });
      h.captures[0].drain();
      assert.equal(h.c.radio.radioHandoffInFlight, true);
      request(ws, 'query', name, args);
      await tick();
      assert.equal(
        executions.length,
        2,
        'current native query may start after provider completion',
      );
      const epoch = h.c.radio.radioHandoffEpoch;
      const pending = h.c.radio.pendingRadioPlaybackResult;
      const attempt = h.c.radio.radioHandoffAttemptId;
      const ownerCurrent = executions[0].options.isCurrent();
      ws.message({ toolCallCancellation: { ids: ['unknown', 'query'] } });
      await h.c.toolQueue;
      assert.equal(executions[1].options.signal.aborted, true);
      assert.equal(executions[1].options.isCurrent(), false);
      assert.equal(h.c.radio.radioHandoffEpoch, epoch);
      assert.equal(executions[0].options.signal.aborted, false);
      assert.equal(executions[0].options.isCurrent(), ownerCurrent);
      assert.equal(h.c.radio.pendingRadioPlaybackResult, pending);
      assert.equal(h.c.radio.radioHandoffAttemptId, attempt);
      assert.equal(h.c.radio.radioHandoffInFlight, true);
      assert.equal(h.state.stopped, 0);
      assert.equal(h.c.pendingTools, 0);
      assert.deepEqual(
        responses(ws).map((r) => r.id),
        ['owner'],
      );
      assert.equal(responses(ws)[0].response.ok, true);
      query.resolve({ ok: true });
      ready.resolve(true);
      await tick();
      assert.equal(h.c.status, 'idle');
      assert.equal(h.state.ducked, false);
      assert.deepEqual(
        responses(ws).map((r) => r.id),
        ['owner'],
      );
    } finally {
      h.c.stop();
    }
    assert.equal(h.timers.size, 0);
  });
}

for (const [id, prior] of [
  ['H03', 'playing'],
  ['H04', 'before-first-output'],
]) {
  test(`${id} native: PTT fences ${prior} reply and recovers the new call after its boundary`, async () => {
    const h = harness();
    try {
      await h.c.start({ pushToTalk: true });
      const ws = h.sockets[0],
        audio = h.captures[0];
      if (prior === 'playing')
        ws.message({ serverContent: audioContent('old') });
      else {
        h.c.input.setMicrophoneEnabled(true);
        audio.callbacks.onAudio(
          { data: 'AAAB', mimeType: 'audio/pcm;rate=16000' },
          audio.metadata,
        );
        h.c.input.setMicrophoneEnabled(false);
      }
      h.c.input.pushToTalkKeyHeld = true;
      assert.equal(h.c.input.bargeIn(), true);
      h.c.input.setMicrophoneEnabled(true);
      h.c.input.setMicrophoneEnabled(false);
      const turn = h.c.turn,
        played = audio.played.length,
        firstEvent = h.events.length;
      ws.message({
        serverContent: {
          ...audioContent('late-old'),
          outputTranscription: { text: 'retired output' },
          inputTranscription: { text: 'new request' },
        },
      });
      request(ws, 'retired-call', 'fly_to_location', { query: 'old target' });
      await h.c.toolQueue;
      assert.equal(audio.played.length, played);
      assert.equal(audio.pending, false);
      assert.equal(h.calls.length, 0);
      assert.equal(
        h.events.slice(firstEvent).some((e) => e.role === 'assistant'),
        false,
      );
      assert.equal(
        h.events
          .slice(firstEvent)
          .some((e) => e.role === 'user' && e.text === 'new request'),
        true,
      );
      ws.message({ serverContent: { interrupted: true } });
      assert.equal(h.c.turn, turn);
      ws.message({ serverContent: audioContent('after-interrupted') });
      assert.equal(
        audio.played.length,
        played,
        'interrupted alone cannot release the fence',
      );
      ws.message({
        serverContent: {
          ...audioContent('boundary-old'),
          outputTranscription: { text: 'still retired' },
          turnComplete: true,
        },
      });
      assert.equal(
        audio.played.length,
        played,
        'coalesced old boundary output is discarded',
      );
      assert.equal(
        h.events.slice(firstEvent).some((e) => e.type === 'completion'),
        false,
      );
      caption(ws, 'unrelated advisory words');
      ws.message({
        toolCall: {
          functionCalls: [
            {
              id: 'retired-call',
              name: 'fly_to_location',
              args: { query: 'replayed old target' },
            },
            {
              id: 'new-call',
              name: 'fly_to_location',
              args: { query: 'new target' },
            },
          ],
        },
      });
      await h.c.toolQueue;
      assert.deepEqual(
        h.calls.map((c) => c.args.query),
        ['new target'],
      );
      assert.equal(h.calls[0].options.userTurn, undefined);
      ws.message({
        serverContent: {
          ...audioContent('new'),
          outputTranscription: { text: 'new reply' },
          turnComplete: true,
        },
      });
      assert.equal(audio.played.at(-1).data, 'new');
      audio.drain();
      assert.equal(
        h.events.findLast((e) => e.type === 'completion').status,
        'completed',
      );
    } finally {
      h.c.stop();
    }
    assert.equal(h.timers.size, 0);
  });
}

test('H05 native: typed token survives audio drain for same-turn tools and revokes on new input', async () => {
  const h = harness();
  try {
    await h.c.start();
    const ws = h.sockets[0],
      audio = h.captures[0];
    h.c.sendTextCommand('Show the current view');
    const response = h.events.findLast((e) => e.type === 'response-start');
    assert.equal(
      readVoiceUserTurnText(response.userTurn),
      'Show the current view',
    );
    request(ws, 'first');
    await h.c.toolQueue;
    assert.equal(h.calls[0].options.userTurn, response.userTurn);
    assert.equal(h.calls[0].options.responseId, response.responseId);
    ws.message({
      serverContent: {
        ...audioContent('confirmation'),
        outputTranscription: { text: 'Here is the current view' },
        turnComplete: true,
      },
    });
    assert.equal(
      h.events.some((e) => e.type === 'completion'),
      false,
    );
    assert.equal(
      h.events.findLast((e) => e.role === 'assistant').responseId,
      response.responseId,
    );
    audio.drain();
    const completion = h.events.findLast((e) => e.type === 'completion');
    assert.equal(completion.responseId, response.responseId);
    assert.equal(completion.spoken, true);
    assert.equal(completion.audioDrained, true);
    assert.equal(
      readVoiceUserTurnText(response.userTurn),
      'Show the current view',
    );
    request(ws, 'same-turn');
    await h.c.toolQueue;
    assert.equal(h.calls[1].options.userTurn, response.userTurn);
    h.c.sendTextCommand('New request');
    assert.equal(readVoiceUserTurnText(response.userTurn), undefined);
  } finally {
    h.c.stop();
  }
  assert.equal(h.timers.size, 0);
});

test('H08 native: replacing pending runner work cannot underflow tool counts or block successor', async () => {
  const gate = deferred(),
    executions = [];
  const h = harness({
    runAction: (name, args, options) => {
      executions.push({ name, args, options });
      return options.callId === 'old'
        ? gate.promise
        : Promise.resolve({ ok: true });
    },
  });
  try {
    await h.c.start();
    const ws = h.sockets[0];
    onset(ws);
    request(ws, 'old');
    await tick();
    const oldWork = h.c.toolQueue;
    assert.equal(h.c.pendingTools, 1);
    ws.message({ voiceActivity: { type: 'ACTIVITY_START' } });
    assert.equal(h.c.pendingTools, 0);
    await oldWork;
    assert.equal(h.c.pendingTools, 0);
    assert.equal(executions[0].options.signal.aborted, true);
    assert.equal(executions[0].options.isCurrent(), false);
    ws.message({ voiceActivity: { type: 'ACTIVITY_END' } });
    ws.message({ serverContent: { interrupted: true, turnComplete: true } });
    request(ws, 'fresh');
    await h.c.toolQueue;
    assert.equal(executions.at(-1).options.callId, 'fresh');
    assert.equal(h.c.pendingTools, 0);
    gate.resolve({ ok: true });
    await tick();
    assert.equal(h.c.pendingTools, 0);
    assert.deepEqual(
      responses(ws).map((r) => r.id),
      ['fresh'],
    );
    ws.message({
      serverContent: { ...audioContent('fresh reply'), turnComplete: true },
    });
    h.captures[0].drain();
    assert.equal(
      h.events.findLast((e) => e.type === 'completion').status,
      'completed',
    );
  } finally {
    h.c.stop();
  }
  assert.equal(h.timers.size, 0);
});

test('H10 native: held speech dispatches without caption authority and new text revokes its call', async () => {
  const gate = deferred(),
    executions = [];
  const h = harness({
    runAction: (name, args, options) => {
      executions.push({ name, args, options });
      return gate.promise;
    },
  });
  try {
    await h.c.start({ pushToTalk: true });
    const ws = h.sockets[0],
      audio = h.captures[0];
    h.c.input.bargeIn();
    h.c.input.setMicrophoneEnabled(true);
    audio.callbacks.onAudio(
      { data: 'AA==', mimeType: 'audio/pcm;rate=16000' },
      audio.metadata,
    );
    h.c.input.setMicrophoneEnabled(false);
    caption(ws, 'Show the current view');
    const response = h.events.findLast((e) => e.type === 'response-start');
    assert.equal(response.userTurn, undefined);
    request(ws, 'held');
    await tick();
    const oldWork = h.c.toolQueue;
    assert.equal(executions.length, 1);
    assert.equal(executions[0].options.userTurn, undefined);
    assert.equal(executions[0].options.responseId, response.responseId);
    h.c.sendTextCommand('new intent');
    await oldWork;
    assert.equal(executions[0].options.signal.aborted, true);
    assert.equal(executions[0].options.isCurrent(), false);
    gate.resolve({ ok: true });
    await tick();
    assert.equal(
      responses(ws).some((r) => r.id === 'held'),
      false,
    );
  } finally {
    h.c.stop();
  }
  assert.equal(h.timers.size, 0);
});

for (const [id, restart] of [
  ['H11', false],
  ['H12', true],
]) {
  test(`${id} native: pending tool cannot revive voice after Stop${restart ? '/restart' : ''}`, async () => {
    const gate = deferred(),
      mutations = [],
      executions = [];
    const h = harness({
      runAction: async (name, args, options) => {
        executions.push(options);
        await gate.promise;
        if (options.isCurrent()) mutations.push(name);
        return { ok: true };
      },
    });
    try {
      await h.c.start();
      const ws = h.sockets[0];
      onset(ws);
      request(ws, 'old');
      await tick();
      const pending = h.c.toolQueue;
      assert.equal(h.c.pendingTools, 1);
      h.c.stop();
      const boundary = h.events.length;
      const successor = restart ? h.c.start() : null;
      await pending;
      assert.equal(
        h.events
          .slice(boundary)
          .some((e) => e.type === 'state' && e.state === 'listening'),
        false,
      );
      assert.equal(executions[0].signal.aborted, true);
      assert.equal(executions[0].isCurrent(), false);
      assert.equal(h.c.pendingTools, 0);
      if (successor) await successor;
      const laterBoundary = h.events.length;
      gate.resolve();
      caption(ws, 'late old speech');
      await tick();
      assert.deepEqual(mutations, []);
      assert.equal(
        h.events.slice(laterBoundary).some((e) => e.type === 'state'),
        false,
      );
      assert.equal(responses(ws).length, 0);
    } finally {
      h.c.stop();
    }
    assert.equal(h.timers.size, 0);
  });
}

for (const [id, boundary] of [
  ['H14', 'interrupted'],
  ['H15', 'natural'],
]) {
  test(`${id} native: shared runner zoom executes promptly after ${boundary} retired boundary`, async () => {
    const mutations = [],
      observed = [];
    const guarded = withToolCatalog(
      async (name, args) => {
        mutations.push({ name, args });
        return { ok: true };
      },
      async () => null,
    );
    const h = harness({
      runAction: (name, args, options) => {
        observed.push(options);
        return guarded(name, args, options);
      },
    });
    try {
      await h.c.start();
      const ws = h.sockets[0];
      ws.message({ serverContent: audioContent('old reply') });
      ws.message({ voiceActivity: { type: 'ACTIVITY_START' } });
      ws.message({
        serverContent: {
          ...(boundary === 'interrupted' ? { interrupted: true } : {}),
          turnComplete: true,
        },
      });
      ws.message({ voiceActivity: { type: 'ACTIVITY_END' } });
      caption(ws, 'zoom in');
      request(ws, 'zoom', 'adjust_camera_zoom', { direction: 'in' });
      await tick();
      assert.equal(
        mutations.length,
        1,
        'native action executes without a transcript wait',
      );
      assert.equal(observed[0].userTurn, undefined);
      assert.equal(h.c.pendingTools, 0);
      assert.equal(
        responses(ws).some((r) => r.response.voiceIntentUnverified),
        false,
      );
    } finally {
      h.c.stop();
    }
    assert.equal(h.timers.size, 0);
  });
}

for (const [id, exit] of [
  ['H18', 'stop'],
  ['H19', 'replacement'],
]) {
  test(`${id} native: ${exit} prevents queued camera dispatch and late captions cannot revive it`, async () => {
    const mutations = [],
      observed = [];
    const guarded = withToolCatalog(
      async (name) => {
        mutations.push(name);
        return { ok: true };
      },
      async () => null,
    );
    const h = harness({
      runAction: (name, args, options) => {
        observed.push(name);
        return guarded(name, args, options);
      },
    });
    try {
      await h.c.start();
      const ws = h.sockets[0];
      onset(ws);
      request(ws, 'queued-old', 'adjust_camera_zoom', { direction: 'in' });
      const oldWork = h.c.toolQueue;
      assert.equal(h.c.pendingTools, 1);
      if (exit === 'stop') h.c.stop();
      else h.c.sendTextCommand('switch voice provider to Gemini');
      caption(ws, 'zoom in');
      await oldWork;
      assert.deepEqual(mutations, []);
      assert.deepEqual(observed, []);
      assert.equal(h.c.pendingTools, 0);
      if (exit === 'replacement') {
        ws.message({
          serverContent: { interrupted: true, turnComplete: true },
        });
        request(ws, 'typed-provider-camera', 'zoom_to_globe');
        await h.c.toolQueue;
        assert.deepEqual(mutations, []);
        assert.deepEqual(observed, []);
        assert.equal(
          responses(ws).at(-1).response.providerRequestBlocked,
          true,
        );
      }
    } finally {
      h.c.stop();
    }
    assert.equal(h.timers.size, 0);
  });
}
