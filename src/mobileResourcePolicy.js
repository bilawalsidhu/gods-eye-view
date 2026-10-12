/** A touch phone keeps the same budget after rotating into landscape. */
export function isMobileResourceConstrained({
  coarsePointer = globalThis.matchMedia?.('(pointer: coarse)')?.matches ??
    false,
  shortViewport = globalThis.matchMedia?.(
    '(max-width: 900px), (max-height: 600px)',
  )?.matches ?? false,
} = {}) {
  return coarsePointer && shortViewport;
}

export function mobileTilesetOptions(
  constrained = isMobileResourceConstrained(),
) {
  return constrained
    ? {
        cacheBytes: 128 * 1024 * 1024,
        maximumCacheOverflowBytes: 32 * 1024 * 1024,
        maximumScreenSpaceError: 32,
      }
    : {};
}
