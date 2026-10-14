import { createSurfaceKeyboard } from './ui/surfaceKeyboard.js';
import {
  API_BASE_STORAGE_KEY,
  resolveApiBase,
  storedApiBase,
} from './mobile/runtimeConfig.js';
import { readApiBase, writeApiBase } from './mobile/keyStore.js';
import { KEY_IDS, createVault } from './mobile/vault.js';
import {
  SECURE_BACKEND,
  insecureBridge,
  loadVaultStorage,
} from './mobile/secureStorage.js';
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

/** Default import function for the Preferences plugin (test seam). */
async function importPreferencesPlugin() {
  return import('@capacitor/preferences');
}

/**
 * Load the production store for the Capacitor branch: the real Preferences
 * plugin (dynamically imported so the web bundle never fetches it), falling
 * back to the `localStorage` adapter.
 *
 * Returns bound plain methods, never the raw plugin proxy: awaiting (or
 * spreading) the proxy reads `.then`, which the native bridge reports as
 * UNIMPLEMENTED and turns into an unhandled rejection on-device.
 * @param {{ importPlugin?: Function }} options Import seam for tests.
 * @returns {Promise<{ get: Function, set: Function, remove: Function }>} Preferences-shaped store.
 */
export async function loadDefaultCapacitorStorage({
  importPlugin = importPreferencesPlugin,
} = {}) {
  try {
    const { Preferences } = await importPlugin();
    if (
      Preferences &&
      typeof Preferences.get === 'function' &&
      typeof Preferences.set === 'function' &&
      typeof Preferences.remove === 'function'
    ) {
      const get = Preferences.get.bind(Preferences);
      const set = Preferences.set.bind(Preferences);
      const remove = Preferences.remove.bind(Preferences);
      return { get, set, remove };
    }
  } catch {
    // Gated import failure (tests, SSR): fall through to the local adapter.
  }
  return localApiBaseStorage();
}

/**
 * Resolve the backend base for display: the injected store first, the boot
 * seam (`storedApiBase`) as fallback. Never throws — unset or unreadable
 * means `''` (same-origin).
 * @param {{ get: Function }} storage Injected Preferences-shaped store.
 * @param {Function} [readImpl] `readApiBase` override for tests.
 * @returns {Promise<string>} Resolved base, or `''` when unset.
 */
