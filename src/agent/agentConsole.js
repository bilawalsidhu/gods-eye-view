import { createSurfaceKeyboard } from '../ui/surfaceKeyboard.js';
import { attachConsoleBox } from './consoleBox.js';
import { createAgentSession, AGENT_EVENTS } from './agentLoop.js';
import { formatCommandCostUsd } from './cost.js';

/**
 * GEV COMMAND: the typed transport for the same agent voice drives.
 *
 * It owns one dialog and nothing else. The actions it runs are the app's
 * existing action runner, passed in, so this module has no knowledge of the
 * viewer, the layers or any tool; and the credentials stay server-side, so it
 * has no knowledge of a provider beyond the id it posts back.
 *
 * Formatting and selection logic are exported separately from the DOM wiring
 * so they can be tested without a browser; `mountAgentConsole` is the only
 * part that touches the document.
 */

/** Where the provider and model choice persist between sessions. */
const AGENT_SELECTION_STORAGE_KEY = 'godsEyeView.agent.selection.v1';

/** Transcript entry kinds, which map to CSS classes. */
const ENTRY_KIND = Object.freeze({
  USER: 'user',
  AGENT: 'agent',
  TOOL: 'tool',
  WARNING: 'warning',
  ERROR: 'error',
});

/** Status strings shown under the input. */
const AGENT_STATUS = Object.freeze({
  READY: 'READY',
  THINKING: 'THINKING',
  RUNNING: 'RUNNING',
  UNAVAILABLE: 'UNAVAILABLE',
});

/**
 * Render a tool call as a compact one-liner.
 *
 * The manual tells the model not to narrate its own tool use, so without this
 * the console would sit silent through a multi-tool turn. Arguments are
 * summarized rather than dumped: a full JSON blob buries the useful word.
 *
 * @param {string} name
 * @param {object|undefined} args
 * @returns {string}
 */
function describeToolCall(name, args) {
  const values = args && typeof args === 'object' ? Object.entries(args) : [];
  if (!values.length) return name;
  const summary = values
    .slice(0, 3)
    .map(([key, value]) => {
      if (Array.isArray(value)) return `${key}=[${value.length}]`;
      if (value !== null && typeof value === 'object') return `${key}={…}`;
      return `${key}=${String(value).slice(0, 32)}`;
    })
    .join(' ');
  const omitted = values.length - 3;
  return omitted > 0 ? `${name} ${summary} +${omitted}` : `${name} ${summary}`;
}

/**
 * Reduce an action result to a short status suffix.
 *
 * The model is instructed never to claim an action without `ok: true`, so the
 * console shows the same signal the model is reading.
 *
 * @param {unknown} result
 * @returns {string}
 */
function describeToolResult(result) {
  if (!result || typeof result !== 'object') return 'done';
  if (result.ok === false) {
    return result.error
      ? `failed: ${String(result.error).slice(0, 80)}`
      : 'failed';
  }
  if (result.partial) return 'partial';
  return 'ok';
}

/**
 * Option label for a provider, marking the ones that need configuration.
 *
 * @param {{label: string, configured: boolean, apiKeyEnv: string|null}} provider
 * @returns {string}
 */
function providerOptionLabel(provider) {
  if (provider.configured) return provider.label;
  return `${provider.label} (needs ${provider.apiKeyEnv})`;
}

/**
 * Option label for a model: its identity, then the two facts that decide
 * whether it is a good choice here — what it costs and whether it can see.
 *
 * @param {{label: string, costPerCommandUsd?: number|null, supportsVision?: boolean}} model
 * @returns {string}
 */
function modelOptionLabel(model) {
  const parts = [model.label];
  const cost = formatCommandCostUsd(model.costPerCommandUsd);
  if (cost !== 'n/a') parts.push(cost);
  if (model.supportsVision) parts.push('vision');
  return parts.length > 1
    ? `${parts[0]}  ·  ${parts.slice(1).join(' · ')}`
    : parts[0];
}

/**
 * Warning text for the transcript, with its remedy when there is one.
 *
 * @param {{message?: string, remedy?: string}} warning
 * @returns {string}
 */
function describeWarning(warning) {
  const message = String(
    warning?.message || 'The provider reported a problem.',
  );
  return warning?.remedy ? `${message} ${warning.remedy}` : message;
}

