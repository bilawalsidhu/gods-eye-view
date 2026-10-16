// Real provider facade/common session/controllers, action runner, manager and
// Radio playback. Browser transport, media and presentation are deterministic.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createProviderCommands } from './providerCommands.js';
import { createVoiceCommands } from './sessionCommands.js';
import { createRealtimeSession } from './realtimeSession.js';
import { createGevActionRunner } from './gevActions.js';
import { DataLayerManager } from '../data/manager.js';
import { createPlayback } from '../layers/radio/playback.js';
import { createSelection } from '../layers/radio/selection.js';
import { createVolume } from '../layers/radio/volume.js';
import { createTuning } from '../layers/radio/tuning.js';
import { createTuningNoise } from '../layers/radio/tuningNoise.js';
import { resolveVoiceModel } from './voiceCost.js';
import { harness, deferred, tick } from './geminiNativeHarness.mjs';

function element() {
  return Object.assign(new EventTarget(), {
    dataset: {},
    style: {},
    classList: { remove() {}, toggle() {} },
    setAttribute() {},
    remove() {},
    focus() {},
    querySelectorAll: () => [],
  });
}

function fixture(t, initialProvider) {
  const saved = new Map();
  const install = (name, value) => {
    saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, {
      configurable: true,
      writable: true,
      value,
    });
  };
  const views = [];
  const peers = [];
  const geminis = [];
  const starts = [];
  const mediaGates = [];
  const controlsEvents = [];
  const sessionEvents = [];
  const audioElements = [];
  let clock = 1000;
  t.mock.method(Date, 'now', () => clock);
  const browserWindow = new EventTarget();
  const doc = Object.assign(new EventTarget(), {
    body: { appendChild() {} },
    querySelectorAll: () => [],
    createElement: () => element(),
    getElementById: () => views.at(-1)?.providerSelect,
  });
  class Peer {
    constructor() {
      this.connectionState = 'connected';
      peers.push(this);
    }
    addTrack() {}
    createDataChannel() {
      this.channel = Object.assign(new EventTarget(), {
        readyState: 'open',
        sent: [],
        send(raw) {
          this.sent.push(JSON.parse(raw));
        },
        close() {
          this.readyState = 'closed';
        },
      });
      return this.channel;
    }
    async createOffer() {
      return { sdp: 'offer' };
    }
    async setLocalDescription(value) {
      this.localDescription = value;
    }
    async setRemoteDescription() {
      this.channel.dispatchEvent(new Event('open'));
    }
    close() {
      this.connectionState = 'closed';
    }
  }
  class Audio extends EventTarget {
    constructor() {
      super();
      audioElements.push(this);
    }
    play() {
      const gate = mediaGates.shift();
      return Promise.resolve(gate?.promise).then(() =>
        this.dispatchEvent(new Event('playing')),
      );
    }
    pause() {
      this.dispatchEvent(new Event('pause'));
    }
    removeAttribute() {
      this.src = '';
    }
    load() {}
  }
  browserWindow.RTCPeerConnection = Peer;
  install('window', browserWindow);
  install('document', doc);
  install('RTCPeerConnection', Peer);
  install('Audio', Audio);
  install('navigator', {
    mediaDevices: {
      async getUserMedia() {
        const track = {
          enabled: true,
          readyState: 'live',
          stop() {
            this.readyState = 'ended';
          },
        };
        return { getTracks: () => [track], getAudioTracks: () => [track] };
      },
    },
  });
  const viewer = {
    clock: { onTick: { addEventListener: () => () => {} } },
    camera: { moveEnd: { addEventListener() {} } },
    scene: { canvas: { addEventListener() {}, removeEventListener() {} } },
  };
  const manager = new DataLayerManager(viewer);
  const station = {
    id: 'station-one',
    name: 'Station One',
    streamUrl: 'https://radio.invalid/one',
  };
  const secondStation = {
    id: 'station-two',
    name: 'Station Two',
    streamUrl: 'https://radio.invalid/two',
  };
  const state = {
    _enabled: false,
    _voiceDucked: false,
    _userVolume: 0.8,
    _audioState: 'stopped',
    _audio: null,
    _playGeneration: 0,
    _playAttemptSequence: 0,
    _selectedId: station.id,
    _selectionGeneration: 0,
    _sessionGeneration: 0,
    _stationById: new Map([
      [station.id, station],
      [secondStation.id, secondStation],
    ]),
    _acceptedCatalogSnapshot: {
      generation: 1,
      stations: [station, secondStation],
    },
    _tuningActive: false,
  };
  const playbackListeners = new Set();
  const stateListeners = new Set();
  const getUIState = () => ({
    enabled: state._enabled,
    stationCount: 2,
    selected: state._stationById.get(state._selectedId),
    audioState: state._audioState,
    voiceDucked: state._voiceDucked,
    playingStationId: state._audioStationId,
    tuningActive: state._tuningActive,
    tuningAwaitingStationId: state._tuningAwaitingStationId,
    tuningRestoredStationId:
      state._cancelledTuningPresentationStation?.id || null,
  });
  const parts = {
    queries: {
      selectedStation: () => state._stationById.get(state._selectedId),
      visibleStations: () => [...state._stationById.values()],
    },
    interaction: { radioPresentationAllowed: () => state._enabled },
    tuning: { endRadioTuning() {} },
    tuningNoise: { clearRadioTuningNoise() {} },
    navigation: {
      radioCameraNavigationOwnsSelection: () => false,
      invalidateRadioCameraNavigation() {},
    },
    rendering: { updateSelectionEntity() {} },
    presentation: {
      emitState: () => {
        for (const fn of stateListeners) fn(getUIState());
      },
      emitPlaybackControl(action, origin, attemptId) {
        const event = { action, origin, attemptId };
        controlsEvents.push(event);
        for (const fn of playbackListeners) fn(event);
      },
      getRadioUIState: getUIState,
      subscribeToRadio(fn) {
        stateListeners.add(fn);
        fn(getUIState());
        return () => stateListeners.delete(fn);
      },
    },
  };
  const playback = createPlayback({
    state,
    parts,
    services: {},
    source: { recordClick() {} },
  });
  parts.playback = playback;
  parts.tuningNoise.syncTuningNoiseGain = () => {};
  parts.volume = createVolume({ state, parts });
  const selection = createSelection({
    state,
    parts,
    services: { ground: { warmGroundFloor() {} } },
  });
  parts.selection = selection;
  parts.model = {
    tuningResolutionStation: (id) => state._tuningStationById?.get(id),
    radioStationResolutionMatches: (frozen, current) =>
      frozen?.id === current?.id,
  };
  parts.tuningNoise = createTuningNoise({ state, parts });
  parts.tuning = createTuning({ state, parts });
  const radio = {
    id: 'radio',
    name: 'Radio',
    updateInterval: -1,
    async init() {},
    async update() {},
    getStats: () => ({ count: 1 }),
    enable() {
      state._enabled = true;
      parts.presentation.emitState();
    },
    disable() {
      state._enabled = false;
      playback.stopRadioPlayback({ origin: 'layer-disable' });
    },
    getUIState,
    subscribe: parts.presentation.subscribeToRadio,
    subscribePlaybackControls(fn) {
      playbackListeners.add(fn);
      return () => playbackListeners.delete(fn);
    },
    setVoiceDucked(value) {
      state._voiceDucked = value;
      parts.presentation.emitState();
    },
    pause: playback.pauseRadioPlayback,
    stopPlayback: playback.stopRadioPlayback,
    playForVoice: playback.playPreparedRadioForVoice,
  };
  manager.register(radio);
  const runner = createGevActionRunner({ viewer, dataManager: manager });
  const backend = {
    async requestToken() {
      starts.push('openai');
      return { token: 'synthetic', model: resolveVoiceModel('mini').id };
    },
    async negotiate() {
      return 'answer';
    },
  };
  const createControl = () => {
    const select = element();
    select.options = [];
    select.ownerDocument = { createElement: () => ({}) };
    select.replaceChildren = (...options) => {
      select.options = options;
    };
    const ui = {
      root: element(),
      button: element(),
      providerSelect: select,
      providerField: element(),
      status: element(),
      detail: element(),
      tierButton: element(),
      costValue: element(),
      errorDetail: element(),
      helpDetail: element(),
    };
    views.push(ui);
    return ui;
  };
  const controls = createProviderCommands(
    {
      runner,
      dataManager: manager,
      backend,
      debugSink: null,
      onSessionEvent: (event) => sessionEvents.push(event),
    },
    {
      storage: { getItem: () => initialProvider, setItem() {} },
      bind: (options) => createVoiceCommands({ ...options, createControl }),
      factories: {
        openai: createRealtimeSession,
        gemini(options) {
          const h = harness({
            ...options,
            fetchImpl: async (_url, init) => {
              starts.push('gemini');
              return {
                ok: true,
                json: async () => ({
                  token: 'auth_tokens/test',
                  model: 'gemini-3.8-live',
                  websocketUrl:
                    'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained',
                  config: {
                    generationConfig: { responseModalities: ['AUDIO'] },
                    ...(JSON.parse(init.body).inputMode === 'push-to-talk'
                      ? {
                          realtimeInputConfig: {
                            automaticActivityDetection: { disabled: true },
                          },
                        }
                      : {}),
                  },
                }),
              };
            },
          });
          geminis.push(h);
          return {
            controller: h.c,
            capabilities: { pushToTalk: true },
            start: (settings) => h.c.start(settings),
            stop: (settings) => h.c.stop(settings),
            getStartOptions: () => ({
              pushToTalk: Boolean(h.c.input.pushToTalkMode),
            }),
            sendText: (text) => h.c.sendTextCommand(text),
            sendMapEvent: (event) => h.c.notifyMapEvent(event),
          };
        },
      },
    },
  );
  t.after(async () => {
    controls.destroy();
    clearTimeout(state._selectionTimer);
    runner.dispose();
    await manager.setEnabled('radio', false);
    for (const [name, descriptor] of saved)
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
  });
  const receiveOpenAI = async (payload) => {
    const channel = peers.at(-1).channel;
    // EventTarget cannot await listeners; production handler returns a promise.
    channel.dispatchEvent(
      new MessageEvent('message', { data: JSON.stringify(payload) }),
    );
    await tick();
  };
  return {
    controls,
    parts,
    radio,
    manager,
    state,
    starts,
    views,
    controlsEvents,
    sessionEvents,
    mediaGates,
    audioElements,
    advance(ms) {
      clock += ms;
      for (const h of geminis) h.advance(ms);
    },
    selectProvider(provider) {
      views.at(-1).providerSelect.value = provider;
      views.at(-1).providerSelect.dispatchEvent(new Event('change'));
    },
    manualPlay: () => playback.playSelectedRadio({ origin: 'user' }),
    pause: () => playback.pauseRadioPlayback({ origin: 'user' }),
    stopRadio: () => playback.stopRadioPlayback({ origin: 'user' }),
    selectStation: () =>
      selection.selectRadioStation(secondStation.id, {
        autoplay: true,
        origin: 'user',
      }),
    setVolume: (value) => parts.volume.setRadioVolume(value),
    beginTuning: () => parts.tuning.beginRadioTuning(),
    cancelTuning: () => parts.tuning.cancelRadioTuning(),
    commitTuning: () =>
      parts.tuning.commitRadioTuningStation(secondStation.id, {
        origin: 'user',
      }),
    async voicePlay() {
      assert.notEqual(controls.sendTextCommand('Play radio'), false);
      if (controls.provider === 'gemini') {
        const h = geminis.at(-1);
        const ws = h.sockets.at(-1);
        ws.message({
          toolCall: {
            functionCalls: [
              {
                id: 'play-radio',
                name: 'control_radio',
                args: { action: 'play' },
              },
            ],
          },
        });
        await h.c.toolQueue;
        ws.message({
          serverContent: {
            modelTurn: { parts: [{ inlineData: { data: 'AAAA' } }] },
            turnComplete: true,
          },
        });
        h.captures.at(-1).drain();
        await tick();
      } else {
        await receiveOpenAI({
          type: 'response.created',
          response: {
            id: 'radio-request',
            metadata: peers
              .at(-1)
              .channel.sent.findLast(
                (event) => event.type === 'response.create',
              ).response.metadata,
          },
        });
        await receiveOpenAI({
          type: 'response.function_call_arguments.done',
          response_id: 'radio-request',
          call_id: 'play-radio',
          name: 'control_radio',
          arguments: '{"action":"play"}',
        });
        await receiveOpenAI({
          type: 'response.done',
          response: {
            id: 'radio-request',
            status: 'completed',
            output: [{ type: 'function_call' }],
          },
        });
        await receiveOpenAI({
          type: 'response.created',
          response: {
            id: 'radio-confirmation',
            metadata: peers
              .at(-1)
              .channel.sent.findLast(
                (event) => event.type === 'response.create',
              ).response.metadata,
          },
        });
        await receiveOpenAI({
          type: 'response.done',
          response: { id: 'radio-confirmation', status: 'completed' },
        });
      }
    },
  };
}

