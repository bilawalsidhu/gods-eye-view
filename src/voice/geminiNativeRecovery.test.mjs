import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, tick, deferred } from './geminiNativeHarness.mjs';
import { createGevActionRunner } from './gevActions.js';
import {
  initialVoiceCardState,
  reduceVoiceCard,
  voiceCardView,
} from './voiceCardPresentation.js';
import { readVoiceUserTurnText } from './userTurnIntent.js';

const tool = (ws, id) =>
  ws.message({
    toolCall: {
      functionCalls: [
        {
          id,
          name: 'adjust_camera_zoom',
          args: { direction: 'in', amount: 'little' },
        },
      ],
    },
  });
const caption = (ws, text) =>
  ws.message({ serverContent: { inputTranscription: { text } } });
const onset = (ws) => {
  ws.message({ voiceActivity: { type: 'ACTIVITY_START' } });
  ws.message({ voiceActivity: { type: 'ACTIVITY_END' } });
};
const complete = (ws) => ws.message({ serverContent: { turnComplete: true } });
const oldAudio = {
  serverContent: {
    modelTurn: {
      parts: [
        {
          inlineData: {
            data: 'AAAA',
            mimeType: 'audio/pcm;rate=24000',
          },
        },
      ],
    },
  },
};
const outputs = (ws) =>
  ws.sent.flatMap((m) => m.toolResponse?.functionResponses || []);

// Socket/media are deterministic. Mutations use the production action runner.
function fixture({ holdFirst = false } = {}) {
  const state = { height: 1000, renders: 0, providerWrites: [], panels: [] };
  const position = { x: 6379137, y: 0, z: 0 };
  const viewer = {
    clock: { onTick: { addEventListener: () => () => {} } },
    camera: {
      positionWC: position,
      positionCartographic: { height: 1000 },
      moveEnd: { addEventListener() {} },
      cancelFlight() {},
      zoomIn(n) {
        position.x -= n;
        state.height -= n;
        this.positionCartographic.height = state.height;
      },
      zoomOut(n) {
        position.x += n;
        state.height += n;
        this.positionCartographic.height = state.height;
      },
    },
    scene: {
      canvas: {
        clientWidth: 800,
        clientHeight: 600,
        addEventListener() {},
        removeEventListener() {},
      },
      requestRender() {
        state.renders++;
      },
    },
  };
  const runner = createGevActionRunner({
    viewer,
    dataManager: { layers: new Map() },
    styleManager: {
      setVoiceProvider: (p) => state.providerWrites.push(p),
      setPanelCollapsed: (...args) => state.panels.push(args),
    },
  });
  const entered = [];
  const gate = deferred();
  const h = harness({
    runAction: async (name, args, options) => {
      entered.push({ name, args, options });
      if (holdFirst && entered.length === 1) await gate.promise;
      if (!options.isCurrent())
        return { ok: false, action: name, changed: false };
      return runner(name, args, options);
    },
  });
  return {
    ...h,
    state,
    entered,
    gate,
    close() {
      gate.resolve();
      h.c.stop();
      runner.dispose();
      assert.equal(h.timers.size, 0);
      assert.deepEqual(state.providerWrites, []);
      assert.deepEqual(state.panels, []);
    },
  };
}

for (const [id, order] of [
  ['H20', 'before-boundary'],
  ['H21', 'after-boundary'],
]) {
  test(`native replacement ${id}: ${order} tool respects retired output and next onset recovers`, async () => {
    const h = fixture();
    try {
      await h.c.start();
      const ws = h.sockets[0];
      ws.message(oldAudio);
      onset(ws);
      caption(ws, 'zoom in');
      if (order === 'before-boundary') {
        tool(ws, 'ambiguous-before');
        await tick();
        assert.equal(h.state.height, 1000);
        assert.equal(h.entered.length, 0);
        assert.equal(outputs(ws).length, 0);
      }
      ws.message({ serverContent: { interrupted: true, turnComplete: true } });
      if (order === 'after-boundary') {
        tool(ws, 'native-after');
        await h.c.toolQueue;
        assert.equal(h.state.height, 750);
        assert.equal(h.entered.length, 1);
        assert.equal(outputs(ws).at(-1).response.ok, true);
        complete(ws);
      }
      onset(ws);
      caption(ws, 'zoom in');
      tool(ws, 'fresh-clean-onset');
      await h.c.toolQueue;
      assert.equal(h.state.height, order === 'before-boundary' ? 750 : 562.5);
      assert.equal(h.entered.length, order === 'before-boundary' ? 1 : 2);
      assert.equal(h.entered.at(-1).options.userTurn, undefined);
      assert.equal(h.c.pendingTools, 0);
      assert.equal(
        outputs(ws).some((o) => o.id === 'ambiguous-before'),
        false,
      );
      assert.equal(
        outputs(ws).find((o) => o.id === 'fresh-clean-onset').response.ok,
        true,
      );
    } finally {
      h.close();
    }
  });
}

