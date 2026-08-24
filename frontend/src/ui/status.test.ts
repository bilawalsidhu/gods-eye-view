/**
 * Tests for the wording of the health banner.
 *
 * These strings are the whole point of the panel: "adsb.lol rate limited until 14:32" and
 * "adsb.lol down: connection refused" are different statements about different problems,
 * and a generic spinner is neither. The painting of them into the DOM is covered by the
 * Playwright suite, which has a real document.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { StatusBanner, describeConnection, describeFeed, summariseFeeds } from './status';
import type { FeedHealth } from '../types/entities';

/**
 * A healthy feed.
 *
 * **`last_success_at` was null here and that made this fixture a lie.** A feed with no success,
 * no error and no failures has not polled yet, so every test using this default was asserting
 * against a never-polled feed while calling it healthy, and they passed because the code could
 * not tell the two apart either. That is the state the banner got wrong live. Fixed by making the
 * default what the name claims: all four healthy feeds on `/api/health` carry a success time, and
 * a test that wants the never-polled state now has to ask for it, which is `notPolled` below.
 */
function feed(overrides: Partial<FeedHealth> = {}): FeedHealth {
  return {
    source: 'adsb.lol',
    layer: 'aircraft',
    healthy: true,
    entity_count: 1234,
    consecutive_failures: 0,
    poll_interval_seconds: 8,
    last_error: null,
    last_success_at: '2026-08-24T09:22:22.801427Z',
    rate_limited_until: null,
    ...overrides,
  };
}

/**
 * `celestrak/gp` exactly as `/api/health` served it on 2026-08-24, field for field.
 *
 * Copied rather than hand-written, because the whole failure was that no reasonable-looking
 * hand-written fixture happened to combine these five values: unhealthy, no error, no failures,
 * no success, and a six-hour interval. 698 satellites were on screen off the disk cache while the
 * banner called this feed down.
 */
function notPolled(overrides: Partial<FeedHealth> = {}): FeedHealth {
  return feed({
    source: 'celestrak/gp',
    layer: 'satellites',
    healthy: false,
    entity_count: 0,
    last_success_at: null,
    last_error: null,
    consecutive_failures: 0,
    poll_interval_seconds: 21_600,
    ...overrides,
  });
}

describe('describeFeed', () => {
  it('names the source and the count when all is well', () => {
    const notice = describeFeed(feed());

    expect(notice.level).toBe('live');
    expect(notice.source).toBe('adsb.lol');
    expect(notice.text).toBe('adsb.lol live, 1,234 in its last poll');
  });

  it('calls a rate limit a warning and says when it lifts', () => {
    const now = new Date('2026-08-19T14:00:00Z');

    const notice = describeFeed(feed({ rate_limited_until: '2026-08-19T14:32:00Z' }), now);

    // Rate limited is not down: the data is fine and we are being asked to wait.
    expect(notice.level).toBe('warning');
    expect(notice.text).toContain('adsb.lol rate limited until');
  });

  it('ignores a rate limit that has already expired', () => {
    const now = new Date('2026-08-19T15:00:00Z');

    const notice = describeFeed(feed({ rate_limited_until: '2026-08-19T14:32:00Z' }), now);

    expect(notice.level).toBe('live');
  });

  it('reports the real reason a feed is down', () => {
    const notice = describeFeed(feed({ healthy: false, last_error: 'connection refused' }));

    expect(notice.level).toBe('error');
    expect(notice.text).toBe('adsb.lol down: connection refused');
  });

  it('never calls a feed down for not having been asked yet', () => {
    // The bug this replaced, live on 2026-08-24: `healthy` is false before the first poll as well
    // as after a failure, so the banner read "celestrak/gp down: no successful poll yet" at error
    // level with zero failures, no error and 698 satellites on screen from the disk cache. It
    // sends a reader to debug a working system, and it persists for the six-hour interval after
    // every restart rather than flickering past on startup.
    const notice = describeFeed(notPolled());

    expect(notice.level).toBe('idle');
    expect(notice.text).not.toContain('down');
    expect(notice.text).toBe('celestrak/gp not polled yet, every 6h');
  });

  it('states the interval, because that is what says how long this will last', () => {
    expect(describeFeed(notPolled({ poll_interval_seconds: 30 })).text).toContain('every 30s');
    expect(describeFeed(notPolled({ poll_interval_seconds: 600 })).text).toContain('every 10m');
  });

  it('still calls a feed down when it has genuinely never succeeded and is failing', () => {
    // Never succeeded is not the same claim as never asked, and the difference is the failures.
    const notice = describeFeed(notPolled({ consecutive_failures: 4 }));

    expect(notice.level).toBe('error');
    expect(notice.text).toBe('celestrak/gp down: no successful poll yet');
  });

  it('keeps the error when a feed failed without recording a reason', () => {
    const notice = describeFeed(feed({ healthy: false, last_error: null }));

    expect(notice.level).toBe('error');
    expect(notice.text).toBe('adsb.lol down: no successful poll yet');
  });

  it('lets a rate limit outrank not having polled, because it is the more specific fact', () => {
    const now = new Date('2026-08-24T14:00:00Z');

    const notice = describeFeed(notPolled({ rate_limited_until: '2026-08-24T14:32:00Z' }), now);

    expect(notice.level).toBe('warning');
  });

  it('treats one failed poll as noise and several as degraded', () => {
    expect(describeFeed(feed({ consecutive_failures: 1 })).level).toBe('live');

    const degraded = describeFeed(feed({ consecutive_failures: 3 }));
    expect(degraded.level).toBe('warning');
    expect(degraded.text).toBe('adsb.lol degraded, 3 failed polls');
  });

  it('lets down beat degraded, because down is the more urgent fact', () => {
    const notice = describeFeed(
      feed({ healthy: false, consecutive_failures: 9, last_error: 'timeout' }),
    );

    expect(notice.level).toBe('error');
  });
});

