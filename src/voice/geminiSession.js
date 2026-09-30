import { createGeminiAudio } from './geminiAudio.js';
import { RealtimeInput } from './realtimeInput.js';
import { RealtimeRadio } from './realtimeRadio.js';
import { captureViewportImage } from './realtimeViewport.js';
import {
  hasStructuredViewIdentity,
  shouldSendViewportImage,
} from './realtimeProtocol.js';

const SOCKET_PATH =
  /^\/ws\/google\.ai\.generativelanguage\.v1(?:alpha|beta)\.GenerativeService\.BidiGenerateContentConstrained$/;
const MAX_BUFFERED_BYTES = 256 * 1024;
const MAX_MESSAGE_LENGTH = 3 * 1024 * 1024;
const MAX_TOOL_CALLS = 16;
const MAX_MAP_EVENTS = 16;
const MAX_MAP_CONTEXT_LENGTH = 16000;

/** Only an ephemeral token can be attached to the fixed Google Live endpoint. */
export function geminiSocketUrl({ token, websocketUrl }) {
  if (
    typeof token !== 'string' ||
    !token.startsWith('auth_tokens/') ||
    token.length > 8192
  )
    throw new Error(
      'Gemini token response did not include an ephemeral credential',
    );
  let url;
  try {
    url = new URL(websocketUrl);
  } catch {
    throw new Error('Invalid Gemini connection endpoint');
  }
  if (
    url.protocol !== 'wss:' ||
    url.hostname !== 'generativelanguage.googleapis.com' ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !SOCKET_PATH.test(url.pathname)
  )
    throw new Error('Invalid Gemini connection endpoint');
  url.searchParams.set('access_token', token);
  return url.href;
}

function cancelled() {
  return new DOMException('Voice operation cancelled', 'AbortError');
}

function awaitWithSignal(promise, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason || cancelled());
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    Promise.resolve(promise)
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', abort));
  });
}

/** Gemini owns its socket/media; the common session owns action authorization. */
export class GeminiSessionController {
  constructor({
    emit,
    runAction,
    signal,
    ui,
    radioLayer = null,
    dataManager = null,
    tokenEndpoint = '/api/gemini/token',
    startupTimeoutMs = 30_000,
    fetchImpl = (...args) => fetch(...args),
    WebSocketClass = globalThis.WebSocket,
    getUserMedia = (settings) => navigator.mediaDevices.getUserMedia(settings),
    createAudio = createGeminiAudio,
    createInput = (settings) => new RealtimeInput(settings),
    captureViewport = captureViewportImage,
  }) {
    Object.assign(this, {
      emit,
      runAction,
      signal,
      ui,
      tokenEndpoint,
      startupTimeoutMs,
      fetchImpl,
      WebSocketClass,
      getUserMedia,
      createAudio,
      captureViewport,
    });
    this.status = 'idle';
    this.model = null;
    this.epoch = 0;
    this.turn = 0;
    this.disposed = false;
    this.socket = null;
    this.channel = null;
    this.stream = null;
    this.audio = null;
    this.abort = null;
    this.tools = new Map();
    this.radioPlaybackCalls = new WeakMap();
    this.seenCalls = new Set();
    this.cancelledCalls = new Set();
    this.toolQueue = Promise.resolve();
    this.pendingTools = 0;
    this.modelComplete = false;
    this.pendingCompletionStatus = null;
    this.postToolOutput = false;
    this.transcripts = { user: '', assistant: '' };
    this.pendingMapEvents = [];
    this.userTurnPending = false;
    this.lastError = null;
    this.completedTurns = 0;
    this.lastAudio = null;
    this.lastViewportAt = 0;
    this.input = createInput({
      readUi: () => ui,
      readStream: () => this.stream,
      readStatus: () => this.status,
      operations: {
        isActive: () => this.isActive(),
        start: (settings) => this.start(settings),
        setStatus: (...args) => this.setStatus(...args),
        pauseRadioForVoice: () => this.radio.pauseRadioForVoice(),
      },
    });
    const setMicrophoneEnabled = this.input.setMicrophoneEnabled.bind(
      this.input,
    );
    this.input.setMicrophoneEnabled = (enabled) => {
      setMicrophoneEnabled(enabled);
      this.audio?.setMicrophoneEnabled(enabled);
      if (enabled && this.channel?.readyState === 'open')
        this.noteUserActivity();
    };
    this.radio = new RealtimeRadio({
      readRadioLayer: () => radioLayer,
      readDataManager: () => dataManager,
      readChannel: () => this.channel,
      readUserTurnPending: () => this.userTurnPending,
      readSessionId: () => `gemini-${this.epoch}`,
      operations: {
        abortTools: () => this.abortTools(),
        isActive: () => this.isActive(),
        stop: (settings) => this.stop(settings),
        readVoiceResumeSettings: () => ({
          pushToTalk: Boolean(this.input.pushToTalkMode),
        }),
        resumeVoice: (settings) => this.start(settings),
        setStatus: (...args) => this.setStatus(...args),
        // The shared Radio owner already surfaces a failed start in the UI.
        queueResponseCreate: () => {},
        debugLog: () => {},
      },
    });
    this.radio.observe();
    this.lifetimeAbort = () => this.stop({ removeUi: true });
    signal?.addEventListener('abort', this.lifetimeAbort, { once: true });
  }

