/**
 * DeepSeek AI Chat Controller — client-side conversation engine.
 *
 * Manages a persistent conversation with DeepSeek via the server-side proxy
 * at /api/deepseek/chat. When DeepSeek returns tool_calls, the controller
 * executes them against the existing GEV action runner (the same 28 tools
 * used by OpenAI Realtime voice) and feeds results back for a follow-up
 * completion. Browser-native Web Speech API provides zero-cost STT/TTS.
 *
 * Zero dependencies beyond the GEV action runner and standard DOM APIs.
 */

/** @typedef {{ role: string, content: string|null, tool_calls?: any[], tool_call_id?: string }} ChatMessage */

const DEEPSEEK_CHAT_API = '/api/deepseek/chat';
const DEEPSEEK_STATUS_API = '/api/deepseek/status';

const SYSTEM_PROMPT = [
  "You are GEV AI, a concise AI controller for a Cesium geospatial app called God's Eye View.",
  'You control the app by calling the provided tools. Never invent tool names or arguments.',
  'Call tools only for clear GEV control, navigation, visual-style, layer, or app-state requests. For ordinary conversation, answer normally without tools.',
  'When a request requires a tool call, call the tool and then speak a SHORT confirmation of what happened.',
  'Keep spoken confirmations short, e.g. "Flying to London" or "Enabling datacenter layer".',
  'For questions like "what am I looking at?", call get_entity_context first, then answer from the returned context.',
  'When a single user request contains MULTIPLE changes, call ALL the corresponding tools before responding.',
  'After receiving all tool results, give exactly one short confirmation covering everything.',
].join('\n');

/**
 * Create a DeepSeek chat controller bound to a GEV action runner.
 *
 * @param {Function} actionRunner - The `runGevAction(name, args)` function from
 *   `createGevActionRunner`. May be null if voice tools are not yet initialized.
 * @returns {object} Controller API.
 */
