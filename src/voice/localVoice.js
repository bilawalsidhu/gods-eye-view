/**
 * Local voice controller (September 2026) — the browser half of the
 * local provider answering upstream issue #212.
 *
 * Ear   = Web Speech API (SpeechRecognition; works on iPhone Safari over HTTPS)
 * Brain = /api/local-voice/turn (Ollama or Anthropic, see server/localVoice.js)
 * Hands = the SAME runner as the OpenAI session (createGevActionRunner → 28 tools)
 * Mouth = speechSynthesis
 *
 * It mirrors the public surface of GevRealtimeController that main.js and the
 * voice UI touch: isActive/start/stop/sendTextCommand/notifyMapEvent/
 * syncCostUi/bindPushToTalkShortcut/toggleVoiceTier/getDiagnostics.
 */

import { governorRequestRender, holdContinuousRender, releaseContinuousRender } from '../renderGovernor.js';

const STATUS = {
  idle: 'OFF',
  connecting: 'CONNECTING',
  listening: 'LISTENING',
  executing: 'EXECUTING',
  error: 'ERROR',
};
const TURN_URL = '/api/local-voice/turn';
const MAX_TOOL_ROUNDS = 4;
// Camera flights and layer loads need frames; the idle render governor parks
// the scene in requestRenderMode, so hold continuous rendering around tool
// execution and for a few seconds after (long enough for a 2-3 s flight).
const RENDER_HOLD_MS = 8000;
const RENDER_HOLD_OWNER = 'local-voice';
const MAX_HISTORY = 20;

function speechRecognitionCtor() {
  return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}

export function isLocalVoiceSupported() {
  return Boolean(speechRecognitionCtor()) && window.isSecureContext !== false;
}

export class LocalVoiceController {
  constructor({ runner, ui, dataManager = null, status = {} }) {
    this.runner = runner;
    this.ui = ui;
    this.dataManager = dataManager;
    this.provider = status.provider || 'local';
    this.model = status.model || '';
    this.lang = status.lang || navigator.language || 'en-US';
    this.history = [];
    this.active = false;
    this.busy = false;
    this.recognition = null;
    this.status = 'idle';
    this.pushToTalkMode = false;
    this.spaceKeyHeld = false;
    this.pushToTalkKeyHeld = false;
    this.lastError = null;
    this.panel = createLocalPanel(this.ui?.root, {
      onSubmit: (text) => this.sendTextCommand(text),
      placeholder: this.lang.toLowerCase().startsWith('es') ? 'Escribe una orden · «?» = ayuda' : "Type a command · '?' for help",
    });
    this.setStatus('idle');
  }

  isActive() {
    return this.active;
  }

  async start() {
    if (this.active) return;
    const Ctor = speechRecognitionCtor();
    if (!Ctor) {
      this.setStatus('error', 'This browser has no speech recognition (use Safari/Chrome over HTTPS)');
      return;
    }
    if (window.isSecureContext === false) {
      this.setStatus('error', 'Microphone needs HTTPS (open the https:// address)');
      return;
    }
    this.active = true;
    this.setStatus('connecting', `${this.providerLabel()} · starting mic`);
    try {
      await navigator.mediaDevices?.getUserMedia?.({ audio: true });
    } catch (error) {
      this.active = false;
      this.setStatus('error', `Microphone permission: ${error?.message || error}`);
      return;
    }
    this.startRecognizer();
    this.setStatus('listening', `${this.providerLabel()} · say a command`);
  }

