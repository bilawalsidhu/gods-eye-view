import assert from 'node:assert/strict';
import test from 'node:test';
import { GevRealtimeController } from './realtimeController.js';
import { RealtimeInput } from './realtimeInput.js';
import { RealtimeViewport } from './realtimeViewport.js';
import { resolveVoiceModel } from './voiceCost.js';
import { createRealtimeBackend } from './realtimeBackend.js';
import { createGevActionRunner } from './gevActions.js';

function installGlobals(t, values) {
  for (const [name, value] of Object.entries(values)) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, {
      configurable: true,
      writable: true,
      value,
    });
    t.after(() => {
      if (previous) Object.defineProperty(globalThis, name, previous);
      else delete globalThis[name];
    });
  }
}

function browser(t) {
  const peers = [];
  const streams = [];
  class Peer {
    constructor() {
      this.connectionState = 'connected';
      peers.push(this);
    }
    addTrack() {}
    createDataChannel() {
      this.channel = {
        readyState: 'open',
        handlers: new Map(),
        sent: [],
        addEventListener(type, handler) {
          this.handlers.set(type, handler);
        },
        send(message) {
          this.sent.push(JSON.parse(message));
        },
        close() {
          this.readyState = 'closed';
        },
      };
      return this.channel;
    }
    async createOffer() {
      return { sdp: 'offer' };
    }
    async setLocalDescription(offer) {
      this.localDescription = offer;
    }
    async setRemoteDescription() {}
    close() {
      this.connectionState = 'closed';
    }
  }
  installGlobals(t, {
    window: { RTCPeerConnection: Peer },
    RTCPeerConnection: Peer,
    document: {
      querySelectorAll: () => [],
      body: { appendChild() {} },
      createElement: () => ({ dataset: {}, style: {}, remove() {} }),
    },
    navigator: {
      mediaDevices: {
        async getUserMedia() {
          const track = {
            stops: 0,
            stop() {
              this.stops++;
            },
          };
          const stream = {
            getTracks: () => [track],
            getAudioTracks: () => [track],
            track,
          };
          streams.push(stream);
          return stream;
        },
      },
    },
  });
  return { peers, streams, Peer };
}

test('overflow teardown requires explicit restart and revoked old callbacks cannot seed its real navigation', async (t) => {
  const { peers, streams } = browser(t);
  let tokens = 0;
  const position = { x: 6379137, y: 0, z: 0 };
  const camera = {
    positionWC: position,
    positionCartographic: { height: 1000 },
    moveEnd: { addEventListener() {} },
    cancelFlight() {},
    zoomIn(metres) {
      position.x -= metres;
      this.positionCartographic.height -= metres;
    },
  };
  const runner = createGevActionRunner({
    viewer: {
      clock: { onTick: { addEventListener: () => () => {} } },
      camera,
      scene: {
        canvas: {
          clientWidth: 800,
          clientHeight: 600,
          addEventListener() {},
          removeEventListener() {},
        },
        requestRender() {},
      },
    },
    dataManager: { layers: new Map() },
    styleManager: {},
  });
  const controller = new GevRealtimeController({
    runner,
    backend: {
      async requestToken() {
        tokens++;
        return { token: 'synthetic', model: resolveVoiceModel('mini').id };
      },
      async negotiate() {
        return 'answer';
      },
    },
    debugSink: null,
    ui: {
      root: {
        dataset: {},
        classList: { remove() {} },
        querySelectorAll: () => [],
      },
      status: {},
      detail: {},
      errorDetail: {},
    },
  });
  const receive = (channel, payload) =>
    channel.handlers.get('message')({ data: JSON.stringify(payload) });
  await controller.start();
  const old = peers[0].channel;
  old.handlers.get('open')();
  for (let index = 0; index < 17; index++) {
    await receive(old, {
      type: 'input_audio_buffer.speech_started',
      item_id: `unanswered-${index}`,
    });
    await receive(old, {
      type: 'input_audio_buffer.committed',
      item_id: `unanswered-${index}`,
    });
  }
  assert.equal(controller.dc, null);
  assert.equal(controller.status, 'error');
  assert.match(controller.ui.errorDetail.textContent, /start voice again/i);
  assert.equal(old.readyState, 'closed');
  assert.equal(peers[0].connectionState, 'closed');
  assert.equal(streams[0].track.stops, 1);
  assert.equal(tokens, 1, 'recovery never reconnects automatically');
  assert.equal(camera.positionCartographic.height, 1000);
  await controller.start(); // Deliberate user restart, using only synthetic transport.
  assert.equal(tokens, 2);
  const current = peers[1].channel;
  current.handlers.get('open')();
  old.readyState = 'open'; // Retained callback may already have been queued.
  await receive(old, {
    type: 'input_audio_buffer.speech_started',
    item_id: 'fresh-input',
  });
  await receive(old, {
    type: 'input_audio_buffer.committed',
    item_id: 'fresh-input',
  });
  await receive(old, {
    type: 'response.created',
    response: { id: 'fresh-response' },
  });
  await receive(old, {
    type: 'response.function_call_arguments.done',
    response_id: 'fresh-response',
    call_id: 'old-zoom',
    name: 'adjust_camera_zoom',
    arguments: '{"direction":"in"}',
  });
  assert.deepEqual(controller._turns.userTurnIntent.reservationState(), {
    pending: 0,
    overflowed: false,
  });
  assert.equal(
    controller._turns.userTurnIntent.forResponse('fresh-response'),
    undefined,
  );
  assert.equal(camera.positionCartographic.height, 1000);
  await receive(current, {
    type: 'input_audio_buffer.speech_started',
    item_id: 'fresh-input',
  });
  await receive(current, {
    type: 'conversation.item.input_audio_transcription.completed',
    item_id: 'fresh-input',
    transcript: 'zoom in',
  });
  await receive(current, {
    type: 'input_audio_buffer.committed',
    item_id: 'fresh-input',
  });
  await receive(current, {
    type: 'response.created',
    response: { id: 'fresh-response' },
  });
  await receive(current, {
    type: 'response.function_call_arguments.done',
    response_id: 'fresh-response',
    call_id: 'fresh-zoom',
    name: 'adjust_camera_zoom',
    arguments: '{"direction":"in"}',
  });
  const output = current.sent.find(
    (message) => message.item?.call_id === 'fresh-zoom',
  );
  assert.equal(JSON.parse(output.item.output).ok, true);
  assert.ok(camera.positionCartographic.height < 1000);
  assert.equal(
    current.sent.some((message) => message.item?.call_id === 'old-zoom'),
    false,
  );
  controller.stop();
  assert.equal(streams[1].track.stops, 1);
});

