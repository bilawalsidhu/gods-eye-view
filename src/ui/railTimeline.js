import { h, render } from 'vue';
import RailTimeline from './rail/RailTimeline.vue';

export { utcClock } from './rail/utcClock.js';

/**
 * Stable native transport with local preview and a coalesced 150 ms drag
 * commit. Renders the RailTimeline component into `container` and patches it
 * synchronously on every update.
 */
export function createRailTimeline({
  container,
  document = container?.ownerDocument,
  sliderClassName = '',
  heading = true,
  onCommit = () => {},
  onPreview = () => {},
  onStep = () => {},
  onLatest = () => {},
  onPlay = () => {},
} = {}) {
  if (!document?.createElement || !container) return null;
  let destroyed = false;
  const paint = (state) =>
    render(
      h(RailTimeline, {
        state,
        sliderClassName,
        heading,
        onCommit,
        onPreview,
        onStep,
        onLatest,
        onPlay,
      }),
      container,
    );
  paint({
    ticks: [],
    index: 0,
    mode: 'latest',
    playing: false,
    readout: '',
    disabled: true,
  });
  return {
    update(state) {
      if (!destroyed) paint(state);
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      render(null, container);
    },
  };
}
