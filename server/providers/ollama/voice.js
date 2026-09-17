import { WebSocketServer } from 'ws';
import { randomUUID } from 'node:crypto';
import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { GEV_REALTIME_TOOLS } from '../openai/tools.js';
import { realtimeInstructions } from '../openai/instructions.js';
import { sharedAudioWorker } from './worker.js';
import { streamChat } from './chat.js';
import { createSentenceSplitter, stripMarkdown } from './sentences.js';
import { trimHistory } from './history.js';
import {
  deterministicFlyTo,
  deterministicRemember,
  deterministicConfirmation,
} from './fastPath.js';
import {
  LOCAL_TOOL_SCHEMAS,
  LOCAL_TOOL_TIMEOUTS,
} from '../../../src/voice/localToolSchemas.js';
import { answerVisually } from './vision.js';
import { applyMemoryContext, speakNotice } from './sessionExtras.js';
import { sharedRemoteHub } from './remote.js';
import { identifySpeaker } from './speaker.js';
import { isTrustedOrigin, rejectUpgrade } from './origin.js';

/**
 * Local voice WebSocket: one connection per mic session. The browser sends
 * one 16 kHz WAV utterance per binary frame followed by {type:'audio_end'};
 * the server answers with transcript, tool_call (awaiting tool_result),
 * streamed audio_chunk frames, text and audio_end. Every turn runs the full
 * tool set through Ollama except a bare "fly to <preset city>", which is
 * answered deterministically without a model round trip.
 */
export const MAX_TOOL_ROUNDS = 4;
export const TOOL_RESULT_TIMEOUT_MS = 10_000;
const MAX_UTTERANCE_BYTES = 2 * 1024 * 1024;

const tools = [...GEV_REALTIME_TOOLS, ...LOCAL_TOOL_SCHEMAS].map(
  ({ name, description, parameters }) => ({
    type: 'function',
    function: { name, description, parameters },
  }),
);
const locationIds =
  GEV_REALTIME_TOOLS.find((tool) => tool.name === 'fly_to_location')?.parameters
    ?.properties?.locationId?.enum || [];

let logChain = Promise.resolve();
function logLocalVoice(event, payload = {}) {
  const dir = join(process.cwd(), '.gev-logs');
  const line = `${JSON.stringify({ loggedAt: new Date().toISOString(), event, ...payload })}\n`;
  logChain = logChain
    .then(() => mkdir(dir, { recursive: true }))
    .then(() => appendFile(join(dir, 'local-voice.jsonl'), line))
    .catch(() => {});
}

const LANGUAGE_NAMES = {
  en: 'English',
  es: 'Spanish',
  fr: 'French',
  de: 'German',
  it: 'Italian',
  pt: 'Portuguese',
  nl: 'Dutch',
  ja: 'Japanese',
  zh: 'Chinese',
  ko: 'Korean',
  ru: 'Russian',
  ar: 'Arabic',
  hi: 'Hindi',
};

function languageName(code) {
  return LANGUAGE_NAMES[code] || code;
}

function voiceModel() {
  return process.env.OLLAMA_VOICE_MODEL || 'qwen3:8b';
}

/**
 * Load the voice model with the full prompt once at server start so the first
 * spoken command does not pay model load plus a 12k-token prompt evaluation.
 */
let warmPromise = null;
export function warmVoiceModel({ chat = streamChat } = {}) {
  if (warmPromise) return warmPromise;
  const started = Date.now();
  warmPromise = chat({
    model: voiceModel(),
    messages: [
      { role: 'system', content: realtimeInstructions() },
      { role: 'user', content: 'Say ready.' },
    ],
    tools,
    options: { num_predict: 4 },
  })
    .then((reply) =>
      logLocalVoice('model.warm', {
        model: voiceModel(),
        ms: Date.now() - started,
        promptEvalCount: reply.promptEvalCount,
      }),
    )
    .catch((error) =>
      logLocalVoice('model.warm_failed', {
        model: voiceModel(),
        error: error?.message,
      }),
    );
  return warmPromise;
}

