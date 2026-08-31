/**
 * The feed health banner: one line at rest, every feed one click away.
 *
 * Named sources and real reasons, never a generic spinner. "adsb.lol rate limited until
 * 14:32" tells the user the data is fine and we are being asked to wait; "feed down"
 * would be a different and wrong statement. A layer that has quietly stopped updating is
 * the failure this panel exists to prevent.
 *
 * **Why it collapses.** It used to print the socket state plus one line per feed, five or
 * six lines that never change, in the same column as the layer rail, which already names
 * every degraded feed against the layer it belongs to. Two panels stating the same thing is
 * how the left of the globe filled up. So the banner states the worst thing happening, which
 * is the one line a user has to see, and the full list stays behind the disclosure for
 * whoever wants it. Nothing left the screen; the socket state is here because it is the one
 * thing the rail has no row for.
 */

import type { ConnectionState } from '../net/ws';
import type { FeedHealth } from '../types/entities';

export type NoticeLevel = 'live' | 'idle' | 'warning' | 'error';

export interface FeedNotice {
  source: string;
  level: NoticeLevel;
  text: string;
}

function clockTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

function absent(value: string | null | undefined): boolean {
  return value === null || value === undefined;
}

/** A poll interval in words. Coarse, because the point is the order of magnitude. */
function everyText(seconds: number): string {
  if (seconds < 60) {
    return `every ${String(Math.round(seconds))}s`;
  }
  if (seconds < 3600) {
    return `every ${String(Math.round(seconds / 60))}m`;
  }
  return `every ${String(Math.round(seconds / 3600))}h`;
}

/**
 * A feed that has not polled yet, which is a third state and not a broken one.
 *
 * **The discriminator was already in the payload and this function is why it now gets used.**
 * `healthy` is false before the first successful poll as well as after a failure, so a feed that
 * has simply not been asked yet was indistinguishable in the code from one that is down. Live on
 * 2026-08-24 `celestrak/gp` arrived as `healthy: false`, `last_success_at: null`,
 * `last_error: null`, `consecutive_failures: 0`: never succeeded, never failed, never asked. The
 * banner called it down and 698 satellites were on screen at the time, served off the disk cache
 * exactly as designed, so the product raised an error about the feed supplying the data the
 * viewer was looking at.
 *
 * Three fields rather than one, because each rules out a different real state. No success rules
 * out a working feed, no failures rules out one that has been trying and losing, and no error
 * rules out one that failed without a counter. Any of the three present and this is a feed with
 * a history, which the branches below are already right about.
 *
 * **CelesTrak is why it persists rather than flickering past on startup.** Its floor and its
 * element sets are both on disk, per AGENTS.md, so a process started inside the window opens no
 * socket at all and this state holds for up to the poll interval, six hours. That is the
 * difference between a wrong string nobody catches and a wrong string that sends someone to
 * debug a healthy system.
 */
function notPolledYet(feed: FeedHealth): boolean {
  return absent(feed.last_success_at) && absent(feed.last_error) && feed.consecutive_failures === 0;
}

/** One feed's state in words. */
export function describeFeed(feed: FeedHealth, now: Date = new Date()): FeedNotice {
  const limit = feed.rate_limited_until;
  if (limit !== null && limit !== undefined && new Date(limit).getTime() > now.getTime()) {
    return {
      source: feed.source,
      level: 'warning',
      text: `${feed.source} rate limited until ${clockTime(limit)}`,
    };
  }
  if (notPolledYet(feed)) {
    // Not gated on `healthy`, because a feed reporting healthy with nothing behind it has still
    // told us nothing and "live, 0 tracked" would be the same overclaim in the other direction.
    // The interval is stated because it is the fact that makes the state make sense: without it
    // a reader waits for a number that is six hours away.
    return {
      source: feed.source,
      level: 'idle',
      text: `${feed.source} not polled yet, ${everyText(feed.poll_interval_seconds)}`,
    };
  }
  if (!feed.healthy) {
    const reason = feed.last_error ?? 'no successful poll yet';
    return { source: feed.source, level: 'error', text: `${feed.source} down: ${reason}` };
  }
  if (feed.consecutive_failures > 1) {
    return {
      source: feed.source,
      level: 'warning',
      text: `${feed.source} degraded, ${String(feed.consecutive_failures)} failed polls`,
    };
  }
  return {
    source: feed.source,
    // "in its last poll", not "tracked", and the difference is measurable. `entity_count` is what
    // the feed's last sweep accepted, which is not the number of things the server holds: sampled
    // 2026-08-24, aircraft ran 901 to 949 against a store of 979 to 993, vessels 5,960 against
    // 6,005, and transit 13,843 against 17,456. `adsb.lol/mil` is the one that matches exactly,
    // 154 to 154, because it is a single endpoint so one sweep covers the whole store. "Tracked"
    // claims the second number while carrying the first, and the layer rail sits 200px below this
    // showing the store count for the same layer with nothing reconciling the two.
    level: 'live',
    text: `${feed.source} live, ${feed.entity_count.toLocaleString('en-GB')} in its last poll`,
  };
}