describe('describeConnection', () => {
  it('has a line for every socket state, so the UI is never silent', () => {
    expect(describeConnection('live', null)).toEqual({
      source: 'live feed',
      level: 'live',
      text: 'Live feed connected',
    });
    expect(describeConnection('connecting', null).level).toBe('warning');
    expect(describeConnection('closed', null).level).toBe('error');
  });

  it('counts down the retry in seconds when it knows one', () => {
    expect(describeConnection('reconnecting', 4200).text).toBe('Live feed lost, retrying in 4s');
  });

  it('still says it is reconnecting when it has no delay to report', () => {
    expect(describeConnection('reconnecting', null).text).toBe('Live feed lost, reconnecting');
  });
});

describe('summariseFeeds', () => {
  const live = describeConnection('live', null);

  it('counts the feeds when all is well', () => {
    const notice = summariseFeeds(live, [feed(), feed({ source: 'digitraffic' })]);

    expect(notice.level).toBe('live');
    expect(notice.text).toBe('Live, 2 feeds healthy');
  });

  it('falls back to the socket state when no feed has reported yet', () => {
    expect(summariseFeeds(live, []).text).toBe('Live feed connected');
  });

  it('reads properly for a single healthy feed', () => {
    expect(summariseFeeds(live, [feed()]).text).toBe('Live, 1 feed healthy');
  });

  it('raises nothing at all for a feed that has not polled yet', () => {
    // The headline the audit caught: five live feeds, one of them never asked, and the first thing
    // a viewer read was "1 of 5 feeds down" at error level.
    const notice = summariseFeeds(live, [
      feed({ source: 'aircraft/union' }),
      feed({ source: 'adsb.lol/mil' }),
      feed({ source: 'vessels/union' }),
      notPolled(),
      feed({ source: 'transit/gtfsrt' }),
    ]);

    expect(notice.level).toBe('live');
    expect(notice.text).not.toContain('down');
    expect(notice.text).not.toContain('degraded');
    expect(notice.text).toBe('Live, 4 of 5 feeds polled');
  });

  it('will not count a feed it has not heard from as healthy either', () => {
    // "5 feeds healthy" would be the same overclaim pointing the other way.
    const notice = summariseFeeds(live, [feed(), notPolled()]);

    expect(notice.text).not.toContain('healthy');
    expect(notice.text).toBe('Live, 1 of 2 feeds polled');
  });

  it('says plainly when nothing has polled, which is what startup looks like', () => {
    expect(summariseFeeds(live, [notPolled(), notPolled()]).text).toBe(
      'Live, no feed has polled yet',
    );
  });

  it('still counts a genuinely broken feed', () => {
    const notice = summariseFeeds(live, [
      feed(),
      feed({ source: 'celestrak/gp', healthy: false, last_error: 'connection refused' }),
    ]);

    // The rail sits directly below and already reads "celestrak/gp down: connection refused"
    // against the Satellites row. Repeating it here put the identical sentence on screen twice a
    // few pixels apart, which is the duplication this panel was shrunk to remove.
    expect(notice.level).toBe('error');
    expect(notice.text).toBe('1 of 2 feeds down');
  });

  it('takes its severity and its wording from the worst feed, not the first', () => {
    const notice = summariseFeeds(live, [
      feed({ source: 'digitraffic', consecutive_failures: 3 }),
      feed({ source: 'celestrak/gp', healthy: false, last_error: 'connection refused' }),
    ]);

    // "down" and "degraded" are different claims, and a banner reporting the milder one would
    // be a lie by omission.
    expect(notice.level).toBe('error');
    expect(notice.text).toBe('2 of 2 feeds down');
  });

  it('calls a feed still answering degraded rather than down', () => {
    const notice = summariseFeeds(live, [feed(), feed({ consecutive_failures: 3 })]);

    expect(notice.level).toBe('warning');
    expect(notice.text).toBe('1 of 2 feeds degraded');
  });

  it('treats a lost socket as the headline, because nothing updates without it', () => {
    const notice = summariseFeeds(describeConnection('closed', null), [
      feed({ healthy: false, last_error: 'connection refused' }),
    ]);

    // Nothing arrives at all, so the socket outranks any number of sick feeds.
    expect(notice.level).toBe('error');
    expect(notice.text).toBe('Live feed closed');
  });
});

