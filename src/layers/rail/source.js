/** Request rail snapshots, path packs, timetables and trip updates through caller-owned transport. */
export function createRailSource({
  fetchImpl = (...args) => fetch(...args),
} = {}) {
  /**
   * GET one per-feed JSON resource and hand back a response-like object whose
   * body read still honours the caller's abort.
   * @param {string} route `trains`, `paths`, `schedule` or `updates`.
   * @param {string} feedId
   * @param {{signal?: AbortSignal}} [options]
   */
  function requestFeedJson(route, feedId, { signal } = {}) {
    signal?.throwIfAborted();
    if (typeof feedId !== 'string' || !feedId || feedId.length > 160)
      throw new TypeError('A rail feed identifier is required');
    return Promise.resolve(
      fetchImpl(`/api/rail/${route}/${encodeURIComponent(feedId)}`, {
        signal,
        headers: { Accept: 'application/json' },
      }),
    ).then((response) => {
      signal?.throwIfAborted();
      return {
        ok: response.ok,
        status: response.status,
        headers: response.headers,
        async json() {
          const body = await response.json();
          signal?.throwIfAborted();
          return body;
        },
      };
    });
  }

  return {
    /** Read the public catalog of enabled feeds. */
    async getFeeds({ signal } = {}) {
      signal?.throwIfAborted();
      const response = await fetchImpl('/api/rail/feeds', {
        signal,
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) throw new Error('Rail feeds HTTP ' + response.status);
      const body = await response.json();
      signal?.throwIfAborted();
      if (!Array.isArray(body?.feeds))
        throw new Error('Malformed rail feed catalog');
      return body.feeds;
    },
    /** The feed's current train-only snapshot. */
    requestSnapshot(feedId, options) {
      return requestFeedJson('trains', feedId, options);
    },
    /** The feed's path pack (route shapes); 404 when none is published. */
    requestPaths(feedId, options) {
      return requestFeedJson('paths', feedId, options);
    },
    /** The feed's timetable pack; 404 when none is published. */
    requestSchedule(feedId, options) {
      return requestFeedJson('schedule', feedId, options);
    },
    /** The feed's live trip updates (delays); 404 for a feed without them. */
    requestUpdates(feedId, options) {
      return requestFeedJson('updates', feedId, options);
    },
  };
}