  get spaceKeyHeld() {
    return this.input.spaceKeyHeld;
  }
  isActive() {
    return !['idle', 'error'].includes(this.status);
  }
  owns(epoch) {
    return (
      !this.disposed && epoch === this.epoch && !this.abort?.signal.aborted
    );
  }

  setStatus(status, detail) {
    this.status = status;
    if (status === 'listening' && this.input.pushToTalkMode)
      detail = this.input.pushToTalkKeyHeld
        ? 'Release Space to send'
        : 'Hold Space to talk';
    this.emit({ type: 'state', state: status, detail });
    this.input.updateVoiceButtonLabel();
    if (['idle', 'connecting', 'error'].includes(status))
      this.input.setVoiceSpeaker('idle');
  }

  send(message, { beforeSetup = false } = {}) {
    if (
      this.socket?.readyState !== 1 ||
      (!beforeSetup && this.channel?.readyState !== 'open')
    )
      return false;
    if (this.socket.bufferedAmount > MAX_BUFFERED_BYTES)
      throw new Error(
        'Gemini connection cannot keep up with microphone audio. Reconnect to continue.',
      );
    const body = JSON.stringify(message);
    if (body.length > MAX_MESSAGE_LENGTH)
      throw new Error('Voice command context is too large');
    this.socket.send(body);
    return true;
  }

  async requestToken(signal, pushToTalk = false) {
    const response = await this.fetchImpl(this.tokenEndpoint, {
      method: 'POST',
      cache: 'no-store',
      redirect: 'error',
      signal,
      headers: { 'Content-Type': 'application/json' },
      body: pushToTalk ? '{"inputMode":"push-to-talk"}' : '{}',
    });
    const data = await response.json().catch(() => null);
    signal.throwIfAborted();
    if (!response.ok)
      throw new Error(
        typeof data?.error === 'string'
          ? data.error
          : `Gemini token request failed (HTTP ${response.status})`,
      );
    if (
      typeof data?.model !== 'string' ||
      !/^gemini-[a-z0-9.-]+$/.test(data.model)
    )
      throw new Error('Gemini token response did not include a valid model');
    if (
      !data.config ||
      typeof data.config !== 'object' ||
      Array.isArray(data.config)
    )
      throw new Error('Gemini token response did not include session settings');
    const manual =
      data.config.realtimeInputConfig?.automaticActivityDetection?.disabled;
    if (pushToTalk ? manual !== true : manual !== undefined && manual !== false)
      throw new Error('Gemini session settings do not match the input mode');
    const url = geminiSocketUrl(data);
    return { ...data, url };
  }

