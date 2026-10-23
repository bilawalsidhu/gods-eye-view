import { t, translateKnown } from '../i18n/index.js';
import { msg } from '../i18n/marker.js';
import { createGeminiAudio } from './geminiAudio.js';
import { RealtimeInput } from './realtimeInput.js';
import { RealtimeRadio } from './realtimeRadio.js';
import { captureViewportImage } from './realtimeViewport.js';
import { createNarrationScheduler } from './narration.js';
import { createEarcon } from './earcon.js';
import { narrationLabel } from './speech.js';
import { waitForSignal } from '../sources/requestDeadline.js';
import { readResponseJsonCapped } from '../sources/httpBody.js';
import { readLayerLifecycleSummary } from './layerSummary.js';
import {
  POINTER_OPEN_MIC_RECENT_MS,
  pointerAnnouncement,
  pointerTurnContext,
  pointerTurnEvent,
} from './pointerContext.js';
import {
  hasStructuredViewIdentity,
  shouldSendViewportImage,
  shouldStopVoiceAfterRadioTool,
  responseInstructionForToolResult,
} from './realtimeProtocol.js';

const SOCKET_PATH =
  /^\/ws\/google\.ai\.generativelanguage\.v1(?:alpha|beta)\.GenerativeService\.BidiGenerateContentConstrained$/;
const MAX_BUFFERED_BYTES = 256 * 1024;
const MAX_CONTROL_BYTES = 1024 * 1024;
const MAX_CONTROL_MESSAGES = 64;
const CONTROL_PRESSURE_TIMEOUT_MS = 5_000;
const CONTROL_POLL_MS = 25;
const MAX_GO_AWAY_MS = 10 * 60 * 1000;
const MAX_MESSAGE_LENGTH = 3 * 1024 * 1024;
const MAX_TOOL_CALLS = 16;
const MAX_SEEN_CALLS = 4096;
const MAX_CALL_ID_LENGTH = 1024;
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
      msg('Gemini token response did not include an ephemeral credential'),
    );
  let url;
  try {
    url = new URL(websocketUrl);
  } catch {
    throw new Error(msg('Invalid Gemini connection endpoint'));
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
    throw new Error(msg('Invalid Gemini connection endpoint'));
  url.searchParams.set('access_token', token);
  return url.href;
}

// Known local-server failures are translated; unexpected diagnostics stay intact.
function tokenErrorMessage(error) {
  switch (error) {
    case msg('Gemini voice could not connect. Try again.'):
    case msg('Gemini voice requires a same-origin app request'):
    case msg('Add a Gemini API key in Provider Settings'):
    case msg('The Gemini Live model configuration is invalid'):
    case msg('Gemini voice is starting too often. Try again shortly.'):
    case msg('Gemini quota is unavailable. Try again later.'):
    case msg('Gemini access was refused. Check the API key and model access.'):
    case msg('Gemini Live is unavailable for the configured model.'):
    case msg('Token request is too large'):
    case msg('Use an empty JSON token request'):
    case msg('Method not allowed'):
      return t(error);
    default:
      return error;
  }
}

function validCallId(id) {
  return (
    typeof id === 'string' &&
    id.length > 0 &&
    id.length <= MAX_CALL_ID_LENGTH &&
    id.trim().length > 0 &&
    !/[\u0000-\u001f\u007f]/u.test(id)
  );
}

function cancelled() {
  return new DOMException('Voice operation cancelled', 'AbortError');
}

