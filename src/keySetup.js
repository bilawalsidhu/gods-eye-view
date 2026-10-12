import { createSurfaceKeyboard } from './ui/surfaceKeyboard.js';
import {
  API_BASE_STORAGE_KEY,
  resolveApiBase,
  storedApiBase,
} from './mobile/runtimeConfig.js';
import { readApiBase, writeApiBase } from './mobile/keyStore.js';
import {
  readStoredCloudVoiceAuthMode,
  writeStoredCloudVoiceAuthMode,
} from './voice/cloudVoiceAuth.js';

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

function sleepWithSignal(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason || new DOMException('Aborted', 'AbortError'));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason || new DOMException('Aborted', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export async function waitForChatGptOAuth({
  fetchImpl,
  signal,
  timeoutMs = 120_000,
  pollMs = 1_000,
  now = () => Date.now(),
  sleep = sleepWithSignal,
} = {}) {
  const deadline = now() + Math.max(0, timeoutMs);
  while (!signal?.aborted && now() <= deadline) {
    const response = await fetchImpl('/api/realtime/oauth-status', {
      cache: 'no-store',
      signal,
    });
    const payload = await response.json().catch(() => ({}));
    if (signal?.aborted) return false;
    if (response.ok && payload.available) return true;
    if (!response.ok || payload.loginFailed) {
      throw new Error(
        payload.error || 'Could not check ChatGPT sign-in. Try again.',
      );
    }
    if (now() >= deadline) break;
    await sleep(Math.max(0, pollMs), signal);
  }
  return false;
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

function updateCloudVoiceAuthControl(auth, busy = false) {
  const mode = readStoredCloudVoiceAuthMode();
  const state = auth.querySelector('.key-setup-cloud-auth-state');
  const toggle = auth.querySelector('[data-cloud-voice-auth-toggle]');
  state.textContent =
    mode === 'oauth' ? 'VOICE AUTH · CHATGPT OAUTH' : 'VOICE AUTH · API KEY';
  toggle.textContent = mode === 'oauth' ? 'USE API KEY' : 'USE CHATGPT OAUTH';
  toggle.title =
    mode === 'oauth'
      ? 'Use OPENAI_API_KEY for the next cloud voice session'
      : 'Use the signed-in local ChatGPT/Codex OAuth session for the next cloud voice session';
  // Keep the control focusable while the delegated handler blocks repeats.
  toggle.setAttribute('aria-disabled', String(busy));
}

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
  if (key.id === 'openai') {
    const auth = documentRef.createElement('div');
    auth.className = 'key-setup-cloud-auth';
    const state = documentRef.createElement('span');
    state.className = 'key-setup-cloud-auth-state';
    const toggle = documentRef.createElement('button');
    toggle.type = 'button';
    toggle.className = 'key-setup-cloud-auth-toggle';
    toggle.dataset.cloudVoiceAuthToggle = 'true';
    auth.append(state, toggle);
    updateCloudVoiceAuthControl(auth);
    row.append(auth);
  }
  return row;
}

/** Move the existing setup action with the theme, retaining its listeners. */
export function bindKeySetupPlacement(documentRef, chip, root) {
  const theme = documentRef?.documentElement;
  const toolbar = documentRef?.getElementById?.('top-center-actions');
  const Observer = documentRef?.defaultView?.MutationObserver;
  if (!theme || !toolbar || !Observer) return () => {};
  const sync = () => {
    if (theme.dataset.uiTheme === 'cyber') {
      if (chip.parentNode !== toolbar) toolbar.append(chip);
    } else if (chip.parentNode !== root.parentNode) {
      root.before(chip);
    }
  };
  const observer = new Observer(sync);
  observer.observe(theme, {
    attributes: true,
    attributeFilter: ['data-ui-theme'],
  });
  sync();
  return () => observer.disconnect();
}

/** Capacitor branch of Provider Settings — the backend URL field. */

const BACKEND_URL_PLACEHOLDER = 'https://gev-backend.example';

/**
 * Whether the app runs inside a Capacitor shell. The native shell injects
 * `window.Capacitor`; plain web never has it, so web behavior stays identical.
 * @param {object|null|undefined} host `window`-like host (`document.defaultView`).
 * @returns {boolean} True only under Capacitor.
 */
export function isCapacitorHost(host = globalThis.window) {
  return Boolean(host?.Capacitor);
}

/**
 * `localStorage`-backed adapter with the Capacitor Preferences shape, used
 * when the Preferences plugin cannot load. The WebView keeps `localStorage`,
 * and the boot seam (`storedApiBase`) reads it, so this is a safe fallback.
 * @returns {{ get: Function, set: Function, remove: Function }} Preferences-shaped store.
 */
export function localApiBaseStorage() {
  const readLocal = () => {
    try {
      const storage = globalThis.localStorage;
      if (!storage || typeof storage.getItem !== 'function') return null;
      return storage.getItem(API_BASE_STORAGE_KEY);
    } catch {
      return null;
    }
  };
  return {
    get: async ({ key }) =>
      key === API_BASE_STORAGE_KEY ? { value: readLocal() } : { value: null },
    set: async ({ key, value }) => {
      if (key !== API_BASE_STORAGE_KEY) return;
      try {
        globalThis.localStorage?.setItem?.(key, String(value));
      } catch {
        // A locked-down WebView stays Preferences-only; the write above either
        // landed in Preferences already or the caller surfaces the failure.
      }
    },
    remove: async ({ key }) => {
      if (key !== API_BASE_STORAGE_KEY) return;
      try {
        globalThis.localStorage?.removeItem?.(key);
      } catch {
        // Same as set: never let a mirror failure mask the primary write.
      }
    },
  };
}

/**
 * Load the production store for the Capacitor branch: the real Preferences
 * plugin (dynamically imported so the web bundle never fetches it), falling
 * back to the `localStorage` adapter.
 * @returns {Promise<{ get: Function, set: Function, remove: Function }>} Preferences-shaped store.
 */
async function loadDefaultCapacitorStorage() {
  try {
    const { Preferences } = await import('@capacitor/preferences');
    if (
      Preferences &&
      typeof Preferences.get === 'function' &&
      typeof Preferences.set === 'function' &&
      typeof Preferences.remove === 'function'
    )
      return Preferences;
  } catch {
    // Gated import failure (tests, SSR): fall through to the local adapter.
  }
  return localApiBaseStorage();
}

/**
 * Mirror the resolved backend base into `localStorage` so the existing boot
 * seam (`storedApiBase`, read by the standalone catalog/scene) picks it up on
 * reload without any change to those call sites.
 * @param {string} resolved Base already resolved via `resolveApiBase`.
 * @returns {void}
 */
export function mirrorApiBaseToLocalStorage(resolved) {
  try {
    const storage = globalThis.localStorage;
    if (!storage) return;
    if (typeof storage.setItem !== 'function') return;
    if (resolved) storage.setItem(API_BASE_STORAGE_KEY, resolved);
    else storage.removeItem?.(API_BASE_STORAGE_KEY);
  } catch {
    // Private-mode WebViews stay Preferences-only; boot still reads '' there.
  }
}

/**
 * Build the backend URL row for the Capacitor branch. Same row CSS as key
 * rows, but it is a device setting (no provider link, no REMOVE button).
 * @param {Document} documentRef Document used to create elements.
 * @param {string} currentBase Currently stored base, or `''` when unset.
 * @returns {HTMLElement} The row element, carrying its input.
 */
export function buildBackendUrlRow(documentRef, currentBase = '') {
  const row = documentRef.createElement('section');
  row.className = 'key-setup-row';
  row.dataset.keyId = 'backend-url';
  row.dataset.set = String(Boolean(currentBase));
  const head = documentRef.createElement('div');
  head.className = 'key-setup-row-head';
  const title = documentRef.createElement('strong');
  title.textContent = 'Backend URL';
  head.append(title);
  const unlocks = documentRef.createElement('p');
  unlocks.className = 'key-setup-unlocks';
  unlocks.textContent =
    'The server this app talks to — your home machine or LAN host. Saved on this device only, never bundled.';
  const fields = documentRef.createElement('div');
  fields.className = 'key-setup-fields';
  const input = documentRef.createElement('input');
  input.type = 'password';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.dataset.envVar = API_BASE_STORAGE_KEY;
  input.setAttribute('aria-label', API_BASE_STORAGE_KEY);
  input.placeholder = BACKEND_URL_PLACEHOLDER;
  input.value = currentBase;
  fields.append(input);
  row.append(head, unlocks, fields);
  return row;
}

/**
 * Render the Capacitor-only backend URL surface: the dev-server status fetch
 * cannot succeed inside the shell, so instead of removing Provider Settings
 * outright, show just the `GEV_API_BASE` field. Saving persists via the
 * injected Preferences-shaped store, mirrors to `localStorage` for the boot
 * seam, and reloads so services rebuild with the new endpoints.
 * @param {object} options
 * @param {Document} [options.documentRef] Document hosting the surface.
 * @param {HTMLElement} [options.chip] Setup chip button.
 * @param {HTMLElement} [options.root] Setup dialog root.
 * @param {{ get: Function, set: Function, remove: Function }} options.storage Injected Preferences-shaped store.
 * @param {() => void} [options.reload] Reload hook (defaults to page reload).
 * @param {Function} [options.readImpl] `readApiBase` override for tests.
 * @param {Function} [options.writeImpl] `writeApiBase` override for tests.
 * @returns {Promise<{ open: Function, close: Function, dispose: Function }|null>} Controls, or null when there is no surface to wire.
 */
export async function initCapacitorBackendSetup({
  documentRef = globalThis.document,
  chip = documentRef?.getElementById?.('key-setup-chip'),
  root = documentRef?.getElementById?.('key-setup'),
  storage,
  reload = () => globalThis.location?.reload?.(),
  readImpl = readApiBase,
  writeImpl = writeApiBase,
} = {}) {
  if (!chip || !root || !storage) return null;
  let current = '';
  try {
    current = await readImpl(storage);
  } catch {
    current = '';
  }
  if (!current) {
    try {
      current = storedApiBase();
    } catch {
      current = '';
    }
  }
  const chipLabel = chip.querySelector?.('[data-key-setup-chip-label]') || chip;
  if (chipLabel) chipLabel.textContent = 'SET BACKEND';
  chip.title = 'Backend URL: the server this app talks to';
  chip.setAttribute?.(
    'aria-label',
    'Backend URL: the server this app talks to',
  );
  chip.hidden = false;
  const rowsHost = root.querySelector?.('[data-key-setup-rows]');
  const applyButton = root.querySelector?.('[data-key-setup-apply]');
  const closeButton = root.querySelector?.('[data-key-setup-close]');
  const statusLine = root.querySelector?.('[data-key-setup-status]');
  const defaultStatusText = statusLine?.textContent || '';
  if (rowsHost) {
    rowsHost.textContent = '';
    rowsHost.append(buildBackendUrlRow(documentRef, current));
  }
  let open = false;
  let busy = false;
  const say = (text) => {
    if (statusLine) statusLine.textContent = text;
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
    if (open) return;
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
  const onApply = async () => {
    if (busy) return;
    const input = root.querySelector?.(
      `input[data-env-var="${API_BASE_STORAGE_KEY}"]`,
    );
    const value = String(input?.value ?? '').trim();
    busy = true;
    applyButton?.setAttribute?.('aria-disabled', 'true');
    say('Saving…');
    try {
      await writeImpl(storage, value);
      mirrorApiBaseToLocalStorage(resolveApiBase(value));
      say('Backend saved — reloading against it.');
      reload();
    } catch (error) {
      say(`Save failed: ${error?.message || error}`);
    } finally {
      busy = false;
      applyButton?.setAttribute?.('aria-disabled', 'false');
    }
  };
  chip.addEventListener?.('click', openDialog);
  closeButton?.addEventListener?.('click', close);
  applyButton?.addEventListener?.('click', onApply);
  say(
    defaultStatusText ||
      'Set the server URL, save, and the app reloads against it.',
  );
  const dispose = () => {
    open = false;
    keyboard.destroy?.();
    chip.removeEventListener?.('click', openDialog);
    closeButton?.removeEventListener?.('click', close);
    applyButton?.removeEventListener?.('click', onApply);
  };
  return { open: openDialog, close, dispose };
}

/** Wire the dev-only setup surface; unavailable endpoints remove it entirely. */
export async function initKeySetup({
  documentRef = globalThis.document,
  fetchImpl,
  signal,
  apiBaseStorage = null,
  reloadImpl = null,
} = {}) {
  const chip = documentRef?.getElementById?.('key-setup-chip');
  const root = documentRef?.getElementById?.('key-setup');
  if (!chip || !root || root.dataset.initialized === 'true') return null;
  root.dataset.initialized = 'true';
  const lifetime = new AbortController();
  let disposed = false;
  let disposeControls = () => {};
  let disposePlacement = () => {};
  const destroy = () => {
    if (disposed) return;
    disposed = true;
    lifetime.abort();
    signal?.removeEventListener('abort', destroy);
    disposeControls();
    disposePlacement();
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
    // Under Capacitor there is no dev server to answer /api/setup/status, so
    // a failed status fetch is expected: offer just the backend URL field
    // instead of removing Provider Settings. Web behavior is unchanged (the
    // surface is removed outright).
    if (isCapacitorHost(documentRef?.defaultView ?? globalThis.window)) {
      let backend = null;
      try {
        backend = await initCapacitorBackendSetup({
          documentRef,
          chip,
          root,
          storage: apiBaseStorage ?? (await loadDefaultCapacitorStorage()),
          reload: reloadImpl ?? (() => globalThis.location?.reload?.()),
        });
      } catch {
        backend = null;
      }
      if (!backend) {
        destroy();
        return null;
      }
      disposeControls = backend.dispose;
      disposePlacement = bindKeySetupPlacement(documentRef, chip, root);
      return { open: backend.open, close: backend.close, destroy };
    }
    // Prod build or non-loopback visitor: the surface cannot function, so it
    // does not exist. (The README covers .env for headless/self-host setups.)
    destroy();
    return null;
  }

  const rowsHost = root.querySelector('[data-key-setup-rows]');
  disposePlacement = bindKeySetupPlacement(documentRef, chip, root);
  const applyButton = root.querySelector('[data-key-setup-apply]');
  const closeButton = root.querySelector('[data-key-setup-close]');
  const chipLabel = chip.querySelector('[data-key-setup-chip-label]') || chip;
  const statusLine = root.querySelector('[data-key-setup-status]');
  const defaultStatusText = statusLine?.textContent || '';
  let busy = false;
  let oauthBusy = false;
  let open = false;

  const syncCloudVoiceAuth = () => {
    for (const auth of rowsHost.querySelectorAll('.key-setup-cloud-auth'))
      updateCloudVoiceAuthControl(auth, oauthBusy);
  };

  const render = (nextStatus) => {
    if (disposed) return;
    status = nextStatus;
    chipLabel.textContent = keySetupChipLabel(status);
    chip.title = `Project keys: ${keySetupChipLabel(status)}`;
    chip.setAttribute('aria-label', chip.title);
    // Fully powered is the owner's clean screen: the chip retires. The dialog
    // stays reachable this session (and via ?setup=1) to swap or verify keys.
    chip.hidden = status.setCount >= status.total;
    if (!rowsHost) return;
    rowsHost.textContent = '';
    for (const key of status.keys || [])
      rowsHost.append(buildRow(documentRef, key));
    syncCloudVoiceAuth();
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
              globalThis.history?.replaceState?.(
                null,
                '',
                new URL(`#${next}`, globalThis.location.href).href,
              );
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
    const updates = collectKeyUpdates(
      inputs.map((input) => ({
        envVar: input.dataset.envVar,
        value: input.value,
      })),
    );
    if (!Object.keys(updates).length) {
      say('Paste at least one key first.');
      return;
    }
    await submitUpdates(updates, 'Saved to');
  };

  chip.addEventListener('click', openDialog);
  closeButton?.addEventListener('click', close);
  applyButton?.addEventListener('click', onApply);
  // Remove buttons are rendered per row; delegate so re-renders stay wired.
  rowsHost?.addEventListener('click', (event) => {
    const authButton = event.target?.closest?.(
      '[data-cloud-voice-auth-toggle]',
    );
    if (authButton && !disposed) {
      if (oauthBusy) return;
      void (async () => {
        const current = readStoredCloudVoiceAuthMode();
        if (current === 'oauth') {
          writeStoredCloudVoiceAuthMode('api-key');
          syncCloudVoiceAuth();
          say('Cloud voice will use OPENAI_API_KEY on the next session.');
          return;
        }
        oauthBusy = true;
        syncCloudVoiceAuth();
        say('Checking local ChatGPT OAuth sign-in…');
        try {
          const response = await doFetch('/api/realtime/oauth-status', {
            cache: 'no-store',
            signal: lifetime.signal,
          });
          const payload = await response.json().catch(() => ({}));
          if (lifetime.signal.aborted) return;
          if (!response.ok)
            throw new Error(
              payload.error || 'Could not check ChatGPT sign-in.',
            );
          if (payload.available) {
            writeStoredCloudVoiceAuthMode('oauth');
            syncCloudVoiceAuth();
            say(
              'ChatGPT OAuth selected for cloud voice. Your API key stays saved and available.',
            );
            return;
          }

          say(
            payload.code === 'CODEX_OAUTH_REAUTH_REQUIRED'
              ? 'ChatGPT sign-in expired. Opening sign-in again…'
              : 'Opening ChatGPT sign-in in your browser…',
          );
          const loginResponse = await doFetch('/api/realtime/oauth-login', {
            method: 'POST',
            cache: 'no-store',
            signal: lifetime.signal,
          });
          const loginPayload = await loginResponse.json().catch(() => ({}));
          if (lifetime.signal.aborted) return;
          if (!loginResponse.ok) {
            say(
              loginPayload.error ||
                payload.error ||
                'Could not start ChatGPT sign-in on this machine.',
            );
            return;
          }
          if (loginPayload.available) {
            writeStoredCloudVoiceAuthMode('oauth');
            syncCloudVoiceAuth();
            say(
              'ChatGPT OAuth selected for cloud voice. Your API key stays saved and available.',
            );
            return;
          }

          say(
            'Finish ChatGPT sign-in in the browser. Waiting for it to complete…',
          );
          const available = await waitForChatGptOAuth({
            fetchImpl: doFetch,
            signal: lifetime.signal,
          });
          if (lifetime.signal.aborted) return;
          if (!available) {
            say(
              'ChatGPT sign-in timed out. Click USE CHATGPT OAUTH to try again.',
            );
            return;
          }
          writeStoredCloudVoiceAuthMode('oauth');
          syncCloudVoiceAuth();
          say(
            'ChatGPT sign-in complete. OAuth will be used for the next cloud voice session.',
          );
        } catch (error) {
          if (lifetime.signal.aborted) return;
          say(`OAuth check failed: ${error?.message || error}`);
        } finally {
          oauthBusy = false;
          if (!disposed) syncCloudVoiceAuth();
        }
      })();
      return;
    }
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
  };
  return { open: openDialog, close, render, destroy };
}