test('native replacement H30: ordinary tools run promptly and late caption fragments cannot strand siblings', async () => {
  const h = fixture();
  try {
    await h.c.start();
    const ws = h.sockets[0];
    onset(ws);
    caption(ws, 'switch to');
    tool(ws, 'ordinary-before-caption-resolution');
    await tick();
    await h.c.toolQueue;
    assert.equal(h.state.height, 750);
    assert.equal(h.c.pendingTools, 0);
    h.advance(1499);
    caption(ws, 'Austin');
    h.advance(5000);
    tool(ws, 'released-sibling');
    await h.c.toolQueue;
    assert.equal(h.state.height, 562.5);
    assert.equal(h.entered.length, 2);
    assert.equal(
      h.entered.every((c) => c.options.userTurn === undefined),
      true,
    );
    assert.equal(outputs(ws).length, 2);
    assert.equal(
      outputs(ws).every((o) => o.response.ok),
      true,
    );
    assert.equal(h.c.pendingTools, 0);
    assert.equal(h.c.status, 'listening');
  } finally {
    h.close();
  }
});

for (const [id, exit] of [
  ['H32', 'stop'],
  ['H33', 'restart'],
  ['H34', 'new-input'],
]) {
  test(`native replacement ${id}: ${exit} retires owned in-flight work and late callbacks`, async () => {
    const h = fixture({ holdFirst: true });
    try {
      await h.c.start();
      let ws = h.sockets[0];
      onset(ws);
      caption(ws, 'switch to');
      tool(ws, 'old-owned-action');
      await tick();
      assert.equal(h.entered.length, 1);
      assert.equal(h.c.pendingTools, 1);
      assert.equal(h.state.height, 1000);
      const oldWork = h.c.toolQueue;
      const oldMessage = ws.onmessage;
      const oldOwner = h.entered[0].options;
      if (exit === 'new-input') h.c.sendTextCommand('zoom out');
      else h.c.stop();
      assert.equal(oldOwner.signal.aborted, true);
      assert.equal(oldOwner.isCurrent(), false);
      if (exit === 'restart') {
        await h.c.start();
        ws = h.sockets.at(-1);
      }
      if (exit !== 'new-input')
        oldMessage({
          data: JSON.stringify({
            toolCall: {
              functionCalls: [
                {
                  id: 'late-old-call',
                  name: 'adjust_camera_zoom',
                  args: { direction: 'in' },
                },
              ],
            },
          }),
        });
      caption(ws, 'Gemini');
      h.advance(1500);
      h.gate.resolve();
      await oldWork;
      await tick();
      assert.equal(h.state.height, 1000);
      assert.equal(h.c.pendingTools, 0);
      assert.equal(
        outputs(ws).some(
          (o) => o.id === 'old-owned-action' || o.id === 'late-old-call',
        ),
        false,
      );
      if (exit === 'stop') {
        assert.equal(h.c.status, 'idle');
        assert.equal(h.c.isActive(), false);
      } else {
        if (exit === 'new-input') {
          ws.message({
            serverContent: { interrupted: true, turnComplete: true },
          });
        } else h.c.sendTextCommand('zoom out');
        tool(ws, 'fresh-after-retirement');
        await h.c.toolQueue;
        assert.equal(h.state.height, 750);
        assert.equal(h.entered.length, 2);
        assert.equal(
          outputs(ws).find((o) => o.id === 'fresh-after-retirement').response
            .ok,
          true,
        );
        assert.equal(h.c.pendingTools, 0);
        assert.equal(h.c.isActive(), true);
      }
    } finally {
      h.close();
    }
  });
}

function captionFixture() {
  let card = initialVoiceCardState();
  const events = [];
  const h = harness({
    emit(event) {
      events.push(event);
      card = reduceVoiceCard(card, event);
    },
  });
  return {
    ...h,
    events,
    view: () => voiceCardView(card),
    close() {
      h.c.stop();
      assert.equal(h.timers.size, 0);
    },
  };
}

const startSpeech = (ws) =>
  ws.message({ voiceActivity: { type: 'ACTIVITY_START' } });
const endSpeech = (ws) =>
  ws.message({ voiceActivity: { type: 'ACTIVITY_END' } });
const speak = (ws, text) =>
  ws.message({
    serverContent: {
      outputTranscription: { text },
      modelTurn: {
        parts: [
          {
            inlineData: {
              data: 'AAAA',
              mimeType: 'audio/pcm;rate=24000',
            },
          },
        ],
      },
    },
  });
