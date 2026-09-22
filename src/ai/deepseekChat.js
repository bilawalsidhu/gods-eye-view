/**
 * DeepSeek AI Chat Panel — the floating chat window UI.
 *
 * Renders a glass-morphism chat panel that connects to the DeepSeek controller.
 * Supports text input, Web Speech API mic dictation, and displays assistant
 * responses, tool-call executions, and error states with tasteful animations.
 *
 * Injected at runtime alongside the existing voice-control pill, positioned
 * above it in the z-stack. Visibility is gated on DEEPSEEK_API_KEY being
 * configured (probed via /api/deepseek/status on first load).
 */

import { createDeepSeekController, createSpeechInput } from './deepseekController.js';

/**
 * Boot the DeepSeek chat panel and toggle button.
 *
 * @param {Function|null} actionRunner - The `runGevAction(name, args)` function
 *   from `createGevActionRunner`. Null until voice tools are initialized; can be
 *   patched later via the returned `setActionRunner`.
 * @returns {{ panel: HTMLElement, toggle: HTMLElement, setActionRunner: (fn: Function) => void }}
 */
export function initDeepSeekChat(actionRunner = null) {
  let controller = createDeepSeekController(actionRunner);
  let speechInput = null;

  // ── Toggle button (always present, hidden when unconfigured) ──────────
  const toggle = document.createElement('button');
  toggle.id = 'ds-chat-toggle';
  toggle.classList.add('ds-unconfigured'); // hidden until status probe
  toggle.innerHTML = `<span class="ds-toggle-icon">⚡</span> DEEPSEEK AI`;
  toggle.title = 'Open DeepSeek AI Chat';

  // ── Chat panel ────────────────────────────────────────────────────────
  const panel = document.createElement('div');
  panel.id = 'gev-deepseek-chat';
  panel.classList.add('ds-unconfigured');
  panel.innerHTML = `
    <div class="ds-chat-header">
      <span class="ds-chat-header-title">DEEPSEEK AI</span>
      <span class="ds-chat-model-badge" id="ds-model-badge">—</span>
      <button class="ds-chat-close-btn" title="Close chat" aria-label="Close DeepSeek chat">✕</button>
    </div>
    <div class="ds-chat-messages" id="ds-chat-messages">
      <div class="ds-chat-msg system">READY — TYPE A COMMAND OR ASK A QUESTION</div>
    </div>
    <div class="ds-chat-input-row">
      <button class="ds-chat-mic-btn" id="ds-chat-mic" title="Voice input (Web Speech API)" aria-label="Voice input">🎙</button>
      <input type="text" id="ds-chat-input" placeholder="Ask GEV AI anything..." autocomplete="off" spellcheck="false" />
      <button id="ds-chat-send" title="Send message" aria-label="Send">▶</button>
    </div>
  `;

  // ── DOM refs ──────────────────────────────────────────────────────────
  const messagesEl = panel.querySelector('#ds-chat-messages');
  const inputEl = panel.querySelector('#ds-chat-input');
  const sendBtn = panel.querySelector('#ds-chat-send');
  const micBtn = panel.querySelector('#ds-chat-mic');
  const closeBtn = panel.querySelector('.ds-chat-close-btn');
  const modelBadge = panel.querySelector('#ds-model-badge');

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
        const detail = data.result?.error || data.result?.action || data.call.function?.name || '';
        appendMessage('tool-result', `${label} ${detail}`);
        break;
      }
      case 'error':
        hideThinking();
        appendMessage('error', `⚠ ${data}`);
        break;
      case 'usage':
        if (typeof console !== 'undefined') {
          console.debug('[DeepSeek] tokens:', data);
        }
        break;
      case 'reset':
        messagesEl.innerHTML = '';
        appendMessage('system', 'CONVERSATION RESET');
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

  // ── Status probe (gate visibility on DEEPSEEK_API_KEY) ────────────────
  controller.checkStatus().then((status) => {
    if (status.configured) {
      panel.classList.remove('ds-unconfigured');
      toggle.classList.remove('ds-unconfigured');
      if (status.model) {
        modelBadge.textContent = status.model.toUpperCase().replace('DEEPSEEK-', '');
      }
    }
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
      controller = createDeepSeekController(fn);
      controller.on(handleControllerEvent);
    },
  };
}
