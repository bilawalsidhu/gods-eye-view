/**
 * src/voice/ondemand/pipeline.js — the OnDemand voice turn state machine.
 *
 *   idle → listening → transcribing → thinking → speaking → idle
 *                                              ↘ error (reason) → idle on next press
 *
 * STREAMING TURN-BASED by design: the live OnDemand public API exposes no
 * client-facing realtime/advanced-voice WebSocket or WebRTC surface
 * (`advancedVoiceMode` is a Flow Builder node type for telephony agents), so
 * each turn is  microphone → media upload + STT → chat stream (SSE deltas)
 * [+ input-less workflow trigger + documented polling] → TTS → playback.
 *
 * Everything with a side effect is injected (transport, recorder, player,
 * layer toggles, MapAction runner, timers, clock), so this module is a pure
 * state machine that node:test drives with fakes. It never sees or emits the
 * optional per-browser API key: the transport attaches it at the fetch
 * boundary and nothing here reads storage.
 *
 * Barge-in: a button press (or the recorder's monitor hearing sustained
 * speech) while `speaking` stops playback immediately, abandons the turn's
 * pending work — including an in-flight workflow poll (AbortController) —
 * and starts a fresh `listening` turn.
 */

import {
  matchLayerIntents,
  classifyRoute,
  localConfirmation,
  extractMapActions,
} from './intents.js';
import { normalizeMapActions, voiceUserId } from './transport.js';
import { GEV_ACTION_SCHEMAS } from '../actionSchemas.js';

export const STATES = Object.freeze([
  'idle',
  'listening',
  'transcribing',
  'thinking',
  'speaking',
  'error',
]);
export const MODES = Object.freeze(['auto', 'workflow', 'chat']);
export const LIMITS = Object.freeze({
  maxUtteranceMs: 12_000,
  silenceMs: 1_200,
  workflowTimeoutMs: 90_000,
  maxContextChars: 12_000,
  maxLayersInContext: 16,
});

const ACTION_NAMES = GEV_ACTION_SCHEMAS.map((schema) => schema.name);

function isAbort(error) {
  return error?.name === 'AbortError';
}

function round(value, digits = 4) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
}

/**
 * Compose the chat query: the utterance first, then a compact spoken-answer
 * instruction and the scene context. The proxy's body allow-list (chat.js
 * §3.1) rejects any extra top-level field, so context travels INSIDE
 * `query`.
 */
export function composeQuery(transcript, context = {}, extras = {}) {
  const compact = {
    camera: context.camera
      ? {
          lat: round(context.camera.lat),
          lon: round(context.camera.lon),
          heightM: round(context.camera.heightM, 0),
          headingDeg: round(context.camera.headingDeg, 0),
        }
      : null,
    scene: context.scene || null,
    locality: context.locality || null,
    layers: Array.isArray(context.layers)
      ? context.layers.slice(0, LIMITS.maxLayersInContext).map((layer) => {
          const row = { id: layer.id, enabled: Boolean(layer.enabled) };
          if (layer.state && layer.state !== 'nominal') row.state = layer.state;
          if (layer.reason) row.reason = String(layer.reason).slice(0, 120);
          if (Number.isFinite(layer.count)) row.count = layer.count;
          return row;
        })
      : [],
    tools: Array.isArray(context.tools)
      ? context.tools.slice(0, 12).map((plugin) => ({
          id: plugin.id,
          tools: Array.isArray(plugin.tools)
            ? plugin.tools.map((tool) => tool.name || tool.path).filter(Boolean)
            : [],
        }))
      : [],
    localActionsApplied: Array.isArray(extras.localResults)
      ? extras.localResults.map((r) => ({
          layerId: r.layerId,
          enabled: r.enabled,
          ok: r.ok !== false,
        }))
      : [],
    route: extras.route || null,
    utc: context.utc || null,
  };
  let json = JSON.stringify(compact);
  if (json.length > LIMITS.maxContextChars) {
    compact.tools = [];
    json = JSON.stringify(compact);
    if (json.length > LIMITS.maxContextChars) {
      compact.layers = compact.layers.slice(0, 6);
      json = JSON.stringify(compact);
    }
  }
  return [
    transcript.trim(),
    '',
    '[ondemand-spatial voice turn]',
    'You are the spoken assistant of the OnDemand Spatial globe. Answer in at most two short plain-text sentences (no markdown, no lists). Layers listed as localActionsApplied were already toggled — confirm them briefly instead of asking.',
    `If a map change would help, end with exactly one line: MAPACTIONS: [{"name":"<action>","args":{...}}] using only these action names: ${ACTION_NAMES.join(', ')}. Otherwise omit that line.`,
    `Scene context (JSON): ${json}`,
  ].join('\n');
}

