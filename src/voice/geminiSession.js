import { createGeminiAudio } from './geminiAudio.js';
import { geminiFunctionResponse } from './geminiTools.js';

const GEMINI_WS_ORIGIN = 'wss://generativelanguage.googleapis.com';
const SETUP_TIMEOUT_MS = 15_000;
const SILENCE_NOTICE_MS = 6_000;
const AUDIBLE_PEAK = 0.01;

/** Request a server-minted, setup-locked Gemini Live token. */
export async function requestGeminiToken({
  endpoint = '/api/gemini/token',
  fetchImpl = (...args) => fetch(...args),
  signal,
} = {}) {
  const response = await fetchImpl(endpoint, {
    signal,
    cache: 'no-store',
    redirect: 'error',
  });
  const data = await response.json().catch(() => null);
  if (!response.ok)
    throw new Error(
      data?.error || `Gemini token failed: HTTP ${response.status}`,
    );
  if (typeof data?.token !== 'string' || !data.token || !data.setup)
    throw new Error('Gemini token response was incomplete');
  return data;
}

/** The constrained Live endpoint that accepts an ephemeral token. */
export function geminiLiveUrl({ token, apiVersion = 'v1beta' }) {
  const version = /^v1(alpha|beta)?$/.test(apiVersion) ? apiVersion : 'v1beta';
  return `${GEMINI_WS_ORIGIN}/ws/google.ai.generativelanguage.${version}.GenerativeService.BidiGenerateContentConstrained?access_token=${encodeURIComponent(token)}`;
}

async function decodeMessage(data) {
  if (typeof data === 'string') return JSON.parse(data);
  if (data instanceof ArrayBuffer)
    return JSON.parse(new TextDecoder().decode(data));
  if (typeof data?.text === 'function') return JSON.parse(await data.text());
  return null;
}

/**
 * Gemini Live adapter for the common voice session: a WebSocket to Google's
 * constrained Live endpoint, 16 kHz microphone input and 24 kHz speech output.
 */