export function createDeepSeekController(actionRunner) {
  /** @type {ChatMessage[]} */
  const history = [{ role: 'system', content: SYSTEM_PROMPT }];

  /** @type {Set<Function>} */
  const listeners = new Set();

  /** @type {boolean} */
  let busy = false;

  /** @type {{ configured: boolean, model: string|null }|null} */
  let cachedStatus = null;

  function emit(event, data) {
    for (const fn of listeners) {
      try { fn(event, data); } catch { /* listener errors are silently dropped */ }
    }
  }

  /**
   * Check if the DeepSeek backend is configured.
   * @returns {Promise<{ configured: boolean, model: string|null }>}
   */
  async function checkStatus() {
    if (cachedStatus) return cachedStatus;
    try {
      const res = await fetch(DEEPSEEK_STATUS_API);
      cachedStatus = await res.json();
    } catch {
      cachedStatus = { configured: false, model: null };
    }
    return cachedStatus;
  }

  /**
   * Send a user message and process the response, including tool calls.
   * @param {string} userText - The user's message.
   * @returns {Promise<string>} The assistant's final text response.
   */
  async function send(userText) {
    if (busy) throw new Error('DeepSeek controller is busy');
    if (!userText?.trim()) return '';
    busy = true;

    const userMessage = { role: 'user', content: userText.trim() };
    history.push(userMessage);
    emit('user', userMessage);
    emit('thinking', true);

    try {
      const reply = await completionLoop();
      return reply;
    } finally {
      busy = false;
      emit('thinking', false);
    }
  }

  /**
   * Core completion loop: call DeepSeek, execute any tool_calls, feed results
   * back, repeat until DeepSeek returns a plain text response (finish_reason=stop).
   * Guards against runaway loops with a max-iterations cap.
   */
  async function completionLoop() {
    const MAX_TOOL_ROUNDS = 8;
    let round = 0;

    while (round < MAX_TOOL_ROUNDS) {
      round++;
      const response = await fetch(DEEPSEEK_CHAT_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: history }),
      });

      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        const msg = err.error || `DeepSeek error ${response.status}`;
        emit('error', msg);
        return `Error: ${msg}`;
      }

      const data = await response.json();
      const choice = data.choices?.[0];
      if (!choice) {
        emit('error', 'No response from DeepSeek');
        return 'Error: No response from DeepSeek';
      }

      const assistantMessage = choice.message;
      history.push(assistantMessage);

      // Report usage stats for cost tracking.
      if (data.usage) {
        emit('usage', data.usage);
      }

      // If the assistant returned tool_calls, execute them and loop.
      if (assistantMessage.tool_calls?.length > 0) {
        emit('tool_calls', assistantMessage.tool_calls);
        for (const call of assistantMessage.tool_calls) {
          const toolResult = await executeToolCall(call);
          const toolMessage = {
            role: 'tool',
            tool_call_id: call.id,
            content: JSON.stringify(toolResult),
          };
          history.push(toolMessage);
          emit('tool_result', { call, result: toolResult });
        }
        // Continue the loop — DeepSeek needs to see the tool results.
        continue;
      }

      // No tool calls — this is the final text response.
      const text = assistantMessage.content || '';
      if (text) {
        emit('assistant', { role: 'assistant', content: text });
        speak(text);
      }
      return text;
    }

    const fallback = 'Completed (tool call limit reached)';
    emit('assistant', { role: 'assistant', content: fallback });
    return fallback;
  }

  /**
   * Execute a single tool call through the GEV action runner.
   * @param {{ id: string, function: { name: string, arguments: string } }} call
   * @returns {Promise<object>}
   */
  async function executeToolCall(call) {
    const name = call.function?.name;
    let args;
    try {
      args = JSON.parse(call.function?.arguments || '{}');
    } catch {
      return { ok: false, error: 'Invalid tool arguments JSON' };
    }

    if (!actionRunner) {
      return { ok: false, error: 'Action runner not initialized' };
    }

    try {
      const result = await actionRunner(name, args);
      return result ?? { ok: true };
    } catch (error) {
      return { ok: false, error: error?.message || `Tool ${name} failed` };
    }
  }

  /**
   * Speak text using browser TTS (zero cost, zero latency).
   * @param {string} text
   */
  function speak(text) {
    if (!text || typeof window === 'undefined') return;
    if (!window.speechSynthesis) return;
    // Cancel any pending speech before starting new.
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 1.1;
    utterance.pitch = 1.0;
    utterance.volume = 0.8;
    window.speechSynthesis.speak(utterance);
  }

  /**
   * Clear conversation history and start fresh.
   */
  function reset() {
    history.length = 0;
    history.push({ role: 'system', content: SYSTEM_PROMPT });
    emit('reset', null);
  }

  return {
    send,
    reset,
    checkStatus,
    /** @param {Function} fn */
    on: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    get busy() { return busy; },
    get messageCount() { return history.length; },
  };
}

/**
 * Create a Web Speech API dictation controller for hands-free input.
 * Falls back gracefully when the browser doesn't support it.
 *
 * @param {(transcript: string) => void} onResult - Called with the final transcript.
 * @returns {{ start: () => void, stop: () => void, isListening: () => boolean }|null}
 */
export function createSpeechInput(onResult) {
  const SpeechRecognition = typeof window !== 'undefined'
    && (window.SpeechRecognition || window.webkitSpeechRecognition);
  if (!SpeechRecognition) return null;

  const recognition = new SpeechRecognition();
  recognition.continuous = false;
  recognition.interimResults = false;
  recognition.lang = 'en-US';
  recognition.maxAlternatives = 1;

  let listening = false;

  recognition.addEventListener('result', (event) => {
    const transcript = event.results?.[0]?.[0]?.transcript;
    if (transcript) onResult(transcript);
  });

  recognition.addEventListener('end', () => { listening = false; });
  recognition.addEventListener('error', () => { listening = false; });

  return {
    start() {
      if (listening) return;
      listening = true;
      recognition.start();
    },
    stop() {
      if (!listening) return;
      listening = false;
      recognition.stop();
    },
    isListening: () => listening,
  };
}