/**
 * Read the persisted provider and model choice.
 *
 * Storage can throw outright in privacy modes, so every access is guarded and
 * a failure degrades to "no preference" rather than breaking the console.
 *
 * @param {Storage} [storage]
 * @returns {{provider: string|null, model: string|null}|null}
 */
function readStoredSelection(storage) {
  try {
    const store = storage ?? globalThis.localStorage;
    const raw = store?.getItem(AGENT_SELECTION_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      provider: typeof parsed.provider === 'string' ? parsed.provider : null,
      model: typeof parsed.model === 'string' ? parsed.model : null,
    };
  } catch {
    return null;
  }
}

/**
 * Persist the provider and model choice, best effort.
 *
 * @param {{provider?: string|null, model?: string|null}} selection
 * @param {Storage} [storage]
 */
function writeStoredSelection(selection, storage) {
  try {
    const store = storage ?? globalThis.localStorage;
    store?.setItem(
      AGENT_SELECTION_STORAGE_KEY,
      JSON.stringify({
        provider: selection?.provider ?? null,
        model: selection?.model ?? null,
      }),
    );
  } catch {
    // A console preference is never worth breaking the app over.
  }
}

/**
 * Choose which model to preselect: the operator's remembered choice, then the
 * server's configured default, then the first model the gate approved.
 *
 * @param {Array<{id: string}>} models
 * @param {{remembered?: string|null, configuredDefault?: string|null}} [options]
 * @returns {object|null}
 */
function pickInitialModel(models, { remembered, configuredDefault } = {}) {
  if (!Array.isArray(models) || !models.length) return null;
  const byId = new Map(models.map((model) => [model.id, model]));
  if (remembered && byId.has(remembered)) return byId.get(remembered);
  if (configuredDefault && byId.has(configuredDefault)) {
    return byId.get(configuredDefault);
  }
  return models[0];
}

/**
 * Choose which provider to preselect: the remembered one when it is still
 * configured, then the server's default when it is, then any configured one.
 *
 * @param {Array<{id: string, configured: boolean}>} providers
 * @param {{remembered?: string|null, configuredDefault?: string|null}} [options]
 * @returns {string|null}
 */
function pickInitialProvider(
  providers,
  { remembered, configuredDefault } = {},
) {
  const list = Array.isArray(providers) ? providers : [];
  const usable = (id) =>
    list.find((entry) => entry.id === id && entry.configured);
  return (
    usable(remembered)?.id ||
    usable(configuredDefault)?.id ||
    list.find((entry) => entry.configured)?.id ||
    list[0]?.id ||
    null
  );
}

/**
 * Mount the typed console against the markup in `agent-console.html`.
 *
 * @param {{
 *   root?: Document,
 *   view?: Window,
 *   runAction: (name: string, args: object) => Promise<object>,
 *   fetchImpl?: typeof fetch,
 *   storage?: Storage,
 * }} options
 * @returns {{destroy: () => void, open: () => void, close: () => void,
 *   session: object}|null} Null when the markup is absent.
 */
