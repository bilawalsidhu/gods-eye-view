export function createState() {
  return {
    viewer: null,
    enabled: false,
    dataSource: null,
    clickHandler: null,
    /** Region outlines, loaded once: `[{id, polygons}]`. */
    outlines: null,
    /**
     * The window on screen: `{anchor, days, regions, observations, mode,
     * season}`. `mode` is `live` or `replay`.
     */
    window: null,
    /** Continuous playhead in days from the window's first midnight. */
    position: 0,
    playing: false,
    /** Off-season: the live window has no rating and no avalanche. */
    quiet: false,
    /** Replay: `{season, weeks}` once the season histogram has loaded. */
    season: null,
    /** Selection: `{kind:'region'|'observation', id}` or null. */
    selected: null,
    status: 'idle',
    error: null,
    loading: false,
    stale: false,
    lastUpdate: null,
    failureReason: null,
    abort: null,
  };
}
