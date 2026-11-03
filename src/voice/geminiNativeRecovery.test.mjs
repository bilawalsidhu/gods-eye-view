import test from 'node:test';
import assert from 'node:assert/strict';
import {
  harness,
  tick,
  deferred,
} from '../testSupport/geminiNativeHarness.mjs';
import { createGevActionRunner } from './gevActions.js';

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
