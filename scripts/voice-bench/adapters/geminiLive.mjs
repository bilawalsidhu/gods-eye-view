/**
 * Gemini Live adapter — BidiGenerateContent over WebSocket.
 *
 * Same prompt as production (system instruction = realtimeInstructions(),
 * tools = GEV_REALTIME_TOOLS as functionDeclarations with the production JSON
 * schema passed verbatim via parametersJsonSchema). The native-audio Live
 * model rejects a TEXT response modality (close 1007), so the session
 * requests AUDIO with output transcription on; tool calls arrive as
 * `toolCall` messages and the transcript stands in for the final words.
 *
 * Fresh session per phrase / dialogue. Each toolCall gets stub
 * `functionResponses`; the model continues on its own. A turn ends at a
 * `turnComplete` whose generation had no toolCall, or after 5 tool rounds
 * (mirrors the Realtime adapter's continuation cap), or 12 s of silence after
 * a tool round.
 */
import WebSocket from 'ws';
import { providerKey } from '../keys.mjs';
import { realtimeInstructions, GEV_REALTIME_TOOLS } from '../productionConfig.mjs';
import { toGeminiDeclarations } from '../toolFormats.mjs';
import { geminiUsageCostUsd } from '../pricing.mjs';
import { newTurnResult } from './openaiRealtime.mjs';

const ENDPOINT = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';
const MAX_TOOL_ROUNDS = 5;
const IDLE_AFTER_TOOL_MS = 12_000;

export function createGeminiLiveAdapter({ model, schemaMode = 'jsonSchema', turnTimeoutMs = 60_000 }) {
  const instructions = realtimeInstructions();
  const functionDeclarations = toGeminiDeclarations(GEV_REALTIME_TOOLS, { mode: schemaMode });
  const adapter = {
    provider: 'gemini-live',
    model,
    settings: {
      responseModalities: ['AUDIO'],
      outputAudioTranscription: true,
      schemaMode,
      temperature: 'server default (not set; production has no Gemini config)',
      thinking: 'server default',
      input: 'realtimeInput.text',
      context: 'fresh session per phrase / dialogue',
    },
    async open() {},
    async close() {},
    async runTurn({ text, onCall, context }) {
      return (await adapter.runDialogue({ turns: [text], onCall, contexts: [context] }))[0];
    },
    runDialogue({ turns, onCall, contexts = [] }) {
      return new Promise((resolveAll) => {
        const tSetup = Date.now();
        const ws = new WebSocket(`${ENDPOINT}?key=${providerKey('gemini')}`);
        const results = [];
        let setupMs = null;
        let cur = null;
        let closed = false;
        const send = (o) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(o)); };
        const shutdown = (error) => {
          if (closed) return;
          closed = true;
          if (cur) {
            clearTimeout(cur.timer);
            clearTimeout(cur.idle);
            if (error) cur.r.errors.push(error);
            if (cur.r.tDoneMs === null) cur.r.tDoneMs = Date.now() - cur.t0;
            results.push(cur.r);
            cur = null;
          }
          while (results.length < turns.length) {
            const r = newTurnResult();
            r.errors.push(error || 'dialogue aborted');
            results.push(r);
          }
          try { ws.terminate(); } catch { /* noop */ }
          resolveAll(results);
        };
        const startTurn = (turn) => {
          const r = newTurnResult();
          r.setupMs = turn === 0 ? setupMs : 0;
          cur = { r, t0: Date.now(), turn, toolRounds: 0, toolCallThisGeneration: false, idle: null };
          cur.timer = setTimeout(() => { cur.r.timeout = true; endTurn(); }, turnTimeoutMs);
          // Live has no system-role mid-session item; a context item (pointer_context)
          // rides as a JSON line ahead of the user's words in the same text turn.
          const ctx = contexts[turn] ? `${JSON.stringify(contexts[turn])}\n` : '';
          send({ realtimeInput: { text: `${ctx}${turns[turn]}` } });
        };
        const endTurn = () => {
          if (!cur) return;
          clearTimeout(cur.timer);
          clearTimeout(cur.idle);
          if (cur.r.tDoneMs === null) cur.r.tDoneMs = Date.now() - cur.t0;
          results.push(cur.r);
          const next = cur.turn + 1;
          const timedOut = cur.r.timeout;
          cur = null;
          if (next < turns.length && !timedOut) startTurn(next);
          else shutdown();
        };
        const mark = (key) => { if (cur && cur.r[key] === null) cur.r[key] = Date.now() - cur.t0; };

        ws.on('open', () => {
          send({
            setup: {
              model: `models/${model}`,
              generationConfig: { responseModalities: ['AUDIO'] },
              systemInstruction: { parts: [{ text: instructions }] },
              tools: [{ functionDeclarations }],
              outputAudioTranscription: {},
            },
          });
        });
        ws.on('unexpected-response', (_req, res) => shutdown(`HTTP ${res.statusCode}`));
        ws.on('error', (e) => shutdown(`ws: ${e.message}`));
        ws.on('close', (code, reason) => {
          shutdown(results.length < turns.length ? `close ${code}: ${reason.toString().slice(0, 200)}` : undefined);
        });
        ws.on('message', (raw) => {
          let m;
          try { m = JSON.parse(raw.toString()); } catch { return; }
          if (m.setupComplete) {
            if (setupMs === null) {
              setupMs = Date.now() - tSetup;
              startTurn(0);
            }
            return;
          }
          if (!cur) return;
          clearTimeout(cur.idle);
          const r = cur.r;
          const lastAt = Date.now();
          const sc = m.serverContent;
          if (sc?.modelTurn?.parts?.length) {
            mark('tFirstTokenMs');
            for (const p of sc.modelTurn.parts) if (typeof p.text === 'string' && !p.thought) r.text += p.text;
          }
          if (sc?.outputTranscription?.text) {
            mark('tFirstTokenMs');
            r.text += sc.outputTranscription.text;
          }
          if (m.toolCall?.functionCalls?.length) {
            mark('tFirstTokenMs');
            mark('tFirstCallMs');
            cur.toolCallThisGeneration = true;
            cur.toolRounds += 1;
            const functionResponses = m.toolCall.functionCalls.map((fc) => {
              const c = { name: fc.name, args: fc.args || {}, atMs: Date.now() - cur.t0 };
              r.calls.push(c);
              return { id: fc.id, name: fc.name, response: onCall(c, cur.turn) };
            });
            send({ toolResponse: { functionResponses } });
          }
          if (m.usageMetadata) {
            const u = m.usageMetadata;
            r.usage.inputTokens += u.promptTokenCount || 0;
            r.usage.cachedTokens += u.cachedContentTokenCount || 0;
            r.usage.outputTokens += u.responseTokenCount || 0;
            r.usage.reasoningTokens += u.thoughtsTokenCount || 0;
            r.costUsd += geminiUsageCostUsd(model, u);
          }
          if (m.goAway) r.errors.push('goAway');
          if (sc?.turnComplete) {
            r.responses += 1;
            if (cur.toolCallThisGeneration && cur.toolRounds < MAX_TOOL_ROUNDS) {
              cur.toolCallThisGeneration = false;
              if (r.text && !r.text.endsWith(' | ')) r.text += ' | ';
              // The follow-up generation normally starts within a second; if
              // the model has nothing more to say, end the turn at its last
              // message rather than charging the wait to its latency.
              const c = cur;
              c.idle = setTimeout(() => { if (cur === c) { c.r.tDoneMs = lastAt - c.t0; endTurn(); } }, IDLE_AFTER_TOOL_MS);
              return;
            }
            endTurn();
          }
        });
      });
    },
  };
  return adapter;
}