// Match the existing OpenAI/Radio classification; transport ownership stays local.
function classifyGeminiTool(name, args = {}) {
  const radioControl = name === 'control_radio';
  const radioVisibility =
    name === 'set_layer_visibility' && args.layerId === 'radio';
  const radioAction = radioControl
    ? String(args.action || '').toLowerCase()
    : null;
  const authorityDomain =
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
  return {
    radioControl,
    radioVisibility,
    authorityDomain,
    stronger,
    abortScope:
      radioAction === 'disable' || radioVisibility ? 'all' : 'playback',
  };
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
    pointer = null,
    tokenEndpoint = '/api/gemini/token',
    startupTimeoutMs = 30_000,
    inputBoundaryTimeoutMs = 5_000,
    fetchImpl = (...args) => fetch(...args),
    WebSocketClass = globalThis.WebSocket,
    getUserMedia = (settings) => navigator.mediaDevices.getUserMedia(settings),
    createAudio = createGeminiAudio,
    createInput = (settings) => new RealtimeInput(settings),
    createNarration = createNarrationScheduler,
    createProgressEarcon = createEarcon,
    captureViewport = captureViewportImage,
    now = () => Date.now(),
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  }) {
    Object.assign(this, {
      emit,
      runAction,
      signal,
      ui,
      tokenEndpoint,
      startupTimeoutMs,
      inputBoundaryTimeoutMs,
      fetchImpl,
      WebSocketClass,
      getUserMedia,
      createAudio,
      captureViewport,
      pointer,
      radioLayer,
      dataManager,
      now,
      // Browser timer functions reject the controller as their receiver.
      setTimer: (...args) => setTimer(...args),
      clearTimer: (...args) => clearTimer(...args),
    });
    this.status = 'idle';
    this.model = null;
    this.epoch = 0;
    this.turn = 0;
    this.inputGeneration = 0;
    this.turnAbort = new AbortController();
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
    this.stopAfterReply = false;
    this.modelSpoke = false;
    this.transcripts = { assistant: '' };
    this.pendingMapEvents = [];
    this.userTurnPending = false;
    // Live output has no response ID. A locally retired reply keeps ownership
    // of incoming output until its ordered server turnComplete boundary.
    this.replyPending = false;
    // A reply Gemini started without a request; it gets no tool authority.
    this.unrequestedReply = false;
    this.automaticTurnOpen = false;
    this.automaticActivityOwner = null;
    this.retiredAutomaticActivityOwner = null;
    this.automaticActivitySequence = 0;
    this.retiredReplyPending = false;
    this.deferredInput = null;
    this.retiredBoundaryWait = null;
    this.forwardedActivityOpen = false;
    this.forwardedCaptureId = null;
    this.captureGeneration = 0;
    this.captureEnabled = false;
    this.pttPlaybackSuppressed = false;
    this.microphoneRequested = false;
    this.captureOwner = null;
    this.userActivityOpen = false;
    this.pointerSentKey = null;
    this.pointerAnnounced = null;
    this.pendingPointerContext = null;
    this.typedIntent = null;
    this.toolSequence = 0;
    this.radioStrongerCommit = null;
    this.intentSequence = 0;
    this.intentItemId = null;
    this.intentResponseId = null;
    this.intentCaptureId = null;
    this.controlQueue = [];
    this.controlBytes = 0;
    this.controlTimer = null;
    this.goAway = null;
    this.droppedAudioChunks = 0;
    this.deferredAudioDrops = { nonPttOwner: 0, closedActivity: 0 };
    this.droppedImages = 0;
    this.lastClose = null;
    this.lastError = null;
    this.completedTurns = 0;
    this.lastAudio = null;
    this.lastViewportAt = -Infinity;
    this.input = createInput({
      readUi: () => ui,
      readStream: () => this.stream,
      readStatus: () => this.status,
      operations: {
        isActive: () => this.isActive(),
        start: (settings) => this.start(settings),
        setStatus: (...args) => this.setStatus(...args),
        pauseRadioForVoice: () => this.radio.pauseRadioForVoice(),
        bargeIn: () => this.claimPttPlayback(),
        holdPointer: () => {
          this.heldPointerSnapshot = this.pointer?.hold('keydown');
        },
        releasePointerHold: () => this.pointer?.releaseHold(),
        beginPointerTurn: (at) =>
          this.input.pushToTalkMode && at === 'keydown'
            ? this.heldPointerSnapshot
            : this.beginPointerTurn(at),
        mayClaimSpeaker: () => this.radio.mayVoiceClaimSpeaker(),
      },
    });
    const setMicrophoneEnabled = this.input.setMicrophoneEnabled.bind(
      this.input,
    );
    this.applyMicrophoneEnabled = (enabled) => {
      enabled = Boolean(enabled) && !this.goAway;
      setMicrophoneEnabled(enabled);
      if (enabled && !this.captureEnabled) {
        // The physical gate owns this generation, independently of tool turns.
        this.captureOwner = {
          captureId: ++this.captureGeneration,
          context: null,
          snapshot: this.heldPointerSnapshot,
          retired: false,
          admitted: false,
          settled: false,
        };
      }
      this.captureEnabled = enabled;
      const metadata = this.captureOwner
        ? { captureId: this.captureOwner.captureId }
        : null;
      this.audio?.setMicrophoneEnabled(enabled, metadata);
      if (enabled && this.channel?.readyState === 'open') {
        if (this.input.pushToTalkMode) this.radio.cancelRadioHandoff();
        else this.noteUserActivity();
      }
    };
    this.input.setMicrophoneEnabled = (enabled) => {
      this.microphoneRequested = Boolean(enabled) && !this.goAway;
      this.applyMicrophoneEnabled(this.microphoneRequested);
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
        setStatus: (...args) => this.setStatus(...args),
        // The shared Radio owner already surfaces a failed start in the UI.
        queueResponseCreate: () => {},
        debugLog: () => {},
      },
    });
    this.earcon = createProgressEarcon({
      isMicrophoneMuted: () =>
        Boolean(
          this.isActive() &&
          this.channel?.readyState === 'open' &&
          this.input.pushToTalkMode &&
          !this.input.pushToTalkKeyHeld &&
          this.stream &&
          this.stream.getAudioTracks().every((track) => !track.enabled) &&
          !this.audio?.pending &&
          this.radio.mayVoiceClaimSpeaker(),
        ),
    });
    this.narration = createNarration({
      // Live clientContent interrupts generation, even with turnComplete:false.
      // Reuse shared progress timing and muted-PTT earcons without injecting a
      // second conversation turn. The model's own preamble supplies speech.
      speak: () => false,
      earcon: this.earcon,
      canSpeak: () => false,
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

  setStatus(status, detail, recovery) {
    this.status = status;
    if (status === 'listening' && this.input.pushToTalkMode)
      detail = this.input.pushToTalkKeyHeld
        ? msg('Release Space to send')
        : msg('Hold Space to talk');
    const event = {
      type: 'state',
      state: status,
      detail: translateKnown(detail),
    };
    if (recovery) event.recovery = translateKnown(recovery);
    this.emit(event);
    this.input.updateVoiceButtonLabel();
    if (['idle', 'connecting', 'error'].includes(status))
      this.input.setVoiceSpeaker('idle');
  }

  send(
    message,
    {
      beforeSetup = false,
      captureId = null,
      onSent = null,
      durable = false,
    } = {},
  ) {
    if (
      this.socket?.readyState !== 1 ||
      (!beforeSetup && this.channel?.readyState !== 'open')
    )
      return false;
    const body = JSON.stringify(message);
    const bytes = new TextEncoder().encode(body).byteLength;
    if (bytes > MAX_MESSAGE_LENGTH)
      throw new Error(msg('Voice command context is too large'));
    const optional = Boolean(
      message.realtimeInput?.audio || message.realtimeInput?.video,
    );
    if (optional) {
      this.pruneControls();
      if (
        this.goAway ||
        this.controlQueue.length ||
        this.socket.bufferedAmount + bytes > MAX_BUFFERED_BYTES
      ) {
        if (message.realtimeInput.audio) this.droppedAudioChunks++;
        else this.droppedImages++;
        return false;
      }
      this.socket.send(body);
      onSent?.();
      return true;
    }
    this.pruneControls();
    const entry = {
      epoch: this.epoch,
      turn: this.turn,
      captureId,
      durable,
      message,
      body,
      bytes,
      onSent,
      deadline: this.now() + CONTROL_PRESSURE_TIMEOUT_MS,
    };
    if (!this.controlQueue.length && this.canSendControl(entry)) {
      this.writeControl(entry);
      return true;
    }
    if (
      bytes > MAX_CONTROL_BYTES ||
      this.controlBytes + bytes > MAX_CONTROL_BYTES ||
      this.controlQueue.length >= MAX_CONTROL_MESSAGES
    )
      throw new Error(
        msg(
          'Gemini reliable transport exceeded its queue limit. Start voice again.',
        ),
      );
    this.controlQueue.push(entry);
    this.controlBytes += bytes;
    this.scheduleControls();
    return true;
  }

  controlCurrent(entry) {
    if (!this.owns(entry.epoch)) return false;
    if (entry.durable) return true;
    const input = entry.message.realtimeInput;
    if (
      entry.message.toolResponse?.functionResponses?.some((call) =>
        this.cancelledCalls.has(call.id),
      )
    )
      return false;
    if (input?.activityEnd)
      return (
        (this.forwardedActivityOpen &&
          this.forwardedCaptureId === entry.captureId) ||
        (this.acceptsCapture({ captureId: entry.captureId }) &&
          this.controlQueue.some(
            (pending) =>
              pending.message.realtimeInput?.activityStart &&
              pending.captureId === entry.captureId &&
              this.controlCurrent(pending),
          ))
      );
    if (entry.captureId !== null)
      return this.acceptsCapture({ captureId: entry.captureId });
    return entry.turn === this.turn;
  }

  pruneControls() {
    this.controlQueue = this.controlQueue.filter((entry) =>
      this.controlCurrent(entry),
    );
    this.controlBytes = this.controlQueue.reduce(
      (total, entry) => total + entry.bytes,
      0,
    );
    if (!this.controlQueue.length) {
      if (this.controlTimer !== null) this.clearTimer(this.controlTimer);
      this.controlTimer = null;
    }
  }

  canSendControl(entry) {
    return (
      entry.bytes <= MAX_CONTROL_BYTES &&
      (this.socket.bufferedAmount === 0 ||
        this.socket.bufferedAmount + entry.bytes <= MAX_BUFFERED_BYTES)
    );
  }

  writeControl(entry) {
    this.socket.send(entry.body);
    if (!this.controlCurrent(entry)) return;
    const input = entry.message.realtimeInput;
    // Only markers actually written to the socket own its physical activity.
    if (input?.activityStart) {
      this.forwardedActivityOpen = true;
      this.forwardedCaptureId = entry.captureId;
      this.beginSpeechIntent(entry.captureId);
      if (!this.controlCurrent(entry)) return;
    }
    if (input?.activityEnd) {
      this.forwardedActivityOpen = false;
      this.forwardedCaptureId = null;
      if (this.intentCaptureId === entry.captureId) this.bindSpeechIntent();
    }
    entry.onSent?.();
  }

  scheduleControls() {
    if (this.controlTimer !== null || !this.controlQueue.length) return;
    const epoch = this.epoch;
    this.controlTimer = this.setTimer(
      () => {
        if (!this.owns(epoch)) return;
        this.controlTimer = null;
        try {
          this.flushControls();
        } catch (error) {
          this.fail(error);
        }
      },
      Math.min(
        CONTROL_POLL_MS,
        Math.max(0, this.controlQueue[0].deadline - this.now()),
      ),
    );
    this.controlTimer?.unref?.();
  }

  flushControls() {
    this.pruneControls();
    while (this.controlQueue.length) {
      const entry = this.controlQueue[0];
      if (this.now() >= entry.deadline)
        throw new Error(
          msg('Gemini reliable transport did not drain. Start voice again.'),
        );
      if (!this.canSendControl(entry)) break;
      this.controlQueue.shift();
      this.controlBytes -= entry.bytes;
      if (this.controlCurrent(entry)) this.writeControl(entry);
    }
    this.scheduleControls();
    if (!this.controlQueue.length) this.finishPlayback();
  }

  clearControls() {
    if (this.controlTimer !== null) this.clearTimer(this.controlTimer);
    this.controlTimer = null;
    this.controlQueue = [];
    this.controlBytes = 0;
  }

  async requestToken(signal, pushToTalk = false) {
    signal.throwIfAborted();
    let acquiredResponse;
    const acquisition = Promise.resolve(
      this.fetchImpl(this.tokenEndpoint, {
        method: 'POST',
        cache: 'no-store',
        redirect: 'error',
        signal,
        headers: { 'Content-Type': 'application/json' },
        body: pushToTalk ? '{"inputMode":"push-to-talk"}' : '{}',
      }),
    );
    void acquisition.then(
      (response) => {
        acquiredResponse = response;
        if (signal.aborted) void response.body?.cancel().catch(() => {});
      },
      () => {},
    );
    try {
      const response = await waitForSignal(acquisition, signal);
      signal.throwIfAborted();
      const data = await readResponseJsonCapped(response, 256 * 1024, signal);
      signal.throwIfAborted();
      if (!response.ok)
        throw new Error(
          typeof data?.error === 'string'
            ? tokenErrorMessage(data.error)
            : t('Gemini token request failed (HTTP {status})', {
                status: response.status,
              }),
        );
      if (
        typeof data?.model !== 'string' ||
        !/^gemini-[a-z0-9.-]+$/.test(data.model)
      )
        throw new Error(
          msg('Gemini token response did not include a valid model'),
        );
      if (
        !data.config ||
        typeof data.config !== 'object' ||
        Array.isArray(data.config)
      )
        throw new Error(
          msg('Gemini token response did not include session settings'),
        );
      const manual =
        data.config.realtimeInputConfig?.automaticActivityDetection?.disabled;
      if (
        pushToTalk ? manual !== true : manual !== undefined && manual !== false
      )
        throw new Error(
          msg('Gemini session settings do not match the input mode'),
        );
      const url = geminiSocketUrl(data);
      return { ...data, url };
    } finally {
      if (signal.aborted) void acquiredResponse?.body?.cancel().catch(() => {});
    }
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
    const permissionSignal = AbortSignal.any([
      this.abort.signal,
      ...(this.signal ? [this.signal] : []),
    ]);
    let signal = permissionSignal;
    this.lastError = null;
    this.lastAudio = null;
    this.completedTurns = 0;
    let acquiredStream = null;
    let releasedStream = null;
    const releaseStream = (stream) => {
      if (!stream || stream === releasedStream) return;
      releasedStream = stream;
      stream.getTracks().forEach((track) => track.stop());
    };
    try {
      this.setStatus('connecting', msg('Requesting microphone'));
      if (!this.owns(epoch)) return;
      signal.throwIfAborted();
      this.radio.pauseRadioForVoice();
      if (!this.owns(epoch)) return;
      // The worklet serializes start, PCM and flushed end notifications. A
      // keydown must not send a new start ahead of the previous queued end.
      let activityCaptureId = null;
      const audio = this.createAudio({
        pushToTalk,
        onAudioStart: (metadata) => {
          if (
            !this.owns(epoch) ||
            this.goAway ||
            !this.acceptsCapture(metadata)
          )
            return;
          if (!pushToTalk || activityCaptureId === metadata.captureId) return;
          this.captureOwner.admitted = true;
          if (
            !this.interrupt('push-to-talk', {
              keepPlayback: !this.pttPlaybackSuppressed,
            })
          )
            return;
          if (!this.owns(epoch) || !this.acceptsCapture(metadata)) return;
          const activityGeneration = this.inputGeneration;
          const activityCurrent = () =>
            this.owns(epoch) &&
            this.inputGeneration === activityGeneration &&
            this.acceptsCapture(metadata);
          this.beginPointerTurn(
            'speech_start',
            this.captureOwner.snapshot,
            activityCurrent,
          );
          if (!activityCurrent()) return;
          const context = this.pendingPointerContext;
          this.captureOwner.context = context;
          if (!this.sendPointerContext(context, metadata)) {
            if (this.owns(epoch))
              this.fail(
                new Error(
                  msg('Gemini could not submit this input. Start voice again.'),
                ),
              );
            return;
          }
          if (!activityCurrent()) return;
          const accepted = this.sendUserInput(
            { realtimeInput: { activityStart: {} } },
            metadata,
          );
          if (!activityCurrent()) return;
          // Quiet context and an empty hold have no response to retire later.
          if (accepted) activityCaptureId = metadata.captureId;
          else if (this.owns(epoch))
            this.fail(
              new Error(
                msg('Gemini could not submit this input. Start voice again.'),
              ),
            );
        },
        onAudio: (chunk, metadata) => {
          if (!this.owns(epoch) || !this.acceptsCapture(metadata)) return;
          if (!pushToTalk || activityCaptureId === metadata.captureId) {
            const sent = this.sendUserInput(
              {
                realtimeInput: { audio: chunk },
              },
              metadata,
            );
            if (sent && pushToTalk) this.replyPending = true;
          }
        },
        onAudioEnd: (metadata) => {
          if (!this.owns(epoch) || !this.validCaptureMetadata(metadata)) return;
          if (pushToTalk) {
            if (this.captureOwner?.captureId === metadata.captureId)
              this.captureOwner.settled = true;
            if (activityCaptureId !== metadata.captureId) {
              this.finishPlayback();
              return;
            }
            this.sendUserInput(
              { realtimeInput: { activityEnd: {} } },
              metadata,
            );
            if (this.acceptsCapture(metadata)) this.narration.userTurnEnded();
            activityCaptureId = null;
          } else if (this.acceptsCapture(metadata)) {
            this.send({ realtimeInput: { audioStreamEnd: true } });
          }
        },
        onAudioDiscard: (metadata) => {
          if (
            !this.owns(epoch) ||
            !pushToTalk ||
            !this.validCaptureMetadata(metadata) ||
            this.captureOwner?.captureId !== metadata.captureId
          )
            return;
          this.captureOwner.settled = true;
          if (!this.acceptsCapture(metadata)) {
            // New typed input owns completion; its retired capture cannot
            // revoke that request or leave its presentation waiting.
            this.finishPlayback();
            return;
          }
          if (
            activityCaptureId === metadata.captureId ||
            this.forwardedCaptureId === metadata.captureId ||
            this.deferredInput?.captureId === metadata.captureId
          )
            return;
          // No provider turn was submitted or retired. Keep an older request's
          // tool/completion ownership; the physical claim still revokes Radio.
          this.radio.cancelRadioHandoff();
          if (!this.audio?.pending) this.input.setVoiceSpeaker('idle');
          this.finishPlayback();
        },
        onDrain: () => {
          if (this.owns(epoch)) {
            this.narration.quiet();
            this.finishPlayback();
          }
        },
        onError: (error) => {
          if (this.owns(epoch)) this.fail(error);
        },
      });
      if (!this.owns(epoch) || signal.aborted) {
        void Promise.resolve(audio.close()).catch(() => {});
        return;
      }
      this.audio = audio;
      // Invoke resume in the initiating gesture, but do not mint the short-lived
      // admission credential while an uncancellable permission prompt is open.
      const initialized = Promise.resolve(audio.initialize(permissionSignal));
      void initialized.catch(() => {});
      if (!this.owns(epoch)) return;
      signal.throwIfAborted();
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
      acquiredStream = await waitForSignal(mediaRequest, signal);
      if (!this.owns(epoch)) {
        releaseStream(acquiredStream);
        return;
      }
      signal.throwIfAborted();
      this.stream = acquiredStream;
      acquiredStream.getAudioTracks().forEach((track) => {
        track.enabled = false;
      });
      signal = AbortSignal.any([
        permissionSignal,
        AbortSignal.timeout(this.startupTimeoutMs),
      ]);
      this.setStatus('connecting', msg('Connecting to Gemini'));
      if (!this.owns(epoch)) return;
      signal.throwIfAborted();
      const startup = Promise.all([
        initialized,
        this.requestToken(signal, pushToTalk),
      ]);
      void startup.catch(() => {});
      const [, credential] = await waitForSignal(startup, signal);
      if (!this.owns(epoch)) return;
      this.model = credential.model;
      await this.connect(credential, epoch, signal);
      if (!this.owns(epoch)) return;
      signal.throwIfAborted();
      const enabled =
        !this.input.pushToTalkMode || this.input.pushToTalkKeyHeld;
      this.input.setMicrophoneEnabled(enabled);
      audio.connectMicrophone(
        acquiredStream,
        enabled,
        this.captureOwner ? { captureId: this.captureOwner.captureId } : null,
      );
      this.input.startVoiceVisualizer(acquiredStream);
      this.input.startAssistantVoiceVisualizer(audio.outputStream);
      this.setStatus('listening', msg('Ask or command'));
    } catch (error) {
      if (acquiredStream && acquiredStream !== this.stream)
        releaseStream(acquiredStream);
      if (this.owns(epoch)) this.fail(error);
    }
  }

  connect(credential, epoch, signal) {
    return new Promise((resolve, reject) => {
      signal.throwIfAborted();
      if (!this.owns(epoch)) return reject(cancelled());
      const socket = new this.WebSocketClass(credential.url);
      socket.binaryType = 'arraybuffer';
      this.socket = socket;
      const channel = { readyState: 'connecting' };
      this.channel = channel;
      let connected = false;
      const current = () => this.owns(epoch) && this.socket === socket;
      const abort = () => {
        signal.removeEventListener('abort', abort);
        reject(signal.reason || cancelled());
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
            throw new Error(msg('Gemini returned an oversized message'));
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
          else if (current()) this.fail(error);
        }
      };
      socket.onerror = () => {
        const error = new Error(
          msg(
            'Gemini Live connection failed. Check network access, then start voice again.',
          ),
        );
        if (!current()) return;
        if (!connected) reject(error);
        else this.fail(error);
      };
      socket.onclose = (event) => {
        if (!current()) return;
        const code =
          Number.isInteger(event?.code) &&
          event.code >= 1000 &&
          event.code <= 4999
            ? event.code
            : null;
        this.lastClose = {
          code,
          category:
            code === 1000
              ? 'normal'
              : code === 1008
                ? 'policy'
                : code === 1011
                  ? 'server'
                  : 'connection',
        };
        const error = new Error(
          connected
            ? msg(
                'Gemini Live connection ended. Start voice again for a new conversation.',
              )
            : msg(
                'Gemini Live could not start. Start voice again to request a fresh session.',
              ),
        );
        error.recovery = connected
          ? msg('Start voice again for a fresh token and a new conversation.')
          : msg('Start voice again to request a fresh session credential.');
        if (!connected) reject(error);
        else this.fail(error);
      };
    });
  }

  fail(error, recovery = error?.recovery) {
    const detail =
      error?.name === 'NotAllowedError'
        ? msg(
            'Microphone permission was denied. Allow microphone access and try again.',
          )
        : error?.name === 'TimeoutError'
          ? msg('Gemini connection timed out. Try again.')
          : error?.message || msg('Gemini voice could not start');
    this.lastError = detail;
    this.stop({ preserveStatus: true });
    this.setStatus('error', detail, recovery);
  }

  abortTools() {
    const resources = this.turnAbort;
    const tools = [...this.tools.values()];
    this.turnAbort = new AbortController();
    this.turn++;
    this.typedIntent = null;
    this.radioStrongerCommit = null;
    this.pruneControls();
    this.tools.clear();
    this.radio?.clearTools();
    this.pendingTools = 0;
    this.toolQueue = Promise.resolve();
    this.narration?.cancel();
    resources.abort();
    for (const entry of tools) entry.abort();
  }

  noteUserActivity() {
    this.narration?.cancel();
    this.modelSpoke = false;
    this.userTurnPending = true;
    this.radio.cancelRadioHandoff();
  }

  /** A physical hold silences playback; only admitted speech retires a turn. */
  claimPttPlayback() {
    if (
      this.channel?.readyState !== 'open' ||
      this.goAway ||
      !this.radio.mayVoiceClaimSpeaker()
    )
      return false;
    this.pttPlaybackSuppressed = true;
    this.audio?.clearPlayback();
    this.input.setVoiceSpeaker('user');
    return true;
  }

  /** A claimed Space hold stops local playback before its audio reaches Live. */
  bargeIn() {
    if (
      this.channel?.readyState !== 'open' ||
      this.goAway ||
      !this.radio.mayVoiceClaimSpeaker()
    )
      return false;
    return this.interrupt('push-to-talk');
  }

  interrupt(
    reason = 'user-speech',
    {
      keepPlayback = false,
      preserveAdvisoryCaption = false,
      serverInterrupted = false,
    } = {},
  ) {
    if (this.goAway && !serverInterrupted) return false;
    const epoch = this.epoch;
    const generation = ++this.inputGeneration;
    const channel = this.channel;
    const owned = () =>
      this.owns(epoch) &&
      this.inputGeneration === generation &&
      this.channel === channel;
    this.pttPlaybackSuppressed = false;
    // Arm only for an outstanding reply: an idle hold/first text command has
    // no old boundary to wait for. This also covers generation before the
    // first output packet, because input submission marks replyPending.
    const deferred = this.deferredInput;
    const deferInput =
      deferred || (this.retiredReplyPending && this.replyPending);
    if (this.replyPending) {
      if (!this.retiredReplyPending)
        this.retiredAutomaticActivityOwner = this.automaticActivityOwner;
      this.retiredReplyPending = true;
    }
    this.replyPending = false;
    this.unrequestedReply = false;
    if (['push-to-talk', 'user-text'].includes(reason)) {
      this.automaticTurnOpen = false;
      this.automaticActivityOwner = null;
    }
    this.clearDeferredInput();
    this.abortTools();
    if (!owned()) return false;
    this.intentItemId = null;
    this.intentResponseId = null;
    this.intentCaptureId = null;
    if (deferInput) {
      // Only one successor may reach Live before the previous boundary. A
      // newer local turn replaces unsent input and waits to interrupt that
      // successor, rather than creating indistinguishable overlapping replies.
      const owner = {
        epoch: this.epoch,
        turn: this.turn,
        messages: [],
        bytes: 0,
        activityOpen: false,
        kind: reason,
        context: null,
        deadline:
          deferred?.deadline ||
          this.retiredBoundaryWait?.deadline ||
          this.now() + this.inputBoundaryTimeoutMs,
      };
      this.clearRetiredBoundaryWait();
      this.deferredInput = owner;
      owner.timer = this.setTimer(
        () => {
          if (this.deferredInput === owner && this.owns(owner.epoch))
            this.fail(
              new Error(
                msg(
                  'Gemini did not finish the interrupted reply. Start voice again.',
                ),
              ),
            );
        },
        Math.max(0, owner.deadline - this.now()),
      );
      owner.timer.unref?.();
    } else this.boundRetiredReply();
    this.noteUserActivity();
    if (!owned()) return false;
    if (!keepPlayback) this.audio?.clearPlayback();
    if (!owned()) return false;
    this.modelComplete = false;
    this.pendingCompletionStatus = null;
    this.postToolOutput = false;
    this.stopAfterReply = false;
    this.transcripts.assistant = '';
    this.emit({
      type: 'interruption',
      reason,
      ...(preserveAdvisoryCaption ? { preserveAdvisoryCaption: true } : {}),
    });
    if (!owned()) return false;
    this.input.setVoiceSpeaker(this.goAway ? 'idle' : 'user');
    if (!owned()) return false;
    this.setStatus(
      'listening',
      this.goAway
        ? msg('Gemini session expiring; finishing the current reply')
        : msg('Ask or command'),
    );
    return owned();
  }

  discardRetiredReply(message, epoch) {
    if (!this.owns(epoch) || !this.retiredReplyPending) return false;
    const content = message.serverContent;
    // Retired output proves the old reply is still running; only silence
    // after it counts toward the first retirement's recovery bound.
    if (
      this.retiredBoundaryWait?.extendable &&
      !content?.turnComplete &&
      (content?.modelTurn ||
        content?.outputTranscription ||
        content?.generationComplete ||
        message.toolCall)
    ) {
      this.clearRetiredBoundaryWait();
      this.boundRetiredReply();
    }
    const retiredIds = (message.toolCall?.functionCalls || [])
      .map((call) => call?.id)
      .filter(validCallId);
    this.rememberCallIds(retiredIds);
    for (const id of retiredIds) this.cancelledCalls.add(id);
    // Gemini documents interrupted -> turnComplete. Discard all retired
    // output, including content coalesced with either marker. A natural
    // completion racing the local claim also closes the old reply safely.
    if (content?.turnComplete) {
      this.clearRetiredBoundaryWait();
      this.retiredReplyPending = false;
      if (
        this.typedIntent?.retiredAutomaticPredecessor ===
        this.retiredAutomaticActivityOwner
      )
        this.typedIntent.retiredAutomaticPredecessor = null;
      // A true replyPending now belongs to a successor submitted while
      // this older reply was retired. Its boundary cannot revoke that input.
      if (this.automaticActivityOwner === this.retiredAutomaticActivityOwner) {
        this.automaticTurnOpen = false;
        this.automaticActivityOwner = null;
      }
      this.retiredAutomaticActivityOwner = null;
      if (this.goAway) {
        this.clearDeferredInput();
        if (
          this.goAway.supersededSuccessor ||
          (!this.replyPending &&
            !this.automaticTurnOpen &&
            !this.pendingTools &&
            !this.audio?.pending &&
            !this.controlQueue.length)
        )
          this.finishGoAway();
      } else this.flushDeferredInput();
    }
    return true;
  }

  handleMessage(message, epoch = this.epoch) {
    if (!this.owns(epoch)) return;
    const initialGeneration = this.inputGeneration;
    const initialTurn = this.turn;
    const initialCurrent = () =>
      this.owns(epoch) &&
      this.inputGeneration === initialGeneration &&
      this.turn === initialTurn;
    if (this.goAway && this.now() >= this.goAway.deadline) {
      this.finishGoAway();
      return;
    }
    if (message.error) {
      this.fail(
        new Error(
          msg(
            'Gemini rejected the voice session. Start voice again to request a fresh session.',
          ),
        ),
        msg(
          'Start voice again for a fresh session credential. If it repeats, check Gemini model and API access.',
        ),
      );
      return;
    }
    if (message.goAway) {
      this.beginGoAway(message.goAway.timeLeft, epoch);
      if (!initialCurrent()) return;
    }
    let prunedCancelledControls = false;
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
      const queuedResponse = this.controlQueue.some((entry) =>
        entry.message.toolResponse?.functionResponses?.some(
          (call) => call.id === id,
        ),
      );
      // A queued response still owns transport work until it reaches the wire.
      if (!action && !results.length && !queuedResponse) continue;
      this.cancelledCalls.add(id);
      action?.abort();
      if (!initialCurrent()) return;
      for (const result of results) this.radio.cancelPlaybackResult(result);
      if (!initialCurrent()) return;
      const queuedControls = this.controlQueue.length;
      this.pruneControls();
      prunedCancelledControls ||= this.controlQueue.length < queuedControls;
    }
    if (prunedCancelledControls) {
      // Removing the last queued response can release an already complete turn.
      this.finishPlayback();
      // Completion observers may stop this session or accept a successor input.
      if (!initialCurrent()) return;
    }
    const content = message.serverContent;
    let receivedReplyPending = this.replyPending || this.retiredReplyPending;
    const settleFencedBoundary = () => {
      // Preserve this packet's old terminal without publishing its caption,
      // audio or tools into the new input. A terminal already processed below
      // must never be reused to close a successor retired by a final observer.
      if (receivedReplyPending && content?.turnComplete)
        this.discardRetiredReply(message, epoch);
    };
    // A server acknowledgment of a local interruption belongs to the retired
    // reply; it must not revoke the successor's pointer, timing or turn token.
    if (content?.interrupted) {
      const newAutomaticActivity =
        !this.input.pushToTalkMode &&
        !this.goAway &&
        message.voiceActivity?.type === 'ACTIVITY_START' &&
        !this.userActivityOpen;
      const predecessor = this.typedIntent?.automaticPredecessor;
      if (
        !this.retiredReplyPending &&
        !newAutomaticActivity &&
        predecessor?.epoch === epoch &&
        this.currentTypedInput()
      ) {
        // Automatic VAD may not have produced output before text superseded
        // it. This specific local predecessor owns one interruption boundary;
        // the acknowledgment is not another user input. Do not infer this
        // from output silence alone, or wait for a boundary until it arrives.
        this.retiredAutomaticActivityOwner = predecessor;
        this.typedIntent.retiredAutomaticPredecessor = predecessor;
        this.typedIntent.automaticPredecessor = null;
      } else if (!this.retiredReplyPending) {
        if (
          !this.interrupt('user-speech', {
            preserveAdvisoryCaption: true,
            serverInterrupted: true,
          })
        ) {
          settleFencedBoundary();
          return;
        }
      }
      this.retiredReplyPending = true;
      receivedReplyPending = true;
      this.boundRetiredReply();
    }
    // Manual PTT owns its onset locally. Automatic speech takes one snapshot
    // per activity, regardless of duplicate/late transcription notifications.
    if (!this.input.pushToTalkMode && !this.goAway) {
      if (
        message.voiceActivity?.type === 'ACTIVITY_START' &&
        !this.userActivityOpen
      ) {
        this.userActivityOpen = true;
        const typedPredecessor = this.typedIntent?.retiredAutomaticPredecessor;
        if (
          this.retiredReplyPending &&
          typedPredecessor &&
          typedPredecessor === this.retiredAutomaticActivityOwner &&
          this.currentTypedInput()
        ) {
          // This precise wait still belongs to the automatic predecessor, not
          // the submitted text. New speech revokes that text without inventing
          // a second retirement/deferred input or renewing the existing bound.
          this.replyPending = false;
          if (!this.interrupt()) return;
        } else if (!this.retiredReplyPending && !this.interrupt()) return;
        // Local activity ownership is only for expiry liveness, not tools.
        // Assign after retiring observed output so its boundary cannot clear
        // a newer detected activity that has not received a reply yet.
        this.automaticActivityOwner = {
          epoch,
          sequence: ++this.automaticActivitySequence,
        };
        this.automaticTurnOpen = true;
        const activityGeneration = this.inputGeneration;
        const activityCurrent = () =>
          this.owns(epoch) && this.inputGeneration === activityGeneration;
        this.beginSpeechIntent(null);
        if (!activityCurrent()) return;
        this.beginPointerTurn('speech_start', undefined, activityCurrent);
        if (!activityCurrent()) return;
        const context = this.pendingPointerContext;
        if (
          context &&
          this.send({
            realtimeInput: { text: JSON.stringify(context.item) },
          }) &&
          activityCurrent()
        )
          this.consumePointerContext(context);
      } else if (
        message.voiceActivity?.type === 'ACTIVITY_END' &&
        this.userActivityOpen
      ) {
        this.userActivityOpen = false;
        this.bindSpeechIntent();
        this.narration.userTurnEnded();
      }
    }
    // Native activity above may intentionally advance the local input. From
    // here, observers must not let the rest of this packet reach a successor.
    const messageGeneration = this.inputGeneration;
    const messageTurn = this.turn;
    const messageCurrent = () =>
      this.owns(epoch) &&
      this.inputGeneration === messageGeneration &&
      this.turn === messageTurn;
    // Native Live captions are unordered advisory segments. Never attach them
    // to a command token or use them to grant/revoke a tool's lifetime.
    if (content?.inputTranscription?.text) {
      this.transcript('user', content.inputTranscription);
      if (!messageCurrent()) {
        settleFencedBoundary();
        return;
      }
    }
    if (this.discardRetiredReply(message, epoch)) return;
    // Push-to-talk owns every input boundary locally: a call that arrives with
    // no input, reply or tool result outstanding was not requested, and nor is
    // anything else in the reply it starts. Open-mic turns start on Gemini's
    // server-side activity detection, which reports no boundary to gate on.
    const unrequested =
      this.input.pushToTalkMode &&
      !this.replyPending &&
      !this.userTurnPending &&
      !this.pendingTools;
    let toolCalls = message.toolCall?.functionCalls || [];
    if (toolCalls.length && (unrequested || this.unrequestedReply)) {
      this.refuseUnrequestedTools(toolCalls);
      toolCalls = [];
    }
    // In push-to-talk, a caption alone after its turn ended still belongs to
    // that turn. It must not open a reply the next input would retire,
    // discarding that input's own tool calls while it waits for a boundary
    // that never comes. Open mic cannot tell it from a new reply's first
    // caption, so there it still opens one.
    const lateCaption =
      this.input.pushToTalkMode &&
      !this.replyPending &&
      !this.userTurnPending &&
      !this.automaticTurnOpen &&
      !this.pendingTools &&
      !content?.modelTurn &&
      !content?.generationComplete &&
      !toolCalls.length;
    if (
      content?.modelTurn ||
      (content?.outputTranscription && !lateCaption) ||
      content?.generationComplete ||
      toolCalls.length
    ) {
      // Output with nothing outstanding starts a reply nobody requested; a
      // later call in it is refused like one that arrived first.
      if (unrequested) this.unrequestedReply = true;
      // Once successor output is observed, an unattributed later interruption
      // cannot still claim the unobserved automatic predecessor's boundary.
      if (this.typedIntent) {
        this.typedIntent.automaticPredecessor = null;
        this.typedIntent.retiredAutomaticPredecessor = null;
      }
      this.replyPending = true;
      receivedReplyPending = true;
    }
    if (content?.outputTranscription?.text) {
      this.userTurnPending = false;
      this.postToolOutput = true;
      this.transcript('assistant', content.outputTranscription);
      if (!messageCurrent()) {
        settleFencedBoundary();
        return;
      }
    }
    for (const part of (content?.interrupted
      ? []
      : content?.modelTurn?.parts) || []) {
      if (part.thought) continue;
      if (part.inlineData?.data) {
        this.userTurnPending = false;
        this.modelComplete = false;
        this.postToolOutput = true;
        if (!this.pttPlaybackSuppressed) {
          this.input.setVoiceSpeaker('ai');
          if (!messageCurrent()) {
            settleFencedBoundary();
            return;
          }
          this.audio?.play(part.inlineData.data, part.inlineData.mimeType);
          if (!messageCurrent()) {
            settleFencedBoundary();
            return;
          }
          this.modelSpoke = true;
          this.narration.audible();
          if (!messageCurrent()) {
            settleFencedBoundary();
            return;
          }
        }
      }
    }
    if (toolCalls.length) this.enqueueTools(toolCalls, epoch);
    if (content?.turnComplete) {
      if (this.typedIntent) {
        this.typedIntent.automaticPredecessor = null;
        this.typedIntent.retiredAutomaticPredecessor = null;
      }
      this.pttPlaybackSuppressed = false;
      // A native terminal boundary also completes a silent user turn. Output,
      // pending tools and queued controls still gate presentation completion.
      this.userTurnPending = false;
      this.replyPending = false;
      this.unrequestedReply = false;
      this.automaticTurnOpen = false;
      this.automaticActivityOwner = null;
      this.retiredAutomaticActivityOwner = null;
      this.modelComplete = true;
      this.pendingCompletionStatus = content.interrupted
        ? 'interrupted'
        : 'completed';
      this.completedTurns++;
      // Native input captions have no response identity. A model completion
      // cannot finalize them or join speech from either side of an interruption.
      if (this.transcripts.assistant) {
        this.emit({
          type: 'transcript',
          role: 'assistant',
          text: this.transcripts.assistant,
          final: true,
          responseId: this.intentResponseId,
        });
        if (!messageCurrent()) return;
        this.transcripts.assistant = '';
      }
      this.finishPlayback();
    }
  }

  transcript(role, value) {
    if (role === 'assistant')
      this.transcripts.assistant = (
        this.transcripts.assistant + value.text
      ).slice(-16000);
    this.emit({
      type: 'transcript',
      role,
      text: value.text,
      final: false,
      responseId: role === 'user' ? null : this.intentResponseId,
      ...(role === 'user' ? { attribution: 'unverified', delta: true } : {}),
    });
  }

  /**
   * Answer unrequested calls without running them: every declaration is
   * BLOCKING, so Live waits for a result. The reply stays tracked, so the next
   * input retires it and its late boundary cannot close the user's turn.
   */
  refuseUnrequestedTools(calls) {
    const refused = new Map();
    for (const call of calls)
      if (
        validCallId(call?.id) &&
        typeof call.name === 'string' &&
        !this.seenCalls.has(call.id)
      )
        refused.set(call.id, call.name);
    this.rememberCallIds([...refused.keys()]);
    if (!refused.size) return;
    this.unrequestedReply = true;
    this.replyPending = true;
    this.send({
      toolResponse: {
        functionResponses: [...refused].map(([id, name]) => ({
          id,
          name,
          response: {
            ok: false,
            action: name,
            changed: false,
            error: 'No user request is active.',
            responseGuidance:
              'Do not call another tool or claim an action ran. Wait for the user.',
          },
        })),
      },
    });
  }

  rememberCallIds(ids) {
    const freshIds = new Set(ids.filter((id) => !this.seenCalls.has(id)));
    // Forgetting an old ID would let its replay acquire a new turn's authority.
    // Reserve the entire batch before changing policy or queuing any action.
    if (this.seenCalls.size + freshIds.size > MAX_SEEN_CALLS)
      throw new Error(
        msg(
          'Gemini action history is full. Start voice again for a fresh session.',
        ),
      );
    for (const id of freshIds) this.seenCalls.add(id);
  }

  enqueueTools(calls, epoch) {
    if (
      calls.length > MAX_TOOL_CALLS ||
      this.pendingTools + calls.length > MAX_TOOL_CALLS
    )
      throw new Error(msg('Gemini requested too many simultaneous actions'));
    const turn = this.turn;
    this.userTurnPending = false;
    this.modelComplete = false;
    // Admit each valid native call ID once per connection.
    const batchIds = new Set();
    const acceptedCalls = calls.filter((call) => {
      if (
        !validCallId(call?.id) ||
        typeof call.name !== 'string' ||
        this.seenCalls.has(call.id) ||
        batchIds.has(call.id)
      )
        return false;
      batchIds.add(call.id);
      return true;
    });
    this.rememberCallIds(acceptedCalls.map((call) => call.id));
    for (const call of acceptedCalls) {
      this.pendingTools++;
      const action = new AbortController();
      action.call = { id: call.id, name: call.name };
      action.sequence = ++this.toolSequence;
      this.tools.set(call.id, action);
      const priorTools = this.toolQueue;
      const args =
        call.args && typeof call.args === 'object' && !Array.isArray(call.args)
          ? call.args
          : {};
      // Stronger Radio controls must reach their shared reservation/result
      // owner while an older selection is awaiting a service. Keep ordinary
      // siblings ordered, and retain every in-flight call in the drain promise.
      // executeTool still checks currentness before any
      // reservation; only a successful stronger result revokes older work.
      const { stronger } = classifyGeminiTool(call.name, args);
      const execution = (stronger ? Promise.resolve() : priorTools)
        .then(async () => {
          if (!this.owns(epoch) || turn !== this.turn) return;
          if (this.cancelledCalls.has(call.id)) {
            if (this.tools.get(call.id) === action) this.tools.delete(call.id);
            this.pendingTools--;
            if (!this.pendingTools) {
              this.setStatus('listening', msg('Ask or command'));
              if (this.owns(epoch) && turn === this.turn) this.finishPlayback();
            }
            return;
          }
          await this.executeTool(call, epoch, turn, action);
        })
        .catch((error) => {
          if (this.owns(epoch) && turn === this.turn) this.fail(error);
        });
      this.toolQueue = stronger
        ? Promise.all([priorTools, execution]).then(() => {})
        : execution;
    }
  }

  async executeTool(call, epoch, turn, action) {
    const args =
      call.args && typeof call.args === 'object' && !Array.isArray(call.args)
        ? call.args
        : {};
    const deadline = AbortSignal.timeout(45_000);
    const expire = () => action.abort(deadline.reason);
    deadline.addEventListener('abort', expire, { once: true });
    const toolSignal = AbortSignal.any([action.signal, this.turnAbort.signal]);
    const {
      radioControl,
      radioVisibility,
      authorityDomain: authority,
      stronger,
      abortScope,
    } = classifyGeminiTool(call.name, args);
    let reservation = null;
    let handoffEpoch = this.radio.radioHandoffEpoch;
    const current = () =>
      this.owns(epoch) && this.turn === turn && !toolSignal.aborted;
    const actionCurrent = () =>
      current() &&
      !this.radioSuperseded(action, authority, epoch, turn) &&
      (authority !== 'playback' ||
        handoffEpoch === this.radio.radioHandoffEpoch);
    let result;
    try {
      if (!actionCurrent()) throw cancelled();
      if (stronger)
        reservation = this.radio.reserveRadioToolHandoff({ abortScope });
      handoffEpoch = this.radio.radioHandoffEpoch;
      if (!actionCurrent()) throw cancelled();
      if (authority)
        this.radio.registerTool(action, {
          responseId: String(turn),
          authorityDomain: authority,
        });
      this.setStatus('executing', msg('Running command'));
      // A common state observer may synchronously stop/replace the session.
      if (!actionCurrent()) throw cancelled();
      this.radio.pauseRadioForVoice();
      if (!actionCurrent()) throw cancelled();
      if (this.modelSpoke) this.narration.preamble();
      this.narration.toolStarted(call.id, {
        name: call.name,
        label: narrationLabel(call.name, args),
        narrate: !radioControl && !radioVisibility,
      });
      if (!actionCurrent()) throw cancelled();
      const execution = Promise.resolve(
        this.runAction(call.name, args, {
          signal: toolSignal,
          callId: call.id,
          progress: (update) => {
            if (actionCurrent()) this.narration.progress(call.id, update);
          },
          isCurrent: actionCurrent,
        }),
      );
      // action-call observers can abort before waitForSignal receives the
      // already-started operation; retain its rejection handler in that case.
      void execution.catch(() => {});
      result = await waitForSignal(execution, toolSignal);
      if (!actionCurrent()) throw cancelled();
      if (result?.ok && result.radioPlaybackRequested) {
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
        this.now() - this.lastViewportAt >= 1000
      ) {
        const capture = Promise.resolve(this.captureViewport());
        void capture.catch(() => {});
        const image = await waitForSignal(capture, toolSignal);
        if (actionCurrent() && image?.startsWith('data:image/jpeg;base64,')) {
          this.lastViewportAt = this.now();
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
        ...(radioVisibility ? { layerId: 'radio' } : {}),
        error:
          error?.name === 'AbortError'
            ? 'Action cancelled by a newer request'
            : error?.message || 'GEV command failed',
      };
    } finally {
      deadline.removeEventListener('abort', expire);
      if (this.tools.get(call.id) === action) this.tools.delete(call.id);
      this.radio.releaseTool(action);
      if (this.owns(epoch) && turn === this.turn)
        this.narration.toolFinished(call.id);
    }
    if (!this.owns(epoch) || turn !== this.turn) return;
    this.pendingTools--;
    // Successful stronger ownership commits before the result is serialized.
    // A failed reservation stays held until after its failure reaches transport.
    if (reservation && result?.ok) {
      this.radio.settleRadioToolHandoffReservation(reservation, {
        commit: true,
        responseId: String(turn),
      });
      reservation = null;
      this.noteRadioStrongerCommit(action, abortScope, turn);
    }
    if (!this.owns(epoch) || turn !== this.turn) return;
    const playbackObsolete =
      authority === 'playback' && handoffEpoch !== this.radio.radioHandoffEpoch;
    if (radioControl || radioVisibility) {
      const state = this.radioLayer?.getUIState?.() || {};
      const lifecycle = readLayerLifecycleSummary(this.dataManager, 'radio', {
        fallbackEnabled: state.enabled ?? result?.enabled,
      });
      result = {
        ...result,
        ...lifecycle,
        audioState: state.audioState || result?.audioState || 'stopped',
        ...(result?.radioAction === 'pause' && lifecycle.enabled === false
          ? { changed: false }
          : {}),
        ...(playbackObsolete && result?.ok && result.radioPlaybackRequested
          ? { radioPlaybackRequested: false, radioPlaybackSuppressed: true }
          : {}),
      };
    }
    if (
      !this.cancelledCalls.has(call.id) &&
      shouldStopVoiceAfterRadioTool(result) &&
      !result.radioPlaybackRequested &&
      !result.radioPlaybackSuppressed
    )
      this.stopAfterReply = true;
    // Native call cancellation suppresses its output, without canceling siblings.
    if (!this.cancelledCalls.has(call.id)) {
      this.postToolOutput = false;
      this.modelComplete = false;
      this.replyPending = true;
      const mapSnapshot = [...this.pendingMapEvents];
      const mapEvents = mapSnapshot.map((text) => JSON.parse(text));
      const response = {
        ...(result ?? { ok: false, error: 'Command returned no result' }),
        responseGuidance: responseInstructionForToolResult(result),
      };
      this.send(
        {
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
        },
        { onSent: () => this.consumeMapEvents(mapSnapshot) },
      );
    }
    if (!this.owns(epoch) || turn !== this.turn) return;
    if (reservation)
      this.radio.settleRadioToolHandoffReservation(reservation, {
        commit: false,
        responseId: String(turn),
      });
    if (this.owns(epoch) && turn === this.turn && !this.pendingTools) {
      this.setStatus('listening', msg('Ask or command'));
      if (this.owns(epoch) && turn === this.turn) this.finishPlayback();
    }
  }

  finishPlayback() {
    if (this.goAway && this.now() >= this.goAway.deadline) {
      this.finishGoAway();
      return;
    }
    if (
      !this.isActive() ||
      !this.modelComplete ||
      this.userTurnPending ||
      this.pendingTools ||
      (this.input.pushToTalkMode &&
        this.captureOwner &&
        !this.captureOwner.retired &&
        !this.captureOwner.admitted &&
        !this.captureOwner.settled) ||
      this.audio?.pending ||
      this.controlQueue.length
    )
      return;
    const completionStatus = this.pendingCompletionStatus;
    this.pendingCompletionStatus = null;
    this.narration.cancel();
    if (completionStatus) {
      const responseId = this.intentResponseId;
      const completionEpoch = this.epoch;
      const completionTurn = this.turn;
      this.emit({
        type: 'completion',
        status: completionStatus,
        responseId,
        spoken: Boolean(this.modelSpoke),
        audioDrained: true,
      });
      // Observers may synchronously accept new input or replace the session.
      // Old completion must not clear its metadata or overwrite its status.
      if (this.epoch !== completionEpoch || this.turn !== completionTurn)
        return;
      // Caption completion does not create an input or tool authority boundary.
      this.clearSettledSpeechIntent();
    }
    // A completion observer may replace this provider immediately. Do not let
    // the retired session update UI or start delayed Radio work afterward.
    if (!this.isActive()) return;
    this.input.setVoiceSpeaker('idle');
    this.setStatus('listening', msg('Ask or command'));
    if (this.stopAfterReply && this.postToolOutput) {
      this.stop({ preserveRadioPlayback: true });
      return;
    }
    if (this.goAway) {
      this.finishGoAway();
      return;
    }
    if (this.postToolOutput && this.radio.pendingRadioPlaybackResult)
      void this.radio.startPendingRadioHandoff();
  }

  sendTextCommand(text) {
    const clean = String(text || '').trim();
    if (!clean || this.goAway) return false;
    if (clean.length > 16000)
      throw new Error(msg('Voice text command is too long'));
    if (this.channel?.readyState !== 'open')
      throw new Error(msg('Gemini voice is not connected'));
    if (this.input.pushToTalkMode && this.captureOwner)
      this.captureOwner.retired = true;
    const automaticPredecessor =
      this.automaticTurnOpen &&
      !this.replyPending &&
      !this.retiredReplyPending &&
      !this.deferredInput
        ? this.automaticActivityOwner
        : null;
    if (!this.interrupt('user-text')) return false;
    const epoch = this.epoch;
    const turn = this.turn;
    const generation = this.inputGeneration;
    const owned = () =>
      this.owns(epoch) &&
      this.turn === turn &&
      this.inputGeneration === generation;
    // Typed intent supersedes the held speech even if its worklet end is late.
    // Close the forwarded manual activity before submitting the new text.
    if (this.input.pushToTalkMode && this.forwardedActivityOpen)
      this.send(
        { realtimeInput: { activityEnd: {} } },
        { captureId: this.forwardedCaptureId },
      );
    if (!owned()) return false;
    const typedIntent = {
      epoch: this.epoch,
      turn: this.turn,
      text: clean,
      responseId: `gemini-response-${this.epoch}-${++this.intentSequence}`,
      automaticPredecessor,
      retiredAutomaticPredecessor: null,
    };
    // Keep local presentation ownership while reliable transport drains.
    this.typedIntent = typedIntent;
    this.beginPointerTurn('text', undefined, owned);
    if (!owned()) return false;
    const context = this.pendingPointerContext;
    const mapSnapshot = [...this.pendingMapEvents];
    const parts = context ? [{ text: JSON.stringify(context.item) }] : [];
    if (this.pendingMapEvents.length)
      parts.push({
        text: JSON.stringify({
          type: 'map_events',
          events: mapSnapshot.map((value) => JSON.parse(value)),
        }),
      });
    parts.push({ text: clean });
    const sent = this.sendUserInput(
      {
        clientContent: { turns: [{ role: 'user', parts }], turnComplete: true },
      },
      undefined,
      {
        onSent: () => {
          if (!owned() || this.typedIntent !== typedIntent) return;
          this.replyPending = true;
          this.bindTextIntent(typedIntent);
          if (!owned() || this.typedIntent !== typedIntent) return;
          this.consumePointerContext(context);
          this.consumeMapEvents(mapSnapshot);
        },
      },
    );
    if (sent && owned()) {
      this.narration.userTurnEnded();
    }
    return sent && owned();
  }

  consumeMapEvents(snapshot) {
    // Queue acceptance is not delivery. A cancelled envelope retains passive
    // context for the next genuine turn, and new events cannot be erased.
    if (snapshot.every((text, index) => this.pendingMapEvents[index] === text))
      this.pendingMapEvents.splice(0, snapshot.length);
  }

  validCaptureMetadata(metadata) {
    return Number.isSafeInteger(metadata?.captureId) && metadata.captureId > 0;
  }

  acceptsCapture(metadata) {
    return (
      this.validCaptureMetadata(metadata) &&
      metadata.captureId === this.captureOwner?.captureId &&
      !this.captureOwner.retired
    );
  }

  sendUserInput(message, metadata, { onSent = null } = {}) {
    const owner = this.deferredInput;
    const input = message.realtimeInput;
    const captureContext = message.clientContent?.turnComplete === false;
    // A superseded start cannot read the current pointer or acquire its queue.
    // Only an end for the actually forwarded old activity may close that wire.
    if (
      captureContext ||
      input?.activityStart ||
      input?.activityEnd ||
      input?.audio
    ) {
      if (!this.validCaptureMetadata(metadata)) return false;
      if (!this.acceptsCapture(metadata)) {
        return input?.activityEnd &&
          this.forwardedActivityOpen &&
          this.forwardedCaptureId === metadata.captureId
          ? this.send(message, { captureId: metadata.captureId, onSent })
          : false;
      }
    }
    if (
      input?.activityEnd &&
      !this.forwardedActivityOpen &&
      !this.controlQueue.some(
        (entry) =>
          entry.captureId === metadata?.captureId &&
          entry.message.realtimeInput?.activityStart,
      ) &&
      !owner?.activityOpen
    )
      return true;
    if (!owner)
      return this.send(message, {
        captureId: metadata?.captureId ?? null,
        onSent,
      });
    if (!this.owns(owner.epoch) || owner.turn !== this.turn) return false;
    // Worklet callbacks keep the previous end ahead of the new start. After
    // replacing unsent input, that old end/PCM has no new gesture to belong to.
    if (input?.activityEnd && !owner.activityOpen)
      return this.forwardedActivityOpen
        ? this.send(message, { captureId: this.forwardedCaptureId, onSent })
        : true;
    if (
      input?.audio &&
      (!owner.activityOpen || owner.kind !== 'push-to-talk')
    ) {
      // These frames cannot be replayed under the deferred explicit owner.
      // Preserve that discard policy while making the loss observable.
      this.droppedAudioChunks++;
      this.deferredAudioDrops[
        owner.kind !== 'push-to-talk' ? 'nonPttOwner' : 'closedActivity'
      ]++;
      return true;
    }
    const bytes = new TextEncoder().encode(JSON.stringify(message)).byteLength;
    if (
      owner.bytes + bytes > MAX_BUFFERED_BYTES ||
      this.now() >= owner.deadline
    ) {
      this.fail(
        new Error(
          msg(
            'Gemini interrupted input exceeded its buffer or wait limit. Start voice again.',
          ),
        ),
      );
      return false;
    }
    if (input?.activityStart) {
      owner.activityOpen = true;
      owner.captureId = metadata?.captureId;
    }
    if (input?.activityEnd) owner.activityOpen = false;
    owner.messages.push(message);
    if (onSent) {
      owner.onSent ||= new Map();
      owner.onSent.set(message, onSent);
    }
    owner.bytes += bytes;
    return true;
  }

  clearDeferredInput() {
    if (this.deferredInput) this.clearTimer(this.deferredInput.timer);
    this.deferredInput = null;
  }

  clearRetiredBoundaryWait() {
    if (this.retiredBoundaryWait)
      this.clearTimer(this.retiredBoundaryWait.timer);
    this.retiredBoundaryWait = null;
  }

  waitForRetiredBoundary(owner) {
    this.clearRetiredBoundaryWait();
    const wait = { epoch: owner.epoch, deadline: owner.deadline };
    this.retiredBoundaryWait = wait;
    wait.timer = this.setTimer(
      () => {
        if (
          this.retiredBoundaryWait === wait &&
          this.owns(wait.epoch) &&
          this.retiredReplyPending
        )
          this.fail(
            new Error(
              msg(
                'Gemini did not finish the interrupted reply. Start voice again.',
              ),
            ),
          );
      },
      Math.max(0, wait.deadline - this.now()),
    );
    wait.timer.unref?.();
  }

  // A first retirement has no deferred owner, yet everything Live sends is
  // discarded until the old boundary. Never leave that wait unbounded.
  boundRetiredReply() {
    if (
      !this.retiredReplyPending ||
      this.deferredInput ||
      this.retiredBoundaryWait
    )
      return;
    this.waitForRetiredBoundary({
      epoch: this.epoch,
      deadline: this.now() + this.inputBoundaryTimeoutMs,
    });
    this.retiredBoundaryWait.extendable = true;
  }

  flushDeferredInput() {
    const owner = this.deferredInput;
    if (!owner) return;
    this.clearDeferredInput();
    const generation = this.inputGeneration;
    const current = () =>
      this.owns(owner.epoch) &&
      owner.turn === this.turn &&
      generation === this.inputGeneration;
    if (!current()) return;
    if (this.now() >= owner.deadline) {
      this.fail(
        new Error(
          msg(
            'Gemini did not finish the interrupted reply. Start voice again.',
          ),
        ),
      );
      return;
    }
    // The already submitted successor is now the one being retired. Send the
    // newest start/text immediately to trigger its own provider boundary.
    this.retiredReplyPending = true;
    // The forwarded predecessor here is explicit PTT/text, not a later VAD
    // activity that may have arrived while its boundary was pending.
    this.retiredAutomaticActivityOwner = null;
    // Flushing (even an empty capture queue) must not remove the absolute
    // recovery bound while the forwarded predecessor still owns output.
    this.waitForRetiredBoundary(owner);
    this.replyPending = false;
    for (const message of owner.messages) {
      if (!current()) return;
      const onSent = owner.onSent?.get(message);
      this.send(message, {
        captureId: owner.captureId ?? null,
        onSent: () => {
          if (!current()) return;
          onSent?.();
          if (!current()) return;
          if (
            (message.clientContent &&
              message.clientContent.turnComplete !== false) ||
            message.realtimeInput?.audio ||
            message.realtimeInput?.text
          )
            this.replyPending = true;
        },
      });
      if (!current()) return;
    }
    if (current() && owner.context && !this.controlQueue.length)
      this.consumePointerContext(owner.context);
  }

  /** Use the common pointer owner; held speech context precedes audio quietly. */
  beginPointerTurn(at, capturedSnapshot = undefined, isCurrent = () => true) {
    if (!this.pointer || !isCurrent()) return null;
    // The delayed manual speech notification still refers to the released hold.
    if (
      capturedSnapshot === undefined &&
      at === 'speech_start' &&
      this.input.pushToTalkMode &&
      !this.pointer.isHeld?.()
    )
      return this.pointer.activeSnapshot?.() || null;
    const gesture =
      at === 'keydown' || (at === 'speech_start' && this.input.pushToTalkMode);
    let snapshot = null;
    try {
      snapshot = this.pointer.beginTurn(
        at,
        capturedSnapshot !== undefined
          ? { capturedSnapshot }
          : gesture
            ? {}
            : { recentMs: POINTER_OPEN_MIC_RECENT_MS },
      );
    } catch {
      snapshot = null;
    }
    if (!isCurrent()) return null;
    const event = pointerTurnEvent(snapshot, gesture);
    this.pointerAnnounced = event.announced;
    this.emit({ type: 'pointer', pointer: event.pointer });
    if (!isCurrent()) return null;
    this.pendingPointerContext = pointerTurnContext(snapshot, {
      at,
      gesture,
      sentKey: this.pointerSentKey,
    });
    return snapshot;
  }

  /** Reveal an implicit referent only after the shared action runner uses it. */
  announcePointer() {
    const snapshot = this.pointer?.activeSnapshot?.() || null;
    const pointer = pointerAnnouncement(snapshot, this.pointerAnnounced);
    if (!pointer) return false;
    this.pointerAnnounced = snapshot;
    this.emit({ type: 'pointer', pointer });
    return true;
  }

  /** Pointing accompanies speech without asking Live to answer the context. */
  sendPointerContext(context, metadata) {
    if (!context) return true;
    const message = {
      clientContent: {
        turns: [
          { role: 'user', parts: [{ text: JSON.stringify(context.item) }] },
        ],
        turnComplete: false,
      },
    };
    // Context has the same physical owner and queue as its PTT start/PCM/end.
    const deferred = Boolean(this.deferredInput);
    const accepted = this.sendUserInput(message, metadata, {
      onSent: () => this.consumePointerContext(context),
    });
    if (accepted && deferred) this.consumePointerContext(context);
    return accepted;
  }

  consumePointerContext(context) {
    if (!context) return;
    if (this.deferredInput) {
      this.deferredInput.context = context;
      if (this.pendingPointerContext === context)
        this.pendingPointerContext = null;
      return;
    }
    this.pointerSentKey = context.key;
    if (this.pendingPointerContext === context)
      this.pendingPointerContext = null;
  }

  // Any clientContent message can interrupt Live generation, including one
  // with turnComplete:false. Passive map results wait for an explicit turn
  // or a tool response; they must never cut off spoken output or start speech.
  notifyMapEvent(event) {
    if (this.goAway || this.channel?.readyState !== 'open') return false;
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

  beginSpeechIntent(captureId) {
    if (this.retiredReplyPending && this.currentTypedInput()) return;
    // Local onset labels serve timing/UI only. They do not assert native
    // transcript ownership or mint a completed-speech authorization token.
    this.clearSettledSpeechIntent();
    // interrupt() revokes old input when a new local turn actually starts.
    // Onsets racing a retired reply must not erase its typed successor.
    this.intentItemId = `gemini-input-${this.epoch}-${++this.intentSequence}`;
    this.intentResponseId = null;
    this.intentCaptureId = captureId;
    // A physical speech onset clears display-only recent captions, including
    // when retirement already fenced the reply and no second interrupt runs.
    this.emit({ type: 'transcript', role: 'user', text: '', final: false });
  }

  bindSpeechIntent() {
    if (!this.intentItemId || this.intentResponseId) return;
    this.intentResponseId = `gemini-response-${this.epoch}-${this.intentSequence}`;
  }

  currentTypedInput(turn = this.turn) {
    const input = this.typedIntent;
    return input?.epoch === this.epoch && input.turn === turn ? input : null;
  }

  // Stronger Radio controls skip the ordered queue. An older Radio call still
  // waiting behind a sibling must not start after a successful stronger
  // result has revoked it; later calls in the same turn remain the model's.
  noteRadioStrongerCommit(action, abortScope, turn) {
    let commit = this.radioStrongerCommit;
    if (commit?.epoch !== this.epoch || commit.turn !== turn)
      commit = this.radioStrongerCommit = {
        epoch: this.epoch,
        turn,
        all: 0,
        playback: 0,
      };
    const scope = abortScope === 'all' ? 'all' : 'playback';
    commit[scope] = Math.max(commit[scope], action.sequence);
  }

  radioSuperseded(action, authority, epoch, turn) {
    const commit = this.radioStrongerCommit;
    // Read-only status queries stay current, as for the shared sibling abort.
    if (
      !authority ||
      authority === 'query' ||
      commit?.epoch !== epoch ||
      commit.turn !== turn
    )
      return false;
    return (
      action.sequence < commit.all ||
      (authority === 'playback' && action.sequence < commit.playback)
    );
  }

  bindTextIntent(intent) {
    if (
      intent !== this.typedIntent ||
      intent.epoch !== this.epoch ||
      intent.turn !== this.turn
    )
      return;
    this.clearSettledSpeechIntent();
    this.intentResponseId = intent.responseId;
    this.emit({
      type: 'transcript',
      role: 'user',
      text: intent.text,
      final: true,
    });
  }

  clearSettledSpeechIntent() {
    this.intentResponseId = null;
    this.intentItemId = null;
    this.intentCaptureId = null;
  }

  beginGoAway(timeLeft, epoch) {
    const duration =
      typeof timeLeft === 'string' &&
      /^(?:\d{1,6})(?:\.\d{1,9})?s$/.test(timeLeft)
        ? Number(timeLeft.slice(0, -1)) * 1000
        : 0;
    const milliseconds = Math.min(
      MAX_GO_AWAY_MS,
      Number.isFinite(duration) ? duration : 0,
    );
    const deadline = this.now() + milliseconds;
    if (this.goAway && this.goAway.deadline <= deadline) return;
    const supersededSuccessor =
      Boolean(this.deferredInput) || Boolean(this.goAway?.supersededSuccessor);
    if (this.goAway) this.clearTimer(this.goAway.timer);
    const owner = {
      epoch,
      turn: this.turn,
      deadline,
      timer: null,
      // Dropping the newest unsent input must not make its superseded,
      // already forwarded predecessor current at the retired boundary.
      supersededSuccessor,
    };
    this.goAway = owner;
    this.clearDeferredInput();
    owner.timer = this.setTimer(() => {
      if (this.goAway === owner && this.owns(epoch)) this.finishGoAway();
    }, milliseconds);
    owner.timer?.unref?.();
    this.input.setMicrophoneEnabled(false);
    this.radio.cancelRadioHandoff();
    this.setStatus(
      this.status,
      msg('Gemini session expiring; finishing the current reply'),
    );
    if (
      milliseconds === 0 ||
      (!this.replyPending &&
        !this.automaticTurnOpen &&
        !this.pendingTools &&
        !this.audio?.pending &&
        !this.controlQueue.length)
    )
      this.finishGoAway();
    else this.finishPlayback();
  }

  finishGoAway() {
    if (!this.goAway) return;
    this.fail(
      new Error(
        msg(
          'Gemini Live connection is expiring. Start voice again for a new conversation.',
        ),
      ),
      msg('Start voice again for a fresh token and a new conversation.'),
    );
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
      narration: this.narration.state(),
      completedTurns: this.completedTurns,
      audio: this.audio?.diagnostics() || this.lastAudio,
      error: this.lastError,
      close: this.lastClose,
      droppedAudioChunks: this.droppedAudioChunks,
      deferredAudioDrops: { ...this.deferredAudioDrops },
      droppedImages: this.droppedImages,
      queuedControls: this.controlQueue.length,
      expiring: Boolean(this.goAway),
    };
  }

  stop({
    removeUi = false,
    preserveStatus = false,
    preserveRadioPlayback = false,
  } = {}) {
    if (this.disposed) return;
    this.epoch++;
    this.inputGeneration++;
    this.clearSettledSpeechIntent();
    this.clearControls();
    if (this.goAway) this.clearTimer(this.goAway.timer);
    this.goAway = null;
    this.abort?.abort();
    this.abort = null;
    this.abortTools();
    this.earcon.dispose();
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
    this.pointer?.clear({ keepHold: this.input.pushToTalkKeyHeld });
    if (!this.input.pushToTalkKeyHeld) this.heldPointerSnapshot = undefined;
    this.input.resetSession();
    this.radio.setRadioVoiceDucking(false);
    this.modelComplete = false;
    this.pendingCompletionStatus = null;
    this.postToolOutput = false;
    this.modelSpoke = false;
    this.stopAfterReply = false;
    this.seenCalls.clear();
    this.cancelledCalls.clear();
    this.pendingMapEvents = [];
    this.userTurnPending = false;
    this.replyPending = false;
    this.unrequestedReply = false;
    this.automaticTurnOpen = false;
    this.automaticActivityOwner = null;
    this.retiredAutomaticActivityOwner = null;
    this.automaticActivitySequence = 0;
    this.retiredReplyPending = false;
    this.clearDeferredInput();
    this.clearRetiredBoundaryWait();
    this.forwardedActivityOpen = false;
    this.forwardedCaptureId = null;
    this.captureEnabled = false;
    this.pttPlaybackSuppressed = false;
    this.microphoneRequested = false;
    this.captureOwner = null;
    this.userActivityOpen = false;
    this.pointerSentKey = null;
    this.pointerAnnounced = null;
    this.pendingPointerContext = null;
    this.transcripts = { assistant: '' };
    if (removeUi) {
      this.disposed = true;
      this.status = 'idle';
      this.input.detachBindings();
      this.radio.detachObservers();
      this.signal?.removeEventListener('abort', this.lifetimeAbort);
      this.ui?.root?.remove();
      this.emit({ type: 'disposed' });
    } else if (!preserveStatus) this.setStatus('idle', msg('Voice off'));
  }
}

export function createGeminiSession(options) {
  const controller = new GeminiSessionController(options);
  return {
    controller,
    capabilities: {
      costControls: false,
      pushToTalk: true,
      advisoryLimit: t(
        'Gemini voice sessions have a time limit. When a session expires, start voice again for a new conversation.',
      ),
    },
    start: (settings) => controller.start(settings),
    getStartOptions: () => ({
      pushToTalk: Boolean(controller.input.pushToTalkMode),
    }),
    stop: (settings) => controller.stop(settings),
    sendText: (text) => controller.sendTextCommand(text),
    sendMapEvent: (event) => controller.notifyMapEvent(event),
    ignoreButtonClick: () => Boolean(controller.spaceKeyHeld),
    bindControls: () => controller.input.bindPushToTalkShortcut(),
  };
}
