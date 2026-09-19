import { createSurfaceKeyboard } from './ui/surfaceKeyboard.js';

/**
 * The POWER UP surface — paste a key, get a power.
 *
 * A small chip sits bottom-right whenever the app is running under the dev
 * server with keys still missing. It opens a dialog rendered ENTIRELY from
 * GET /api/setup/status (the registry lives in src/keySetupCore.mjs and this
 * module never duplicates it): one row per key, what it unlocks, where to get
 * it, and a paste field. SAVE posts to /api/setup/keys, which writes the
 * repo-root .env and restarts the dev server — Vite's client then reloads the
 * page itself, and the pasted key is simply *on*. No hand-edited env files.
 *
 * The surface self-destructs where it cannot work: a prod build (no endpoint)
 * or a LAN visitor (loopback-only endpoint) fails the status fetch, and both
 * the chip and the dialog are removed outright.
 */

/** Chip label — pure, exported for tests. */
export function keySetupChipLabel(status) {
  const missing = Math.max(0, (status?.total || 0) - (status?.setCount || 0));
  return missing > 0
    ? `POWER UP · ${missing} ${missing === 1 ? 'KEY' : 'KEYS'} WAITING`
    : 'POWERED UP';
}

/**
 * Collect a POST body from field descriptors — pure, exported for tests.
 * @param {Array<{envVar: string, value: string}>} fields
 * @returns {Record<string, string>} non-empty trimmed values only
 */
export function collectKeyUpdates(fields) {
  const updates = {};
  for (const field of fields || []) {
    const value = String(field?.value ?? '').trim();
    if (value && field?.envVar) updates[field.envVar] = value;
  }
  return updates;
}

/**
 * Collect the local-LLM settings the panel is changing — pure, exported for
 * tests.
 *
 * Only DIFFERENCES are sent. The fields render the EFFECTIVE configuration
 * (including defaults nobody saved), so submitting them wholesale would turn
 * every default into an explicit override on the first save. A field cleared
 * to empty means "back to the default", which the store expresses as a
 * removal (null). Externally-supplied values are reported, never rewritten.
 * @param {Array<{envVar: string, value: string, initial: string, managed?: string|null}>} fields
 * @returns {Record<string, string|null>}
 */
export function collectLlmUpdates(fields) {
  const updates = {};
  for (const field of fields || []) {
    if (!field?.envVar || field.managed === 'external') continue;
    const value = String(field.value ?? '').trim();
    if (value === String(field.initial ?? '').trim()) continue;
    updates[field.envVar] = value === '' ? null : value;
  }
  return updates;
}

/** One honest line about the configured text backend — pure, for tests. */
export function llmSummaryLine(llm) {
  if (!llm) return '';
  const provider = (llm.providers || []).find(
    (candidate) => candidate.id === llm.provider,
  );
  const label = provider?.label || String(llm.provider || '').toUpperCase();
  if (provider?.kind !== 'local') {
    return llm.apiKeyPresent
      ? `${label} runs the AI HUD summary and voice control.`
      : `${label} selected — add OPENAI_API_KEY above to switch it on.`;
  }
  return `${label} at ${llm.baseUrl} runs the AI HUD summary. Voice control stays on OpenAI — local models cannot serve the Realtime speech API.`;
}

/** Render a /api/llm/status probe as one line — pure, exported for tests. */
export function llmProbeLine(payload) {
  const where =
    payload?.probed?.endpoint || payload?.probed?.baseUrl || 'the model server';
  if (!payload?.reachable) {
    return `UNREACHABLE · ${payload?.error || 'no answer'} (${where}). Nothing else is affected.`;
  }
  const models = Array.isArray(payload?.models) ? payload.models : [];
  if (!models.length) {
    return `REACHABLE · ${where} answered but listed no models.`;
  }
  const shown = models.slice(0, 6).join(', ');
  return `REACHABLE · ${models.length} model${models.length === 1 ? '' : 's'}: ${shown}${models.length > 6 ? ' …' : ''}`;
}