export function createGeminiSession({
  emit,
  runAction,
  signal: lifetime,
  ui,
  requestToken = (options) => requestGeminiToken(options),
  WebSocketImpl = globalThis.WebSocket,
  createAudio = createGeminiAudio,
}) {
  let socket = null;
  let audio = null;
  let epoch = 0;
  let stopping = false;
  let userText = '';
  let assistantText = '';
  let silenceTimer = null;
  const cancelledCalls = new Set();

  const setSpeaker = (speaker) => {
    if (ui?.root) ui.root.dataset.speaker = speaker;
  };
  const send = (message) => {
    if (socket?.readyState !== 1) return false;
    socket.send(JSON.stringify(message));
    return true;
  };

  async function runCalls(calls, current) {
    emit({ type: 'state', state: 'executing', detail: 'Gemini is acting' });
    const functionResponses = [];
    for (const call of calls) {
      if (!current() || cancelledCalls.has(call.id)) continue;
      let result;
      try {
        result = await runAction(call.name, call.args || {});
      } catch (error) {
        if (error?.name === 'AbortError') break;
        result = { ok: false, error: error?.message || 'Action failed' };
      }
      if (cancelledCalls.delete(call.id) || !current()) continue;
      functionResponses.push({
        id: call.id,
        name: call.name,
        response: geminiFunctionResponse(result),
      });
    }
    if (functionResponses.length && current())
      send({ toolResponse: { functionResponses } });
    if (current())
      emit({ type: 'state', state: 'listening', detail: 'Gemini Live' });
  }

  function handleServerContent(content) {
    if (content.interrupted) {
      audio?.flush();
      emit({ type: 'interruption', reason: 'user-speech' });
    }
    for (const part of content.modelTurn?.parts || []) {
      const data = part.inlineData;
      if (data?.data && String(data.mimeType || '').startsWith('audio/'))
        audio?.play(data.data, data.mimeType);
    }
    if (content.inputTranscription?.text) {
      userText += content.inputTranscription.text;
      setSpeaker('user');
    }
    if (content.outputTranscription?.text) {
      assistantText += content.outputTranscription.text;
      emit({
        type: 'transcript',
        role: 'assistant',
        text: content.outputTranscription.text,
        final: false,
      });
    }
    if (content.turnComplete) {
      if (userText.trim())
        emit({ type: 'transcript', role: 'user', text: userText, final: true });
      if (assistantText.trim())
        emit({
          type: 'transcript',
          role: 'assistant',
          text: assistantText,
          final: true,
        });
      userText = assistantText = '';
      emit({ type: 'completion', responseId: null, status: 'completed' });
    }
  }

  return {
    capabilities: { costControls: false, pushToTalk: false },
    async start() {
      const attempt = ++epoch;
      const current = () => attempt === epoch && !lifetime?.aborted;
      stopping = false;
      const credential = await requestToken({ signal: lifetime });
      if (!current()) return;
      const mic = createAudio({ onSpeaker: setSpeaker });
      audio = mic;
      const ws = new WebSocketImpl(geminiLiveUrl(credential));
      socket = ws;
      await new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('Gemini Live did not accept the session')),
          SETUP_TIMEOUT_MS,
        );
        const fail = (reason) => {
          clearTimeout(timer);
          reject(new Error(reason));
        };
        ws.onopen = () => {
          ws.send(JSON.stringify({ setup: credential.setup }));
        };
        ws.onerror = () => fail('Gemini Live connection failed');
        ws.onclose = (event) =>
          fail(
            `Gemini Live closed the session${event?.reason ? `: ${event.reason}` : ''}`,
          );
        ws.onmessage = async (event) => {
          const message = await decodeMessage(event.data).catch(() => null);
          if (!message || !current()) return;
          if (message.setupComplete) {
            clearTimeout(timer);
            resolve();
            return;
          }
          if (message.serverContent) handleServerContent(message.serverContent);
          if (message.toolCallCancellation?.ids)
            for (const id of message.toolCallCancellation.ids)
              cancelledCalls.add(id);
          if (message.toolCall?.functionCalls?.length)
            void runCalls(message.toolCall.functionCalls, current);
          if (message.goAway)
            emit({
              type: 'state',
              state: 'listening',
              detail: 'Gemini session ending soon',
            });
        };
      });
      if (!current()) return;
      ws.onclose = (event) => {
        if (stopping || !current()) return;
        // End this attempt so a pending capture or notice cannot revive it.
        epoch++;
        clearTimeout(silenceTimer);
        audio?.stop();
        emit({
          type: 'state',
          state: 'error',
          detail: `Gemini Live closed the session${event?.reason ? `: ${event.reason}` : ''}`,
        });
      };
      // Name the microphone the browser picked for this site, and say so when
      // it stays silent: the choice is per origin, so a session can connect
      // and still be listening to the wrong device.
      let heard = false;
      let noticed = false;
      let listening = 'Gemini Live';
      let chunks = 0;
      const capture = await audio.startCapture((data, peak = 1) => {
        chunks++;
        if (!heard && peak >= AUDIBLE_PEAK) {
          heard = true;
          if (noticed && current())
            emit({ type: 'state', state: 'listening', detail: listening });
        }
        send({
          realtimeInput: {
            audio: { data, mimeType: 'audio/pcm;rate=16000' },
          },
        });
      });
      if (!current()) {
        // Stopped while the microphone prompt was open: release the capture.
        mic.stop();
        return;
      }
      if (capture?.label) listening = `Gemini Live · ${capture.label}`;
      emit({ type: 'state', state: 'listening', detail: listening });
      silenceTimer = setTimeout(() => {
        if (heard || !current()) return;
        noticed = true;
        const mic = capture?.label || 'the microphone';
        const status = capture?.status?.() || {};
        console.warn('[gemini-voice] no microphone signal', {
          chunks,
          ...status,
        });
        emit({
          type: 'state',
          state: 'listening',
          detail: !chunks
            ? `Microphone capture did not start (${mic})`
            : status.muted
              ? `The browser receives no audio from ${mic}`
              : `No sound yet from ${mic}`,
        });
      }, SILENCE_NOTICE_MS);
      silenceTimer.unref?.();
    },
    stop() {
      epoch++;
      stopping = true;
      clearTimeout(silenceTimer);
      cancelledCalls.clear();
      userText = assistantText = '';
      audio?.stop();
      audio = null;
      try {
        socket?.close(1000);
      } catch {
        /* already closed */
      }
      socket = null;
      setSpeaker('idle');
    },
    sendText(text) {
      return send({
        clientContent: {
          turns: [{ role: 'user', parts: [{ text: String(text) }] }],
          turnComplete: true,
        },
      });
    },
    sendMapEvent(event) {
      return send({
        clientContent: {
          turns: [
            {
              role: 'user',
              parts: [{ text: `[map event] ${JSON.stringify(event)}` }],
            },
          ],
          turnComplete: false,
        },
      });
    },
  };
}
