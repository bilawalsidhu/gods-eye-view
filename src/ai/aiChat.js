/**
 * AI Chat Panel — the floating chat window UI.
 *
 * Renders a glass-morphism chat panel that connects to the AI chat controller.
 * Supports text input, Web Speech API mic dictation, and displays assistant
 * responses, tool-call executions, and error states with tasteful animations.
 *
 * Injected at runtime alongside the existing voice-control pill, positioned
 * above it in the z-stack. Visibility is gated on at least one provider key
 * (DEEPSEEK_API_KEY or MIMO_API_KEY) being configured (probed via
 * /api/ai/status on first load). With more than one, the header shows a
 * provider picker whose choice is remembered per browser.
 */

import { t } from '../i18n/index.js';
import {
  createAiChatController,
  createSpeechInput,
} from './aiChatController.js';

const PROVIDER_STORAGE_KEY = 'gev.aiChat.provider';

function readStoredProvider() {
  try {
    return window.localStorage.getItem(PROVIDER_STORAGE_KEY);
  } catch {
    return null;
  }
}

function storeProvider(id) {
  try {
    window.localStorage.setItem(PROVIDER_STORAGE_KEY, id);
  } catch {
    /* storage unavailable — the choice lasts for this page only */
  }
}

/**
 * Boot the AI chat panel and toggle button.
 *
 * @param {Function|null} actionRunner - The `runGevAction(name, args)` function
 *   from `createGevActionRunner`. Null until voice tools are initialized; can be
 *   patched later via the returned `setActionRunner`.
 * @returns {{ panel: HTMLElement, toggle: HTMLElement, setActionRunner: (fn: Function) => void }}
 */