function mountAgentConsole({
  root = globalThis.document,
  view = globalThis,
  runAction,
  fetchImpl = globalThis.fetch?.bind(globalThis),
  storage,
} = {}) {
  const dialog = root?.getElementById?.('agent-console');
  const chip = root?.getElementById?.('agent-console-chip');
  if (!dialog || !chip) return null;

  const header = dialog.querySelector('[data-panel-header]');
  const providerSelect = root.getElementById('agent-provider');
  const modelSelect = root.getElementById('agent-model');
  const transcript = root.getElementById('agent-transcript');
  const form = root.getElementById('agent-form');
  const input = root.getElementById('agent-input');
  const sendButton = root.getElementById('agent-send');
  const closeButton = root.getElementById('agent-console-close');
  const statusEl = root.getElementById('agent-status');
  const costEl = root.getElementById('agent-cost');

  const session = createAgentSession({ runAction, fetchImpl });
  let providers = [];
  let models = [];
  let selection = readStoredSelection(storage) || {
    provider: null,
    model: null,
  };
  let configLoaded = null;

  function append(kind, text) {
    const entry = root.createElement('li');
    entry.className = `agent-entry agent-entry-${kind}`;
    entry.textContent = text;
    transcript.appendChild(entry);
    transcript.scrollTop = transcript.scrollHeight;
    return entry;
  }

  function setStatus(status, detail = '') {
    statusEl.textContent = detail ? `${status} · ${detail}` : status;
    dialog.dataset.agentStatus = status.toLowerCase();
  }

  function currentModel() {
    return models.find((model) => model.id === modelSelect.value) || null;
  }

  function refreshCost() {
    costEl.textContent = formatCommandCostUsd(
      currentModel()?.costPerCommandUsd,
    );
  }

  function setBusy(busy) {
    input.disabled = busy;
    sendButton.disabled = busy;
    modelSelect.disabled = busy;
    providerSelect.disabled = busy;
  }

  async function readJson(url, init) {
    const response = await fetchImpl(url, init);
    const data = await response.json().catch(() => null);
    if (!response.ok || !data) {
      throw new Error(data?.error || `HTTP ${response.status}`);
    }
    return data;
  }

  // The provider picker stays live while a listing is in flight, so a slow
  // listing can land after a newer one. Only the newest may touch the DOM, or
  // the picker ends up showing one provider's models under another's name.
  let latestModelsRequest = 0;

  async function loadModels(providerId) {
    const request = (latestModelsRequest += 1);
    const superseded = () => request !== latestModelsRequest;

    modelSelect.replaceChildren();
    models = [];
    refreshCost();

    // The select is empty until the listing lands, and submitting in that
    // window would send no model, so input stays disabled until there is
    // something real to send. The provider picker stays live throughout.
    setBusy(true);
    providerSelect.disabled = false;

    const provider = providers.find((entry) => entry.id === providerId);
    if (!provider) {
      setStatus(AGENT_STATUS.UNAVAILABLE, 'no provider');
      return;
    }
    if (!provider.configured) {
      setStatus(AGENT_STATUS.UNAVAILABLE, `set ${provider.apiKeyEnv}`);
      return;
    }

    setStatus(AGENT_STATUS.THINKING, 'loading models');
    try {
      const data = await readJson(
        `/api/agent/models?provider=${encodeURIComponent(providerId)}`,
      );
      if (superseded()) return;
      models = Array.isArray(data.models) ? data.models : [];
      for (const model of models) {
        const option = root.createElement('option');
        option.value = model.id;
        option.textContent = modelOptionLabel(model);
        modelSelect.appendChild(option);
      }
      const initial = pickInitialModel(models, {
        remembered: selection.model,
        configuredDefault: data.defaultModel,
      });
      if (initial) modelSelect.value = initial.id;
      refreshCost();
      setStatus(
        models.length ? AGENT_STATUS.READY : AGENT_STATUS.UNAVAILABLE,
        models.length ? '' : 'no usable models',
      );
      // Only a provider with a usable model may accept input.
      setBusy(models.length === 0);
      providerSelect.disabled = false;
    } catch (error) {
      if (superseded()) return;
      setStatus(AGENT_STATUS.UNAVAILABLE);
      append(ENTRY_KIND.ERROR, error?.message || 'Could not list models');
      providerSelect.disabled = false;
    }
  }

  async function loadConfig() {
    try {
      const data = await readJson('/api/agent/config');
      providers = Array.isArray(data.providers) ? data.providers : [];
      providerSelect.replaceChildren();
      for (const provider of providers) {
        const option = root.createElement('option');
        option.value = provider.id;
        option.textContent = providerOptionLabel(provider);
        providerSelect.appendChild(option);
      }
      const chosen = pickInitialProvider(providers, {
        remembered: selection.provider,
        configuredDefault: data.defaultProvider,
      });
      if (chosen) providerSelect.value = chosen;
      await loadModels(providerSelect.value);
    } catch (error) {
      setStatus(AGENT_STATUS.UNAVAILABLE);
      append(ENTRY_KIND.ERROR, error?.message || 'Agent backend unavailable');
    }
  }

  function handleEvent(event) {
    if (event.type === AGENT_EVENTS.MESSAGE) {
      append(
        event.message.role === 'user' ? ENTRY_KIND.USER : ENTRY_KIND.AGENT,
        event.message.content,
      );
    } else if (event.type === AGENT_EVENTS.TOOL_START) {
      setStatus(AGENT_STATUS.RUNNING, event.name);
      append(ENTRY_KIND.TOOL, describeToolCall(event.name, event.args));
    } else if (event.type === AGENT_EVENTS.TOOL_RESULT) {
      const last = transcript.lastElementChild;
      if (last?.classList.contains('agent-entry-tool')) {
        last.dataset.outcome = describeToolResult(event.result);
      }
    } else if (event.type === AGENT_EVENTS.WARNING) {
      append(ENTRY_KIND.WARNING, describeWarning(event.warning));
    } else if (event.type === AGENT_EVENTS.REQUEST) {
      setStatus(AGENT_STATUS.THINKING);
    } else if (event.type === AGENT_EVENTS.ERROR) {
      append(ENTRY_KIND.ERROR, event.error);
    }
  }

  async function submit(submitEvent) {
    submitEvent?.preventDefault?.();
    const text = input.value.trim();
    if (!text || session.busy) return;
    if (!modelSelect.value) {
      append(ENTRY_KIND.ERROR, 'Select a model before sending a command.');
      return;
    }

    input.value = '';
    setBusy(true);
    setStatus(AGENT_STATUS.THINKING);
    try {
      // handleEvent already renders the error entry; appending result.error
      // here as well would show every failure twice.
      await session.send(text, {
        provider: providerSelect.value,
        model: modelSelect.value,
        onEvent: handleEvent,
      });
    } finally {
      setBusy(false);
      setStatus(AGENT_STATUS.READY);
      input.focus();
    }
  }

  async function onProviderChange() {
    selection = { provider: providerSelect.value, model: null };
    writeStoredSelection(selection, storage);
    // The transcript references tools the previous model called; a new back
    // end starts clean rather than inheriting a half-finished exchange.
    session.reset();
    await loadModels(providerSelect.value);
  }

  function onModelChange() {
    selection = { provider: providerSelect.value, model: modelSelect.value };
    writeStoredSelection(selection, storage);
    refreshCost();
  }

  // The window is draggable from its header and resizable from every edge,
  // and remembers where it was left. Attached before the keyboard so a
  // destroy tears the two down in the order they were built.
  const windowBox = attachConsoleBox({
    dialog,
    handle: header,
    root,
    view,
    storage,
  });

  // Escape and Tab come from the shared surface keyboard, the same owner key
  // setup and the first-run launcher use. A non-modal dialog does not dismiss
  // itself, and its own keydown listener would miss Escape whenever focus is
  // outside it — which is exactly the state a disabled input leaves it in.
  const keyboard = createSurfaceKeyboard({
    root: dialog,
    documentRef: root,
    isActive: () => dialog.open === true,
    onEscape: () => close(),
    fallbackFocus: () => chip,
  });

  function open() {
    if (dialog.open) return;
    // Placed before it is shown, so it never paints at the stylesheet's
    // corner for a frame and then jump to where the operator left it.
    windowBox.apply();
    keyboard.activate();
    // Non-modal on purpose: a command moves the camera, and the point of
    // typing one is watching it happen.
    dialog.show();
    chip.setAttribute('aria-expanded', 'true');
    // The listing is fetched on first open, not at startup: an install with no
    // provider configured should not spend a request to discover that.
    configLoaded ||= loadConfig();
    input.focus();
  }

  function close() {
    if (!dialog.open) return;
    dialog.close();
    chip.setAttribute('aria-expanded', 'false');
    keyboard.deactivate({ restoreFocus: true });
  }

  function onChipClick() {
    if (dialog.open) close();
    else open();
  }

  chip.hidden = false;
  setStatus(AGENT_STATUS.READY);
  form.addEventListener('submit', submit);
  providerSelect.addEventListener('change', onProviderChange);
  modelSelect.addEventListener('change', onModelChange);
  chip.addEventListener('click', onChipClick);
  closeButton.addEventListener('click', close);

  return {
    session,
    windowBox,
    open,
    close,
    destroy() {
      form.removeEventListener('submit', submit);
      providerSelect.removeEventListener('change', onProviderChange);
      modelSelect.removeEventListener('change', onModelChange);
      chip.removeEventListener('click', onChipClick);
      closeButton.removeEventListener('click', close);
      keyboard.destroy();
      windowBox.destroy();
      session.abort();
      if (dialog.open) dialog.close();
      chip.hidden = true;
      chip.setAttribute('aria-expanded', 'false');
    },
  };
}

export {
  AGENT_SELECTION_STORAGE_KEY,
  AGENT_STATUS,
  ENTRY_KIND,
  describeToolCall,
  describeToolResult,
  describeWarning,
  modelOptionLabel,
  mountAgentConsole,
  pickInitialModel,
  pickInitialProvider,
  providerOptionLabel,
  readStoredSelection,
  writeStoredSelection,
};
