import { createSurfaceKeyboard } from './ui/surfaceKeyboard.js';
import { useProviderSettingsStore } from './ui/stores/providerSettings.js';
import { applicationPinia } from './ui/vueRuntime.js';
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
 *
 * ProviderSettingsView renders it: initKeySetup() keeps the requests, the
 * field values and the dialog's keyboard, and publishes what is shown to the
 * gev-provider-settings store.
 */

import { t, msg, tn, onLocaleChange } from './i18n/index.js';

/**
 * Chip label — pure, exported for tests (keySetup.test.mjs pins the English).
 * @param {{total?: number, setCount?: number}|null} status
 * @returns {string}
 */
export function keySetupChipLabel(status) {
  const missing = Math.max(0, (status?.total || 0) - (status?.setCount || 0));
  return missing > 0
    ? tn(
        missing,
        'POWER UP · {count} KEY WAITING',
        'POWER UP · {count} KEYS WAITING',
      )
    : t('POWERED UP');
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
 * Why /api/setup/keys refused a save, by the `code` the server sends beside
 * its English `error` (src/keySetupCore.mjs, server/standalone/key-setup.js).
 * The English matches the server's text.
 */
const SAVE_REFUSALS = Object.freeze({
  proxied: msg('Provider Settings does not answer proxied requests'),
  sharing: msg('Provider Settings is disabled while sharing is enabled'),
  'not-loopback': msg(
    'Provider Settings answers only the machine running the server',
  ),
  'not-local-host': msg('Provider Settings answers only local hostnames'),
  'origin-required': msg('Provider Settings requires an exact local Origin'),
  'origin-unrecognized': msg('Unrecognized Origin refused'),
  'cross-origin': msg('Cross-origin requests are refused'),
  'content-type': msg('Content-Type must be application/json'),
  method: msg('Method not allowed'),
  'too-large': msg('Request too large'),
  'invalid-json': msg('Invalid JSON'),
  'not-object': msg('Body must be a JSON object of {ENV_VAR: value}'),
  'no-keys': msg('No keys provided'),
  'too-many': msg('At most {limit} keys per save'),
  'unknown-key': msg('Unknown key: {name}'),
  'not-string': msg('{name} must be a string'),
  empty: msg('{name} is empty'),
  'too-long': msg('{name} is longer than any real key ({limit} max)'),
  'not-printable': msg(
    '{name} may only contain printable characters with no spaces',
  ),
  'invalid-char': msg(
    '{name} contains a character that is not valid in a key (#, quotes, $, \\, or backtick)',
  ),
  external: msg(
    '{name} is configured outside Provider Settings and can only be changed where it was set',
  ),
  'harden-failed': msg(
    'The key was not saved: could not restrict the credential file to your account; nothing was saved',
  ),
  'store-unreadable': msg(
    'The key was not saved: the existing configuration could not be read, so nothing was changed',
  ),
  'write-failed': msg('Could not write the {store} store'),
});

/**
 * The status line for a refused save — pure, exported for tests. A known
 * `code` reads in the active language; anything else shows the server's text.
 * @param {{code?: string, params?: object, error?: string}} payload
 * @param {number} status HTTP status of the response.
 * @returns {string}
 */
export function saveRefusalText(payload, status) {
  const pattern = Object.hasOwn(SAVE_REFUSALS, payload?.code)
    ? SAVE_REFUSALS[payload.code]
    : null;
  if (pattern) {
    const values = {};
    for (const name of ['name', 'limit', 'store']) {
      const value = payload.params?.[name];
      if (typeof value === 'string' || typeof value === 'number')
        values[name] = value;
    }
    return t(pattern, values);
  }
  return payload?.error || t('Save failed ({status}).', { status });
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

/**
 * An OAuth check error. A server reason is later wrapped in «OAuth check
 * failed: …»; our own translated fallback is flagged to show unwrapped.
 * @param {unknown} serverError
 * @param {string} fallback Already-translated fallback sentence.
 * @returns {Error}
 */
function oauthCheckError(serverError, fallback) {
  if (serverError) return new Error(String(serverError));
  const error = new Error(fallback);
  error.oauthFallback = true;
  return error;
}

/**
 * Status text for a failed OAuth check — pure, exported for tests. A fallback
 * sentence of our own already says what failed and is shown alone; any other
 * reason (server text, network error) gets the «OAuth check failed» wrapper.
 * @param {unknown} error
 * @returns {string}
 */
export function oauthCheckFailureText(error) {
  if (error?.oauthFallback && error.message) return error.message;
  return t('OAuth check failed: {detail}', {
    detail: error?.message || error,
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
      throw oauthCheckError(
        payload.error,
        t('Could not check ChatGPT sign-in. Try again.'),
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

const TIER_DOTS = Object.freeze({ metered: '🔴', paid: '🔴', free: '🟡' });

/** One key row as the view renders it, from the status payload's own text. */
function presentRow(key) {
  return {
    id: key.id,
    title: key.title,
    set: Boolean(key.set),
    managed: key.managed || null,
    external: key.managed === 'external',
    tierDot: TIER_DOTS[key.tier] || '',
    tierTitle:
      key.tier === 'metered'
        ? t('Metered — a billing-enabled account')
        : key.tier === 'paid'
          ? t('Optional paid token — public access works without one')
          : t('Free key — register, paste, done'),
    clientExposed: Boolean(key.clientExposed),
    getUrl: key.getUrl,
    unlocks: t(key.unlocks),
    envVars: [...(key.envVars || [])],
  };
}

/** Wire the dev-only setup surface; unavailable endpoints remove it entirely. */
export async function initKeySetup({
  documentRef = globalThis.document,
  fetchImpl,
  signal,
  store = useProviderSettingsStore(applicationPinia()),
} = {}) {
  const root = documentRef?.getElementById?.('key-setup');
  if (!root || store.controls) return null;
  const lifetime = new AbortController();
  const doFetch = fetchImpl || globalThis.fetch?.bind(globalThis);
  let disposed = false;
  // Pasted keys live only here until Save.
  const fields = {};
  const state = {
    available: null,
    ready: false,
    chip: null,
    dialog: { hidden: true, visible: false },
    rows: [],
    // Bumped by a save: the rows render afresh, so no field keeps a key.
    generation: 0,
    fields,
    status: null,
    // Counts messages, so the live region announces a repeated one again.
    statusSeq: 0,
    saving: null,
    auth: { mode: readStoredCloudVoiceAuthMode(), busy: false },
  };
  const publish = () => {
    if (store.controls !== controls) return;
    store.publish({
      ...state,
      chip: state.chip && { ...state.chip },
      dialog: { ...state.dialog },
      fields: { ...fields },
      auth: { ...state.auth },
    });
  };
  const destroy = () => {
    if (disposed) return;
    disposed = true;
    offLocale();
    lifetime.abort();
    signal?.removeEventListener('abort', destroy);
    open = false;
    keyboard.destroy();
    state.available = false;
    state.ready = false;
    publish();
    if (store.controls === controls) store.connect(null);
  };

  let status = null;
  let busy = false;
  let open = false;

  const render = (nextStatus) => {
    if (disposed) return;
    status = nextStatus;
    const label = keySetupChipLabel(status);
    // Fully powered is the owner's clean screen: the chip retires. The dialog
    // stays reachable this session (and via ?setup=1) to swap or verify keys.
    state.chip = {
      label,
      title: t('Project keys: {status}', { status: label }),
      hidden: status.setCount >= status.total,
    };
    state.rows = (status.keys || []).map(presentRow);
    state.auth = { ...state.auth, mode: readStoredCloudVoiceAuthMode() };
    publish();
  };

  // The chip and rows are translated here; show them again in a new locale.
  const offLocale = onLocaleChange(() => {
    if (status) render(status);
  });

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
    if (disposed || open || !state.ready) return;
    open = true;
    keyboard.activate();
    state.dialog = { hidden: false, visible: false };
    publish();
    // The frame runs after Vue shows the dialog, so the fade starts from it.
    globalThis.requestAnimationFrame?.(() => {
      if (!open) return;
      state.dialog = { hidden: false, visible: true };
      publish();
      // The fields are already rendered; focus after Vue applies the class.
      Promise.resolve().then(() => {
        if (open) root.querySelector('input')?.focus?.({ preventScroll: true });
      });
    });
  };

  const hideIfClosed = () => {
    if (open || disposed || state.dialog.hidden) return;
    state.dialog = { hidden: true, visible: false };
    publish();
  };

  const close = () => {
    if (!open) return;
    open = false;
    state.dialog = { hidden: false, visible: false };
    state.status = null;
    publish();
    globalThis.setTimeout?.(hideIfClosed, 400);
    keyboard.deactivate({ restoreFocus: true });
  };

  const say = (text) => {
    state.status = text;
    state.statusSeq += 1;
    publish();
  };

  const syncAuth = (busyNow = state.auth.busy) => {
    state.auth = { mode: readStoredCloudVoiceAuthMode(), busy: busyNow };
    publish();
  };

  const storeLabel = () =>
    status?.store === 'pinokio-environment'
      ? t('your app configuration')
      : t('your local .env');

  // doneMessageKey names the whole saved/removed sentence; the storage
  // destination is interpolated so the {store} phrase stays one spelling.
  const submitUpdates = async (updates, doneMessageKey) => {
    if (disposed || busy) return;
    const googleWasUnset = !status?.keys?.find(
      (key) => key.id === 'google-maps',
    )?.set;
    busy = true;
    state.saving = true;
    say(t('Saving…'));
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
        say(saveRefusalText(payload, response.status));
        return;
      }
      for (const envVar of Object.keys(fields)) delete fields[envVar];
      state.generation += 1;
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
      say(t(doneMessageKey, { store: storeLabel() }));
    } catch (error) {
      say(
        t('Save failed: {detail}', {
          detail: error?.message || error,
        }),
      );
    } finally {
      busy = false;
      state.saving = false;
      publish();
    }
  };

  const apply = async () => {
    if (disposed || busy) return;
    const updates = collectKeyUpdates(
      Object.entries(fields).map(([envVar, value]) => ({ envVar, value })),
    );
    if (!Object.keys(updates).length) {
      say(t('Paste at least one key first.'));
      return;
    }
    await submitUpdates(
      updates,
      msg('Saved to {store}. Restarting — this page reloads itself.'),
    );
  };

  const remove = (envVars) => {
    if (disposed || busy) return;
    if (!Array.isArray(envVars) || !envVars.length) return;
    // Removal is destructive and — behind a framing defense that should already
    // stop it — a clickjack target. A confirm turns a single aligned click into
    // a deliberate two-step the lure cannot pre-satisfy.
    const ok =
      typeof globalThis.confirm !== 'function' ||
      globalThis.confirm(t('Remove this key from your saved configuration?'));
    if (!ok) return;
    void submitUpdates(
      Object.fromEntries(envVars.map((name) => [name, null])),
      msg('Removed from {store}. Restarting — this page reloads itself.'),
    );
  };

  const toggleAuth = async () => {
    if (disposed || state.auth.busy) return;
    const current = readStoredCloudVoiceAuthMode();
    if (current === 'oauth') {
      writeStoredCloudVoiceAuthMode('api-key');
      syncAuth();
      say(t('Cloud voice will use OPENAI_API_KEY on the next session.'));
      return;
    }
    syncAuth(true);
    say(t('Checking local ChatGPT OAuth sign-in…'));
    try {
      const response = await doFetch('/api/realtime/oauth-status', {
        cache: 'no-store',
        signal: lifetime.signal,
      });
      const payload = await response.json().catch(() => ({}));
      if (lifetime.signal.aborted) return;
      if (!response.ok)
        throw oauthCheckError(
          payload.error,
          t('Could not check ChatGPT sign-in.'),
        );
      if (payload.available) {
        writeStoredCloudVoiceAuthMode('oauth');
        syncAuth();
        say(
          t(
            'ChatGPT OAuth selected for cloud voice. Your API key stays saved and available.',
          ),
        );
        return;
      }

      say(
        payload.code === 'CODEX_OAUTH_REAUTH_REQUIRED'
          ? t('ChatGPT sign-in expired. Opening sign-in again…')
          : t('Opening ChatGPT sign-in in your browser…'),
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
            t('Could not start ChatGPT sign-in on this machine.'),
        );
        return;
      }
      if (loginPayload.available) {
        writeStoredCloudVoiceAuthMode('oauth');
        syncAuth();
        say(
          t(
            'ChatGPT OAuth selected for cloud voice. Your API key stays saved and available.',
          ),
        );
        return;
      }

      say(
        t('Finish ChatGPT sign-in in the browser. Waiting for it to complete…'),
      );
      const available = await waitForChatGptOAuth({
        fetchImpl: doFetch,
        signal: lifetime.signal,
      });
      if (lifetime.signal.aborted) return;
      if (!available) {
        say(
          t('ChatGPT sign-in timed out. Click {button} to try again.', {
            button: t('USE CHATGPT OAUTH'),
          }),
        );
        return;
      }
      writeStoredCloudVoiceAuthMode('oauth');
      syncAuth();
      say(
        t(
          'ChatGPT sign-in complete. OAuth will be used for the next cloud voice session.',
        ),
      );
    } catch (error) {
      if (lifetime.signal.aborted) return;
      say(oauthCheckFailureText(error));
    } finally {
      if (!disposed) syncAuth(false);
    }
  };

  const controls = {
    open: openDialog,
    close,
    apply,
    remove,
    toggleAuth: () => void toggleAuth(),
    setField(envVar, value) {
      fields[envVar] = String(value ?? '');
      publish();
    },
    transitionEnd: hideIfClosed,
  };
  store.connect(controls);
  publish();

  if (signal?.aborted) {
    destroy();
    return null;
  }
  signal?.addEventListener('abort', destroy, { once: true });

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

  state.available = true;
  state.ready = true;
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

  return { open: openDialog, close, render, destroy };
}
