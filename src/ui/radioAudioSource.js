/**
 * Adapts the Radio layer to the audio visualizer source contract
 * (src/ui/audioVisualizer.js). Only streams served with CORS are 'live';
 * others play directly and are reported as 'opaque'.
 */

/** Visualizer mode for a Radio UI state snapshot. */
export function radioVisualizerMode(state) {
  if (!state?.enabled || !state.playingStationId) return 'hidden';
  if (state.audioState === 'loading') return 'acquiring';
  if (state.audioState !== 'playing') return 'hidden';
  return state.audioReadable ? 'live' : 'opaque';
}

/** Visualizer state for a Radio UI state snapshot. */
export function radioVisualizerState(state) {
  const playing =
    state?.selected && state.selected.id === state.playingStationId
      ? state.selected
      : null;
  return {
    mode: radioVisualizerMode(state),
    label: playing?.name || '',
    notice: 'SPECTRUM UNAVAILABLE · STREAM BLOCKS CORS',
  };
}

/**
 * @param {{subscribe: Function, getAnalyser: Function}} radio Radio layer.
 * @returns {{subscribe: Function, getAnalyser: Function}}
 */
export function createRadioAudioSource(radio) {
  return {
    subscribe: (listener) =>
      radio.subscribe((state) => listener(radioVisualizerState(state))),
    getAnalyser: () => radio.getAnalyser?.() ?? null,
  };
}