/**
 * After the FIRST Google key lands, the restart's reload should boot the
 * photoreal default — not faithfully restore the auto-selected keyless OSM
 * basemap from the URL's live share hash. Strips only `map=osm`: a stack under
 * any other name was chosen or shared on purpose and survives, and so does
 * everything else in the hash (camera, style, layers). Pure, exported for tests.
 * @param {string} hash Location hash without the leading '#'.
 * @returns {string|null} The rewritten hash, or null when there is nothing to strip.
 */
export function stripKeylessBasemapFromHash(hash) {
  if (!hash) return null;
  try {
    const params = new URLSearchParams(hash);
    if (!['osm', 'esri-imagery'].includes(params.get('map'))) return null;
    params.delete('map');
    return params.toString();
  } catch {
    return null;
  }
}

const TIER_DOTS = Object.freeze({ metered: '🔴', free: '🟡' });

/** Build one key row. All content is our own registry text, set via textContent. */
function buildRow(documentRef, key) {
  const row = documentRef.createElement('section');
  row.className = 'key-setup-row';
  row.dataset.keyId = key.id;
  row.dataset.set = String(Boolean(key.set));
  if (key.managed) row.dataset.managed = key.managed;
  const external = key.managed === 'external';

  const head = documentRef.createElement('div');
  head.className = 'key-setup-row-head';
  const led = documentRef.createElement('span');
  led.className = 'key-setup-led';
  led.setAttribute('aria-hidden', 'true');
  const title = documentRef.createElement('strong');
  title.textContent = key.title;
  const tier = documentRef.createElement('span');
  tier.className = 'key-setup-tier';
  tier.textContent = TIER_DOTS[key.tier] || '';
  tier.title =
    key.tier === 'metered'
      ? 'Metered — a billing-enabled account'
      : 'Free key — register, paste, done';
  head.append(led, title, tier);
  if (key.clientExposed) {
    const exposed = documentRef.createElement('span');
    exposed.className = 'key-setup-exposed';
    exposed.textContent = 'browser-side';
    exposed.title =
      'This key runs in the browser by design — restrict it at the provider (see SECURITY.md)';
    head.append(exposed);
  }
  if (external) {
    // Externally supplied credentials (shell env, Keychain, a launcher) are
    // facts this panel reports, never values it rewrites or deletes.
    const badge = documentRef.createElement('span');
    badge.className = 'key-setup-external';
    badge.textContent = 'configured externally';
    badge.title =
      'Supplied by your environment, Keychain, or launcher — change it where it was set';
    head.append(badge);
  }
  const get = documentRef.createElement('a');
  get.className = 'key-setup-get';
  get.href = key.getUrl;
  get.target = '_blank';
  get.rel = 'noopener noreferrer';
  get.textContent = key.set ? 'MANAGE ↗' : 'GET KEY ↗';
  head.append(get);

  const unlocks = documentRef.createElement('p');
  unlocks.className = 'key-setup-unlocks';
  unlocks.textContent = key.unlocks;

  row.append(head, unlocks);
  if (!external) {
    const fields = documentRef.createElement('div');
    fields.className = 'key-setup-fields';
    for (const envVar of key.envVars) {
      const input = documentRef.createElement('input');
      // Passwords-style so a pasted key never shows on a shared or recorded
      // screen — this app gets screen-recorded a lot.
      input.type = 'password';
      input.autocomplete = 'off';
      input.spellcheck = false;
      input.dataset.envVar = envVar;
      input.setAttribute('aria-label', envVar);
      input.placeholder = key.set
        ? `${envVar} saved — paste to replace`
        : `paste ${envVar}`;
      fields.append(input);
    }
    if (key.managed === 'file') {
      const remove = documentRef.createElement('button');
      remove.type = 'button';
      remove.className = 'key-setup-remove';
      remove.dataset.keySetupRemove = JSON.stringify(key.envVars);
      remove.textContent = 'REMOVE';
      remove.title = `Remove ${key.title} from this app's saved keys`;
      fields.append(remove);
    }
    row.append(fields);
  }
  return row;
}