/**
 * @param {object} deps
 * @param {ReturnType<import('./transport.js').createTransport>} deps.transport
 * @param {{start: Function, monitor?: Function}} deps.recorder
 * @param {{play: Function, stop: Function}} deps.player
 * @param {(name: string, args: object, options: object) => Promise<any>} [deps.runMapAction]
 * @param {(layerId: string, enabled: boolean) => Promise<any>} [deps.setLayerEnabled]
 * @param {() => object} [deps.sceneContext]
 * @param {() => Promise<object[]>} [deps.toolsCatalogue]
 */
export function createVoicePipeline({
  transport,
  recorder,
  player,
  runMapAction = null,
  setLayerEnabled = null,
  sceneContext = () => ({}),
  toolsCatalogue = null,
  now = () => Date.now(),
  setTimeout: setTimer = globalThis.setTimeout?.bind(globalThis),
  clearTimeout: clearTimer = globalThis.clearTimeout?.bind(globalThis),
  maxUtteranceMs = LIMITS.maxUtteranceMs,
  workflowTimeoutMs = LIMITS.workflowTimeoutMs,
  userId = voiceUserId(now),
  classify = classifyRoute,
  mode = 'auto',
  workflowEnabled = true,
  voice = 'alloy',
} = {}) {
  if (!transport)
    throw new TypeError('createVoicePipeline requires a transport');
  if (!recorder) throw new TypeError('createVoicePipeline requires a recorder');
  if (!player) throw new TypeError('createVoicePipeline requires a player');

  const listeners = new Set();
  let state = 'idle';
  let detail = '';
  let currentMode = MODES.includes(mode) ? mode : 'auto';
  let disposed = false;
  let turnCounter = 0;
  let activeTurn = null; // the turn owning listening/transcribing/thinking/speaking
  let capture = null; // recorder capture while listening
  let pendingStop = null; // press() before the recorder resolved
  let maxTimer = null;
  let monitor = null;
  let sessionPromise = null;
  let pendingWorkflow = null; // AbortController of the newest workflow poll
  const history = [];

  function emit(event) {
    const payload = { ...event, turn: event.turn ?? activeTurn?.id ?? null };
    for (const listener of [...listeners]) {
      try {
        listener(payload);
      } catch {
        // a broken listener never breaks the pipeline
      }
    }
  }

  function setState(next, nextDetail = '') {
    state = next;
    detail = nextDetail;
    emit({ type: 'state', state, detail });
  }

  function ensureSession(signal) {
    if (!sessionPromise) {
      sessionPromise = transport
        .createSession({ userId, signal })
        .catch((error) => {
          sessionPromise = null;
          throw error;
        });
    }
    return sessionPromise;
  }

  function newTurn(origin) {
    turnCounter += 1;
    return {
      id: turnCounter,
      origin,
      transcript: '',
      mode: currentMode,
      route: null,
      controller: new AbortController(),
      workflowController: null,
      metrics: { startedAt: now() },
      startedAt: now(),
    };
  }

  /** Abandon a pending workflow poll (a newer turn supersedes it). */
  function abandonWorkflow() {
    const controller = pendingWorkflow;
    pendingWorkflow = null;
    if (controller && !controller.signal.aborted) controller.abort();
  }

  function abandonTurn(turn) {
    abandonWorkflow();
    if (!turn) return;
    if (!turn.controller.signal.aborted) turn.controller.abort();
    if (turn.workflowController && !turn.workflowController.signal.aborted) {
      turn.workflowController.abort();
    }
  }

  function clearMaxTimer() {
    if (maxTimer !== null) clearTimer(maxTimer);
    maxTimer = null;
  }

  function stopMonitor() {
    const active = monitor;
    monitor = null;
    try {
      active?.stop?.();
    } catch {
      // ignore
    }
  }

  // ---- listening -----------------------------------------------------------

  async function startListening(origin = 'button') {
    if (disposed) return null;
    const previous = activeTurn;
    abandonTurn(previous); // includes any pending workflow poll
    player.stop();
    stopMonitor();
    clearMaxTimer();
    const turn = newTurn(origin);
    activeTurn = turn;
    pendingStop = null;
    setState('listening', 'Requesting microphone…');
    let started;
    try {
      started = await recorder.start({
        onSpeech: () => {
          if (activeTurn === turn && state === 'listening') {
            turn.metrics.speechAt = now();
            emit({ type: 'speech', turn: turn.id });
          }
        },
        onSilence: () => {
          if (activeTurn === turn && state === 'listening')
            void stopListening('silence');
        },
      });
    } catch (error) {
      if (activeTurn !== turn) return turn;
      setState('error', `Microphone unavailable: ${error?.message || error}`);
      emit({
        type: 'error',
        message: `Microphone unavailable: ${error?.message || error}`,
      });
      activeTurn = null;
      return turn;
    }
    if (activeTurn !== turn || turn.controller.signal.aborted) {
      void started?.cancel?.();
      return turn;
    }
    capture = started;
    turn.metrics.listeningAt = now();
    setState('listening', 'Listening… press again or pause to send');
    maxTimer = setTimer(() => {
      if (activeTurn === turn && state === 'listening')
        void stopListening('max');
    }, maxUtteranceMs);
    if (pendingStop) {
      const reason = pendingStop;
      pendingStop = null;
      void stopListening(reason);
    }
    return turn;
  }

  async function stopListening(reason = 'manual') {
    const turn = activeTurn;
    if (!turn || state !== 'listening') return null;
    if (!capture) {
      pendingStop = reason;
      return null;
    }
    clearMaxTimer();
    const active = capture;
    capture = null;
    turn.metrics.stopReason = reason;
    setState(
      'transcribing',
      reason === 'max'
        ? 'Utterance cap reached — transcribing…'
        : 'Transcribing…',
    );
    let blob = null;
    try {
      blob = await active.stop();
    } catch {
      blob = null;
    }
    if (activeTurn !== turn || turn.controller.signal.aborted) return turn;
    if (!blob || blob.size === 0) {
      setState('idle', 'No audio captured');
      activeTurn = null;
      return turn;
    }
    turn.metrics.audioBytes = blob.size;
    const signal = turn.controller.signal;
    let transcript = '';
    const t0 = now();
    try {
      const session = await ensureSession(signal).catch((error) => {
        if (isAbort(error)) throw error;
        return null; // upload still attempted without a sessionId
      });
      const result = await transport.transcribe(blob, {
        sessionId: session?.sessionId,
        signal,
      });
      transcript = result.text;
      turn.metrics.sttMs = now() - t0;
      turn.metrics.sttUploadMs = result.uploadMs;
    } catch (error) {
      if (isAbort(error) || activeTurn !== turn) return turn;
      setState('error', `Transcription failed: ${error?.message || error}`);
      emit({
        type: 'error',
        message: `Transcription failed: ${error?.message || error}`,
        status: error?.status ?? null,
      });
      activeTurn = null;
      return turn;
    }
    if (activeTurn !== turn || signal.aborted) return turn;
    if (!transcript) {
      setState('idle', 'Nothing heard');
      activeTurn = null;
      return turn;
    }
    turn.transcript = transcript;
    await runTurn(turn);
    return turn;
  }

  // ---- thinking ------------------------------------------------------------

  async function buildContext() {
    let context = {};
    try {
      context = sceneContext() || {};
    } catch {
      context = {};
    }
    let tools = [];
    try {
      const catalogue =
        typeof toolsCatalogue === 'function'
          ? toolsCatalogue
          : typeof transport.tools === 'function'
            ? () => transport.tools()
            : null;
      tools = catalogue ? (await catalogue()) || [] : [];
    } catch {
      tools = [];
    }
    return { ...context, tools, utc: new Date(now()).toISOString() };
  }

  async function applyLocalIntents(turn, intents) {
    if (!intents.length || typeof setLayerEnabled !== 'function') return [];
    setState(
      'thinking',
      `Local: ${intents.map((i) => `${i.label} ${i.enabled ? 'on' : 'off'}`).join(', ')}`,
    );
    const results = await Promise.all(
      intents.map(async (intent) => {
        try {
          const changed = await setLayerEnabled(intent.layerId, intent.enabled);
          return { ...intent, ok: true, changed: changed !== false };
        } catch (error) {
          return {
            ...intent,
            ok: false,
            error: error?.message || String(error),
          };
        }
      }),
    );
    emit({ type: 'intents', intents, results, turn: turn.id });
    return results;
  }

  async function dispatch(turn, actions, source) {
    if (!actions.length) return [];
    if (typeof runMapAction !== 'function') {
      emit({
        type: 'actions',
        source,
        actions,
        results: [],
        skipped: 'no runner',
        turn: turn.id,
      });
      return [];
    }
    const results = [];
    for (const action of actions) {
      if (turn.controller.signal.aborted) break;
      try {
        const result = await runMapAction(action.name, action.args, {
          signal: turn.controller.signal,
          source,
          origin: 'voice',
        });
        results.push({ name: action.name, ok: result?.ok !== false, result });
      } catch (error) {
        results.push({
          name: action.name,
          ok: false,
          error: error?.message || String(error),
        });
      }
    }
    emit({ type: 'actions', source, actions, results, turn: turn.id });
    return results;
  }

  function runWorkflowFor(turn) {
    abandonWorkflow();
    turn.workflowController = new AbortController();
    pendingWorkflow = turn.workflowController;
    const signal = turn.workflowController.signal;
    const t0 = now();
    const release = () => {
      if (pendingWorkflow === turn.workflowController) pendingWorkflow = null;
    };
    emit({ type: 'workflow', phase: 'executing', turn: turn.id });
    return transport
      .runWorkflow({
        signal,
        timeoutMs: workflowTimeoutMs,
        onLog: (log) =>
          emit({ type: 'workflow', phase: 'log', log, turn: turn.id }),
        onStatus: (status) =>
          emit({ type: 'workflow', phase: 'status', ...status, turn: turn.id }),
      })
      .then(async (result) => {
        release();
        turn.metrics.workflow = {
          executionId: result.executionId,
          status: result.status,
          ok: result.ok,
          timeToFirstLogMs: result.timeToFirstLogMs,
          totalMs: result.totalMs,
          polls: result.polls,
          logCount: result.logs.length,
          actionCount: result.mapActions.length,
          error: result.error,
        };
        emit({
          type: 'workflow',
          phase: 'done',
          ...turn.metrics.workflow,
          message: result.message,
          turn: turn.id,
        });
        if (
          result.mapActions.length &&
          !signal.aborted &&
          !turn.controller.signal.aborted
        ) {
          await dispatch(turn, result.mapActions, 'workflow');
        }
        return result;
      })
      .catch((error) => {
        release();
        if (isAbort(error)) {
          emit({
            type: 'workflow',
            phase: 'abandoned',
            elapsedMs: now() - t0,
            turn: turn.id,
          });
          turn.metrics.workflow = { status: 'abandoned', totalMs: now() - t0 };
          return null;
        }
        turn.metrics.workflow = {
          status: 'failed',
          error: error?.message || String(error),
          httpStatus: error?.status ?? null,
        };
        emit({
          type: 'workflow',
          phase: 'failed',
          ...turn.metrics.workflow,
          turn: turn.id,
        });
        return null;
      });
  }

  function partialDisplay(text) {
    return text.replace(/\n?\s*MAPACTIONS?\s*:[\s\S]*$/i, '').trim();
  }

  async function runTurn(turn) {
    const { transcript } = turn;
    const signal = turn.controller.signal;
    emit({ type: 'transcript', text: transcript, turn: turn.id });

    // 1. Local fast path — before any network call, works without OnDemand.
    const intents = matchLayerIntents(transcript);
    const localResults = await applyLocalIntents(turn, intents);
    if (signal.aborted || activeTurn !== turn) return;

    // 2. Route.
    const route = turn.mode === 'auto' ? classify(transcript) : turn.mode;
    turn.route = route;
    setState(
      'thinking',
      route === 'workflow' ? 'OnDemand workflow + chat…' : 'OnDemand chat…',
    );
    emit({ type: 'route', route, turn: turn.id });

    // 3. Workflow trigger runs alongside (execute is input-less per §7.1).
    const workflowPromise =
      route === 'workflow' && workflowEnabled ? runWorkflowFor(turn) : null;

    // 4. Chat answer (streams deltas).
    let answer = '';
    let chatError = null;
    const tChat = now();
    try {
      const session = await ensureSession(signal);
      const context = await buildContext();
      const query = composeQuery(transcript, context, { localResults, route });
      const result = await transport.chatStream({
        sessionId: session.sessionId,
        query,
        signal,
        onDelta: (text) =>
          emit({
            type: 'answer',
            text: partialDisplay(text),
            partial: true,
            source: 'chat',
            turn: turn.id,
          }),
        onStatus: (log) => emit({ type: 'status-log', log, turn: turn.id }),
      });
      answer = result.text;
      turn.metrics.chatMs = now() - tChat;
      turn.metrics.chatFirstDeltaMs = result.firstDeltaMs;
      turn.metrics.chatMessageId = result.messageId;
    } catch (error) {
      if (isAbort(error) || activeTurn !== turn) return;
      chatError = error;
      turn.metrics.chatError = error?.message || String(error);
      turn.metrics.chatErrorStatus = error?.status ?? null;
    }
    if (signal.aborted || activeTurn !== turn) return;

    // 5. Answer text + MapActions.
    let { text: spoken, mapActions } = extractMapActions(answer);
    let source = 'chat';
    if (chatError) {
      if (workflowPromise)
        setState(
          'thinking',
          `Chat failed (${chatError.message}) — waiting for workflow…`,
        );
      const workflowResult = workflowPromise ? await workflowPromise : null;
      if (signal.aborted || activeTurn !== turn) return;
      if (workflowResult?.ok && workflowResult.message) {
        spoken = workflowResult.message;
        source = 'workflow';
      } else if (intents.length) {
        spoken = localConfirmation(intents, {
          failed: localResults.filter((r) => !r.ok),
        });
        source = 'local';
      } else {
        setState('error', chatError.message);
        emit({
          type: 'error',
          message: chatError.message,
          status: chatError.status ?? null,
          turn: turn.id,
        });
        activeTurn = null;
        return;
      }
    }
    if (!spoken && mapActions.length) spoken = 'Done.';
    emit({
      type: 'answer',
      text: spoken,
      partial: false,
      source,
      reason: chatError ? chatError.message : null,
      turn: turn.id,
    });
    if (mapActions.length)
      await dispatch(turn, normalizeMapActions(mapActions), 'chat');
    if (signal.aborted || activeTurn !== turn) return;

    // 6. Speak.
    await speak(turn, spoken, chatError ? chatError.message : null);
    if (signal.aborted || activeTurn !== turn) return;
    history.push({ transcript, answer: spoken, route, metrics: turn.metrics });
    if (history.length > 20) history.shift();
    activeTurn = null;
    setState(
      'idle',
      chatError ? `Answered locally — ${chatError.message}` : summarize(turn),
    );
    emit({ type: 'metrics', metrics: turn.metrics, turn: turn.id });
  }

  function summarize(turn) {
    const parts = [];
    if (Number.isFinite(turn.metrics.sttMs))
      parts.push(`stt ${turn.metrics.sttMs} ms`);
    if (Number.isFinite(turn.metrics.chatFirstDeltaMs))
      parts.push(`first delta ${turn.metrics.chatFirstDeltaMs} ms`);
    if (Number.isFinite(turn.metrics.ttsMs))
      parts.push(`tts ${turn.metrics.ttsMs} ms`);
    const wf = turn.metrics.workflow;
    if (wf?.status) {
      parts.push(
        `workflow ${wf.status}${Number.isFinite(wf.timeToFirstLogMs) ? ` · first log ${wf.timeToFirstLogMs} ms` : ''}`,
      );
    } else if (turn.route === 'workflow' && workflowEnabled)
      parts.push('workflow running…');
    return parts.join(' · ') || 'Ready';
  }

  // ---- speaking ------------------------------------------------------------

  async function speak(turn, text, reason) {
    if (!text) return;
    const signal = turn.controller.signal;
    setState('speaking', reason ? `Speaking (local) — ${reason}` : 'Speaking…');
    stopMonitor();
    if (typeof recorder.monitor === 'function') {
      try {
        monitor = await recorder.monitor({
          onSpeech: () => {
            if (activeTurn === turn && state === 'speaking')
              void bargeIn('voice');
          },
        });
      } catch {
        monitor = null;
      }
    }
    if (signal.aborted || activeTurn !== turn) {
      stopMonitor();
      return;
    }
    try {
      const t0 = now();
      const source = await transport.synthesize(text, { voice, signal });
      turn.metrics.ttsMs = now() - t0;
      if (signal.aborted || activeTurn !== turn) return;
      const tPlay = now();
      const outcome = await player.play(source, { signal });
      turn.metrics.playbackMs = now() - tPlay;
      turn.metrics.interrupted = Boolean(outcome?.interrupted);
    } catch (error) {
      if (isAbort(error) || activeTurn !== turn) return;
      turn.metrics.ttsError = error?.message || String(error);
      emit({
        type: 'tts-unavailable',
        message: turn.metrics.ttsError,
        status: error?.status ?? null,
        turn: turn.id,
      });
    } finally {
      if (activeTurn === turn) stopMonitor();
    }
  }

  async function bargeIn(origin = 'button') {
    const turn = activeTurn;
    if (!turn || state !== 'speaking') return null;
    turn.metrics.bargeIn = origin;
    emit({ type: 'barge-in', origin, turn: turn.id });
    player.stop();
    stopMonitor();
    return startListening(`barge-in:${origin}`);
  }

  // ---- public surface ------------------------------------------------------

  function cancel(reason = 'Cancelled') {
    const turn = activeTurn;
    clearMaxTimer();
    pendingStop = null;
    const active = capture;
    capture = null;
    void active?.cancel?.();
    player.stop();
    stopMonitor();
    abandonTurn(turn);
    activeTurn = null;
    if (state !== 'idle') setState('idle', reason);
  }

  /**
   * One press of the OD VOICE button. Returns the action taken.
   * @returns {Promise<'listen'|'send'|'cancel'|'barge-in'|'noop'>}
   */
  async function press() {
    if (disposed) return 'noop';
    switch (state) {
      case 'idle':
      case 'error':
        await startListening('button');
        return 'listen';
      case 'listening':
        void stopListening('manual');
        return 'send';
      case 'transcribing':
      case 'thinking':
        cancel('Cancelled');
        return 'cancel';
      case 'speaking':
        await bargeIn('button');
        return 'barge-in';
      default:
        return 'noop';
    }
  }

  /** Run a turn from typed text (skips listening/transcribing). */
  async function submitText(text, { mode: turnMode } = {}) {
    if (disposed) return null;
    const transcript = String(text || '').trim();
    if (!transcript) return null;
    abandonTurn(activeTurn);
    player.stop();
    stopMonitor();
    clearMaxTimer();
    const active = capture;
    capture = null;
    void active?.cancel?.();
    const turn = newTurn('text');
    if (MODES.includes(turnMode)) turn.mode = turnMode;
    turn.transcript = transcript;
    activeTurn = turn;
    await runTurn(turn);
    return turn;
  }

  return {
    press,
    startListening,
    stopListening,
    bargeIn,
    submitText,
    cancel,
    subscribe(listener) {
      if (typeof listener !== 'function') return () => {};
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getState: () => state,
    getDetail: () => detail,
    getMode: () => currentMode,
    setMode(next) {
      if (MODES.includes(next)) {
        currentMode = next;
        emit({ type: 'mode', mode: next });
      }
      return currentMode;
    },
    getHistory: () => history.slice(),
    getActiveTurn: () => activeTurn,
    /** Which state the button press would act on right now. */
    get busy() {
      return state !== 'idle' && state !== 'error';
    },
    dispose() {
      cancel('Disposed');
      disposed = true;
      listeners.clear();
    },
  };
}