export async function resolveBackendBase(storage, readImpl = readApiBase) {
  try {
    const stored = await readImpl(storage);
    if (stored) return stored;
  } catch {
    // Fall through to the boot seam.
  }
  try {
    return storedApiBase();
  } catch {
    return '';
  }
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
  input.type = 'text';
  input.inputMode = 'url';
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
 * Build one read-only vault presence row. Presence only: the row carries
 * the key id and its set/unset state, never an input and never a value.
 * @param {Document} documentRef Document used to create elements.
 * @param {string} id Vault key id.
 * @param {boolean} set Whether the key is stored on this device.
 * @returns {HTMLElement} The row element.
 */
export function buildVaultStatusRow(documentRef, id, set = false) {
  const row = documentRef.createElement('section');
  row.className = 'key-setup-row';
  row.dataset.keyId = `vault:${id}`;
  row.dataset.set = String(Boolean(set));
  row.dataset.vault = 'true';
  const head = documentRef.createElement('div');
  head.className = 'key-setup-row-head';
  const title = documentRef.createElement('strong');
  title.textContent = id;
  const state = documentRef.createElement('span');
  state.className = 'key-setup-vault-state';
  state.textContent = set ? 'SET' : 'NOT SET';
  state.title = set
    ? 'Stored on this device only'
    : 'Not stored on this device';
  head.append(title, state);
  row.append(head);
  return row;
}

/**
 * Build the read-only vault status section: one presence row per vault key
 * plus a banner while the backend is not Keystore-backed. All text is
 * static; values never appear.
 * @param {Document} documentRef Document used to create elements.
 * @param {Record<string, { set: boolean, backend: string }>|null} status Presence record from the vault.
 * @returns {HTMLElement} The section element.
 */
export function buildVaultStatusSection(documentRef, status) {
  const section = documentRef.createElement('div');
  section.className = 'key-setup-vault';
  section.dataset.vaultSection = 'true';
  const note = documentRef.createElement('p');
  note.className = 'key-setup-vault-note';
  note.textContent =
    'On-device provider keys (presence only — values are never shown).';
  section.append(note);
  for (const id of KEY_IDS)
    section.append(buildVaultStatusRow(documentRef, id, status?.[id]?.set));
  const backend = status?.[KEY_IDS[0]]?.backend ?? 'insecure';
  if (backend !== 'secure') {
    const banner = documentRef.createElement('p');
    banner.className = 'key-setup-vault-banner';
    banner.dataset.vaultBanner = 'true';
    banner.textContent =
      'Device storage is not Keystore-backed yet — keys live in app preferences.';
    section.append(banner);
  }
  return section;
}

/**
 * Read the on-device vault presence snapshot for display. Fail-closed:
 * any failure resolves to null so the dialog still renders.
 * @param {{ get: Function, set: Function, remove: Function }|null} storage Injected Preferences-shaped store.
 * @returns {Promise<Record<string, { set: boolean, backend: string }>|null>} Presence record, or null when unreadable.
 */
export async function readVaultSnapshot(storage) {
  try {
    if (!storage) return null;
    const vault = createVault({
      storage: insecureBridge(storage),
      insecureOk: true,
    });
    return await vault.keyStatus();
  } catch {
    return null;
  }
}

/**
 * Load the writable on-device vault for the Capacitor surfaces: the secure
 * store when it loads, otherwise the injected Preferences fallback (still
 * flagged insecure and bannered). The insecure fallback passes `insecureOk`
 * explicitly — a deliberate, visible opt-in until the device reports
 * Keystore-backed storage.
 * @param {{ get: Function, set: Function, remove: Function }|null} preferences Injected Preferences-shaped fallback.
 * @param {{ loadSecure?: Function }} options Secure-loader seam for tests.
 * @returns {Promise<{ vault: object, backend: string }|null>} Vault plus its backend label, or null when no store resolves.
 */
export async function loadSetupVault(preferences, { loadSecure } = {}) {
  const { store, backend } = await loadVaultStorage(preferences, {
    loadSecure,
  });
  if (!store) return null;
  const vault = createVault({
    storage: store,
    insecureOk: backend !== SECURE_BACKEND,
  });
  return { vault, backend };
}

/**
 * Load the writable vault plus its presence snapshot for display.
 * Fail-closed: any failure resolves to null so the dialog still renders.
 * @param {{ get: Function, set: Function, remove: Function }|null} preferences Injected Preferences-shaped fallback.
 * @param {{ loadSecure?: Function }} options Secure-loader seam for tests.
 * @returns {Promise<{ vault: object, backend: string, snapshot: Record<string, { set: boolean, backend: string }>|null }|null>} Vault, backend, and presence record.
 */
export async function readSetupVaultSnapshot(preferences, options) {
  const setup = await loadSetupVault(preferences, options);
  if (!setup) return null;
  let snapshot = null;
  try {
    snapshot = await setup.vault.keyStatus();
  } catch {
    snapshot = null;
  }
  return { ...setup, snapshot };
}

/**
 * Build one editable vault key row (Capacitor only). Presence plus a
 * password input, SAVE, and REMOVE (hidden until set): values are
 * write-only — the input is never prefilled and the row carries no value.
 * @param {Document} documentRef Document used to create elements.
 * @param {string} id Vault key id.
 * @param {boolean} set Whether the key is stored on this device.
 * @returns {HTMLElement} The row element, carrying its input and buttons.
 */
export function buildVaultKeyRow(documentRef, id, set = false) {
  const row = documentRef.createElement('section');
  row.className = 'key-setup-row';
  row.dataset.keyId = `vault:${id}`;
  row.dataset.set = String(Boolean(set));
  row.dataset.vault = 'true';
  const head = documentRef.createElement('div');
  head.className = 'key-setup-row-head';
  const title = documentRef.createElement('strong');
  title.textContent = id;
  const state = documentRef.createElement('span');
  state.className = 'key-setup-vault-state';
  state.dataset.vaultState = 'true';
  state.textContent = set ? 'SET' : 'NOT SET';
  state.title = set
    ? 'Stored on this device only'
    : 'Not stored on this device';
  head.append(title, state);
  const fields = documentRef.createElement('div');
  fields.className = 'key-setup-fields';
  const input = documentRef.createElement('input');
  // Passwords-style so a pasted key never shows on a shared or recorded
  // screen — this app gets screen-recorded a lot. Never prefilled: the row
  // carries presence, never a value.
  input.type = 'password';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.dataset.vaultKey = id;
  input.setAttribute('aria-label', id);
  input.placeholder = set ? `${id} saved — paste to replace` : `paste ${id}`;
  const save = documentRef.createElement('button');
  save.type = 'button';
  save.className = 'key-setup-vault-save';
  save.dataset.vaultSave = id;
  save.textContent = 'SAVE';
  save.title = `Save ${id} on this device only`;
  const remove = documentRef.createElement('button');
  remove.type = 'button';
  remove.className = 'key-setup-vault-remove';
  remove.dataset.vaultRemove = id;
  remove.textContent = 'REMOVE';
  remove.title = `Remove ${id} from this device`;
  remove.hidden = !set;
  fields.append(input, save, remove);
  row.append(head, fields);
  return row;
}

/**
 * Build the editable vault section for the Capacitor surfaces: one
 * write/remove row per vault key plus the insecure-backend banner while the
 * store is not Keystore-backed. All text is static; values never appear.
 * @param {Document} documentRef Document used to create elements.
 * @param {Record<string, { set: boolean, backend: string }>|null} status Presence record from the vault.
 * @returns {HTMLElement} The section element.
 */
export function buildVaultKeySection(documentRef, status) {
  const section = documentRef.createElement('div');
  section.className = 'key-setup-vault';
  section.dataset.vaultSection = 'true';
  section.dataset.vaultEditable = 'true';
  const note = documentRef.createElement('p');
  note.className = 'key-setup-vault-note';
  note.textContent =
    'On-device provider keys — paste to save on this device only. Values are never shown.';
  section.append(note);
  for (const id of KEY_IDS)
    section.append(buildVaultKeyRow(documentRef, id, status?.[id]?.set));
  const backend = status?.[KEY_IDS[0]]?.backend ?? 'insecure';
  if (backend !== 'secure') {
    const banner = documentRef.createElement('p');
    banner.className = 'key-setup-vault-banner';
    banner.dataset.vaultBanner = 'true';
    banner.textContent =
      'Device storage is not Keystore-backed yet — keys live in app preferences.';
    section.append(banner);
  }
  return section;
}

/**
 * Wire SAVE/REMOVE buttons in an editable vault section. Buttons are wired
 * directly (no delegation), and a successful write/remove updates its own
 * row in place — presence text, REMOVE visibility, cleared input — so no
 * re-render (and no backend-URL edit loss) is needed. Vault errors are
 * sanitized by the vault itself (they name only the key id).
 * @param {{ section: HTMLElement|null, vault: { writeKey: Function, removeKey: Function, keyStatus: Function }|null, say?: Function, onChanged?: Function|null }} options Section, vault, status-line hook, and post-change hook.
 * @returns {void}
 */
export function wireVaultKeySection({
  section,
  vault,
  say = () => {},
  onChanged = null,
} = {}) {
  if (!section || !vault) return;
  const sayIt = (text) => {
    try {
      say(text);
    } catch {
      // A status line is a nicety; the write already landed or failed loudly.
    }
  };
  const rowFor = (id) =>
    section.querySelector(`section[data-key-id="vault:${id}"]`);
  const syncRow = (id, set) => {
    const row = rowFor(id);
    if (!row) return;
    row.dataset.set = String(Boolean(set));
    const state = row.querySelector('[data-vault-state]');
    if (state) {
      state.textContent = set ? 'SET' : 'NOT SET';
      state.title = set
        ? 'Stored on this device only'
        : 'Not stored on this device';
    }
    const input = row.querySelector('input');
    if (input) input.value = '';
    const remove = row.querySelector('[data-vault-remove]');
    if (remove) remove.hidden = !set;
  };
  const changed = async () => {
    if (typeof onChanged !== 'function') return;
    try {
      onChanged(await vault.keyStatus());
    } catch {
      // Presence refresh is a nicety; the row already shows the new state.
    }
  };
  for (const save of section.querySelectorAll('[data-vault-save]')) {
    const id = save.dataset?.vaultSave;
    if (!id) continue;
    save.addEventListener?.('click', () => {
      void (async () => {
        const row = rowFor(id);
        const value = String(row?.querySelector('input')?.value ?? '').trim();
        if (!value) {
          sayIt('Paste a key first.');
          return;
        }
        sayIt('Saving…');
        try {
          await vault.writeKey(id, value);
        } catch (error) {
          sayIt(`Save failed: ${error?.message || error}`);
          return;
        }
        syncRow(id, true);
        sayIt(`${id} saved on this device.`);
        await changed();
      })();
    });
  }
  /** Show inline "Confirm?" text; second click within 3 s removes. */
  const pendingRemove = new Map();
  for (const remove of section.querySelectorAll('[data-vault-remove]')) {
    const id = remove.dataset?.vaultRemove;
    if (!id) continue;
    remove.addEventListener?.('click', () => {
      const wasPending = pendingRemove.get(id);
      if (wasPending) {
        clearTimeout(wasPending.timeout);
        pendingRemove.delete(id);
        void (async () => {
          sayIt('Removing…');
          try {
            await vault.removeKey(id);
          } catch (error) {
            sayIt(`Remove failed: ${error?.message || error}`);
            return;
          }
          syncRow(id, false);
          sayIt(`${id} removed from this device.`);
          await changed();
        })();
      } else {
        pendingRemove.set(id, {
          timeout: setTimeout(() => {
            pendingRemove.delete(id);
            remove.textContent = remove.dataset.originalText ?? 'Remove';
          }, 3000),
        });
        remove.dataset.originalText = remove.textContent;
        remove.textContent = 'Confirm?';
      }
    });
  }
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
 * @param {Function} [options.setupVaultImpl] `readSetupVaultSnapshot` override for tests.
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
  setupVaultImpl = readSetupVaultSnapshot,
} = {}) {
  if (!chip || !root || !storage) return null;
  const current = await resolveBackendBase(storage, readImpl);
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
    // Editable per-key vault rows ride along: presence plus SAVE/REMOVE on
    // the writable vault (secure store when it loads, bannered Preferences
    // fallback otherwise). Values are write-only and never shown.
    try {
      const setup = await setupVaultImpl(storage);
      if (setup?.snapshot) {
        const section = buildVaultKeySection(documentRef, setup.snapshot);
        rowsHost.append(section);
        wireVaultKeySection({
          section,
          vault: setup.vault,
          say: (text) => {
            if (statusLine) statusLine.textContent = text;
          },
        });
      }
    } catch {
      // Presence is a nicety; the backend field must still render.
    }
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

  // Capacitor merge state: null means a plain web dialog; a string (possibly
  // '') means the backend URL row rides along with the key rows.
  let backendBase = null;
  let backendStorage = null;
  let vaultSnapshot = null;
  let setupVault = null;
  const reloadPage = reloadImpl ?? (() => globalThis.location?.reload?.());

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
    // Capture an in-progress backend edit BEFORE clearing: key-save
    // re-renders must not eat a URL the user typed but hasn't saved yet.
    const pendingBase =
      backendBase !== null
        ? rowsHost.querySelector?.(
            `input[data-env-var="${API_BASE_STORAGE_KEY}"]`,
          )?.value
        : undefined;
    rowsHost.textContent = '';
    for (const key of status.keys || [])
      rowsHost.append(buildRow(documentRef, key));
    if (backendBase !== null) {
      rowsHost.append(
        buildBackendUrlRow(
          documentRef,
          typeof pendingBase === 'string' ? pendingBase : backendBase,
        ),
      );
      // Editable per-key vault rows, Capacitor only: the web dialog below
      // never takes this branch, so its bytes are unchanged.
      if (vaultSnapshot && setupVault) {
        const section = buildVaultKeySection(documentRef, vaultSnapshot);
        rowsHost.append(section);
        wireVaultKeySection({
          section,
          vault: setupVault,
          say,
          onChanged: (snapshot) => {
            vaultSnapshot = snapshot;
            render(status);
          },
        });
      }
    }
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
        // The backend URL is device state, not a server key: it persists
        // on-device (see onApply) and must survive the post-save clear.
        if (input.dataset.envVar !== API_BASE_STORAGE_KEY) input.value = '';
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
    // The backend URL never leaves the device: it is persisted on-device and
    // excluded from the server POST even if a status payload ever carries it.
    const backendInput =
      backendBase !== null
        ? inputs.find((input) => input.dataset.envVar === API_BASE_STORAGE_KEY)
        : null;
    const backendRaw = backendInput
      ? String(backendInput.value ?? '').trim()
      : null;
    const updates = collectKeyUpdates(
      inputs
        .filter((input) => input.dataset.envVar !== API_BASE_STORAGE_KEY)
        .map((input) => ({
          envVar: input.dataset.envVar,
          value: input.value,
        })),
    );
    const backendChanged =
      backendRaw !== null && resolveApiBase(backendRaw) !== backendBase;
    if (!Object.keys(updates).length && !backendChanged) {
      say('Paste at least one key first.');
      return;
    }
    if (backendChanged) {
      // Device state first: a later server restart reloads the page, and the
      // boot seam must already see the mirrored base when that happens.
      try {
        await writeApiBase(backendStorage, backendRaw);
        mirrorApiBaseToLocalStorage(resolveApiBase(backendRaw));
        backendBase = resolveApiBase(backendRaw);
      } catch (error) {
        say(`Backend save failed: ${error?.message || error}`);
        return;
      }
    }
    if (!Object.keys(updates).length) {
      say('Backend saved — reloading against it.');
      reloadPage();
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
    // stop it — a clickjack target. An inline "Confirm?" second click turns a
    // single aligned click into a deliberate two-step the lure cannot pre-satisfy.
    if (!button.dataset.confirmPending) {
      button.dataset.confirmPending = 'true';
      button.dataset.originalText = button.textContent;
      button.textContent = 'Confirm?';
      button.dataset.confirmTimeout = setTimeout(() => {
        delete button.dataset.confirmPending;
        button.textContent = button.dataset.originalText;
      }, 3000);
      return;
    }
    // Second click within 3 s — proceed with removal.
    clearTimeout(Number(button.dataset.confirmTimeout));
    delete button.dataset.confirmPending;
    delete button.dataset.confirmTimeout;
    button.textContent = button.dataset.originalText;
    void submitUpdates(
      Object.fromEntries(envVars.map((name) => [name, null])),
      'Removed from',
    );
  });

  // Under Capacitor the backend URL rides alongside the keys, so LAN-server
  // key management keeps working with the device backend visible in the same
  // dialog. The backend-only screen (status-fetch catch above) is only the
  // unreachable fallback. Web never takes this branch: no such input exists,
  // and the Preferences import below never runs there.
  if (isCapacitorHost(documentRef?.defaultView ?? globalThis.window)) {
    backendStorage = apiBaseStorage ?? (await loadDefaultCapacitorStorage());
    backendBase = await resolveBackendBase(backendStorage);
    // The vault is writable here (secure store when it loads, bannered
    // Preferences fallback otherwise). Presence is one snapshot per dialog,
    // refreshed after each write/remove via the section's onChanged hook.
    const setup = await readSetupVaultSnapshot(backendStorage);
    setupVault = setup?.vault ?? null;
    vaultSnapshot = setup?.snapshot ?? null;
  }
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
