import { DEFAULT_ALPHA } from './policy.js';

export function createState() {
  return {
    viewer: null,
    enabled: false,
    /** Time key of the frame most on screen (first of its month). */
    date: null,
    /** Newest published month; the year scale ends at its year. */
    latest: null,
    /**
     * The shown year's frame stack: `{dates, position, layers}`, one imagery
     * layer per month in date order (see filmstrip.js).
     */
    filmstrip: null,
    /**
     * Playback: `{year, dates, position, playing}`, dates oldest first and
     * position a continuous playhead in frames.
     */
    playback: null,
    /** Year being loaded underneath the shown one, or null. */
    playbackLoading: null,
    playbackError: null,
    playbackAbort: null,
    alpha: DEFAULT_ALPHA,
    status: 'idle',
    error: null,
    loading: false,
    lastUpdate: null,
    failureReason: null,
    abort: null,
    /**
     * Click-to-read state. The readout lives on its own data source so
     * clearing a reading never disturbs the imagery overlay, and its abort
     * controller is separate so a new click supersedes only the previous
     * sample, not the year resolution.
     */
    sampleDataSource: null,
    sample: null,
    sampling: false,
    sampleAbort: null,
    clickHandler: null,
  };
}