/** The socket's own state, which is separate from any upstream feed's. */
export function describeConnection(state: ConnectionState, retryInMs: number | null): FeedNotice {
  switch (state) {
    case 'live': {
      return { source: 'live feed', level: 'live', text: 'Live feed connected' };
    }
    case 'connecting': {
      return { source: 'live feed', level: 'warning', text: 'Connecting to the live feed' };
    }
    case 'reconnecting': {
      return {
        source: 'live feed',
        level: 'warning',
        text:
          retryInMs === null
            ? 'Live feed lost, reconnecting'
            : `Live feed lost, retrying in ${String(Math.round(retryInMs / 1000))}s`,
      };
    }
    case 'closed': {
      return { source: 'live feed', level: 'error', text: 'Live feed closed' };
    }
  }
}

/** Worst first, so the summary can pick the thing that matters. */
const SEVERITY: Record<NoticeLevel, number> = { error: 2, warning: 1, live: 0, idle: 0 };

/**
 * Whether a notice is something wrong, which is not the same as not being live.
 *
 * Both this module and the layer rail used to test `level !== 'live'` to mean "a fault", so
 * adding a third non-live state that is nobody's fault would have made both of them wrong in the
 * same way at once. Severity is the thing they actually mean, so they both ask this instead.
 */
export function isFault(notice: FeedNotice): boolean {
  return SEVERITY[notice.level] > 0;
}

/**
 * The one line the collapsed banner shows.
 *
 * **It counts broken feeds rather than naming them, and that is the point.** The layer rail
 * sits directly below this and already names every failing feed against the layer it belongs
 * to, in the same words. Restating the worst one here put the identical sentence on screen
 * twice, a few pixels apart, which is exactly the duplication that filled the left of the
 * globe. So this says how many and the rail says which.
 *
 * The socket is the exception and it comes first, because it is the one thing the rail has no
 * row for and nothing on the globe updates without it. A lost socket is the headline whatever
 * the feeds are doing.
 */
export function summariseFeeds(
  connection: FeedNotice,
  feeds: readonly FeedHealth[],
  now: Date = new Date(),
): FeedNotice {
  if (connection.level !== 'live') {
    // Nothing arrives at all, so the socket outranks any number of sick feeds.
    return connection;
  }
  const notices = feeds.map((feed) => describeFeed(feed, now));
  const bad = notices
    .filter((notice) => isFault(notice))
    .toSorted((left, right) => SEVERITY[right.level] - SEVERITY[left.level]);
  const worst = bad[0];
  if (worst !== undefined) {
    // "down" and "degraded" are different claims: a feed still answering with two failures
    // behind it has not stopped, and saying it has would be the wrong statement.
    const state = worst.level === 'error' ? 'down' : 'degraded';
    return {
      ...worst,
      text: `${String(bad.length)} of ${String(feeds.length)} feeds ${state}`,
    };
  }
  if (feeds.length === 0) {
    return connection;
  }
  // A feed that has not polled yet cannot be counted as healthy, and counting it as one is how
  // "5 feeds healthy" would replace one false claim with another. The level stays the socket's,
  // because nothing here is wrong: the system is live and the count says what it is counting.
  const waiting = notices.filter((notice) => notice.level === 'idle').length;
  if (waiting === feeds.length) {
    return { ...connection, text: 'Live, no feed has polled yet' };
  }
  if (waiting > 0) {
    return {
      ...connection,
      text: `Live, ${String(feeds.length - waiting)} of ${String(feeds.length)} feeds polled`,
    };
  }
  return {
    ...connection,
    text: `Live, ${String(feeds.length)} ${feeds.length === 1 ? 'feed' : 'feeds'} healthy`,
  };
}

export class StatusBanner {
  private connection: FeedNotice = describeConnection('connecting', null);
  private feeds: readonly FeedHealth[] = [];
  private readonly summary: HTMLElement;
  private readonly lines: HTMLElement;

  constructor(root: HTMLElement) {
    root.classList.add('status');
    // A live region on the root, so the summary changing is announced once. The disclosure
    // is a `details` element rather than a button and a panel: the browser owns the open
    // state, the keyboard, and telling a screen reader whether it is expanded.
    root.setAttribute('role', 'status');
    root.setAttribute('aria-live', 'polite');
    const disclosure = document.createElement('details');
    disclosure.className = 'status-disclosure';
    this.summary = document.createElement('summary');
    this.summary.className = 'status-line';
    this.lines = document.createElement('div');
    this.lines.className = 'status-lines';
    disclosure.append(this.summary, this.lines);
    root.append(disclosure);
    this.paint();
  }

  /** Called with whatever the last `feed_status` message carried, or null for no change. */
  update(feeds: readonly FeedHealth[] | null): void {
    if (feeds === null) {
      return;
    }
    this.feeds = feeds;
    this.paint();
  }

  setConnection(state: ConnectionState, retryInMs: number | null): void {
    this.connection = describeConnection(state, retryInMs);
    this.paint();
  }

  private paint(): void {
    const summary = summariseFeeds(this.connection, this.feeds);
    // Bracketed because `DOMStringMap` is an index signature: dotted access on one is a
    // typo waiting to happen, which is what noPropertyAccessFromIndexSignature says.
    this.summary.dataset['level'] = summary.level;
    this.summary.textContent = summary.text;
    const notices = [this.connection, ...this.feeds.map((feed) => describeFeed(feed))];
    this.lines.replaceChildren(
      ...notices.map((notice) => {
        const line = document.createElement('p');
        line.className = 'status-line';
        line.dataset['level'] = notice.level;
        line.textContent = notice.text;
        return line;
      }),
    );
  }
}
