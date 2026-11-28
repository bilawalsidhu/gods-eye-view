/** The page's localStorage, or null where it is absent or access throws. */
export function browserStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** `storage`, or the page's localStorage when none was given. */
export function optionalStorage(storage) {
  return storage === undefined ? browserStorage() : storage;
}