  async start({ pushToTalk = false } = {}) {
    if (this.disposed || this.isActive() || this.signal?.aborted) return;
    const held = pushToTalk && this.input.pushToTalkKeyHeld;
    const spaceHeld = this.input.spaceKeyHeld;
    this.stop({ preserveStatus: true });
    this.input.pushToTalkMode = pushToTalk;
    this.input.pushToTalkKeyHeld = held;
    this.input.spaceKeyHeld = spaceHeld;
    this.abort = new AbortController();
    const epoch = this.epoch;
    const signal = AbortSignal.any([
      this.abort.signal,
      ...(this.signal ? [this.signal] : []),
      AbortSignal.timeout(this.startupTimeoutMs),
    ]);
    this.lastError = null;
    this.lastAudio = null;
    this.completedTurns = 0;
    this.setStatus('connecting', 'Connecting to Gemini');
    this.radio.pauseRadioForVoice();
    let acquiredStream = null;
    let releasedStream = null;
    const releaseStream = (stream) => {
      if (!stream || stream === releasedStream) return;
      releasedStream = stream;
      stream.getTracks().forEach((track) => track.stop());
    };
    try {
      // The worklet serializes start, PCM and flushed end notifications. A
      // keydown must not send a new start ahead of the previous queued end.
      let activityOpen = false;
      const audio = this.createAudio({
        onAudioStart: () => {
          if (this.owns(epoch) && pushToTalk && !activityOpen)
            activityOpen = this.send({ realtimeInput: { activityStart: {} } });
        },
        onAudio: (chunk) => {
          if (this.owns(epoch) && (!pushToTalk || activityOpen))
            this.send({ realtimeInput: { audio: chunk } });
        },
        onAudioEnd: () => {
          if (!this.owns(epoch)) return;
          if (pushToTalk) {
            if (activityOpen) this.send({ realtimeInput: { activityEnd: {} } });
            activityOpen = false;
          } else {
            this.send({ realtimeInput: { audioStreamEnd: true } });
          }
        },
        onDrain: () => {
          if (this.owns(epoch)) this.finishPlayback();
        },
        onError: (error) => {
          if (this.owns(epoch)) this.fail(error);
        },
      });
      this.audio = audio;
      const [, credential] = await awaitWithSignal(
        Promise.all([
          audio.initialize(signal),
          this.requestToken(signal, pushToTalk),
        ]),
        signal,
      );
      if (!this.owns(epoch)) return;
      this.model = credential.model;
      await this.connect(credential, epoch, signal);
      if (!this.owns(epoch)) return;
      this.setStatus('connecting', 'Requesting microphone');
      const mediaRequest = Promise.resolve(
        this.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
            channelCount: 1,
          },
        }),
      );
      // Permission prompts cannot be cancelled. A later grant still belongs
      // to this attempt and must release its own tracks after stop/timeout.
      void mediaRequest.then(
        (stream) => {
          if (!this.owns(epoch) || signal.aborted) releaseStream(stream);
        },
        () => {},
      );
      acquiredStream = await awaitWithSignal(mediaRequest, signal);
      if (!this.owns(epoch)) {
        releaseStream(acquiredStream);
        return;
      }
      signal.throwIfAborted();
      this.stream = acquiredStream;
      const enabled =
        !this.input.pushToTalkMode || this.input.pushToTalkKeyHeld;
      this.input.setMicrophoneEnabled(enabled);
      audio.connectMicrophone(acquiredStream, enabled);
      this.input.startVoiceVisualizer(acquiredStream);
      this.input.startAssistantVoiceVisualizer(audio.outputStream);
      this.setStatus('listening', 'Ask or command');
    } catch (error) {
      if (acquiredStream && acquiredStream !== this.stream)
        releaseStream(acquiredStream);
      if (this.owns(epoch)) this.fail(error);
    }
  }

  connect(credential, epoch, signal) {
    return new Promise((resolve, reject) => {
      const socket = new this.WebSocketClass(credential.url);
      socket.binaryType = 'arraybuffer';
      this.socket = socket;
      const channel = { readyState: 'connecting' };
      this.channel = channel;
      let connected = false;
      const current = () => this.owns(epoch) && this.socket === socket;
      const abort = () => {
        signal.removeEventListener('abort', abort);
        reject(cancelled());
      };
      signal.addEventListener('abort', abort, { once: true });
      socket.onopen = () => {
        if (!current()) return;
        try {
          this.send(
            {
              setup: {
                ...credential.config,
                model: `models/${credential.model}`,
              },
            },
            { beforeSetup: true },
          );
        } catch (error) {
          reject(error);
        }
      };
      socket.onmessage = ({ data }) => {
        if (!current()) return;
        try {
          const text =
            typeof data === 'string' ? data : new TextDecoder().decode(data);
          if (text.length > MAX_MESSAGE_LENGTH)
            throw new Error('Gemini returned an oversized message');
          const message = JSON.parse(text);
          if (message.setupComplete) {
            if (connected) return;
            connected = true;
            channel.readyState = 'open';
            signal.removeEventListener('abort', abort);
            resolve();
          }
          this.handleMessage(message, epoch);
        } catch (error) {
          if (!connected) reject(error);
          else this.fail(error);
        }
      };
      socket.onerror = () => {
        const error = new Error(
          'Gemini Live connection failed. Check network access and the API key.',
        );
        if (!current()) return;
        if (!connected) reject(error);
        else this.fail(error);
      };
      socket.onclose = () => {
        if (!current()) return;
        const error = new Error(
          'Gemini Live session ended. Start voice again to reconnect.',
        );
        if (!connected) reject(error);
        else this.fail(error);
      };
    });
  }

  fail(error) {
    const detail =
      error?.name === 'NotAllowedError'
        ? 'Microphone permission was denied. Allow microphone access and try again.'
        : error?.name === 'TimeoutError'
          ? 'Gemini connection timed out. Try again.'
          : error?.message || 'Gemini voice could not start';
    this.lastError = detail;
    this.stop({ preserveStatus: true });
    this.setStatus('error', detail);
  }

  abortTools() {
    this.turn++;
    for (const entry of this.tools.values()) entry.abort();
    this.tools.clear();
    this.radio?.clearTools();
    this.pendingTools = 0;
    this.toolQueue = Promise.resolve();
  }

  noteUserActivity() {
    this.userTurnPending = true;
    this.radio.cancelRadioHandoff();
  }

  interrupt(reason = 'user-speech') {
    this.abortTools();
    this.noteUserActivity();
    this.audio?.clearPlayback();
    this.modelComplete = false;
    this.pendingCompletionStatus = null;
    this.postToolOutput = false;
    this.transcripts.assistant = '';
    this.emit({ type: 'interruption', reason });
    this.input.setVoiceSpeaker('user');
    this.setStatus('listening', 'Ask or command');
  }

  handleMessage(message, epoch = this.epoch) {
    if (!this.owns(epoch)) return;
    if (message.error)
      throw new Error(
        'Gemini rejected the voice session. Check its model and API settings.',
      );
    if (message.goAway) {
      this.fail(
        new Error(
          'Gemini session is expiring. Start voice again to reconnect.',
        ),
      );
      return;
    }
    for (const id of message.toolCallCancellation?.ids || []) {
      const action = this.tools.get(id);
      const results = [
        this.radio.pendingRadioPlaybackResult,
        this.radio.radioHandoffInFlightResult,
      ].filter((result) => {
        const owner = result && this.radioPlaybackCalls.get(result);
        return (
          owner?.id === id && owner.epoch === epoch && owner.turn === this.turn
        );
      });
      // Completed queries and unknown/stale IDs own no remaining work.
      if (!action && !results.length) continue;
      this.cancelledCalls.add(id);
      if (this.cancelledCalls.size > 256)
        this.cancelledCalls.delete(this.cancelledCalls.values().next().value);
      action?.abort();
      for (const result of results) this.radio.cancelPlaybackResult(result);
    }
    const content = message.serverContent;
    // Transcription is delivered independently and may arrive after its own
    // tool call. Only an explicit speech onset/interruption owns cancellation.
    if (
      content?.interrupted ||
      message.voiceActivity?.voiceActivityType === 'ACTIVITY_START'
    )
      this.interrupt();
    if (content?.inputTranscription?.text)
      this.transcript('user', content.inputTranscription);
    if (content?.outputTranscription?.text) {
      this.userTurnPending = false;
      this.postToolOutput = true;
      this.transcript('assistant', content.outputTranscription);
    }
    for (const part of (content?.interrupted
      ? []
      : content?.modelTurn?.parts) || []) {
      if (part.thought) continue;
      if (part.inlineData?.data) {
        this.userTurnPending = false;
        this.modelComplete = false;
        this.postToolOutput = true;
        this.input.setVoiceSpeaker('ai');
        this.audio?.play(part.inlineData.data, part.inlineData.mimeType);
      }
    }
    if (message.toolCall?.functionCalls?.length)
      this.enqueueTools(message.toolCall.functionCalls, epoch);
    if (content?.turnComplete) {
      this.modelComplete = true;
      this.pendingCompletionStatus = content.interrupted
        ? 'interrupted'
        : 'completed';
      this.completedTurns++;
      for (const role of ['user', 'assistant']) {
        if (this.transcripts[role]) {
          this.emit({
            type: 'transcript',
            role,
            text: this.transcripts[role],
            final: true,
          });
          this.transcripts[role] = '';
        }
      }
      this.finishPlayback();
    }
  }

  transcript(role, value) {
    this.transcripts[role] = (this.transcripts[role] + value.text).slice(
      -16000,
    );
    this.emit({ type: 'transcript', role, text: value.text, final: false });
  }

  enqueueTools(calls, epoch) {
    if (
      calls.length > MAX_TOOL_CALLS ||
      this.pendingTools + calls.length > MAX_TOOL_CALLS
    )
      throw new Error('Gemini requested too many simultaneous actions');
    const turn = this.turn;
    this.userTurnPending = false;
    this.modelComplete = false;
    for (const call of calls) {
      if (
        !call?.id ||
        typeof call.name !== 'string' ||
        this.seenCalls.has(call.id)
      )
        continue;
      this.seenCalls.add(call.id);
      if (this.seenCalls.size > 256)
        this.seenCalls.delete(this.seenCalls.values().next().value);
      this.pendingTools++;
      const action = new AbortController();
      this.tools.set(call.id, action);
      this.toolQueue = this.toolQueue
        .then(async () => {
          if (!this.owns(epoch) || turn !== this.turn) return;
          if (this.cancelledCalls.has(call.id)) {
            if (this.tools.get(call.id) === action) this.tools.delete(call.id);
            this.pendingTools--;
            if (!this.pendingTools)
              this.setStatus('listening', 'Ask or command');
            return;
          }
          await this.executeTool(call, epoch, turn, action);
        })
        .catch((error) => {
          if (this.owns(epoch) && turn === this.turn) this.fail(error);
        });
    }
  }

  async executeTool(call, epoch, turn, action) {
    const args =
      call.args && typeof call.args === 'object' && !Array.isArray(call.args)
        ? call.args
        : {};
    const radioControl = call.name === 'control_radio';
    const radioVisibility =
      call.name === 'set_layer_visibility' && args.layerId === 'radio';
    const radioAction = radioControl
      ? String(args.action || '').toLowerCase()
      : null;
    const authority =
      radioVisibility || ['enable', 'disable'].includes(radioAction)
        ? 'visibility'
        : radioAction === 'status'
          ? 'query'
          : radioControl
            ? 'playback'
            : null;
    const stronger =
      (radioControl && ['disable', 'pause', 'stop'].includes(radioAction)) ||
      (radioVisibility && args.enabled === false);
    const reservation = stronger
      ? this.radio.reserveRadioToolHandoff({
          abortScope:
            radioAction === 'disable' || radioVisibility ? 'all' : 'playback',
        })
      : null;
    const handoffEpoch = this.radio.radioHandoffEpoch;
    const toolSignal = AbortSignal.any([
      action.signal,
      AbortSignal.timeout(45_000),
    ]);
    const current = () =>
      this.owns(epoch) && this.turn === turn && !toolSignal.aborted;
    const actionCurrent = () =>
      current() &&
      (authority !== 'playback' ||
        handoffEpoch === this.radio.radioHandoffEpoch);
    if (authority)
      this.radio.registerTool(action, {
        responseId: String(turn),
        authorityDomain: authority,
      });
    this.setStatus('executing', 'Running command');
    this.radio.pauseRadioForVoice();
    let result;
    try {
      result = await awaitWithSignal(
        this.runAction(call.name, args, {
          signal: toolSignal,
          isCurrent: actionCurrent,
        }),
        toolSignal,
      );
      if (!actionCurrent()) throw cancelled();
      if (result?.ok && result.radioPlaybackRequested) {
        // A runner may reuse an envelope; handoff identity belongs to this call.
        const playbackResult = { ...result };
        this.radioPlaybackCalls.set(playbackResult, {
          id: call.id,
          epoch,
          turn,
        });
        this.radio.setPendingPlayback(playbackResult);
      }
      if (
        result?.action === 'get_entity_context' &&
        shouldSendViewportImage(result.scene?.basemap?.viewScale) &&
        !hasStructuredViewIdentity(result) &&
        Date.now() - this.lastViewportAt >= 1000
      ) {
        const image = await this.captureViewport();
        if (current() && image?.startsWith('data:image/jpeg;base64,')) {
          this.lastViewportAt = Date.now();
          this.send({
            realtimeInput: {
              video: {
                mimeType: 'image/jpeg',
                data: image.slice(image.indexOf(',') + 1),
              },
            },
          });
        }
      }
    } catch (error) {
      result = {
        ok: false,
        tool: call.name,
        error:
          error?.name === 'AbortError'
            ? 'Action cancelled by a newer request'
            : error?.message || 'GEV command failed',
      };
    } finally {
      if (this.tools.get(call.id) === action) this.tools.delete(call.id);
      this.radio.releaseTool(action);
    }
    if (!this.owns(epoch) || turn !== this.turn) return;
    this.pendingTools--;
    if (reservation)
      this.radio.settleRadioToolHandoffReservation(reservation, {
        commit: Boolean(result?.ok),
        responseId: String(turn),
      });
    // A server cancellation already discarded this call; do not revive it.
    if (!this.cancelledCalls.has(call.id)) {
      this.postToolOutput = false;
      this.modelComplete = false;
      const mapEvents = this.pendingMapEvents.map((text) => JSON.parse(text));
      const response = result ?? {
        ok: false,
        error: 'Command returned no result',
      };
      const sent = this.send({
        toolResponse: {
          functionResponses: [
            {
              id: call.id,
              name: call.name,
              response: mapEvents.length
                ? { ...response, mapEvents }
                : response,
            },
          ],
        },
      });
      if (sent) this.pendingMapEvents = [];
    }
    if (!this.pendingTools) this.setStatus('listening', 'Ask or command');
  }

  finishPlayback() {
    if (
      !this.isActive() ||
      !this.modelComplete ||
      this.userTurnPending ||
      this.pendingTools ||
      this.audio?.pending
    )
      return;
    const completionStatus = this.pendingCompletionStatus;
    this.pendingCompletionStatus = null;
    if (completionStatus)
      this.emit({ type: 'completion', status: completionStatus });
    // A completion observer may replace this provider immediately. Do not let
    // the retired session update UI or start delayed Radio work afterward.
    if (!this.isActive()) return;
    this.input.setVoiceSpeaker('idle');
    this.setStatus('listening', 'Ask or command');
    if (this.postToolOutput && this.radio.pendingRadioPlaybackResult)
      void this.radio.startPendingRadioHandoff();
  }

  sendTextCommand(text) {
    const clean = String(text || '').trim();
    if (!clean) return false;
    if (clean.length > 16000) throw new Error('Voice text command is too long');
    if (this.channel?.readyState !== 'open')
      throw new Error('Gemini voice is not connected');
    this.interrupt('user-text');
    const parts = [];
    if (this.pendingMapEvents.length)
      parts.push({
        text: JSON.stringify({
          type: 'map_events',
          events: this.pendingMapEvents.map((value) => JSON.parse(value)),
        }),
      });
    parts.push({ text: clean });
    const sent = this.send({
      clientContent: { turns: [{ role: 'user', parts }], turnComplete: true },
    });
    if (sent) this.pendingMapEvents = [];
    return sent;
  }

  // Any clientContent message can interrupt Live generation, including one
  // with turnComplete:false. Passive map results wait for an explicit turn
  // or a tool response; they must never cut off spoken output or start speech.
  notifyMapEvent(event) {
    if (this.channel?.readyState !== 'open') return false;
    let text;
    try {
      text = JSON.stringify(event);
    } catch {
      return false;
    }
    if (!text || text.length > MAX_MAP_CONTEXT_LENGTH) return false;
    this.pendingMapEvents.push(text);
    while (
      this.pendingMapEvents.length > MAX_MAP_EVENTS ||
      this.pendingMapEvents.reduce((sum, value) => sum + value.length, 0) >
        MAX_MAP_CONTEXT_LENGTH
    )
      this.pendingMapEvents.shift();
    return true;
  }

  getDiagnostics() {
    return {
      provider: 'gemini',
      status: this.status,
      model: this.model,
      connected: this.channel?.readyState === 'open',
      microphoneActive: Boolean(
        this.stream
          ?.getAudioTracks()
          .some((track) => track.enabled && track.readyState !== 'ended'),
      ),
      pendingTools: this.pendingTools,
      completedTurns: this.completedTurns,
      audio: this.audio?.diagnostics() || this.lastAudio,
      error: this.lastError,
    };
  }

  stop({
    removeUi = false,
    preserveStatus = false,
    preserveRadioPlayback = false,
  } = {}) {
    if (this.disposed) return;
    this.epoch++;
    this.abort?.abort();
    this.abort = null;
    this.abortTools();
    this.radio.invalidateHandoff();
    this.radio.stopHandoff({ preserveRadioPlayback });
    this.radio.clearPendingPlayback();
    if (this.channel) this.channel.readyState = 'closed';
    this.channel = null;
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null;
      socket.close();
    }
    if (this.audio) {
      const lastAudio = {
        ...this.audio.diagnostics(),
        queuedSeconds: 0,
        resourcesReleased: true,
        contextState: 'closing',
      };
      this.lastAudio = lastAudio;
      void Promise.resolve(this.audio.close()).then(
        (closed) => {
          lastAudio.contextState = closed === false ? 'close-failed' : 'closed';
        },
        () => {
          lastAudio.contextState = 'close-failed';
        },
      );
    }
    this.audio = null;
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    this.input.cancelPushToTalkHold();
    this.input.stopVoiceVisualizer();
    this.input.resetSession();
    this.radio.setRadioVoiceDucking(false);
    this.modelComplete = false;
    this.pendingCompletionStatus = null;
    this.postToolOutput = false;
    this.seenCalls.clear();
    this.cancelledCalls.clear();
    this.pendingMapEvents = [];
    this.userTurnPending = false;
    this.transcripts = { user: '', assistant: '' };
    if (removeUi) {
      this.disposed = true;
      this.status = 'idle';
      this.input.detachBindings();
      this.radio.detachObservers();
      this.signal?.removeEventListener('abort', this.lifetimeAbort);
      this.ui?.root?.remove();
      this.emit({ type: 'disposed' });
    } else if (!preserveStatus) this.setStatus('idle', 'Voice off');
  }
}

export function createGeminiSession(options) {
  const controller = new GeminiSessionController(options);
  return {
    controller,
    capabilities: { costControls: false, pushToTalk: true },
    start: (settings) => controller.start(settings),
    stop: (settings) => controller.stop(settings),
    sendText: (text) => controller.sendTextCommand(text),
    sendMapEvent: (event) => controller.notifyMapEvent(event),
    ignoreButtonClick: () => Boolean(controller.spaceKeyHeld),
    bindControls: () => controller.input.bindPushToTalkShortcut(),
  };
}
