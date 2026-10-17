/**
 * OpenAI Realtime adapter — text turns over the Realtime WebSocket.
 *
 * Each dialogue (one phrase, or a multi-turn dialogue) opens a FRESH session
 * configured with production's exact session body (captured from the token
 * handler) and sends its user text items one turn at a time. Each turn
 * mirrors qa-voice-routing's loop: every function call gets a stub output, and
 * a continuation response is requested after `response.done` (never while a
 * response is active), up to 4 continuations.
 */
import WebSocket from 'ws';
import { providerKey } from '../keys.mjs';
import { captureProductionSession } from '../productionConfig.mjs';
import { openAiUsageCostUsd } from '../pricing.mjs';

const MAX_CONTINUATIONS = 4;

export function newTurnResult() {
  return {
    calls: [], text: '', errors: [], responses: 0,
    usage: { inputTokens: 0, cachedTokens: 0, outputTokens: 0, reasoningTokens: 0 },
    costUsd: 0, tFirstTokenMs: null, tFirstCallMs: null, tDoneMs: null, setupMs: null, timeout: false,
  };
}

export function createOpenAiRealtimeAdapter({ model, turnTimeoutMs = 45_000 }) {
  let session = null;
  const adapter = {
    provider: 'openai-realtime',
    model,
    settings: {},
    async open() {
      session = await captureProductionSession(model);
      adapter.settings = {
        reasoning: session.reasoning,
        truncation: session.truncation,
        tool_choice: session.tool_choice,
        temperature: 'not settable (GA Realtime session has no temperature field)',
        output_modalities: ['text'],
        context: 'fresh session per phrase / dialogue',
      };
    },
    async close() {},
    async runTurn({ text, onCall, context }) {
      return (await adapter.runDialogue({ turns: [text], onCall, contexts: [context] }))[0];
    },
    runDialogue({ turns, onCall, contexts = [] }) {
      return new Promise((resolveAll) => {
        const tSetup = Date.now();
        const ws = new WebSocket(`wss://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`, {
          headers: { Authorization: `Bearer ${providerKey('openai')}` },
        });
        const results = [];
        let setupMs = null;
        let cur = null; // { r, t0, continuations, needContinuation, turn, timer }
        let closed = false;
        const send = (o) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(o)); };
        const shutdown = (error) => {
          if (closed) return;
          closed = true;
          if (cur) {
            clearTimeout(cur.timer);
            if (error) cur.r.errors.push(error);
            cur.r.tDoneMs = Date.now() - cur.t0;
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
          cur = { r, t0: Date.now(), continuations: 0, needContinuation: false, turn };
          cur.timer = setTimeout(() => { cur.r.timeout = true; endTurn(); }, turnTimeoutMs);
          // Optional inert system item first (the app's pointer_context shape).
          if (contexts[turn]) send({ type: 'conversation.item.create', item: { type: 'message', role: 'system', content: [{ type: 'input_text', text: JSON.stringify(contexts[turn]) }] } });
          send({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: turns[turn] }] } });
          send({ type: 'response.create', response: { output_modalities: ['text'] } });
        };
        const endTurn = () => {
          if (!cur) return;
          clearTimeout(cur.timer);
          cur.r.tDoneMs = Date.now() - cur.t0;
          results.push(cur.r);
          const next = cur.turn + 1;
          const timedOut = cur.r.timeout;
          cur = null;
          if (next < turns.length && !timedOut) startTurn(next);
          else shutdown();
        };
        const mark = (key) => { if (cur && cur.r[key] === null) cur.r[key] = Date.now() - cur.t0; };

        ws.on('unexpected-response', (_req, res) => shutdown(`HTTP ${res.statusCode}`));
        ws.on('error', (e) => shutdown(`ws: ${e.message}`));
        ws.on('close', () => shutdown(results.length < turns.length ? 'socket closed' : undefined));
        ws.on('message', (raw) => {
          let m;
          try { m = JSON.parse(raw.toString()); } catch { return; }
          if (m.type === 'session.created') {
            send({ type: 'session.update', session });
            return;
          }
          if (m.type === 'session.updated' && setupMs === null) {
            setupMs = Date.now() - tSetup;
            startTurn(0);
            return;
          }
          if (m.type === 'error') {
            if (!cur) { shutdown(m.error?.message || 'realtime error'); return; }
            cur.r.errors.push(m.error?.message || 'realtime error');
            return;
          }
          if (!cur) return;
          const r = cur.r;
          if (
            m.type === 'response.output_text.delta' ||
            m.type === 'response.function_call_arguments.delta' ||
            m.type === 'response.output_audio_transcript.delta'
          ) mark('tFirstTokenMs');
          if (m.type === 'response.output_text.delta' || m.type === 'response.output_audio_transcript.delta') {
            r.text += m.delta || '';
          }
          if (m.type === 'response.output_item.done' && m.item?.type === 'function_call') {
            mark('tFirstTokenMs');
            mark('tFirstCallMs');
            let args = {};
            try { args = JSON.parse(m.item.arguments || '{}'); } catch { args = { __unparsed: m.item.arguments }; }
            const c = { name: m.item.name, args, atMs: Date.now() - cur.t0 };
            r.calls.push(c);
            send({
              type: 'conversation.item.create',
              item: { type: 'function_call_output', call_id: m.item.call_id, output: JSON.stringify(onCall(c, cur.turn)) },
            });
            cur.needContinuation = true;
          }
          if (m.type === 'response.done') {
            r.responses += 1;
            const u = m.response?.usage;
            if (u) {
              r.usage.inputTokens += u.input_tokens || 0;
              r.usage.cachedTokens += u.input_token_details?.cached_tokens || 0;
              r.usage.outputTokens += u.output_tokens || 0;
              r.usage.reasoningTokens += u.output_token_details?.reasoning_tokens || 0;
              r.costUsd += openAiUsageCostUsd(model, u);
            }
            if (m.response?.status === 'failed') r.errors.push(JSON.stringify(m.response?.status_details).slice(0, 200));
            if (cur.needContinuation && cur.continuations < MAX_CONTINUATIONS) {
              cur.needContinuation = false;
              cur.continuations += 1;
              if (r.text) r.text += ' | ';
              send({ type: 'response.create', response: { output_modalities: ['text'] } });
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