for (const provider of ['openai', 'gemini']) {
  for (const route of ['manual', 'voice']) {
    for (const end of ['pause', 'off']) {
      test(`${provider} ${route} Radio playback suspends active voice and ${end} resumes after more than 30 seconds`, async (t) => {
        const f = fixture(t, provider);
        await f.manager.setEnabled('radio', true);
        await f.controls.start();
        assert.equal(f.controls.isActive(), true);
        if (route === 'manual') await f.manualPlay();
        else await f.voicePlay();
        assert.equal(f.state._audioState, 'playing');
        assert.equal(f.controls.isActive(), false);
        const starts = f.starts.length;
        f.advance(120_000);
        if (end === 'pause') f.pause();
        else await f.manager.setEnabled('radio', false, { origin: 'user' });
        await tick();
        assert.equal(
          f.controls.isActive(),
          true,
          'Radio interrupted active voice, so it must resume',
        );
        assert.equal(f.starts.length, starts + 1);
        f.stopRadio();
        await tick();
        assert.equal(f.starts.length, starts + 1, 'resume is one-shot');
      });
    }
  }
  test(`${provider} Radio pause/off never enables voice that was already off`, async (t) => {
    const f = fixture(t, provider);
    await f.manager.setEnabled('radio', true);
    await f.manualPlay();
    f.pause();
    await f.manualPlay();
    await f.manager.setEnabled('radio', false, { origin: 'user' });
    await tick();
    assert.equal(f.controls.isActive(), false);
    assert.deepEqual(f.starts, []);
  });
  test(`${provider} explicit voice ON pauses currently playing Radio`, async (t) => {
    const f = fixture(t, provider);
    await f.manager.setEnabled('radio', true);
    await f.manualPlay();
    await f.controls.start();
    assert.equal(f.controls.isActive(), true);
    assert.equal(f.state._audioState, 'paused');
  });
  for (const end of ['pause', 'off']) {
    test(`${provider} provider switch during Radio playback cancels resume on ${end}`, async (t) => {
      const f = fixture(t, provider);
      await f.manager.setEnabled('radio', true);
      await f.controls.start();
      await f.voicePlay();
      assert.equal(f.controls.isActive(), false);
      const starts = f.starts.length;
      f.selectProvider(provider === 'openai' ? 'gemini' : 'openai');
      assert.equal(f.controls.isActive(), false);
      if (end === 'pause') f.pause();
      else await f.manager.setEnabled('radio', false, { origin: 'user' });
      await tick();
      assert.equal(f.controls.isActive(), false);
      assert.equal(f.starts.length, starts);
    });
  }
  test(`${provider} explicit voice OFF cancels a suspended voice resume`, async (t) => {
    const f = fixture(t, provider);
    await f.manager.setEnabled('radio', true);
    await f.controls.start();
    await f.voicePlay();
    f.controls.stop();
    const starts = f.starts.length;
    f.pause();
    await tick();
    assert.equal(f.controls.isActive(), false);
    assert.equal(f.starts.length, starts);
  });
  test(`${provider} enabling Radio alone preserves active voice and never starts playback`, async (t) => {
    const f = fixture(t, provider);
    await f.controls.start();
    await f.manager.setEnabled('radio', true, { origin: 'user' });
    assert.equal(f.controls.isActive(), true);
    assert.equal(f.state._audioState, 'stopped');
    assert.equal(f.audioElements.length, 0);
  });
  test(`${provider} station replacement, volume, repeated layer enable and same provider preserve rightful resume`, async (t) => {
    const f = fixture(t, provider);
    await f.manager.setEnabled('radio', true);
    await f.controls.start();
    await f.voicePlay();
    const starts = f.starts.length;
    const oldAudio = f.audioElements.at(-1);
    f.setVolume(0.4);
    await f.manager.setEnabled('radio', true, { origin: 'user' });
    f.selectProvider(provider); // Selecting the same provider is not a switch.
    assert.equal(f.selectStation(), true);
    await tick();
    assert.equal(f.radio.getUIState().selected.id, 'station-two');
    assert.equal(f.state._audioState, 'playing');
    oldAudio.dispatchEvent(new Event('playing'));
    oldAudio.dispatchEvent(new Event('waiting'));
    oldAudio.dispatchEvent(new Event('pause'));
    assert.equal(
      f.state._audioState,
      'playing',
      'retired media cannot affect the replacement',
    );
    assert.equal(f.controls.isActive(), false);
    f.pause();
    await tick();
    assert.equal(f.controls.isActive(), true);
    assert.equal(f.starts.length, starts + 1);
  });
  test(`${provider} failed manual playback leaves active voice on`, async (t) => {
    const f = fixture(t, provider);
    await f.manager.setEnabled('radio', true);
    await f.controls.start();
    const rejected = deferred();
    f.mediaGates.push(rejected);
    const play = f.manualPlay();
    assert.equal(
      f.controls.isActive(),
      true,
      'play-request alone cannot suspend voice',
    );
    rejected.resolve(Promise.reject(new Error('Stream refused')));
    assert.equal(await play, false);
    assert.equal(f.controls.isActive(), true);
  });
  for (const override of ['explicit-off', 'provider-change']) {
    test(`${provider} ${override} defeats Radio pause resume queued before its microtask`, async (t) => {
      const f = fixture(t, provider);
      await f.manager.setEnabled('radio', true);
      await f.controls.start();
      await f.voicePlay();
      const starts = f.starts.length;
      f.pause();
      if (override === 'explicit-off') f.controls.stop();
      else f.selectProvider(provider === 'openai' ? 'gemini' : 'openai');
      await tick();
      assert.equal(f.controls.isActive(), false);
      assert.equal(f.starts.length, starts);
    });
  }
  test(`${provider} replacement play before queued pause resume keeps voice suspended until the new attempt pauses`, async (t) => {
    const f = fixture(t, provider);
    await f.manager.setEnabled('radio', true);
    await f.controls.start();
    await f.voicePlay();
    const starts = f.starts.length;
    f.pause();
    const replacement = f.manualPlay();
    await replacement;
    await tick();
    assert.equal(f.controls.isActive(), false);
    assert.equal(f.starts.length, starts);
    f.pause();
    await tick();
    assert.equal(f.controls.isActive(), true);
    assert.equal(f.starts.length, starts + 1);
  });
  test(`${provider} explicit OFF defeats delayed replacement media completion`, async (t) => {
    const f = fixture(t, provider);
    await f.manager.setEnabled('radio', true);
    await f.controls.start();
    await f.voicePlay();
    const starts = f.starts.length;
    const delayed = deferred();
    f.mediaGates.push(delayed);
    const replacement = f.manualPlay();
    f.controls.stop();
    delayed.resolve();
    await replacement;
    f.pause();
    await tick();
    assert.equal(f.controls.isActive(), false);
    assert.equal(f.starts.length, starts);
  });
  test(`${provider} tuner drag keeps voice suspended and settled cancellation resumes its saved owner`, async (t) => {
    const f = fixture(t, provider);
    await f.manager.setEnabled('radio', true);
    await f.controls.start();
    await f.voicePlay();
    const starts = f.starts.length;
    assert.equal(f.beginTuning(), true);
    await tick();
    assert.equal(f.state._audioState, 'paused');
    assert.equal(
      f.controls.isActive(),
      false,
      'internal drag pause is not explicit user pause',
    );
    assert.equal(f.starts.length, starts);
    assert.equal(f.cancelTuning(), true);
    await tick();
    assert.equal(f.controls.isActive(), true);
    assert.equal(f.starts.length, starts + 1);
  });
  test(`${provider} tuner commit keeps the saved owner through pending and successful replacement playback`, async (t) => {
    const f = fixture(t, provider);
    await f.manager.setEnabled('radio', true);
    await f.controls.start();
    await f.voicePlay();
    const starts = f.starts.length;
    f.beginTuning();
    const gate = deferred();
    f.mediaGates.push(gate);
    assert.equal(f.commitTuning().ok, true);
    await tick();
    assert.equal(f.controls.isActive(), false);
    assert.equal(f.starts.length, starts);
    gate.resolve();
    await tick();
    assert.equal(f.state._audioState, 'playing');
    assert.equal(f.controls.isActive(), false);
    f.pause();
    await tick();
    assert.equal(f.controls.isActive(), true);
    assert.equal(f.starts.length, starts + 1);
  });
  test(`${provider} provider replacement during tuning defeats the retired state callback on cancel`, async (t) => {
    const f = fixture(t, provider);
    await f.manager.setEnabled('radio', true);
    await f.controls.start();
    await f.voicePlay();
    const starts = f.starts.length;
    f.beginTuning();
    f.selectProvider(provider === 'openai' ? 'gemini' : 'openai');
    f.cancelTuning();
    await tick();
    assert.equal(f.controls.isActive(), false);
    assert.equal(f.starts.length, starts);
  });
  test(`${provider} failed replacement preserves suspended voice ownership until explicit Radio OFF`, async (t) => {
    const f = fixture(t, provider);
    await f.manager.setEnabled('radio', true);
    await f.controls.start();
    await f.voicePlay();
    const starts = f.starts.length;
    const failed = deferred();
    f.mediaGates.push(failed);
    const replacement = f.manualPlay();
    await tick();
    assert.equal(
      f.controls.isActive(),
      false,
      'prepared replacement cannot resume voice',
    );
    failed.resolve(Promise.reject(new Error('Replacement failed')));
    assert.equal(await replacement, false);
    assert.equal(
      f.controls.isActive(),
      false,
      'failure is not a user pause or off',
    );
    await f.manager.setEnabled('radio', false, { origin: 'user' });
    await tick();
    assert.equal(f.controls.isActive(), true);
    assert.equal(f.starts.length, starts + 1);
  });
}