const zoom = (ws, id) =>
  ws.message({
    toolCall: {
      functionCalls: [
        {
          id,
          name: 'adjust_camera_zoom',
          args: { direction: 'in', amount: 'little' },
        },
      ],
    },
  });

test('native captions: interrupted request cannot overwrite fragmented successor preview at completion', async () => {
  const h = captionFixture();
  try {
    await h.c.start();
    const ws = h.sockets[0];
    startSpeech(ws);
    caption(ws, 'Can you explain the data layers in GEV?');
    endSpeech(ws);
    speak(ws, 'The app has several data layers.');

    startSpeech(ws);
    ws.message({ serverContent: { interrupted: true } });
    complete(ws);
    assert.equal(h.view().user.text, '…');
    assert.equal(h.view().assistant.text, '');

    for (const text of ['Zoom ', 'in ', 'a little.']) caption(ws, text);
    endSpeech(ws);
    assert.equal(h.view().user.text, 'Zoom in a little.');
    zoom(ws, 'successor-zoom');
    await h.c.toolQueue;
    assert.equal(h.calls.length, 1);
    assert.deepEqual(h.calls[0].args, { direction: 'in', amount: 'little' });
    assert.equal(h.calls[0].options.userTurn, undefined);
    assert.equal(
      ws.sent.some((m) =>
        m.toolResponse?.functionResponses?.some(
          (call) => call.id === 'successor-zoom' && call.response.ok,
        ),
      ),
      true,
    );
    speak(ws, 'Zooming in ');
    speak(ws, 'slightly.');
    complete(ws);
    h.captures[0].drain();
    assert.equal(h.view().user.text, 'Zoom in a little.');
    assert.equal(h.view().assistant.text, 'Zooming in slightly.');
    assert.equal(
      h.events.some(
        (e) => e.type === 'transcript' && e.role === 'user' && e.final,
      ),
      false,
    );
    assert.equal(
      h.events.some(
        (e) =>
          e.type === 'transcript' &&
          e.role === 'assistant' &&
          e.final &&
          e.text === 'Zooming in slightly.',
      ),
      true,
    );
    const segments = h.events.filter((e) => e.type === 'user-input-segment');
    assert.deepEqual(
      segments.map((e) => e.text),
      ['Can you explain the data layers in GEV?', 'Zoom ', 'in ', 'a little.'],
    );
    assert.equal(
      segments.every(
        (e) => e.inputId === null && e.inputScope === 'unattributed-segment',
      ),
      true,
    );
    const captions = h.events.filter(
      (e) => e.type === 'transcript' && e.role === 'user',
    );
    assert.equal(
      captions.every(
        (e) =>
          e.delta === true &&
          e.final === false &&
          e.attribution === 'unverified' &&
          e.responseId === null,
      ),
      true,
    );
  } finally {
    h.close();
  }
});

test('native captions: duplicate activity and interrupted acknowledgments preserve received fragments', async () => {
  const h = captionFixture();
  try {
    await h.c.start();
    const ws = h.sockets[0];
    speak(ws, 'Old reply');
    startSpeech(ws);
    caption(ws, 'Zoom ');
    startSpeech(ws);
    ws.message({ serverContent: { interrupted: true } });
    ws.message({ serverContent: { interrupted: true } });
    assert.equal(h.view().user.text, 'Zoom');
    caption(ws, 'in ');
    complete(ws);
    caption(ws, 'a little.');
    endSpeech(ws);
    assert.equal(h.view().user.text, 'Zoom in a little.');
    complete(ws);
    assert.equal(h.view().user.text, 'Zoom in a little.');
  } finally {
    h.close();
  }
});

test('native captions: no new caption means successor completion cannot replay old request', async () => {
  const h = captionFixture();
  try {
    await h.c.start();
    const ws = h.sockets[0];
    caption(ws, 'Explain the data layers.');
    speak(ws, 'Several layers are available.');
    startSpeech(ws);
    ws.message({ serverContent: { interrupted: true } });
    complete(ws);
    zoom(ws, 'uncaptioned-successor');
    await h.c.toolQueue;
    complete(ws);
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0].options.userTurn, undefined);
    assert.equal(h.view().user.text, '…');
  } finally {
    h.close();
  }
});

test('native captions: advisory arrival order is displayed without synthesizing final speech ownership', async () => {
  const h = captionFixture();
  try {
    await h.c.start();
    const ws = h.sockets[0];
    // Captions have no input id: presentation does not guess their semantic order.
    caption(ws, 'little. ');
    caption(ws, 'Zoom in a ');
    assert.equal(h.view().user.text, 'little. Zoom in a');
    complete(ws);
    assert.equal(h.view().user.text, 'little. Zoom in a');
    assert.equal(
      h.events.some((e) => e.type === 'user-input-final'),
      false,
    );
    assert.equal(
      h.events.some((e) => e.type === 'response-start'),
      false,
    );
    assert.equal(
      h.events.some((e) => e.role === 'user' && e.final),
      false,
    );
  } finally {
    h.close();
  }
});

