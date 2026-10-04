export const VOICE_INACTIVITY_STORAGE_KEY =
  'godsEyeView.voice.inactivityMinutes';
export const DEFAULT_VOICE_INACTIVITY_MINUTES = 5;
export const VOICE_SETTINGS_COCKPIT_EXIT_MS = 20_000;
export const VOICE_INACTIVITY_PRESETS = Object.freeze([3, 5, 10, 15]);
export const VOICE_INACTIVITY_NONE_MESSAGE =
  'GEV will not stop voice because of inactivity. Provider session limits and disconnections still apply.';

function localVoiceStorage(storage) {
  if (storage !== undefined) return storage;
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** Parse a stored or user-entered inactivity duration. `null` means None. */
export function parseVoiceInactivityMinutes(value) {
  if (value === null || value === 'none') return null;
  if (typeof value === 'string' && !/^\d+$/.test(value.trim()))
    return undefined;
  const minutes = Number(value);
  return Number.isInteger(minutes) && minutes >= 1 && minutes <= 60
    ? minutes
    : undefined;
}

/** Read the browser-local preference without ever consulting URL state. */
export function readVoiceInactivityMinutes(storage) {
  try {
    const raw = localVoiceStorage(storage)?.getItem?.(
      VOICE_INACTIVITY_STORAGE_KEY,
    );
    if (raw == null) return DEFAULT_VOICE_INACTIVITY_MINUTES;
    const parsed = parseVoiceInactivityMinutes(raw);
    return parsed === undefined ? DEFAULT_VOICE_INACTIVITY_MINUTES : parsed;
  } catch {
    return DEFAULT_VOICE_INACTIVITY_MINUTES;
  }
}

/** Persist the browser-local preference. Invalid values are rejected. */
export function writeVoiceInactivityMinutes(value, storage) {
  const parsed = parseVoiceInactivityMinutes(value);
  if (parsed === undefined) return false;
  try {
    localVoiceStorage(storage)?.setItem?.(
      VOICE_INACTIVITY_STORAGE_KEY,
      parsed === null ? 'none' : String(parsed),
    );
  } catch {
    /* Storage is optional. */
  }
  return true;
}

export function voiceInactivityPauseMessage(minutes) {
  return `Voice paused after ${minutes} minute${minutes === 1 ? '' : 's'} of inactivity.`;
}

/**
 * Keep one bounded request to reveal Voice Settings after Cockpit exits.
 * The owner is tied to the current voice-session lifetime so stale requests
 * cannot open UI after a stop, provider change, or application teardown.
 */
export function createDeferredVoiceSettingsIntent({
  open,
  onExpire,
  eventTarget = globalThis.window,
  setTimer = globalThis.setTimeout,
  clearTimer = globalThis.clearTimeout,
  deferOpen = globalThis.queueMicrotask,
  timeoutMs = VOICE_SETTINGS_COCKPIT_EXIT_MS,
}) {
  let timer = null;
  let pending = false;
  let destroyed = false;
  let generation = 0;
  const cancel = () => {
    generation += 1;
    if (timer !== null) clearTimer?.(timer);
    timer = null;
    pending = false;
  };
  const expire = () => {
    if (!pending || destroyed) return;
    timer = null;
    pending = false;
    onExpire?.();
  };
  const handleCockpit = (event) => {
    if (!pending || destroyed || event?.detail?.active !== false) return;
    if (timer !== null) clearTimer?.(timer);
    timer = null;
    pending = false;
    const exitGeneration = ++generation;
    const reveal = () => {
      if (destroyed || generation !== exitGeneration) return;
      open?.();
    };
    if (typeof deferOpen === 'function') deferOpen(reveal);
    else Promise.resolve().then(reveal);
  };
  eventTarget?.addEventListener?.('gev:cockpit-mode-changed', handleCockpit);
  return {
    schedule() {
      if (destroyed) return false;
      cancel();
      pending = true;
      timer = setTimer?.(expire, timeoutMs) ?? null;
      timer?.unref?.();
      return true;
    },
    cancel,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      cancel();
      eventTarget?.removeEventListener?.(
        'gev:cockpit-mode-changed',
        handleCockpit,
      );
    },
    get pending() {
      return pending;
    },
    timeoutMs,
  };
}