/** One labelled control in the local-LLM section. */
function buildLlmField(documentRef, { envVar, label, hint, managed, control }) {
  const wrapper = documentRef.createElement('label');
  wrapper.className = 'key-setup-llm-field';
  const caption = documentRef.createElement('span');
  caption.className = 'key-setup-llm-label';
  caption.textContent = label;
  wrapper.append(caption);
  if (managed === 'external') {
    const badge = documentRef.createElement('span');
    badge.className = 'key-setup-external';
    badge.textContent = 'configured externally';
    badge.title =
      'Supplied by your environment, Keychain, or launcher — change it where it was set';
    caption.append(' ', badge);
    control.disabled = true;
  }
  control.dataset.llmEnvVar = envVar;
  control.dataset.llmManaged = managed || '';
  control.setAttribute('aria-label', envVar);
  wrapper.append(control);
  if (hint) {
    const note = documentRef.createElement('span');
    note.className = 'key-setup-llm-hint';
    note.textContent = hint;
    wrapper.append(note);
  }
  return wrapper;
}

/**
 * Build the local-LLM controls from the status payload. Every control records
 * the value it rendered with in `data-llm-initial`, which is what makes the
 * save a diff rather than a wholesale rewrite of the defaults.
 */
function buildLlmFields(documentRef, llm) {
  const managed = llm.managed || {};
  const providers = llm.providers || [];
  const fragment = documentRef.createDocumentFragment();

  const provider = documentRef.createElement('select');
  provider.className = 'key-setup-llm-select';
  for (const entry of providers) {
    const option = documentRef.createElement('option');
    option.value = entry.id;
    option.textContent = `${entry.label} — ${entry.blurb}`;
    provider.append(option);
  }
  provider.value = llm.provider;
  provider.dataset.llmInitial = provider.value;
  fragment.append(
    buildLlmField(documentRef, {
      envVar: llm.envVars.provider,
      label: 'PROVIDER',
      hint: 'openai is the default and the only one that can also do voice.',
      managed: managed[llm.envVars.provider],
      control: provider,
    }),
  );

  const baseUrl = documentRef.createElement('input');
  baseUrl.type = 'text';
  baseUrl.autocomplete = 'off';
  baseUrl.spellcheck = false;
  baseUrl.value = llm.baseUrl || '';
  baseUrl.placeholder = 'http://localhost:11434';
  baseUrl.dataset.llmInitial = baseUrl.value;
  fragment.append(
    buildLlmField(documentRef, {
      envVar: llm.envVars.baseUrl,
      label: 'BASE URL',
      hint: 'Ollama listens on 11434, llama-server on 8080. Clear the field to restore the default.',
      managed: managed[llm.envVars.baseUrl],
      control: baseUrl,
    }),
  );

  const model = documentRef.createElement('input');
  model.type = 'text';
  model.autocomplete = 'off';
  model.spellcheck = false;
  model.value = llm.model || '';
  model.placeholder = 'model id — run TEST CONNECTION to list them';
  model.setAttribute('list', 'key-setup-llm-models');
  model.dataset.llmInitial = model.value;
  fragment.append(
    buildLlmField(documentRef, {
      envVar: llm.envVars.model,
      label: 'MODEL',
      hint: 'Pick from the tested server, or type one it has pulled.',
      managed: managed[llm.envVars.model],
      control: model,
    }),
  );

  return { fragment, provider, baseUrl, model };
}

/**
 * Wire the chip + dialog. Fire-and-forget from main.js; resolves to null when
 * the surface has no business existing (prod build, LAN visitor, no markup).
 */