  startRecognizer() {
    const Ctor = speechRecognitionCtor();
    if (!Ctor || !this.active) return;
    if (this.recognition) {
      try { this.recognition.onend = null; this.recognition.stop(); } catch { /* ignore */ }
    }
    const rec = new Ctor();
    rec.lang = this.lang;
    rec.continuous = true;
    rec.interimResults = false;
    rec.maxAlternatives = 1;
    rec.onresult = (event) => {
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        if (!result.isFinal) continue;
        const text = String(result[0]?.transcript || '').trim();
        if (text) this.handleUtterance(text);
      }
    };
    rec.onerror = (event) => {
      const code = event?.error || 'unknown';
      if (code === 'no-speech' || code === 'aborted') return;
      if (code === 'not-allowed' || code === 'service-not-allowed') {
        this.active = false;
        this.setStatus('error', 'Microphone not allowed');
        return;
      }
      this.setStatus('listening', `${this.providerLabel()} · mic hiccup (${code})`);
    };
    rec.onend = () => {
      // Safari/Chrome end the recognizer after silence; keep listening while active.
      if (this.active && !this.speaking) setTimeout(() => this.startRecognizer(), 250);
    };
    this.recognition = rec;
    try { rec.start(); } catch { /* already started */ }
  }

  stopRecognizer() {
    if (!this.recognition) return;
    try { this.recognition.onend = null; this.recognition.stop(); } catch { /* ignore */ }
    this.recognition = null;
  }

  stop({ removeUi = false } = {}) {
    if (removeUi) this.panel?.root?.remove();
    clearTimeout(this.renderHoldTimer);
    releaseContinuousRender(RENDER_HOLD_OWNER);
    this.active = false;
    this.stopRecognizer();
    try { window.speechSynthesis?.cancel(); } catch { /* ignore */ }
    this.setStatus('idle');
    if (removeUi && this.ui?.root) this.ui.root.remove();
  }

  sendTextCommand(text) {
    let clean = String(text || '').trim();
    if (!clean) return false;
    if (clean === '?' || clean === 'help' || clean === 'ayuda') {
      clean = this.lang.toLowerCase().startsWith('es')
        ? '¿Qué puedo decirte? Resume en pocas líneas las órdenes que entiendes: navegar, zoom, girar/orbitar, seguir aviones o barcos, cabina, capas, estilos, radio.'
        : 'What can I say? Summarize in a few lines the commands you understand: navigate, zoom, orbit/rotate, follow aircraft or ships, cockpit, layers, styles, radio.';
    }
    this.handleUtterance(clean, { typed: true });
    return true;
  }

  showReply(text, { error = false } = {}) {
    if (!this.panel?.reply) return;
    this.panel.reply.hidden = !text;
    this.panel.reply.textContent = text || '';
    this.panel.reply.dataset.error = error ? 'true' : 'false';
  }

  providerLabel() {
    if (this.provider === 'anthropic') return 'CLAUDE';
    if (this.provider === 'ollama') return (this.model || 'LOCAL').toUpperCase().slice(0, 12);
    return 'LOCAL';
  }

  pushHistory(entry) {
    this.history.push(entry);
    if (this.history.length > MAX_HISTORY) this.history = this.history.slice(-MAX_HISTORY);
  }

  async handleUtterance(text, { typed = false } = {}) {
    if (this.busy) {
      // Queue instead of dropping: a second order spoken while the first turn
      // is still running (model latency + flight) must not vanish.
      this.queue = this.queue || [];
      this.queue.push({ text, typed });
      this.setStatus('executing', `${this.providerLabel()} · queued: "${text.slice(0, 40)}"`);
      return;
    }
    this.busy = true;
    this.setStatus('executing', `"${text.slice(0, 60)}"`);
    this.setVoiceSpeaker('user');
    this.pushHistory({ role: 'user', content: text });
    try {
      let turn = await this.requestTurn();
      let rounds = 0;
      while (turn.toolCalls?.length && rounds < MAX_TOOL_ROUNDS) {
        rounds += 1;
        this.pushHistory({ role: 'assistant', content: turn.text || '', toolCalls: turn.toolCalls });
        for (const call of turn.toolCalls) {
          const result = await this.runTool(call);
          this.pushHistory({ role: 'tool', id: call.id, name: call.name, content: JSON.stringify(result).slice(0, 4000) });
        }
        turn = await this.requestTurn();
      }
      const reply = String(turn.text || '').trim() || (rounds ? 'Done.' : '');
      this.pushHistory({ role: 'assistant', content: reply, toolCalls: [] });
      this.showReply(reply);
      if (reply && this.active) await this.speak(reply);
      this.setStatus(this.active ? 'listening' : 'idle', this.active ? `${this.providerLabel()} · ${reply.slice(0, 70)}` : undefined);
    } catch (error) {
      this.lastError = String(error?.message || error);
      this.showReply(this.lastError, { error: true });
      this.setStatus(this.active ? 'listening' : 'idle', `${this.providerLabel()} · ${this.lastError.slice(0, 80)}`);
      if (typed) console.warn('[local-voice]', this.lastError);
    } finally {
      this.busy = false;
      this.setVoiceSpeaker('idle');
      const next = this.queue?.shift();
      if (next) setTimeout(() => this.handleUtterance(next.text, { typed: next.typed }), 50);
    }
  }

  async requestTurn() {
    const response = await fetch(TURN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: this.history }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data?.error || `voice provider ${response.status}`);
    return { text: data.text || '', toolCalls: Array.isArray(data.toolCalls) ? data.toolCalls : [] };
  }

  holdRender() {
    holdContinuousRender(RENDER_HOLD_OWNER);
    clearTimeout(this.renderHoldTimer);
    this.renderHoldTimer = setTimeout(() => releaseContinuousRender(RENDER_HOLD_OWNER), RENDER_HOLD_MS);
    governorRequestRender(RENDER_HOLD_OWNER);
  }

  async runTool(call) {
    this.setStatus('executing', `${call.name.replace(/_/g, ' ')}…`);
    this.holdRender();
    try {
      let result = await this.runner(call.name, call.args || {}, { isCurrent: () => true });
      // Small models like to echo the route's title into fly_route; the tool
      // only accepts saved names — retry once for "the newest route".
      if (call.name === 'fly_route' && result?.ok === false && /No route matches/i.test(result.error || '') && call.args?.name) {
        result = await this.runner('fly_route', { ...call.args, name: undefined }, { isCurrent: () => true });
      }
      return result ?? { ok: true, action: call.name };
    } catch (error) {
      return { ok: false, action: call.name, error: String(error?.message || error).slice(0, 300) };
    }
  }

  speak(text) {
    return new Promise((resolve) => {
      const synth = window.speechSynthesis;
      if (!synth || !text) return resolve();
      this.speaking = true;
      this.stopRecognizer(); // do not transcribe our own voice
      this.setVoiceSpeaker('ai');
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = this.lang;
      const preferred = pickVoice(synth, this.lang);
      if (preferred) utterance.voice = preferred;
      utterance.rate = 1.03;
      const done = () => {
        this.speaking = false;
        this.setVoiceSpeaker('idle');
        if (this.active) this.startRecognizer();
        resolve();
      };
      utterance.onend = done;
      utterance.onerror = done;
      try { synth.cancel(); synth.speak(utterance); } catch { done(); }
    });
  }

  notifyMapEvent(payload) {
    // Fed back as context so the model can confirm/correct what it narrated.
    if (payload && this.history.length) {
      this.pushHistory({ role: 'user', content: `[map event] ${JSON.stringify(payload).slice(0, 400)}` });
    }
  }

  setStatus(status, detail) {
    this.status = status;
    if (!this.ui?.root) return;
    this.ui.root.dataset.status = status;
    if (status === 'error') this.ui.root.classList.remove('error-dismissed');
    if (this.ui.buttonLabel) this.ui.buttonLabel.textContent = 'MIC';
    if (this.ui.status) this.ui.status.textContent = STATUS[status] || STATUS.idle;
    const primaryDetail = status === 'error'
      ? 'VOICE UNAVAILABLE'
      : (detail || (status === 'idle' ? `VOICE STANDBY · ${this.providerLabel()}` : 'VOICE ACTIVE'));
    if (this.ui.detail) {
      this.ui.detail.textContent = primaryDetail;
      this.ui.detail.title = primaryDetail;
    }
    if (this.ui.errorDetail) this.ui.errorDetail.textContent = status === 'error' ? (detail || 'Voice session could not be started.') : '';
    if (this.ui.helpDetail) this.ui.helpDetail.textContent = `Click mic to talk · ${this.providerLabel()} (local provider, no OpenAI key)`;
    if (status === 'idle' || status === 'connecting' || status === 'error') this.setVoiceSpeaker('idle');
  }

  setVoiceSpeaker(speaker) {
    if (this.ui?.root) this.ui.root.dataset.speaker = speaker === 'user' || speaker === 'ai' ? speaker : 'idle';
  }

  syncCostUi() {
    if (this.ui?.tierButton) {
      this.ui.tierButton.textContent = this.providerLabel();
      this.ui.tierButton.title = `Voice provider: ${this.provider}${this.model ? ` · ${this.model}` : ''} (local, no per-minute audio cost)`;
      this.ui.tierButton.setAttribute('aria-pressed', 'false');
    }
    if (this.ui?.costValue) {
      this.ui.costValue.textContent = this.provider === 'anthropic' ? 'API' : '$0';
      this.ui.costValue.dataset.level = 'ok';
      this.ui.costValue.title = this.provider === 'anthropic'
        ? 'Anthropic API: text tokens per turn, no audio metering'
        : 'Local model: no cost';
    }
  }

  bindPushToTalkShortcut() {
    // Space toggles the session (no hold-to-talk with the browser recognizer).
    this.keyHandler = (event) => {
      if (event.code !== 'Space' || event.repeat) return;
      const target = event.target;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
      event.preventDefault();
      if (this.active) this.stop(); else this.start();
    };
    window.addEventListener('keydown', this.keyHandler);
  }

  toggleVoiceTier() {
    // Provider is fixed by the server env; nothing to toggle.
    this.syncCostUi();
  }

  getDiagnostics() {
    return { provider: this.provider, model: this.model, lang: this.lang, active: this.active, busy: this.busy, history: this.history.length, lastError: this.lastError };
  }
}

