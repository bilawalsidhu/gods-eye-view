import { createSurfaceKeyboard } from './ui/surfaceKeyboard.js';
import { currentLocale, subscribeLocale, t } from './i18n/index.js';
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
 * Every user-facing string translates at render through the `settings` pack
 * (src/i18n/locales/<locale>/settings.js); a locale switch repaints the chip
 * and default status live, and rows rebuild at the next open. Server error
 * strings carried in payloads are protocol responses and stay verbatim.
 */

/** Chip label — pure, exported for tests. English; the panel paints via i18n. */
export function keySetupChipLabel(status) {
  const missing = keySetupMissingCount(status);
  return missing > 0
    ? `POWER UP · ${missing} ${missing === 1 ? 'KEY' : 'KEYS'} WAITING`
    : 'POWERED UP';
}

/** Missing (non-hidden) key count shared by the English and translated labels. */
function keySetupMissingCount(status) {
  return Math.max(0, (status?.total || 0) - (status?.setCount || 0));
}

/** Same label, translated at paint from the `settings` pack. */
function localizedChipLabel(status) {
  const missing = keySetupMissingCount(status);
  return missing > 0
    ? t('settings.chip.waiting', { count: missing })
    : t('settings.chip.ready');
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
      // A provider/server error string arrives in payload.error and stays
      // verbatim; only our own fallback is translated.
      throw new Error(payload.error || t('settings.oauth.checkFailedRetry'));
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
    mode === 'oauth'
      ? t('settings.voiceAuth.stateOauth')
      : t('settings.voiceAuth.stateApiKey');
  toggle.textContent =
    mode === 'oauth'
      ? t('settings.voiceAuth.useApiKey')
      : t('settings.voiceAuth.useOauth');
  toggle.title =
    mode === 'oauth'
      ? t('settings.voiceAuth.useApiKeyTip')
      : t('settings.voiceAuth.useOauthTip');
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
  // Registry text translates at render; the English fields stay the fallback
  // for payloads that predate the parallel message keys.
  const titleText = key.titleKey ? t(key.titleKey) : key.title;
  const unlocksText = key.unlocksKey ? t(key.unlocksKey) : key.unlocks;

  const head = documentRef.createElement('div');
  head.className = 'key-setup-row-head';
  const led = documentRef.createElement('span');
  led.className = 'key-setup-led';
  led.setAttribute('aria-hidden', 'true');
  const title = documentRef.createElement('strong');
  title.textContent = titleText;
  const tier = documentRef.createElement('span');
  tier.className = 'key-setup-tier';
  tier.textContent = TIER_DOTS[key.tier] || '';
  tier.title =
    key.tier === 'metered'
      ? t('settings.tier.metered')
      : t('settings.tier.free');
  head.append(led, title, tier);
  if (key.clientExposed) {
    const exposed = documentRef.createElement('span');
    exposed.className = 'key-setup-exposed';
    exposed.textContent = t('settings.badge.browserSide');
    exposed.title = t('settings.badge.browserSideTip');
    head.append(exposed);
  }
  if (external) {
    // Externally supplied credentials (shell env, Keychain, a launcher) are
    // facts this panel reports, never values it rewrites or deletes.
    const badge = documentRef.createElement('span');
    badge.className = 'key-setup-external';
    badge.textContent = t('settings.badge.external');
    badge.title = t('settings.badge.externalTip');
    head.append(badge);
  }
  const get = documentRef.createElement('a');
  get.className = 'key-setup-get';
  get.href = key.getUrl;
  get.target = '_blank';
  get.rel = 'noopener noreferrer';
  get.textContent = key.set
    ? t('settings.row.manage')
    : t('settings.row.getKey');
  head.append(get);

  const unlocks = documentRef.createElement('p');
  unlocks.className = 'key-setup-unlocks';
  unlocks.textContent = unlocksText;

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
      // The identifier itself is the accessible name — never translated.
      input.setAttribute('aria-label', envVar);
      input.placeholder = key.set
        ? t('settings.field.replace', { envVar })
        : t('settings.field.paste', { envVar });
      fields.append(input);
    }
    if (key.managed === 'file') {
      const remove = documentRef.createElement('button');
      remove.type = 'button';
      remove.className = 'key-setup-remove';
      remove.dataset.keySetupRemove = JSON.stringify(key.envVars);
      remove.textContent = t('settings.row.remove');
      remove.title = t('settings.row.removeTip', { title: titleText });
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

/** Wire the dev-only setup surface; unavailable endpoints remove it entirely. */
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
  let disposePlacement = () => {};
  // Assigned once the surface is up; a no-op until then (destroy may run first).
  let unsubscribeLocale = () => {};
  const destroy = () => {
    if (disposed) return;
    disposed = true;
    lifetime.abort();
    signal?.removeEventListener('abort', destroy);
    unsubscribeLocale();
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
  // The status line and chip label are repainted at runtime, so the static
  // binder never owns them: this module translates at paint instead.
  const defaultStatus = () => t('settings.status.default');
  let statusIsTransient = false;
  // Which locale the rendered rows were built in — rows only rebuild at the
  // next open after a switch (see openDialog), never mid-typing.
  let renderedLocale = currentLocale();
  let busy = false;
  let oauthBusy = false;
  let open = false;

  const syncCloudVoiceAuth = () => {
    for (const auth of rowsHost.querySelectorAll('.key-setup-cloud-auth'))
      updateCloudVoiceAuthControl(auth, oauthBusy);
  };

  const paintChip = () => {
    const label = localizedChipLabel(status);
    chipLabel.textContent = label;
    chip.title = t('settings.chip.projectKeys', { label });
    chip.setAttribute('aria-label', chip.title);
  };

  const render = (nextStatus) => {
    if (disposed) return;
    status = nextStatus;
    paintChip();
    // Fully powered is the owner's clean screen: the chip retires. The dialog
    // stays reachable this session (and via ?setup=1) to swap or verify keys.
    chip.hidden = status.setCount >= status.total;
    if (!rowsHost) return;
    rowsHost.textContent = '';
    for (const key of status.keys || [])
      rowsHost.append(buildRow(documentRef, key));
    renderedLocale = currentLocale();
    syncCloudVoiceAuth();
    if (statusLine && !statusIsTransient)
      statusLine.textContent = defaultStatus();
  };

  // A live locale switch re-translates the chip and the default status line.
  // Rows translate at render; rebuilding them under an open dialog would wipe
  // a half-pasted key, so they pick up the new language at the next open.
  unsubscribeLocale = subscribeLocale(() => {
    paintChip();
    if (statusLine && !statusIsTransient)
      statusLine.textContent = defaultStatus();
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
    if (disposed || open) return;
    // A switch while the dialog was closed left the rows in the old language;
    // reopening is the safe repaint point (no half-typed input to wipe).
    if (status && currentLocale() !== renderedLocale) render(status);
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
    if (statusLine) {
      statusLine.textContent = defaultStatus();
      statusIsTransient = false;
    }
    keyboard.deactivate({ restoreFocus: true });
  };

  const say = (text) => {
    if (statusLine) {
      statusIsTransient = true;
      statusLine.textContent = text;
    }
  };

  const storeLabel = () =>
    status?.store === 'pinokio-environment'
      ? t('settings.store.appConfig')
      : t('settings.store.localEnv');

  const submitUpdates = async (updates, doneKey) => {
    if (disposed || busy) return;
    const googleWasUnset = !status?.keys?.find(
      (key) => key.id === 'google-maps',
    )?.set;
    busy = true;
    applyButton?.setAttribute('aria-disabled', 'true');
    say(t('settings.save.saving'));
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
        // A server refusal is protocol text and stays verbatim; the local
        // HTTP-status fallback is ours to translate.
        say(
          payload.error ||
            t('settings.save.failedStatus', { status: response.status }),
        );
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
      say(t(doneKey, { store: storeLabel() }));
    } catch (error) {
      say(
        t('settings.save.failedMessage', { message: error?.message || error }),
      );
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
      say(t('settings.save.pasteFirst'));
      return;
    }
    await submitUpdates(updates, 'settings.save.savedTo');
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
          say(t('settings.voiceAuth.switchedToApiKey'));
          return;
        }
        oauthBusy = true;
        syncCloudVoiceAuth();
        say(t('settings.oauth.checking'));
        try {
          const response = await doFetch('/api/realtime/oauth-status', {
            cache: 'no-store',
            signal: lifetime.signal,
          });
          const payload = await response.json().catch(() => ({}));
          if (lifetime.signal.aborted) return;
          if (!response.ok)
            throw new Error(
              payload.error || t('settings.oauth.checkFailedShort'),
            );
          if (payload.available) {
            writeStoredCloudVoiceAuthMode('oauth');
            syncCloudVoiceAuth();
            say(t('settings.oauth.selected'));
            return;
          }

          say(
            payload.code === 'CODEX_OAUTH_REAUTH_REQUIRED'
              ? t('settings.oauth.expired')
              : t('settings.oauth.opening'),
          );
          const loginResponse = await doFetch('/api/realtime/oauth-login', {
            method: 'POST',
            cache: 'no-store',
            signal: lifetime.signal,
          });
          const loginPayload = await loginResponse.json().catch(() => ({}));
          if (lifetime.signal.aborted) return;
          if (!loginResponse.ok) {
            // Server-provided error text stays verbatim (protocol response).
            say(
              loginPayload.error ||
                payload.error ||
                t('settings.oauth.startFailed'),
            );
            return;
          }
          if (loginPayload.available) {
            writeStoredCloudVoiceAuthMode('oauth');
            syncCloudVoiceAuth();
            say(t('settings.oauth.selected'));
            return;
          }

          say(t('settings.oauth.waiting'));
          const available = await waitForChatGptOAuth({
            fetchImpl: doFetch,
            signal: lifetime.signal,
          });
          if (lifetime.signal.aborted) return;
          if (!available) {
            say(
              t('settings.oauth.timedOut', {
                button: t('settings.voiceAuth.useOauth'),
              }),
            );
            return;
          }
          writeStoredCloudVoiceAuthMode('oauth');
          syncCloudVoiceAuth();
          say(t('settings.oauth.complete'));
        } catch (error) {
          if (lifetime.signal.aborted) return;
          say(
            t('settings.oauth.checkFailed', {
              message: error?.message || error,
            }),
          );
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
      globalThis.confirm(t('settings.remove.confirm'));
    if (!ok) return;
    void submitUpdates(
      Object.fromEntries(envVars.map((name) => [name, null])),
      'settings.save.removedFrom',
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