export async function initKeySetup({
  documentRef = globalThis.document,
  fetchImpl,
  signal,
} = {}) {
  const chip = documentRef?.getElementById?.('key-setup-chip');
  const root = documentRef?.getElementById?.('key-setup');
  if (!chip || !root || root.dataset.initialized === 'true') return null;
  root.dataset.initialized = 'true';
  const lifetime = new AbortController();
  let disposed = false;
  let disposeControls = () => {};
  const destroy = () => {
    if (disposed) return;
    disposed = true;
    lifetime.abort();
    signal?.removeEventListener('abort', destroy);
    disposeControls();
    chip.remove();
    root.remove();
  };
  if (signal?.aborted) {
    destroy();
    return null;
  }
  signal?.addEventListener('abort', destroy, { once: true });
  const doFetch = fetchImpl || globalThis.fetch?.bind(globalThis);

  let status = null;
  try {
    const response = await doFetch('/api/setup/status', {
      cache: 'no-store',
      signal: lifetime.signal,
    });
    if (!response.ok) throw new Error(String(response.status));
    status = await response.json();
    if (disposed) return null;
  } catch {
    // Prod build or non-loopback visitor: the surface cannot function, so it
    // does not exist. (The README covers .env for headless/self-host setups.)
    destroy();
    return null;
  }

  const rowsHost = root.querySelector('[data-key-setup-rows]');
  const applyButton = root.querySelector('[data-key-setup-apply]');
  const closeButton = root.querySelector('[data-key-setup-close]');
  const chipLabel = chip.querySelector('[data-key-setup-chip-label]') || chip;
  const statusLine = root.querySelector('[data-key-setup-status]');
  const defaultStatusText = statusLine?.textContent || '';
  let busy = false;
  let open = false;

  const llmHost = root.querySelector('[data-key-setup-llm]');
  const llmFieldsHost = root.querySelector('[data-key-setup-llm-fields]');
  const llmModelList = root.querySelector('[data-key-setup-llm-models]');
  const llmNote = root.querySelector('[data-key-setup-llm-note]');
  const llmTestButton = root.querySelector('[data-key-setup-llm-test]');
  let llmBusy = false;
  let llmControls = null;

  const sayLlm = (text) => {
    if (llmNote) llmNote.textContent = text;
  };

  /** Replace the model datalist with what the probe actually reported. */
  const fillLlmModels = (models) => {
    if (!llmModelList) return;
    llmModelList.textContent = '';
    for (const name of Array.isArray(models) ? models : []) {
      const option = documentRef.createElement('option');
      option.value = name;
      llmModelList.append(option);
    }
  };

  const renderLlm = (llm) => {
    if (!llmHost) return;
    // An older/other server that does not report an llm block: the section
    // has nothing to configure, so it does not exist.
    if (!llm?.envVars) {
      llmHost.remove();
      llmControls = null;
      return;
    }
    llmHost.hidden = false;
    if (!llmFieldsHost) return;
    llmFieldsHost.textContent = '';
    llmControls = buildLlmFields(documentRef, llm);
    llmFieldsHost.append(llmControls.fragment);
    sayLlm(llmSummaryLine(llm));
    // Switching provider should move the base URL and model to that
    // provider's defaults — but only while they still hold a default, never
    // over something typed or saved.
    let previous = llm.provider;
    llmControls.provider.addEventListener(
      'change',
      () => {
        const next = (llm.providers || []).find(
          (candidate) => candidate.id === llmControls.provider.value,
        );
        const before = (llm.providers || []).find(
          (candidate) => candidate.id === previous,
        );
        if (!next) return;
        const replaceable = (element, was) =>
          element.value.trim() === '' || element.value.trim() === (was || '');
        if (replaceable(llmControls.baseUrl, before?.defaultBaseUrl))
          llmControls.baseUrl.value = next.defaultBaseUrl;
        if (replaceable(llmControls.model, before?.defaultModel))
          llmControls.model.value = next.defaultModel;
        previous = next.id;
        sayLlm(
          llmSummaryLine({
            ...llm,
            provider: next.id,
            baseUrl: llmControls.baseUrl.value,
          }),
        );
      },
      { signal: lifetime.signal },
    );
  };

  /** Probe whatever is currently typed, without saving it first. */
  const onTestLlm = async () => {
    if (disposed || llmBusy || !llmControls) return;
    llmBusy = true;
    llmTestButton?.setAttribute('aria-disabled', 'true');
    sayLlm('Testing…');
    try {
      const params = new URLSearchParams();
      const provider = llmControls.provider.value.trim();
      const baseUrl = llmControls.baseUrl.value.trim();
      if (provider) params.set('provider', provider);
      if (baseUrl) params.set('baseUrl', baseUrl);
      const response = await doFetch(`/api/llm/status?${params.toString()}`, {
        cache: 'no-store',
        signal: lifetime.signal,
      });
      const payload = await response.json().catch(() => ({}));
      if (disposed) return;
      if (!response.ok) {
        sayLlm(payload.error || `Test failed (${response.status}).`);
        return;
      }
      fillLlmModels(payload.models);
      sayLlm(llmProbeLine(payload));
    } catch (error) {
      // A failed probe is information, never a broken panel.
      sayLlm(`Test failed: ${error?.message || error}`);
    } finally {
      llmBusy = false;
      llmTestButton?.setAttribute('aria-disabled', 'false');
    }
  };

  /** The current local-LLM field values, as collectLlmUpdates wants them. */
  const llmFieldStates = () =>
    llmControls
      ? [llmControls.provider, llmControls.baseUrl, llmControls.model].map(
          (element) => ({
            envVar: element.dataset.llmEnvVar,
            value: element.value,
            initial: element.dataset.llmInitial,
            managed: element.dataset.llmManaged || null,
          }),
        )
      : [];

  const render = (nextStatus) => {
    if (disposed) return;
    status = nextStatus;
    chipLabel.textContent = keySetupChipLabel(status);
    // Fully powered is the owner's clean screen: the chip retires. The dialog
    // stays reachable this session (and via ?setup=1) to swap or verify keys.
    chip.hidden = status.setCount >= status.total;
    renderLlm(status.llm);
    if (!rowsHost) return;
    rowsHost.textContent = '';
    for (const key of status.keys || [])
      rowsHost.append(buildRow(documentRef, key));
  };

  const visible = () =>
    root.isConnected &&
    root.classList.contains('visible') &&
    root.getClientRects().length > 0;

  const keyboard = createSurfaceKeyboard({
    root,
    documentRef,
    isActive: () => open && visible(),
    onEscape: () => close(),
  });

  const openDialog = () => {
    if (disposed || open) return;
    open = true;
    keyboard.activate();
    root.hidden = false;
    globalThis.requestAnimationFrame?.(() => {
      if (!open) return;
      root.classList.add('visible');
      root.querySelector('input')?.focus?.({ preventScroll: true });
    });
  };

  const close = () => {
    if (!open) return;
    open = false;
    root.classList.remove('visible');
    const hide = () => {
      if (!open) root.hidden = true;
    };
    root.addEventListener('transitionend', hide, { once: true });
    globalThis.setTimeout?.(hide, 400);
    if (statusLine) statusLine.textContent = defaultStatusText;
    keyboard.deactivate({ restoreFocus: true });
  };

  const say = (text) => {
    if (statusLine) statusLine.textContent = text;
  };

  const storeLabel = () =>
    status?.store === 'pinokio-environment'
      ? 'your app configuration'
      : 'your local .env';

  const submitUpdates = async (updates, doneVerb) => {
    if (disposed || busy) return;
    const googleWasUnset = !status?.keys?.find(
      (key) => key.id === 'google-maps',
    )?.set;
    busy = true;
    applyButton?.setAttribute('aria-disabled', 'true');
    say('Saving…');
    try {
      const response = await doFetch('/api/setup/keys', {
        method: 'POST',
        signal: lifetime.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      });
      const payload = await response.json().catch(() => ({}));
      if (disposed) return;
      if (!response.ok || !payload.ok) {
        say(payload.error || `Save failed (${response.status}).`);
        return;
      }
      for (const input of root.querySelectorAll('input[data-env-var]'))
        input.value = '';
      render(payload.status);
      if (googleWasUnset && payload.saved?.includes('GOOGLE_MAPS_API_KEY')) {
        const strip = () => {
          try {
            const next = stripKeylessBasemapFromHash(
              globalThis.location?.hash?.slice(1) || '',
            );
            if (next !== null)
              globalThis.history?.replaceState?.(null, '', `#${next}`);
          } catch {
            // Continuity is a nicety, never a blocker.
          }
        };
        strip();
        // The live share writer may re-serialize the still-OSM stack before
        // the restart's reload lands, so strip again at the door.
        globalThis.addEventListener?.('pagehide', strip, {
          once: true,
          signal: lifetime.signal,
        });
      }
      say(
        `${doneVerb} ${storeLabel()}. Restarting — this page reloads itself.`,
      );
    } catch (error) {
      say(`Save failed: ${error?.message || error}`);
    } finally {
      busy = false;
      applyButton?.setAttribute('aria-disabled', 'false');
    }
  };

  const onApply = async () => {
    if (disposed || busy) return;
    const inputs = [...root.querySelectorAll('input[data-env-var]')];
    const updates = {
      ...collectKeyUpdates(
        inputs.map((input) => ({
          envVar: input.dataset.envVar,
          value: input.value,
        })),
      ),
      ...collectLlmUpdates(llmFieldStates()),
    };
    if (!Object.keys(updates).length) {
      say('Paste a key or change a text-model setting first.');
      return;
    }
    await submitUpdates(updates, 'Saved to');
  };

  chip.addEventListener('click', openDialog);
  closeButton?.addEventListener('click', close);
  applyButton?.addEventListener('click', onApply);
  llmTestButton?.addEventListener('click', onTestLlm);
  // Remove buttons are rendered per row; delegate so re-renders stay wired.
  rowsHost?.addEventListener('click', (event) => {
    const button = event.target?.closest?.('[data-key-setup-remove]');
    if (disposed || !button || busy) return;
    let envVars = [];
    try {
      envVars = JSON.parse(button.dataset.keySetupRemove || '[]');
    } catch {
      return;
    }
    if (!Array.isArray(envVars) || !envVars.length) return;
    // Removal is destructive and — behind a framing defense that should already
    // stop it — a clickjack target. A confirm turns a single aligned click into
    // a deliberate two-step the lure cannot pre-satisfy.
    const ok =
      typeof globalThis.confirm !== 'function' ||
      globalThis.confirm('Remove this key from your saved configuration?');
    if (!ok) return;
    void submitUpdates(
      Object.fromEntries(envVars.map((name) => [name, null])),
      'Removed from',
    );
  });

  render(status);

  // Re-entry for a fully-keyed setup, demos, and support: ?setup=1 opens the
  // dialog even though the chip has retired.
  try {
    if (
      new URLSearchParams(globalThis.location?.search || '').get('setup') ===
      '1'
    )
      openDialog();
  } catch {
    // An unparsable location never blocks init.
  }

  disposeControls = () => {
    open = false;
    keyboard.destroy();
    chip.removeEventListener('click', openDialog);
    closeButton?.removeEventListener('click', close);
    applyButton?.removeEventListener('click', onApply);
    llmTestButton?.removeEventListener('click', onTestLlm);
  };
  return { open: openDialog, close, render, destroy };
}
