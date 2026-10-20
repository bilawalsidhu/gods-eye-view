- Explicit cyclone selections publish only the currently selected NHC/CPHC
  storm into shared context. Switching storms removes the previous identity
  without a false eviction event. Deliberate clears remain distinct from feed
  disappearance (kvnloo, #847; reviewed by quanticsoul4772).
