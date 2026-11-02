export const VOICE_PREVIEW_STORAGE_KEY = 'godsEyeView.voice.previewEnabled';
export const VOICE_TIMEOUT_STORAGE_KEY = 'godsEyeView.voice.inactivityMinutes';
const PRESETS = ['3', '5', '10', '15'];

function parseMinutes(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return undefined;
  if (typeof value === 'string' && !/^\d+$/.test(value)) return undefined;
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 && number <= 60
    ? number
    : undefined;
}

/** Outer, browser-local live state. Construction never writes storage. */
export function createVoicePreferences({ storage } = {}) {
  const listeners = new Set();
  const target = () =>
    storage === undefined ? globalThis.localStorage : storage;
  const read = (key) => {
    try {
      return target()?.getItem?.(key);
    } catch {
      return undefined;
    }
  };
  const rawMinutes = read(VOICE_TIMEOUT_STORAGE_KEY);
  let state = {
    previewEnabled: read(VOICE_PREVIEW_STORAGE_KEY) !== 'false',
    minutes: rawMinutes === 'none' ? 0 : (parseMinutes(rawMinutes) ?? 5),
    previewPersisted: null,
    timeoutPersisted: null,
  };
  const snapshot = () => ({ ...state });
  function apply(field, status, key, value, serialized) {
    const changed = state[field] !== value;
    let persisted = false;
    state = { ...state, [field]: value };
    try {
      const destination = target();
      if (
        typeof destination?.setItem === 'function' &&
        typeof destination?.getItem === 'function'
      ) {
        destination.setItem(key, serialized);
        persisted = destination.getItem(key) === serialized;
      }
    } catch {
      /* The applied live value remains authoritative across mounts. */
    }
    state = { ...state, [status]: persisted };
    const result = {
      ok: true,
      applied: true,
      changed,
      persisted,
      ...snapshot(),
    };
    for (const listener of [...listeners]) listener(snapshot());
    return result;
  }
  const invalid = () => ({
    ok: false,
    applied: false,
    changed: false,
    persisted: null,
    reason: 'invalid-value',
    ...snapshot(),
  });
  return {
    snapshot,
    setPreviewEnabled(value) {
      return typeof value === 'boolean'
        ? apply(
            'previewEnabled',
            'previewPersisted',
            VOICE_PREVIEW_STORAGE_KEY,
            value,
            String(value),
          )
        : invalid();
    },
    setMinutes(value) {
      const parsed = parseMinutes(value);
      return parsed === undefined
        ? invalid()
        : apply(
            'minutes',
            'timeoutPersisted',
            VOICE_TIMEOUT_STORAGE_KEY,
            parsed,
            parsed === 0 ? 'none' : String(parsed),
          );
    },
    subscribe(listener) {
      if (typeof listener !== 'function')
        throw new TypeError('Preference listener required');
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** Mount-local controls, backed by an independently owned preference model. */
export function bindPreferenceControls({ ui, preferences, copy, onChange }) {
  const {
    voicePreviewInput: preview,
    voicePreviewNote: previewNote,
    voiceTimeoutSelect: select,
    voiceTimeoutInput: input,
    voiceTimeoutNote: timeoutNote,
  } = ui;
  let disposed = false;
  const initial = preferences.snapshot();
  const displayed = parseMinutes(input?.value);
  let custom =
    !PRESETS.includes(String(initial.minutes)) && initial.minutes > 0
      ? initial.minutes
      : displayed > 0
        ? displayed
        : 5;
  function render(state) {
    if (disposed) return;
    if (preview) preview.checked = state.previewEnabled;
    if (previewNote)
      previewNote.textContent = `${copy.previewNote}${state.previewPersisted === false ? ` ${copy.notSaved}` : ''}`;
    if (timeoutNote)
      timeoutNote.textContent = `${copy.timeoutNote}${state.timeoutPersisted === false ? ` ${copy.notSaved}` : ''}`;
    const value = String(state.minutes);
    const customSelected = state.minutes > 0 && !PRESETS.includes(value);
    if (customSelected) custom = state.minutes;
    if (select)
      select.value =
        state.minutes === 0 ? '0' : customSelected ? 'custom' : value;
    if (input) {
      input.value = String(custom);
      input.hidden = !customSelected;
    }
  }
  const unsubscribe = preferences.subscribe((state) => {
    render(state);
    onChange?.(state);
  });
  const previewChange = () => {
    if (!disposed && !preferences.setPreviewEnabled(preview.checked).ok)
      render(preferences.snapshot());
  };
  const selectChange = () => {
    if (disposed) return;
    const value = select.value;
    if (value === 'custom') {
      const parsed = parseMinutes(input?.value);
      if (parsed === undefined || parsed === 0) {
        render(preferences.snapshot());
        return;
      }
      custom = parsed;
      preferences.setMinutes(parsed);
      // A custom value may equal a preset: retain the user's explicit editor choice.
      select.value = 'custom';
      if (input) input.hidden = false;
    } else if (value === '0' || PRESETS.includes(value))
      preferences.setMinutes(value);
    else render(preferences.snapshot());
  };
  const inputChange = () => {
    if (disposed) return;
    const parsed = parseMinutes(input.value);
    if (parsed === undefined || parsed === 0) {
      render(preferences.snapshot());
      return;
    }
    custom = parsed;
    preferences.setMinutes(parsed);
    if (select) select.value = 'custom';
    input.hidden = false;
  };
  const bindings = [
    [preview, previewChange],
    [select, selectChange],
    [input, inputChange],
  ];
  for (const [element, listener] of bindings)
    element?.addEventListener('change', listener);
  render(initial);
  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      for (const [element, listener] of bindings)
        element?.removeEventListener('change', listener);
    },
  };
}
