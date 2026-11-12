/**
 * Tracks whether each data feed is delivering, so a stretch with no recorded
 * points can be told apart: the feed answered with nothing, the feed failed,
 * or nothing asked for it (the app was closed or the layer was off).
 *
 * States: ok (answered with contacts), empty (answered with none), failing
 * (an HTTP error), idle (no request for a while, a state the clock moves a
 * feed into), unseen (nothing yet since the server started).
 */

/** Seconds without a request before a browser-driven feed counts as idle. */
const DEFAULT_IDLE_SEC = { air: 300, mil: 300, local: 300 };

/** @param {{ idleSec?: Record<string, number> }} [options] */
export function createFeedMonitor({ idleSec = DEFAULT_IDLE_SEC } = {}) {
  /** @type {Map<string, {state: string, since: number, lastRequest: number, lastOk: number|null, lastStatus: number, lastCount: number}>} */
  const feeds = new Map();

  function move(layer, feed, state, ts, status) {
    if (feed.state === state) return null;
    const first = feed.state === 'unseen';
    feed.state = state;
    feed.since = ts;
    // A feed that starts well is not news; the first bad answer is.
    return first && state === 'ok'
      ? null
      : { ts, layer, state, detail: status >= 400 ? String(status) : '' };
  }

  return {
    /**
     * Notes one answer from a feed. `count` is the contacts it carried.
     * Returns a state change worth logging, or null.
     */
    observe(layer, { status, count, ts }) {
      let feed = feeds.get(layer);
      if (!feed) {
        feed = {
          state: 'unseen',
          since: ts,
          lastRequest: ts,
          lastOk: null,
          lastStatus: status,
          lastCount: count,
        };
        feeds.set(layer, feed);
      }
      feed.lastRequest = ts;
      feed.lastStatus = status;
      feed.lastCount = count;
      if (status >= 400) return move(layer, feed, 'failing', ts, status);
      if (count > 0) feed.lastOk = ts;
      return move(layer, feed, count > 0 ? 'ok' : 'empty', ts, status);
    },

    /** Moves feeds nobody has asked for into idle; returns the changes. */
    tick(ts) {
      const changes = [];
      for (const [layer, feed] of feeds) {
        const limit = idleSec[layer];
        if (!limit || feed.state === 'idle' || feed.state === 'unseen')
          continue;
        if (ts - feed.lastRequest > limit) {
          const change = move(layer, feed, 'idle', ts, 0);
          if (change) changes.push(change);
        }
      }
      return changes;
    },

    /** One entry per layer, in the order given; layers never heard from are 'unseen'. */
    snapshot(layers, ts) {
      return layers.map((layer) => {
        const feed = feeds.get(layer);
        if (!feed) return { layer, state: 'unseen' };
        return {
          layer,
          state: feed.state,
          since: feed.since,
          lastRequest: feed.lastRequest,
          lastOk: feed.lastOk,
          lastStatus: feed.lastStatus,
          lastCount: feed.lastCount,
          idleFor: feed.state === 'idle' ? ts - feed.lastRequest : 0,
        };
      });
    },
  };
}
