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
  let disposed = false;
  const initial = preferences.snapshot();
  const displayed = parseMinutes(ui.state.preferences.timeoutMinutes);
  let custom =
    !PRESETS.includes(String(initial.minutes)) && initial.minutes > 0
      ? initial.minutes
      : displayed > 0
        ? displayed
        : 5;
  // Every render republishes the fields, so a refused change shows the
  // applied value again.
  function render(state) {
    if (disposed) return;
    const value = String(state.minutes);
    const customSelected = state.minutes > 0 && !PRESETS.includes(value);
    if (customSelected) custom = state.minutes;
    ui.update('preferences', {
      previewChecked: state.previewEnabled,
      // Functions, so a locale change words the notes again.
      previewNote: () =>
        `${copy.previewNote}${state.previewPersisted === false ? ` ${copy.notSaved}` : ''}`,
      timeoutNote: () =>
        `${copy.timeoutNote}${state.timeoutPersisted === false ? ` ${copy.notSaved}` : ''}`,
      timeoutChoice:
        state.minutes === 0 ? '0' : customSelected ? 'custom' : value,
      timeoutMinutes: String(custom),
      timeoutInputHidden: !customSelected,
      revision: ui.state.preferences.revision + 1,
    });
  }
  const unsubscribe = preferences.subscribe((state) => {
    render(state);
    onChange?.(state);
  });
  // A custom value may equal a preset: keep the person's explicit editor
  // choice.
  const showCustom = () =>
    ui.update('preferences', {
      timeoutChoice: 'custom',
      timeoutMinutes: String(custom),
      timeoutInputHidden: false,
      revision: ui.state.preferences.revision + 1,
    });
  const offs = [
    ui.on('preview-change', (checked) => {
      if (!disposed && !preferences.setPreviewEnabled(checked).ok)
        render(preferences.snapshot());
    }),
    ui.on('timeout-select', (value) => {
      if (disposed) return;
      if (value === 'custom') {
        const parsed = parseMinutes(ui.state.preferences.timeoutMinutes);
        if (parsed === undefined || parsed === 0) {
          render(preferences.snapshot());
          return;
        }
        custom = parsed;
        preferences.setMinutes(parsed);
        showCustom();
      } else if (value === '0' || PRESETS.includes(value))
        preferences.setMinutes(value);
      else render(preferences.snapshot());
    }),
    ui.on('timeout-input', (value) => {
      if (disposed) return;
      const parsed = parseMinutes(value);
      if (parsed === undefined || parsed === 0) {
        render(preferences.snapshot());
        return;
      }
      custom = parsed;
      preferences.setMinutes(parsed);
      showCustom();
    }),
  ];
  render(initial);
  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      for (const off of offs) off();
    },
  };
}