/** Run one conversational turn for a session; resolves when speech is queued. */
export async function runTurn(session, text, deps) {
  const { send, worker, chat = streamChat, log = () => {} } = deps;
  const turnId = randomUUID();
  const turnAbort = new AbortController();
  session.turnAbort = turnAbort;
  const onClose = () => turnAbort.abort();
  session.closeSignal.addEventListener('abort', onClose, { once: true });
  const speech = createSpeechQueue({
    session,
    turnId,
    worker,
    send,
    signal: turnAbort.signal,
    log,
  });
  const spoken = String(text).slice(0, 4000);
  session.messages.push({
    role: 'user',
    content:
      session.language && session.language !== 'en'
        ? `${spoken}

(The user spoke ${languageName(session.language)}; reply in that language.)`
        : spoken,
  });
  let content = '';
  let rounds = 0;
  let calls = null;
  let visionAnswered = false;
  const fast =
    deterministicFlyTo(text, { locationIds }) || deterministicRemember(text);
  if (fast) {
    log('turn.fast_path', { turnId, text, call: fast });
    calls = [{ function: fast }];
  }
  try {
    for (;;) {
      if (turnAbort.signal.aborted) return;
      if (fast && rounds === 1 && !calls) {
        // The deterministic command already ran; confirm it without a model
        // round trip using the tool result.
        let toolResult = null;
        try {
          toolResult = JSON.parse(session.messages.at(-1)?.content || 'null');
        } catch {
          /* keep null */
        }
        content = deterministicConfirmation(fast, toolResult);
        speech.enqueue(content);
        break;
      }
      if (!calls) {
        const splitter = createSentenceSplitter();
        send({ type: 'thinking', turnId });
        const reply = await chat({
          model: voiceModel(),
          messages: trimHistory(session.messages),
          tools,
          signal: turnAbort.signal,
          onToken: (delta) => {
            content += delta;
            for (const sentence of splitter.push(delta))
              speech.enqueue(sentence);
          },
        });
        log('turn.model', {
          turnId,
          promptEvalCount: reply.promptEvalCount,
          evalCount: reply.evalCount,
          totalDurationMs: reply.totalDurationMs,
          toolCalls: reply.toolCalls.map((call) => call.function?.name),
        });
        if (reply.toolCalls.length) {
          // Text emitted before a tool call is pre-amble; do not narrate it.
          speech.discardUnspoken();
          content = '';
          calls = reply.toolCalls;
        } else {
          for (const sentence of splitter.flush()) speech.enqueue(sentence);
          break;
        }
      }
      if (++rounds > MAX_TOOL_ROUNDS) {
        content = 'Stopped after too many tool calls.';
        speech.enqueue(content);
        send({
          type: 'error',
          error: 'Tool loop limit reached',
          terminal: false,
        });
        break;
      }
      for (const call of calls) {
        const name = call.function?.name;
        const args = call.function?.arguments || {};
        const callId = randomUUID();
        log('tool_call', { turnId, callId, name, arguments: args });
        send({ type: 'tool_call', callId, turnId, name, arguments: args });
        const result = await awaitToolResult(
          session,
          callId,
          turnAbort.signal,
          LOCAL_TOOL_TIMEOUTS[name] || TOOL_RESULT_TIMEOUT_MS,
        );
        log('tool_result', { turnId, callId, ok: result?.ok !== false });
        if (name === 'ask_about_view' && result?.vision && result?.image) {
          const { image, ...rest } = result;
          session.messages.push(
            { role: 'assistant', tool_calls: [call] },
            {
              role: 'tool',
              name,
              content: JSON.stringify(rest).slice(0, 2000),
            },
          );
          content = await answerVisually(
            { question: result.question, image, context: result.context },
            { speech, signal: turnAbort.signal, chat, log },
          );
          visionAnswered = true;
          break;
        }
        session.messages.push(
          { role: 'assistant', tool_calls: [call] },
          {
            role: 'tool',
            name,
            content: JSON.stringify(result ?? { ok: false }).slice(0, 4000),
          },
        );
      }
      calls = null;
      if (visionAnswered) break;
    }
    if (turnAbort.signal.aborted) return;
    content = stripMarkdown(content);
    session.messages.push({ role: 'assistant', content });
    send({ type: 'text', turnId, text: content });
    await speech.finish();
  } catch (error) {
    if (turnAbort.signal.aborted) return;
    log('turn.error', { turnId, error: error?.message });
    speech.discardUnspoken();
    send({
      type: 'error',
      turnId,
      error: error?.message || 'Local voice turn failed',
      terminal: false,
    });
  } finally {
    session.closeSignal.removeEventListener('abort', onClose);
    if (session.turnAbort === turnAbort) session.turnAbort = null;
  }
}

function awaitToolResult(
  session,
  callId,
  signal,
  timeoutMs = TOOL_RESULT_TIMEOUT_MS,
) {
  return new Promise((resolve) => {
    const finish = (value) => {
      clearTimeout(timer);
      session.pending.delete(callId);
      signal.removeEventListener('abort', onAbort);
      resolve(value);
    };
    const timer = setTimeout(
      () => finish({ ok: false, error: 'Tool result timed out' }),
      timeoutMs,
    );
    const onAbort = () => finish({ ok: false, error: 'Session closed' });
    signal.addEventListener('abort', onAbort, { once: true });
    session.pending.set(callId, finish);
  });
}