/**
 * Own the application-level inactivity timer. Provider close/warning events
 * stay authoritative; this owner only requests the normal complete stop path.
 */
export function createVoiceInactivityController({
  session,
  minutes = DEFAULT_VOICE_INACTIVITY_MINUTES,
  onExpire,
  setTimer = globalThis.setTimeout,
  clearTimer = globalThis.clearTimeout,
}) {
  let preference = parseVoiceInactivityMinutes(minutes);
  if (preference === undefined) preference = DEFAULT_VOICE_INACTIVITY_MINUTES;
  let timer = null;
  let connected = false;
  const pendingTools = new Set();
  const blockers = new Set();

  const cancel = () => {
    if (timer === null) return;
    clearTimer(timer);
    timer = null;
  };
  const canArm = () =>
    connected &&
    preference !== null &&
    pendingTools.size === 0 &&
    blockers.size === 0 &&
    session.isActive();
  const arm = () => {
    cancel();
    if (!canArm()) return;
    const armedMinutes = preference;
    timer = setTimer(() => {
      timer = null;
      if (!canArm() || preference !== armedMinutes) return;
      connected = false;
      try {
        onExpire?.();
      } finally {
        session.stop({ detail: voiceInactivityPauseMessage(armedMinutes) });
      }
    }, armedMinutes * 60_000);
    timer?.unref?.();
  };
  const activity = () => {
    if (connected) arm();
  };
  const setBlocking = (kind, active) => {
    if (active) blockers.add(kind);
    else blockers.delete(kind);
    if (active) cancel();
    else activity();
  };
  const clearActivity = () => {
    connected = false;
    pendingTools.clear();
    blockers.clear();
    cancel();
  };
  const handleEvent = (event) => {
    if (!event) return;
    if (event.type === 'state') {
      if (event.state === 'listening') {
        connected = true;
        activity();
      } else if (['idle', 'error'].includes(event.state)) {
        clearActivity();
      }
      return;
    }
    if (!connected) return;
    if (event.type === 'transcript' && String(event.text || '').trim()) {
      activity();
      return;
    }
    if (event.type === 'action-call') {
      pendingTools.add(event.actionId);
      cancel();
      return;
    }
    if (event.type === 'action-settled') {
      if (pendingTools.delete(event.actionId)) activity();
      return;
    }
    if (event.type === 'interruption') {
      pendingTools.clear();
      activity();
      return;
    }
    if (event.type === 'activity') {
      setBlocking(event.kind || 'voice', event.active !== false);
      return;
    }
    if (event.type === 'completion') activity();
  };

  return {
    handleEvent,
    noteActivity: activity,
    setPreference(value) {
      const parsed = parseVoiceInactivityMinutes(value);
      if (parsed === undefined) return false;
      preference = parsed;
      activity();
      return true;
    },
    get preference() {
      return preference;
    },
    destroy: clearActivity,
  };
}