// A drag ending paused with no new stream must give back the voice Radio
// interrupted: commit to a vanished station, or release without a station.
for (const provider of ['openai', 'gemini']) {
  for (const ending of [
    'commit to an unavailable station',
    'release without a station',
  ]) {
    test(`${provider} tuner ${ending} resumes the voice Radio interrupted`, async (t) => {
      const f = fixture(t, provider);
      await f.manager.setEnabled('radio', true);
      await f.controls.start();
      await f.voicePlay();
      assert.equal(f.controls.isActive(), false, 'voice suspended by Radio');
      const starts = f.starts.length;
      assert.equal(f.beginTuning(), true);
      if (ending === 'commit to an unavailable station') {
        f.state._stationById.delete('station-two');
        const result = f.commitTuning();
        assert.equal(result.ok, false);
        assert.equal(result.reason, 'station-unavailable');
      } else f.parts.tuning.endRadioTuning();
      await tick();
      assert.equal(f.state._audioState, 'paused', 'Radio no longer plays');
      assert.equal(f.controls.isActive(), true, 'interrupted voice resumes');
      assert.equal(f.starts.length, starts + 1, 'resumes exactly once');
      f.stopRadio();
      await tick();
      assert.equal(
        f.starts.length,
        starts + 1,
        'a later Stop cannot resume again',
      );
    });
  }
}

// The host is told when Radio playback stops active voice, so it can explain
// the silence. Radio started while voice is already OFF stops nothing.
const radioSuspensions = (f) =>
  f.sessionEvents.filter(
    (event) => event.type === 'voice-suspended' && event.reason === 'radio',
  ).length;
for (const provider of ['openai', 'gemini']) {
  for (const route of ['voice', 'manual']) {
    test(`${provider} ${route} Radio playback reports the voice it stopped once`, async (t) => {
      const f = fixture(t, provider);
      await f.manager.setEnabled('radio', true);
      await f.controls.start();
      assert.equal(radioSuspensions(f), 0);
      if (route === 'voice') await f.voicePlay();
      else await f.manualPlay();
      await tick();
      assert.equal(f.controls.isActive(), false, 'Radio stopped voice');
      assert.equal(radioSuspensions(f), 1);
    });
  }
  test(`${provider} Radio started with voice OFF reports nothing`, async (t) => {
    const f = fixture(t, provider);
    await f.manager.setEnabled('radio', true);
    await f.manualPlay();
    await tick();
    assert.equal(radioSuspensions(f), 0);
  });
}
