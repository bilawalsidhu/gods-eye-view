const KEY = 'gev-selection-camera-v1';

/** Ordinary selection preserves the overview unless the user opts into focus. */
export function selectionMovesCamera() {
  try {
    return globalThis.localStorage?.getItem(KEY) === 'focus';
  } catch {
    return false;
  }
}

/** Persist the ordinary-click camera preference. Explicit Focus stays independent. */
export function setSelectionMovesCamera(enabled) {
  const storage = globalThis.localStorage;
  if (!storage) throw new Error('Browser storage is unavailable');
  storage.setItem(KEY, enabled ? 'focus' : 'inspect');
  return Boolean(enabled);
}