/** Sentence FIFO -> Piper -> ordered audio_chunk frames for one turn. */
export function createSpeechQueue({
  session,
  turnId,
  worker,
  send,
  signal,
  log,
}) {
  const enabled = worker?.health?.().tts === 'piper';
  const queue = [];
  let seq = 0;
  let running = null;
  let discarded = false;
  async function drain() {
    while (queue.length && !signal?.aborted) {
      const sentence = queue.shift();
      try {
        await worker.synthesize(sentence, {
          language: session.language,
          onChunk: (chunk) => {
            if (signal?.aborted || discarded) return;
            send({
              type: 'audio_chunk',
              turnId,
              seq: seq++,
              sampleRate: chunk.sampleRate,
              pcm16: chunk.pcm16,
              text: sentence,
            });
          },
        });
      } catch (error) {
        log?.('tts.error', { turnId, error: error?.message });
        return;
      }
    }
  }
  return {
    enqueue(sentence) {
      const clean = stripMarkdown(sentence);
      if (!enabled || !clean || signal?.aborted) return;
      discarded = false;
      queue.push(clean);
      if (!running) running = drain().finally(() => (running = null));
    },
    discardUnspoken() {
      queue.length = 0;
      discarded = true;
    },
    async finish() {
      if (running) await running;
      if (!signal?.aborted) send({ type: 'audio_end', turnId, chunks: seq });
      session.lastTurnChunks = seq;
    },
  };
}

function isWebm(bytes) {
  return (
    bytes.length >= 4 &&
    bytes[0] === 0x1a &&
    bytes[1] === 0x45 &&
    bytes[2] === 0xdf &&
    bytes[3] === 0xa3
  );
}

function isWav(bytes) {
  return bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF';
}