/**
 * Typed command box + last-reply line under the mic control. Voice is optional:
 * the same turn loop runs from the keyboard (car passengers, quiet rooms,
 * browsers without SpeechRecognition).
 */
function createLocalPanel(root, { onSubmit, placeholder }) {
  if (!root || typeof document === 'undefined') return null;
  root.querySelector('.gev-local-voice')?.remove();
  const panel = document.createElement('div');
  panel.className = 'gev-local-voice';
  panel.innerHTML = `
    <form class="gev-local-voice-form" autocomplete="off">
      <input class="gev-local-voice-input" type="text" spellcheck="false" aria-label="Command" />
    </form>
    <div class="gev-local-voice-reply" role="status" aria-live="polite" hidden></div>`;
  const form = panel.querySelector('form');
  const input = panel.querySelector('input');
  input.placeholder = placeholder;
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const text = input.value;
    input.value = '';
    onSubmit(text);
  });
  input.addEventListener('keydown', (event) => event.stopPropagation()); // keep app hotkeys (Space, 1-7) out of the box
  root.appendChild(panel);
  return { root: panel, input, reply: panel.querySelector('.gev-local-voice-reply') };
}

/**
 * Pick the best available system voice for a language. Order: an explicit
 * override (localStorage `gev.local-voice.voice` = voice name), then the
 * platform's premium/enhanced voices, then well-known good names, then any
 * voice of that language. Compact/eSpeak-style voices come last.
 */