test('backend OFF metadata enables ordinary speech tools when accepted session metadata omits captions', async (t) => {
  browser(t);
  const actions = [];
  const controller = new GevRealtimeController({
    runner: async (name, _args, options) => {
      actions.push({ name, userTurn: options.userTurn });
      return { ok: true, action: name };
    },
    backend: createRealtimeBackend({
      tokenTransport: async () =>
        Response.json(
          {
            value: 'synthetic',
            session: { model: resolveVoiceModel('mini').id },
          },
          {
            headers: { 'X-GEV-Voice-Transcribe-Model': 'off' },
          },
        ),
      connectionTransport: async () => new Response('answer'),
    }),
    debugSink: null,
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
  await controller.start();
  controller.dc.handlers.get('open')();
  const event = (payload) =>
    controller.dc.handlers.get('message')({ data: JSON.stringify(payload) });
  await event({
    type: 'session.created',
    session: { type: 'realtime', audio: { input: { turn_detection: {} } } },
  });
  await event({ type: 'input_audio_buffer.speech_started', item_id: 'mic' });
  await event({ type: 'input_audio_buffer.committed', item_id: 'mic' });
  await event({ type: 'response.created', response: { id: 'off-response' } });
  await event({
    type: 'response.function_call_arguments.done',
    response_id: 'off-response',
    name: 'fly_to_location',
    call_id: 'navigation',
    arguments: '{}',
  });
  assert.equal(actions.length, 1);
  assert.equal(actions[0].name, 'fly_to_location');
  assert.ok(actions[0].userTurn);
  controller.stop();
  assert.equal(
    controller._turns.speechTranscriptionEnabled,
    true,
    'Stop resets backend OFF state',
  );
});

test('a late old OFF token cannot change transcription authority in the replacement session', async (t) => {
  browser(t);
  let releaseOld;
  let tokens = 0;
  const controller = new GevRealtimeController({
    runner: async () => ({ ok: true }),
    backend: {
      requestToken() {
        tokens++;
        if (tokens === 1)
          return new Promise((resolve) => {
            releaseOld = resolve;
          });
        return Promise.resolve({
          token: 'new',
          model: resolveVoiceModel('mini').id,
          transcribeModel: 'gpt-4o-mini-transcribe',
        });
      },
      async negotiate() {
        return 'answer';
      },
    },
    debugSink: null,
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
  const oldStart = controller.start();
  controller.stop();
  await controller.start();
  releaseOld({
    token: 'old',
    model: resolveVoiceModel('mini').id,
    transcribeModel: 'off',
  });
  await oldStart;
  assert.equal(controller._turns.speechTranscriptionEnabled, true);
  controller.stop();
});

test('retained peer and channel callbacks cannot act after stop or enter a replacement session', async (t) => {
  const { peers, streams } = browser(t);
  const actions = [];
  const controller = new GevRealtimeController({
    runner: async (name) => {
      actions.push(name);
      return { ok: true };
    },
    backend: {
      async requestToken() {
        return { token: 'synthetic', model: resolveVoiceModel('mini').id };
      },
      async negotiate() {
        return 'answer';
      },
    },
    debugSink: null,
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
  await controller.start();
  const old = peers[0];
  old.channel.handlers.get('open')();
  assert.equal(controller.status, 'listening');
  const message = {
    data: JSON.stringify({
      type: 'response.function_call_arguments.done',
      name: 'get_entity_context',
      call_id: 'stale',
      arguments: '{}',
    }),
  };
  controller.stop();
  assert.doesNotThrow(() => old.ontrack({ streams: [{}] }));
  await old.channel.handlers.get('message')(message);
  await controller.start();
  const current = peers[1];
  current.channel.handlers.get('open')();
  const audio = controller.audioEl;
  old.channel.readyState = 'open'; // Model an already queued callback from the old transport.
  old.channel.handlers.get('open')();
  await old.channel.handlers.get('message')(message);
  old.ontrack({ streams: [{}] });
  old.onicecandidateerror({ errorText: 'stale error' });
  assert.equal(controller.status, 'listening');
  assert.equal(controller.pc, current);
  assert.equal(controller.audioEl, audio);
  assert.equal(audio.srcObject, undefined);
  assert.deepEqual(actions, []);
  const incoming = {};
  current.ontrack({ streams: [incoming] });
  assert.equal(
    audio.srcObject,
    incoming,
    'the current peer still delivers audio',
  );
  controller.stop();
  assert.deepEqual(
    streams.map((s) => s.track.stops),
    [1, 1],
  );
});

test('an offer resolved after restart cannot change the replacement peer description', async (t) => {
  const { peers, Peer } = browser(t);
  let finishOldOffer;
  const originalOffer = Peer.prototype.createOffer;
  Peer.prototype.createOffer = function () {
    if (peers.indexOf(this) === 0)
      return new Promise((resolve) => {
        finishOldOffer = resolve;
      });
    return originalOffer.call(this);
  };
  const controller = new GevRealtimeController({
    runner: async () => ({ ok: true }),
    backend: {
      async requestToken() {
        return { token: 'synthetic', model: resolveVoiceModel('mini').id };
      },
      async negotiate() {
        return 'answer';
      },
    },
    debugSink: null,
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
  const firstStart = controller.start();
  while (!finishOldOffer) await new Promise((resolve) => setImmediate(resolve));
  controller.stop();
  await controller.start();
  const current = peers[1];
  finishOldOffer({ sdp: 'superseded offer' });
  await firstStart;
  assert.equal(controller.pc, current);
  assert.equal(current.localDescription.sdp, 'offer');
  assert.equal(peers[0].localDescription, undefined);
  controller.stop();
});

const localContext = {
  action: 'get_entity_context',
  scene: { basemap: { viewScale: 'local' } },
};

test('a late viewport capture cannot publish into a replacement or reset conversation', async () => {
  for (const reset of [false, true]) {
    let channel = { readyState: 'open' };
    let finish;
    const sent = [];
    const owner = new RealtimeViewport({
      readChannel: () => channel,
      capture: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
      operations: {
        sendRealtimeEvent(message) {
          sent.push(message);
          return true;
        },
      },
    });
    const pending = owner.sendVisualContextIfUseful(localContext);
    if (reset) owner.reset();
    else channel = { readyState: 'open' };
    finish('data:image/jpeg;base64,abc');
    assert.equal(await pending, false);
    assert.deepEqual(sent, []);
    assert.equal(owner.lastViewportItemId, null);
  }
});

test('a current viewport capture retains one image and replaces it through the protocol', async () => {
  const channel = { readyState: 'open' };
  const sent = [];
  const owner = new RealtimeViewport({
    readChannel: () => channel,
    capture: async () => 'data:image/jpeg;base64,abc',
    operations: {
      sendRealtimeEvent(message) {
        sent.push(message);
        return true;
      },
    },
  });
  assert.equal(await owner.sendVisualContextIfUseful(localContext), true);
  const first = owner.lastViewportItemId;
  assert.equal(await owner.sendVisualContextIfUseful(localContext), true);
  assert.equal(sent[1].type, 'conversation.item.delete');
  assert.equal(sent[1].item_id, first);
  assert.equal(sent[2].item.id, owner.lastViewportItemId);
  owner.reset();
  assert.equal(owner.lastViewportItemId, null);
  assert.equal(owner.pendingViewportDeletes.size, 0);
});

test('audio meter initialization failure releases its newly acquired AudioContext', (t) => {
  let closes = 0;
  class AudioContext {
    resume() {
      return Promise.resolve();
    }
    createAnalyser() {
      return {};
    }
    createMediaStreamSource() {
      throw new Error('analysis unavailable');
    }
    close() {
      closes++;
      return Promise.resolve();
    }
  }
  installGlobals(t, { window: { AudioContext } });
  const owner = new RealtimeInput({
    readUi: () => ({
      root: {
        querySelectorAll: () => [
          { style: { setProperty() {}, removeProperty() {} } },
        ],
      },
    }),
    readStatus: () => 'listening',
    readStream: () => null,
    operations: {},
  });
  owner.startVoiceVisualizer({});
  assert.equal(closes, 1);
  assert.equal(owner.visualizerAudioContext, null);
  owner.stopVoiceVisualizer();
  assert.equal(closes, 1);
});

test('stopping one audio meter revokes retained frames without stopping another meter', (t) => {
  const frames = [];
  const contexts = [];
  class AudioContext {
    constructor() {
      this.reads = 0;
      this.closes = 0;
      contexts.push(this);
    }
    resume() {
      return Promise.resolve();
    }
    createAnalyser() {
      return {
        frequencyBinCount: 32,
        getByteFrequencyData: (data) => {
          this.reads++;
          data.fill(30);
        },
      };
    }
    createMediaStreamSource() {
      return { connect() {}, disconnect() {} };
    }
    close() {
      this.closes++;
      return Promise.resolve();
    }
  }
  installGlobals(t, {
    window: { AudioContext },
    requestAnimationFrame: (callback) => {
      frames.push(callback);
      return frames.length;
    },
    cancelAnimationFrame() {},
  });
  const create = () =>
    new RealtimeInput({
      readUi: () => ({
        root: {
          querySelectorAll: () => [
            { style: { setProperty() {}, removeProperty() {} } },
          ],
        },
      }),
      readStatus: () => 'listening',
      readStream: () => null,
      operations: {},
    });
  const first = create();
  const second = create();
  first.startVoiceVisualizer({});
  second.startVoiceVisualizer({});
  first.stopVoiceVisualizer();
  const reads = contexts[0].reads;
  frames[0]();
  assert.equal(contexts[0].reads, reads);
  assert.equal(frames.length, 2, 'a revoked frame cannot rearm itself');
  frames[1]();
  assert.equal(contexts[1].reads, 2);
  assert.equal(
    frames.length,
    3,
    'the other meter retains its own render lifetime',
  );
  second.stopVoiceVisualizer();
  assert.deepEqual(
    contexts.map((c) => c.closes),
    [1, 1],
  );
});

test('late action or viewport completion cannot resume a stopped or replacement conversation', async (t) => {
  browser(t);
  for (const phase of ['tool', 'tool-error', 'viewport']) {
    for (const restart of [false, true]) {
      let finish;
      const controller = new GevRealtimeController({
        runner:
          phase === 'viewport'
            ? async () => ({ ok: true, ...localContext })
            : () =>
                new Promise((resolve, reject) => {
                  finish =
                    phase === 'tool-error'
                      ? () => reject(new Error('superseded action failed'))
                      : () =>
                          resolve({ ok: true, action: 'get_entity_context' });
                }),
        backend: {
          async requestToken() {
            return { token: 'synthetic', model: resolveVoiceModel('mini').id };
          },
          async negotiate() {
            return 'answer';
          },
        },
        debugSink: null,
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
      if (phase === 'viewport')
        controller._viewport.capture = () =>
          new Promise((resolve) => {
            finish = () => resolve('data:image/jpeg;base64,abc');
          });
      await controller.start();
      controller.dc.handlers.get('open')();
      controller.sendTextCommand('What is in the current view?');
      await controller.handleRealtimeEvent({
        data: JSON.stringify({
          type: 'response.created',
          response: {
            id: 'owned-response',
            metadata: controller.dc.sent.findLast(
              (e) => e.type === 'response.create',
            )?.response?.metadata,
          },
        }),
      });
      const pending = controller.handleRealtimeEvent({
        data: JSON.stringify({
          type: 'response.function_call_arguments.done',
          name: 'get_entity_context',
          response_id: 'owned-response',
          call_id: 'delayed',
          arguments: '{}',
        }),
      });
      while (!finish) await new Promise((resolve) => setImmediate(resolve));
      controller.stop();
      if (restart) {
        await controller.start();
        controller.dc.handlers.get('open')();
      }
      const status = controller.status;
      finish();
      await pending;
      assert.equal(
        controller.status,
        status,
        `${phase}: stopped status stays owned by the new lifetime`,
      );
      assert.deepEqual(
        controller.dc?.sent || [],
        [],
        `${phase}: no old result or response reaches the replacement`,
      );
      assert.equal(controller.pendingResponseInstructions, null);
      controller.stop();
    }
  }
});