/** Bind the voice-only settings popup to the local preference owner. */
export function bindVoiceInactivitySettings({
  ui,
  storage,
  controller,
  initialOpen = false,
}) {
  const select = ui.inactivitySelect;
  const options = Array.from(ui.inactivityOptions || []);
  const customRow = ui.inactivityCustomRow;
  const customInput = ui.inactivityCustomInput;
  const customValue = ui.inactivityCustomValue;
  const note = ui.inactivityNote;
  const panel = ui.voiceSettingsPanel;
  const button = ui.voiceSettingsButton;
  const close = ui.voiceSettingsClose;
  if ((!select && options.length === 0) || !customInput || !panel || !button)
    return () => {};

  const initial = readVoiceInactivityMinutes(storage);
  const renderNote = (value) => {
    if (!note) return;
    note.textContent =
      value === null
        ? VOICE_INACTIVITY_NONE_MESSAGE
        : `GEV pauses voice after ${value} minute${value === 1 ? '' : 's'} without voice activity.`;
  };
  const showCustom = (shown) => {
    if (customRow) customRow.hidden = !shown;
  };
  const renderCustomValue = (value) => {
    const parsed = parseVoiceInactivityMinutes(value);
    if (parsed === undefined || parsed === null) return;
    const label = `${parsed} min`;
    if (customValue) customValue.textContent = label;
    customInput.setAttribute?.(
      'aria-valuetext',
      `${parsed} minute${parsed === 1 ? '' : 's'}`,
    );
  };
  const renderValue = (value) => {
    const preset = VOICE_INACTIVITY_PRESETS.includes(value);
    const selection =
      value === null ? 'none' : preset ? String(value) : 'custom';
    if (select) select.value = selection;
    for (const option of options) option.checked = option.value === selection;
    if (value !== null && !preset) customInput.value = String(value);
    renderCustomValue(customInput.value);
    showCustom(value !== null && !preset);
    renderNote(value);
  };
  const commit = (value) => {
    const parsed = parseVoiceInactivityMinutes(value);
    const valid = parsed !== undefined;
    customInput.setCustomValidity?.(
      valid ? '' : 'Enter a whole number from 1 to 60.',
    );
    customInput.setAttribute?.('aria-invalid', String(!valid));
    if (!valid) {
      if (note) note.textContent = 'Enter a whole number from 1 to 60 minutes.';
      return false;
    }
    writeVoiceInactivityMinutes(parsed, storage);
    controller.setPreference(parsed);
    renderCustomValue(parsed);
    renderNote(parsed);
    return true;
  };
  const choose = (value) => {
    const custom = value === 'custom';
    showCustom(custom);
    if (custom) {
      customInput.setCustomValidity?.('');
      customInput.setAttribute?.('aria-invalid', 'false');
      renderCustomValue(customInput.value);
      if (note) note.textContent = 'Choose a duration from 1 to 60 minutes.';
    } else {
      commit(value);
    }
  };
  const selectHandler = () => choose(select.value);
  const optionHandler = (event) => {
    if (!event.currentTarget.checked) return;
    for (const option of options)
      option.checked = option === event.currentTarget;
    choose(event.currentTarget.value);
  };
  const customHandler = () => {
    renderCustomValue(customInput.value);
    commit(customInput.value);
  };
  const setOpen = (open) => {
    const activeElement =
      panel.ownerDocument?.activeElement ?? globalThis.document?.activeElement;
    const restoreFocus =
      !open && !panel.hidden && panel.contains?.(activeElement);
    panel.hidden = !open;
    button.setAttribute('aria-expanded', String(open));
    if (open)
      (
        options.find((option) => option.checked) ||
        select ||
        options[0]
      )?.focus?.();
    else if (restoreFocus) button.focus?.();
  };
  const toggleHandler = () => setOpen(panel.hidden);
  const closeHandler = () => setOpen(false);
  const escapeHandler = (event) => {
    if (event.key !== 'Escape' || panel.hidden) return;
    event.preventDefault();
    closeHandler();
  };

  controller.setPreference(initial);
  renderValue(initial);
  setOpen(initialOpen);
  button.addEventListener('click', toggleHandler);
  close?.addEventListener('click', closeHandler);
  panel.addEventListener('keydown', escapeHandler);
  select?.addEventListener('change', selectHandler);
  for (const option of options)
    option.addEventListener('change', optionHandler);
  customInput.addEventListener('input', customHandler);
  customInput.addEventListener('change', customHandler);
  const unsubscribe = () => {
    button.removeEventListener('click', toggleHandler);
    close?.removeEventListener('click', closeHandler);
    panel.removeEventListener('keydown', escapeHandler);
    select?.removeEventListener('change', selectHandler);
    for (const option of options)
      option.removeEventListener('change', optionHandler);
    customInput.removeEventListener('input', customHandler);
    customInput.removeEventListener('change', customHandler);
  };
  unsubscribe.setOpen = (open) => {
    setOpen(Boolean(open));
    return true;
  };
  unsubscribe.setPreference = (value) => {
    const parsed = parseVoiceInactivityMinutes(value);
    if (parsed === undefined || !commit(parsed)) return false;
    renderValue(parsed);
    return true;
  };
  unsubscribe.getPreference = () => controller.preference;
  return unsubscribe;
}