test('native captions: local PTT and typed boundaries clear preview without changing typed authority', async () => {
  const h = captionFixture();
  try {
    await h.c.start();
    const ws = h.sockets[0];
    caption(ws, 'Older speech.');
    assert.equal(h.c.bargeIn(), true);
    assert.equal(h.view().user.text, '…');
    caption(ws, 'Zoom ');
    caption(ws, 'in a little.');
    assert.equal(h.view().user.text, 'Zoom in a little.');
    complete(ws);
    assert.equal(h.view().user.text, 'Zoom in a little.');

    assert.equal(h.c.sendTextCommand('Zoom in a little.'), true);
    assert.equal(h.view().user.text, '…');
    caption(ws, 'unrelated advisory speech');
    zoom(ws, 'typed-zoom');
    await h.c.toolQueue;
    assert.equal(h.calls.length, 1);
    assert.equal(
      readVoiceUserTurnText(h.calls[0].options.userTurn),
      'Zoom in a little.',
    );
    complete(ws);
    assert.equal(h.view().user.text, 'unrelated advisory speech');
  } finally {
    h.close();
  }
});

test('native captions: Stop and restart do not retain old display fragments or accept old socket captions', async () => {
  const h = captionFixture();
  try {
    await h.c.start();
    const old = h.sockets[0];
    caption(old, 'Old partial ');
    h.c.stop();
    assert.equal(h.view().visible, false);
    await h.c.start();
    const ws = h.sockets[1];
    caption(ws, 'Zoom ');
    caption(old, 'stale caption');
    caption(ws, 'in a little.');
    complete(ws);
    assert.equal(h.view().user.text, 'Zoom in a little.');
    assert.equal(h.tracks[0].readyState, 'ended');
    assert.equal(h.captures[0].closed, true);
  } finally {
    h.close();
  }
});

for (const split of [false, true]) {
  test(`native captions: server-only interruption retains ${split ? 'a leading fragment alongside its successor' : 'a complete pre-marker caption'} as recent speech`, async () => {
    const h = captionFixture();
    try {
      await h.c.start();
      const ws = h.sockets[0];
      speak(ws, 'An earlier assistant reply.');
      caption(ws, split ? 'Zoom ' : 'Zoom in a little.');
      ws.message({ serverContent: { interrupted: true } });
      assert.equal(h.view().user.text, '…');
      assert.equal(h.view().recentSpeech.text, split ? 'Zoom' : 'Zoom in a little.');
      assert.equal(h.view().recentSpeech.visible, true);
      ws.message({ serverContent: { interrupted: true } });
      assert.equal(h.view().recentSpeech.text, split ? 'Zoom' : 'Zoom in a little.');
      if (split) caption(ws, 'in a little.');
      complete(ws);
      zoom(ws, 'server-only-caption');
      await h.c.toolQueue;
      speak(ws, 'Zooming in slightly.');
      complete(ws);
      h.captures[0].drain();
      assert.equal(h.view().recentSpeech.text, split ? 'Zoom' : 'Zoom in a little.');
      assert.equal(h.view().user.text, split ? 'in a little.' : '…');
      assert.equal(h.view().assistant.text, 'Zooming in slightly.');
      assert.equal(h.calls[0].options.userTurn, undefined);
      assert.equal(h.events.some((e) => e.role === 'user' && e.final), false);
    } finally {
      h.close();
    }
  });
}

for (const boundary of ['native-onset', 'push-to-talk', 'typed', 'stop']) {
  test(`native captions: ${boundary} clears recent speech retained by a server-only acknowledgment`, async () => {
    const h = captionFixture();
    try {
      await h.c.start();
      const ws = h.sockets[0];
      speak(ws, 'Old response');
      caption(ws, 'Earlier advisory speech');
      ws.message({ serverContent: { interrupted: true } });
      assert.equal(h.view().recentSpeech.visible, true);
      // The native onset must clear presentation even while retirement is
      // already pending and therefore does not emit another interruption.
      if (boundary === 'native-onset') startSpeech(ws);
      else if (boundary === 'push-to-talk') h.c.bargeIn();
      else if (boundary === 'typed') h.c.sendTextCommand('Zoom in a little.');
      else h.c.stop();
      assert.equal(h.view().recentSpeech.visible, false);
      assert.equal(h.view().recentSpeech.text, '');
      assert.equal(h.view().user.text, '…');
    } finally {
      h.close();
    }
  });
}