const GOOD_VOICE_NAMES = {
  es: ['Mónica', 'Monica', 'Jorge', 'Paulina', 'Marisol', 'Google español', 'Microsoft Elvira', 'Microsoft Alvaro'],
  en: ['Samantha', 'Daniel', 'Karen', 'Moira', 'Google US English', 'Google UK English Female', 'Microsoft Aria'],
  fr: ['Amélie', 'Thomas', 'Google français'],
  it: ['Alice', 'Luca', 'Google italiano'],
  de: ['Anna', 'Markus', 'Google Deutsch'],
};
export function pickVoice(synth, lang) {
  const voices = (synth?.getVoices ? synth.getVoices() : []) || [];
  if (!voices.length) return null;
  const base = String(lang || 'en').slice(0, 2).toLowerCase();
  let override = null;
  try { override = localStorage.getItem('gev.local-voice.voice'); } catch { /* private mode */ }
  if (override) {
    const hit = voices.find((v) => v.name === override || v.voiceURI === override);
    if (hit) return hit;
  }
  const sameLang = voices.filter((v) => (v.lang || '').toLowerCase().startsWith(base));
  const pool = sameLang.length ? sameLang : voices;
  const premium = pool.find((v) => /premium|enhanced|siri|natural|neural/i.test(`${v.name} ${v.voiceURI}`));
  if (premium) return premium;
  for (const name of GOOD_VOICE_NAMES[base] || []) {
    const hit = pool.find((v) => v.name.toLowerCase().startsWith(name.toLowerCase()));
    if (hit) return hit;
  }
  const notCompact = pool.find((v) => !/compact|espeak|eloquence/i.test(`${v.name} ${v.voiceURI}`));
  return notCompact || pool[0];
}