export function initAiChat(actionRunner = null) {
  let controller = createAiChatController(actionRunner);
  /** @type {{ id: string, label: string, model: string }[]} */
  let providers = [];
  let speechInput = null;

  // ── Toggle button (always present, hidden when unconfigured) ──────────
  const toggle = document.createElement('button');
  toggle.id = 'ds-chat-toggle';
  toggle.classList.add('ds-unconfigured'); // hidden until status probe
  // i18n-ignore: product name and icon
  toggle.innerHTML = `<span class="ds-toggle-icon" aria-hidden="true">⚡</span> <span translate="no">GEV AI</span>`;
  toggle.title = t('Open GEV AI Chat');

  // ── Chat panel ────────────────────────────────────────────────────────
  const panel = document.createElement('div');
  panel.id = 'gev-ai-chat';
  panel.classList.add('ds-unconfigured');
  // i18n-ignore: product name and icon glyphs; copy below goes through t()
  panel.innerHTML = `
    <div class="ds-chat-header">
      <span class="ds-chat-header-title" translate="no">GEV AI</span>
      <select class="ds-chat-provider" id="ds-provider" aria-label="${t('AI provider')}" hidden></select>
      <span class="ds-chat-model-badge" id="ds-model-badge" translate="no">—</span>
      <button class="ds-chat-close-btn" title="${t('Close chat')}" aria-label="${t('Close AI chat')}"><span aria-hidden="true">✕</span></button>
    </div>
    <div class="ds-chat-messages" id="ds-chat-messages">
      <div class="ds-chat-msg system">${t('READY — TYPE A COMMAND OR ASK A QUESTION')}</div>
    </div>
    <div class="ds-chat-input-row">
      <button class="ds-chat-mic-btn" id="ds-chat-mic" title="${t('Voice input (Web Speech API)')}" aria-label="${t('Voice input')}"><span aria-hidden="true">🎙</span></button>
      <input type="text" id="ds-chat-input" placeholder="${t('Ask GEV AI anything...')}" autocomplete="off" spellcheck="false" />
      <button id="ds-chat-send" title="${t('Send message')}" aria-label="${t('Send')}"><span aria-hidden="true">▶</span></button>
    </div>
  `;

  // ── DOM refs ──────────────────────────────────────────────────────────
  const messagesEl = panel.querySelector('#ds-chat-messages');
  const inputEl = panel.querySelector('#ds-chat-input');
  const sendBtn = panel.querySelector('#ds-chat-send');
  const micBtn = panel.querySelector('#ds-chat-mic');
  const closeBtn = panel.querySelector('.ds-chat-close-btn');
  const modelBadge = panel.querySelector('#ds-model-badge');
  const providerSelect = panel.querySelector('#ds-provider');

  // ── Toggle behavior ───────────────────────────────────────────────────
  let isOpen = false;

  function setOpen(open) {
    isOpen = open;
    panel.classList.toggle('open', open);
    toggle.classList.toggle('active', open);
    if (open) {
      inputEl.focus();
      scrollToBottom();
    }
  }

  toggle.addEventListener('click', () => setOpen(!isOpen));
  closeBtn.addEventListener('click', () => setOpen(false));

  // Close on Escape.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isOpen) {
      e.stopPropagation();
      setOpen(false);
    }
  });

  // ── Message rendering ─────────────────────────────────────────────────
  function appendMessage(role, text) {
    const msg = document.createElement('div');
    msg.className = `ds-chat-msg ${role}`;
    msg.textContent = text;
    messagesEl.appendChild(msg);
    scrollToBottom();
    return msg;
  }

  function scrollToBottom() {
    requestAnimationFrame(() => {
      messagesEl.scrollTop = messagesEl.scrollHeight;
    });
  }

  let thinkingEl = null;

  function showThinking() {
    if (thinkingEl) return;
    thinkingEl = document.createElement('div');
    thinkingEl.className = 'ds-chat-thinking';
    thinkingEl.innerHTML = '<span></span><span></span><span></span>';
    messagesEl.appendChild(thinkingEl);
    scrollToBottom();
  }

  function hideThinking() {
    if (thinkingEl) {
      thinkingEl.remove();
      thinkingEl = null;
    }
  }

  // ── Controller event handler (shared between init and hot-patch) ────────
  function handleControllerEvent(event, data) {
    switch (event) {
      case 'user':
        appendMessage('user', data.content);
        break;
      case 'assistant':
        hideThinking();
        appendMessage('assistant', data.content);
        break;
      case 'thinking':
        if (data) showThinking();
        else hideThinking();
        break;
      case 'tool_calls':
        for (const call of data) {
          appendMessage('system', `⚙ ${call.function?.name || 'tool'}(…)`);
        }
        break;
      case 'tool_result': {
        const ok = data.result?.ok !== false;
        const label = ok ? '✓' : '✗';
        const detail =
          data.result?.error ||
          data.result?.action ||
          data.call.function?.name ||
          '';
        appendMessage('tool-result', `${label} ${detail}`);
        break;
      }
      case 'error':
        hideThinking();
        appendMessage('error', `⚠ ${data}`);
        break;
      case 'usage':
        if (typeof console !== 'undefined') {
          console.debug('[AI chat] tokens:', controller.provider, data);
        }
        break;
      case 'reset':
        messagesEl.innerHTML = '';
        appendMessage('system', t('CONVERSATION RESET'));
        break;
    }
  }

  controller.on(handleControllerEvent);

  // ── Input handling ────────────────────────────────────────────────────
  async function handleSend() {
    const text = inputEl.value.trim();
    if (!text || controller.busy) return;
    inputEl.value = '';
    sendBtn.disabled = true;
    try {
      await controller.send(text);
    } finally {
      sendBtn.disabled = false;
      inputEl.focus();
    }
  }

  sendBtn.addEventListener('click', handleSend);
  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  });

  // ── Mic (Web Speech API) ──────────────────────────────────────────────
  speechInput = createSpeechInput((transcript) => {
    inputEl.value = transcript;
    micBtn.classList.remove('listening');
    // Auto-send after dictation completes.
    handleSend();
  });

  if (speechInput) {
    micBtn.addEventListener('click', () => {
      if (speechInput.isListening()) {
        speechInput.stop();
        micBtn.classList.remove('listening');
      } else {
        speechInput.start();
        micBtn.classList.add('listening');
      }
    });
  } else {
    // No Web Speech support — hide the mic button.
    micBtn.style.display = 'none';
  }

  // ── Provider selection ────────────────────────────────────────────────
  function selectProvider(id) {
    const selected = providers.find((entry) => entry.id === id) ?? providers[0];
    if (!selected) return;
    controller.provider = selected.id;
    providerSelect.value = selected.id;
    modelBadge.textContent = selected.model.toUpperCase();
  }

  providerSelect.addEventListener('change', () => {
    selectProvider(providerSelect.value);
    storeProvider(providerSelect.value);
    appendMessage(
      'system',
      t('PROVIDER — {name}', {
        name: providerSelect.selectedOptions[0]?.textContent ?? '',
      }),
    );
  });

  // ── Status probe (gate visibility on a configured provider key) ───────
  controller.checkStatus().then((status) => {
    if (!status.configured) return;
    panel.classList.remove('ds-unconfigured');
    toggle.classList.remove('ds-unconfigured');
    providers = Array.isArray(status.providers) ? status.providers : [];
    for (const entry of providers) {
      const option = document.createElement('option');
      option.value = entry.id;
      option.textContent = entry.label;
      providerSelect.appendChild(option);
    }
    providerSelect.hidden = providers.length < 2;
    selectProvider(readStoredProvider() ?? status.defaultProvider);
  });

  // ── Mount into the page ───────────────────────────────────────────────
  document.body.appendChild(panel);
  document.body.appendChild(toggle);

  return {
    panel,
    toggle,
    /**
     * Hot-patch the action runner after voice tools are initialized.
     * @param {Function} fn
     */
    setActionRunner(fn) {
      const { provider } = controller;
      controller = createAiChatController(fn);
      controller.provider = provider;
      controller.on(handleControllerEvent);
    },
  };
}