export function attachVoiceWebSocket(
  server,
  path = process.env.VOICE_WS_PATH || '/api/voice/ws',
  {
    worker = sharedAudioWorker({ log: logLocalVoice }),
    chat,
    warmModel = true,
  } = {},
) {
  const httpServer = server?.httpServer;
  // Preview servers and unit tests install the routes without an HTTP server;
  // only a real server pays for a Whisper process and a model load.
  if (!httpServer) return null;
  worker
    .ensureStarted()
    .catch((error) =>
      logLocalVoice('worker.start_failed', { error: error?.message }),
    );
  if (warmModel) void warmVoiceModel();
  // Companion remotes (remote.html, server/providers/ollama/remote.js) mirror
  // this session's text frames and may inject commands; audio never leaves.
  const hub = sharedRemoteHub();
  const marker = '__gevVoiceUpgrade';
  if (httpServer[marker]) httpServer.off('upgrade', httpServer[marker]);
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_UTTERANCE_BYTES,
  });
  const onUpgrade = (request, socket, head) => {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname !== path) return;
    if (!isTrustedOrigin(request)) return rejectUpgrade(socket);
    wss.handleUpgrade(request, socket, head, (ws) =>
      wss.emit('connection', ws, request),
    );
  };
  httpServer[marker] = onUpgrade;
  httpServer.on('upgrade', onUpgrade);

  wss.on('connection', async (ws) => {
    const closeController = new AbortController();
    const session = {
      id: randomUUID(),
      messages: [{ role: 'system', content: realtimeInstructions() }],
      pending: new Map(),
      turnAbort: null,
      language: null,
      turns: Promise.resolve(),
      closeSignal: closeController.signal,
    };
    let audio = Buffer.alloc(0);
    const send = (payload) => {
      if (ws.readyState !== ws.OPEN) return false;
      ws.send(JSON.stringify(payload));
      // Remote hub: text frames only (publish drops audio_chunk itself).
      hub.publish(session.id, payload);
      return true;
    };
    logLocalVoice('session.open', { sessionId: session.id });
    let health;
    try {
      health = await worker.ensureStarted();
    } catch (error) {
      send({
        type: 'error',
        error: `Audio worker unavailable: ${error?.message || error}`,
        terminal: true,
      });
      ws.close(1011, 'audio worker unavailable');
      return;
    }
    send({
      type: 'ready',
      protocol: 'ollama-local',
      tools: tools.length,
      model: voiceModel(),
      ...health,
    });

    const enqueueTurn = (run) => {
      session.turns = session.turns.then(run).catch(() => {});
      return session.turns;
    };

    const handleUtterance = async (bytes) => {
      if (isWebm(bytes)) {
        send({
          type: 'error',
          error: 'Send 16 kHz WAV utterances (WebM is no longer accepted)',
          terminal: false,
        });
        return;
      }
      if (!isWav(bytes)) {
        send({
          type: 'error',
          error: 'Unrecognized audio frame',
          terminal: false,
        });
        return;
      }
      let transcript;
      try {
        transcript = await worker.transcribe(bytes, {
          language: process.env.WHISPER_LANGUAGE,
        });
      } catch (error) {
        logLocalVoice('transcribe.error', { error: error?.message });
        send({
          type: 'error',
          error: `Transcription failed: ${error?.message || error}`,
          terminal: !worker.running,
        });
        return;
      }
      if (
        transcript.language &&
        (transcript.languageProbability ?? 1) >= 0.6 &&
        transcript.text
      )
        session.language = String(transcript.language).toLowerCase();
      logLocalVoice('transcript', {
        sessionId: session.id,
        language: transcript.language,
        text: transcript.text,
        sttMs: transcript.sttMs,
        durationMs: transcript.durationMs,
        device: health?.device,
      });
      // Speaker identity hook (server/providers/ollama/speaker.js): keeps the
      // last few utterance WAVs on session.recentUtterances for enrollment and
      // tags the transcript with the matched voice profile {name, score}|null.
      const speaker = transcript.text
        ? await identifySpeaker(worker, bytes, session)
        : null;
      send({
        type: 'transcript',
        text: transcript.text,
        noSpeech: Boolean(transcript.noSpeech),
        language: transcript.language,
        durationMs: transcript.durationMs,
        sttMs: transcript.sttMs,
        speaker,
      });
      if (!transcript.text) return;
      await runTurn(session, transcript.text, {
        send,
        worker,
        chat,
        log: (event, payload) =>
          logLocalVoice(event, { sessionId: session.id, ...payload }),
      });
    };

    // Remote hub: let companion pages drive this session with the same
    // turn queue the browser uses; audio_end from a remote is a WAV utterance.
    // Peer federation (peers.js): speak "From <peer>" alerts; relay places.
    const speech = { send, worker, createSpeechQueue };
    hub.registerSession(session.id, {
      sendText: (text) =>
        enqueueTurn(() =>
          runTurn(session, text, {
            send,
            worker,
            chat,
            log: (name, payload) =>
              logLocalVoice(name, { sessionId: session.id, ...payload }),
          }),
        ),
      interrupt: () => session.turnAbort?.abort(),
      sendUtterance: (bytes) => enqueueTurn(() => handleUtterance(bytes)),
      notify: (text, extra) =>
        enqueueTurn(() => speakNotice(session, text, { ...extra, ...speech })),
      deliver: (frame) => send(frame),
    });

    ws.on('message', (raw, isBinary) => {
      if (isBinary) {
        if (audio.length + raw.length > MAX_UTTERANCE_BYTES) {
          audio = Buffer.alloc(0);
          send({ type: 'error', error: 'Utterance too long', terminal: false });
          return;
        }
        audio = Buffer.concat([audio, raw]);
        return;
      }
      let event;
      try {
        event = JSON.parse(raw.toString());
      } catch {
        send({ type: 'error', error: 'Invalid JSON', terminal: false });
        return;
      }
      if (event.type === 'tool_result') {
        session.pending.get(event.callId)?.(event.result);
        return;
      }
      if (event.type === 'audio_end') {
        const bytes = audio;
        audio = Buffer.alloc(0);
        if (bytes.length) void enqueueTurn(() => handleUtterance(bytes));
        return;
      }
      if (event.type === 'text') {
        const text = String(event.text || '').trim();
        if (text)
          void enqueueTurn(() =>
            runTurn(session, text, {
              send,
              worker,
              chat,
              log: (name, payload) =>
                logLocalVoice(name, { sessionId: session.id, ...payload }),
            }),
          );
        return;
      }
      if (event.type === 'interrupt') {
        session.turnAbort?.abort();
        return;
      }
      if (event.type === 'context') {
        applyMemoryContext(session, event);
        return;
      }
      if (event.type === 'notify') {
        const text = String(event.text || '')
          .trim()
          .slice(0, 400);
        if (text)
          void enqueueTurn(() =>
            speakNotice(session, text, {
              send,
              worker,
              createSpeechQueue,
              // share:false (share_alerts off, or an info notice) tags the
              // notice as already travelled so peers.js never forwards it.
              origin: event.share === false ? 'local' : null,
              kind: event.kind === 'info' ? 'info' : 'alert',
              log: (name, payload) =>
                logLocalVoice(name, { sessionId: session.id, ...payload }),
            }),
          );
        return;
      }
      // map_event and unknown frames are accepted and ignored.
    });
    ws.on('close', (code, reason) => {
      logLocalVoice('session.close', {
        sessionId: session.id,
        code,
        reason: String(reason || ''),
      });
      closeController.abort();
      session.turnAbort?.abort();
      hub.unregisterSession(session.id); // Remote hub: tell companions.
      for (const finish of session.pending.values())
        finish({ ok: false, error: 'Session closed' });
      session.pending.clear();
    });
  });
  return wss;
}

export { tools as OLLAMA_TOOLS };
