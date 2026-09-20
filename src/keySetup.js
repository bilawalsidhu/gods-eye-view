import { createSurfaceKeyboard } from './ui/surfaceKeyboard.js';
import { FREE_LLM_PROVIDERS } from './ai/freeLlmCatalog.js';

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

export const NVIDIA_MODEL_PRESETS = Object.freeze([
  { id: 'nvidia/nemotron-3.5-lightning-30b-a3b', label: '⚡ Nemotron 3.5' },
  { id: 'nvidia/nemotron-3-ultra-550b-a55b', label: '🧠 Nemotron 550B' },
  { id: 'moonshotai/kimi-k3', label: '👁️ Kimi K3' },
  { id: 'meta/llama-3.3-70b-instruct', label: '🦙 Llama 3.3 70B' },
  { id: 'deepseek-ai/deepseek-r1', label: '🔬 DeepSeek R1' },
  { id: 'mistralai/mistral-large-2-instruct', label: '🌊 Mistral Large 2' },
]);

const TIER_DOTS = Object.freeze({ metered: '🔴', free: '🟡' });

/** Build one key row. All content is our own registry text, set via textContent. */
/** Build one key row. All content is our own registry text, set via textContent. */
function buildRow(documentRef, key, status = null) {
  const isAiRow = key.id === 'nvidia';
  const providerSummary = status?.providerSummary;
  const activeId = providerSummary?.activeId || 'nvidia';
  const providerMap = providerSummary?.providers || {};
  const activeProvider =
    FREE_LLM_PROVIDERS.find((p) => p.id === activeId) || FREE_LLM_PROVIDERS[0];
  const isAnyAiKeySaved = Object.values(providerMap).some((p) => p.set);

  const row = documentRef.createElement('section');
  row.className = 'key-setup-row' + (isAiRow ? ' key-setup-row-ai' : '');
  row.dataset.keyId = key.id;
  row.dataset.set = String(Boolean(isAiRow ? isAnyAiKeySaved : key.set));
  if (key.managed) row.dataset.managed = key.managed;
  const external = key.managed === 'external' && !isAiRow;

  const head = documentRef.createElement('div');
  head.className = 'key-setup-row-head';
  const led = documentRef.createElement('span');
  led.className = 'key-setup-led';
  led.setAttribute('aria-hidden', 'true');
  const title = documentRef.createElement('strong');
  title.textContent = isAiRow ? 'FREE AI ENGINES (13 PROVIDERS)' : key.title;

  const statusBadge = documentRef.createElement('span');
  if (isAiRow) {
    statusBadge.className = `key-setup-status-pill ${isAnyAiKeySaved ? 'saved' : 'missing'}`;
    statusBadge.innerHTML = isAnyAiKeySaved
      ? `🟢 ACTIVE: ${activeProvider.name}`
      : '⚠️ NOT PASTED';
    statusBadge.title = isAnyAiKeySaved
      ? `Currently using ${activeProvider.name} as your primary inference engine`
      : 'No free AI engine key has been saved in .env yet';
  } else {
    statusBadge.className = `key-setup-status-pill ${key.set ? 'saved' : 'missing'}`;
    statusBadge.innerHTML = key.set ? '🟢 KEY SAVED & ACTIVE' : '⚠️ NOT PASTED';
    statusBadge.title = key.set
      ? `${key.title} is installed in your local .env and active`
      : `No key saved yet for ${key.title}`;
  }

  const tier = documentRef.createElement('span');
  tier.className = 'key-setup-tier';
  tier.textContent = TIER_DOTS[key.tier] || '';
  tier.title =
    key.tier === 'metered'
      ? 'Metered — a billing-enabled account'
      : 'Free key — register, paste, done';
  head.append(led, title, statusBadge, tier);

  if (key.clientExposed) {
    const exposed = documentRef.createElement('span');
    exposed.className = 'key-setup-exposed';
    exposed.textContent = 'browser-side';
    exposed.title =
      'This key runs in the browser by design — restrict it at the provider (see SECURITY.md)';
    head.append(exposed);
  }
  if (external) {
    const badge = documentRef.createElement('span');
    badge.className = 'key-setup-external';
    badge.textContent = 'configured externally';
    badge.title =
      'Supplied by your environment, Keychain, or launcher — change it where it was set';
    head.append(badge);
  }

  const get = documentRef.createElement('a');
  get.className = 'key-setup-get';
  get.href = isAiRow ? activeProvider.keyUrl : key.getUrl;
  get.target = '_blank';
  get.rel = 'noopener noreferrer';
  get.textContent = isAiRow
    ? (providerMap[activeId]?.set
        ? `MANAGE ${activeProvider.name.toUpperCase()} ↗`
        : `GET FREE ${activeProvider.name.toUpperCase()} KEY ↗`)
    : key.set
      ? 'MANAGE ↗'
      : 'GET KEY ↗';
  head.append(get);

  const unlocks = documentRef.createElement('p');
  unlocks.className = 'key-setup-unlocks';
  unlocks.textContent = isAiRow
    ? `Active engine: ${activeProvider.icon} ${activeProvider.name} (${activeProvider.badge}). Access 82+ frontier open-weights, fast LPU speed, or 1M context. Select any provider below to see its status or paste its key.`
    : key.unlocks;

  row.append(head, unlocks);

  if (!external || isAiRow) {
    const fields = documentRef.createElement('div');
    fields.className = 'key-setup-fields';

    if (!isAiRow) {
      if (key.set) {
        const savedBanner = documentRef.createElement('div');
        savedBanner.className = 'key-setup-saved-key-banner';
        savedBanner.innerHTML = `
          <span class="key-setup-saved-check">✓</span>
          <div>
            <strong>KEY IS ALREADY PASTED & SAVED IN .ENV</strong>
            <small>Active and ready to use. Type in the box below only if you want to replace it.</small>
          </div>
        `;
        fields.append(savedBanner);
      }

      for (const envVar of key.envVars) {
        const input = documentRef.createElement('input');
        input.type = envVar.includes('MODEL') ? 'text' : 'password';
        input.autocomplete = 'off';
        input.spellcheck = false;
        input.dataset.envVar = envVar;
        input.setAttribute('aria-label', envVar);
        input.placeholder = key.set
          ? `•••••••••••••••••••• (${envVar} saved — paste only to replace)`
          : `paste ${envVar}`;
        input.addEventListener('input', () => {
          if (input.value.trim().length > 0) input.classList.add('has-new-key');
          else input.classList.remove('has-new-key');
        });
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
    } else {
      // DEDICATED AI MULTI-PROVIDER INTERFACE
      // 1. Current Active Engine Card
      const activeCard = documentRef.createElement('div');
      activeCard.className = 'key-setup-active-engine-card';
      const activeSaved = Boolean(providerMap[activeId]?.set);
      activeCard.innerHTML = `
        <div class="active-engine-badge-line">
          <span class="active-engine-tag">⚡ CURRENT ACTIVE INFERENCE ENGINE</span>
          <span class="active-engine-status-pill ${activeSaved ? 'saved' : 'missing'}">
            ${activeSaved ? '🟢 KEY SAVED & ACTIVE IN .ENV' : '⚠️ NO KEY SAVED (FALLBACK)'}
          </span>
        </div>
        <div class="active-engine-title">
          ${activeProvider.icon} <strong>${activeProvider.name}</strong> <span class="active-engine-badge">${activeProvider.badge}</span>
        </div>
        <div class="active-engine-desc">${activeProvider.description}</div>
      `;
      fields.append(activeCard);

      // 2. Clear Instruction
      const hint = documentRef.createElement('div');
      hint.className = 'key-setup-provider-hint';
      hint.innerHTML = `👇 <b>13 Dedicated Provider Slots</b> — Every provider has its own separate input field. Paste keys for any or all providers below without overwriting other keys:`;
      fields.append(hint);

      // Hidden inputs that carry active engine configuration updates if changed
      const baseUrlInput = documentRef.createElement('input');
      baseUrlInput.type = 'hidden';
      baseUrlInput.dataset.envVar = 'NVIDIA_BASE_URL';
      baseUrlInput.value = '';
      fields.append(baseUrlInput);

      const modelInput = documentRef.createElement('input');
      modelInput.type = 'hidden';
      modelInput.dataset.envVar = 'NVIDIA_MODEL';
      modelInput.value = '';
      fields.append(modelInput);

      // 3. Quick-jump Provider Chips Container
      const presetsContainer = documentRef.createElement('div');
      presetsContainer.className = 'key-setup-model-presets';

      const chipEls = [];

      for (const provider of FREE_LLM_PROVIDERS) {
        const chip = documentRef.createElement('button');
        chip.type = 'button';
        const pSaved = Boolean(providerMap[provider.id]?.set);
        const pActive = provider.id === activeId;

        chip.className = `key-setup-preset-chip ${pActive ? 'is-active' : ''} ${pSaved ? 'has-key' : 'no-key'}`;

        const statusTagClass = pSaved
          ? pActive
            ? 'tag-active'
            : 'tag-saved'
          : 'tag-missing';
        const statusTagText = pSaved
          ? pActive
            ? '⚡ ACTIVE'
            : '🟢 SAVED'
          : '⚪ NO KEY';

        chip.innerHTML = `
          <span class="chip-provider-label">${provider.icon} ${provider.name}</span>
          <span class="chip-status-tag ${statusTagClass}">${statusTagText}</span>
        `;
        chip.title = `${provider.name} (${provider.badge}) — ${pSaved ? 'Key Saved' : 'No Key Pasted'}. Click to scroll to input.`;

        chip.addEventListener('click', () => {
          chipEls.forEach((c) => c.classList.remove('selected'));
          chip.classList.add('selected');
          const targetCard = fields.querySelector(`[data-provider-id="${provider.id}"]`);
          if (targetCard) {
            targetCard.scrollIntoView?.({ behavior: 'smooth', block: 'nearest' });
            targetCard.querySelector('input[data-env-var]')?.focus?.();
          }
        });

        chipEls.push(chip);
        presetsContainer.append(chip);
      }
      fields.append(presetsContainer);

      // 4. Segregated list of ALL 13 providers — each with its OWN dedicated input field!
      const providersList = documentRef.createElement('div');
      providersList.className = 'key-setup-providers-list';

      for (const provider of FREE_LLM_PROVIDERS) {
        const pSaved = Boolean(providerMap[provider.id]?.set);
        const pActive = provider.id === activeId;

        const card = documentRef.createElement('div');
        card.className = `key-setup-provider-card ${pActive ? 'is-active' : ''} ${pSaved ? 'has-key' : 'no-key'}`;
        card.dataset.providerId = provider.id;

        // Card Header
        const cardHead = documentRef.createElement('div');
        cardHead.className = 'provider-card-head';

        const titleGroup = documentRef.createElement('div');
        titleGroup.className = 'provider-card-title-group';

        const radioLabel = documentRef.createElement('label');
        radioLabel.className = 'provider-card-radio-label';

        const radio = documentRef.createElement('input');
        radio.type = 'radio';
        radio.name = 'key_setup_active_provider';
        radio.value = provider.id;
        radio.checked = pActive;
        radio.title = `Select ${provider.name} as active engine`;
        radio.addEventListener('change', () => {
          if (radio.checked) {
            baseUrlInput.value = provider.baseUrl;
            modelInput.value = provider.defaultModel;
          }
        });

        const iconSpan = documentRef.createElement('span');
        iconSpan.textContent = provider.icon;
        const nameStrong = documentRef.createElement('strong');
        nameStrong.textContent = provider.name;

        radioLabel.append(radio, iconSpan, nameStrong);

        const badge = documentRef.createElement('span');
        badge.className = 'provider-card-badge';
        badge.textContent = provider.badge;

        const statusTag = documentRef.createElement('span');
        statusTag.className = `chip-status-tag ${
          pSaved
            ? pActive
              ? 'tag-active'
              : 'tag-saved'
            : 'tag-missing'
        }`;
        statusTag.textContent = pSaved
          ? pActive
            ? '⚡ ACTIVE'
            : '🟢 SAVED'
          : '⚪ NO KEY';

        titleGroup.append(radioLabel, badge, statusTag);

        const cardLinks = documentRef.createElement('div');
        cardLinks.className = 'provider-card-links';
        const getLink = documentRef.createElement('a');
        getLink.className = 'key-setup-get';
        getLink.href = provider.keyUrl;
        getLink.target = '_blank';
        getLink.rel = 'noopener noreferrer';
        getLink.textContent = pSaved ? 'MANAGE ↗' : 'GET FREE KEY ↗';
        cardLinks.append(getLink);

        cardHead.append(titleGroup, cardLinks);

        // Card Description
        const desc = documentRef.createElement('div');
        desc.className = 'provider-card-desc';
        desc.textContent = provider.description;

        // Card Input Row: dedicated input + activate/remove buttons
        const inputRow = documentRef.createElement('div');
        inputRow.className = 'provider-card-input-row';

        const providerInput = documentRef.createElement('input');
        providerInput.type = 'password';
        providerInput.autocomplete = 'off';
        providerInput.spellcheck = false;
        providerInput.dataset.envVar = provider.envVar;
        providerInput.setAttribute(
          'aria-label',
          `${provider.name} API Key (${provider.envVar})`,
        );
        providerInput.placeholder = pSaved
          ? `•••••••••••••••••••• (${provider.envVar} saved — paste only to replace)`
          : `paste ${provider.envVar} (${provider.keyPlaceholder})`;

        providerInput.addEventListener('input', () => {
          const val = String(providerInput.value || '').trim();
          if (val.length > 0) {
            providerInput.classList.add('has-new-key');
          } else {
            providerInput.classList.remove('has-new-key');
          }
        });

        inputRow.append(providerInput);

        if (pSaved && !pActive) {
          const activateBtn = documentRef.createElement('button');
          activateBtn.type = 'button';
          activateBtn.className = 'key-setup-activate-btn';
          activateBtn.textContent = '⚡ ACTIVATE';
          activateBtn.title = `Switch active inference engine to ${provider.name}`;
          activateBtn.dataset.keySetupActivate = JSON.stringify({
            NVIDIA_BASE_URL: provider.baseUrl,
            NVIDIA_MODEL: provider.defaultModel,
          });
          inputRow.append(activateBtn);
        }

        if (pSaved) {
          const removeBtn = documentRef.createElement('button');
          removeBtn.type = 'button';
          removeBtn.className = 'key-setup-remove';
          removeBtn.dataset.keySetupRemove = JSON.stringify(
            pActive
              ? [provider.envVar, 'NVIDIA_BASE_URL', 'NVIDIA_MODEL']
              : [provider.envVar],
          );
          removeBtn.textContent = 'REMOVE';
          removeBtn.title = `Remove ${provider.name} key (${provider.envVar}) from your saved .env`;
          inputRow.append(removeBtn);
        }

        card.append(cardHead, desc, inputRow);
        providersList.append(card);
      }

      fields.append(providersList);
    }

    row.append(fields);
  }
  return row;
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

  const render = (nextStatus) => {
    if (disposed) return;
    status = nextStatus;
    chipLabel.textContent = keySetupChipLabel(status);
    // Fully powered is the owner's clean screen: the chip retires. The dialog
    // stays reachable this session (and via ?setup=1) to swap or verify keys.
    chip.hidden = status.setCount >= status.total;
    if (!rowsHost) return;
    rowsHost.textContent = '';
    for (const key of status.keys || [])
      rowsHost.append(buildRow(documentRef, key, status));
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
  // Remove and activate buttons are rendered per row; delegate so re-renders stay wired.
  rowsHost?.addEventListener('click', (event) => {
    const activateBtn = event.target?.closest?.('[data-key-setup-activate]');
    if (activateBtn && !disposed && !busy) {
      let updates = {};
      try {
        updates = JSON.parse(activateBtn.dataset.keySetupActivate || '{}');
      } catch {
        return;
      }
      if (Object.keys(updates).length > 0) {
        say('Switching active engine…');
        void submitUpdates(updates, 'Activated in');
      }
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
