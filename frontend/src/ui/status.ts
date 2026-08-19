/**
 * The per-feed health banner.
 *
 * Named sources and real reasons, never a generic spinner. "adsb.lol rate limited until
 * 14:32" tells the user the data is fine and we are being asked to wait; "feed down"
 * would be a different and wrong statement. A layer that has quietly stopped updating is
 * the failure this panel exists to prevent.
 */

import type { ConnectionState } from '../net/ws';
import type { FeedHealth } from '../types/entities';

export type NoticeLevel = 'live' | 'warning' | 'error';

export interface FeedNotice {
  source: string;
  level: NoticeLevel;
  text: string;
}

function clockTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
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
    level: 'live',
    text: `${feed.source} live, ${feed.entity_count.toLocaleString('en-GB')} tracked`,
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

export class StatusBanner {
  private connection: FeedNotice = describeConnection('connecting', null);
  private feeds: readonly FeedHealth[] = [];
  private readonly root: HTMLElement;

  constructor(root: HTMLElement) {
    this.root = root;
    root.classList.add('status');
    root.setAttribute('role', 'status');
    root.setAttribute('aria-live', 'polite');
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
    const notices = [this.connection, ...this.feeds.map((feed) => describeFeed(feed))];
    this.root.replaceChildren(
      ...notices.map((notice) => {
        const line = document.createElement('p');
        line.className = 'status-line';
        // Bracketed because `DOMStringMap` is an index signature: dotted access on one is
        // a typo waiting to happen, which is what noPropertyAccessFromIndexSignature says.
        line.dataset['level'] = notice.level;
        line.textContent = notice.text;
        return line;
      }),
    );
  }
}