describe('StatusBanner', () => {
  beforeEach(() => {
    vi.stubGlobal('document', {
      createElement: (tag: string): FakeElement => new FakeElement(tag),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows the summary closed and every feed inside', () => {
    const root = new FakeElement('div');
    const banner = new StatusBanner(asElement(root));

    // The socket connects before any feed reports, and until it does that is the headline:
    // nothing on the globe moves without it.
    banner.setConnection('live', null);
    banner.update([feed(), feed({ source: 'digitraffic' })]);

    // One line at rest. The rail already names every degraded feed against its layer, so a
    // second panel repeating all of them is what filled the left of the globe up.
    expect(root.select('status-line')[0]?.textContent).toBe('Live, 2 feeds healthy');
    // Nothing left the screen: the full list is inside the disclosure.
    expect(root.select('status-lines')[0]?.children.map((line) => line.textContent)).toStrictEqual([
      'Live feed connected',
      'adsb.lol live, 1,234 in its last poll',
      'digitraffic live, 1,234 in its last poll',
    ]);
  });

  it('carries the level as an attribute, so state is never colour alone', () => {
    const root = new FakeElement('div');
    const banner = new StatusBanner(asElement(root));

    banner.setConnection('reconnecting', 4000);

    const summary = root.select('status-line')[0];
    expect(summary?.dataset['level']).toBe('warning');
    expect(summary?.textContent).toBe('Live feed lost, retrying in 4s');
  });

  it('ignores a status message that carried no feed list', () => {
    const root = new FakeElement('div');
    const banner = new StatusBanner(asElement(root));

    banner.setConnection('live', null);
    banner.update([feed()]);
    banner.update(null);

    expect(root.select('status-line')[0]?.textContent).toBe('Live, 1 feed healthy');
  });
});

/** Enough of an element for the banner: it builds a disclosure and writes text into it. */
class FakeElement {
  readonly tag: string;
  readonly children: FakeElement[] = [];
  readonly dataset: Record<string, string> = {};
  readonly attributes: Record<string, string> = {};
  readonly classList = {
    add: (): void => {
      // The banner adds its own class; nothing here reads it.
    },
  };
  className = '';
  textContent = '';

  constructor(tag: string) {
    this.tag = tag;
  }

  append(...nodes: FakeElement[]): void {
    this.children.push(...nodes);
  }

  replaceChildren(...nodes: FakeElement[]): void {
    this.children.length = 0;
    this.children.push(...nodes);
  }

  setAttribute(name: string, value: string): void {
    this.attributes[name] = value;
  }

  select(className: string): FakeElement[] {
    const found: FakeElement[] = [];
    for (const child of this.children) {
      if (child.className === className) {
        found.push(child);
      }
      found.push(...child.select(className));
    }
    return found;
  }
}

function asElement(fake: FakeElement): HTMLElement {
  return fake as unknown as HTMLElement;
}
