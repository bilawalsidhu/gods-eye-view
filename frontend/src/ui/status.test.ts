/**
 * Tests for the wording of the health banner.
 *
 * These strings are the whole point of the panel: "adsb.lol rate limited until 14:32" and
 * "adsb.lol down: connection refused" are different statements about different problems,
 * and a generic spinner is neither. The painting of them into the DOM is covered by the
 * Playwright suite, which has a real document.
 */

import { describe, expect, it } from 'vitest';

import { describeConnection, describeFeed } from './status';
import type { FeedHealth } from '../types/entities';

function feed(overrides: Partial<FeedHealth> = {}): FeedHealth {
  return {
    source: 'adsb.lol',
    layer: 'aircraft',
    healthy: true,
    entity_count: 1234,
    consecutive_failures: 0,
    poll_interval_seconds: 8,
    last_error: null,
    last_success_at: null,
    rate_limited_until: null,
    ...overrides,
  };
}

describe('describeFeed', () => {
  it('names the source and the count when all is well', () => {
    const notice = describeFeed(feed());

    expect(notice.level).toBe('live');
    expect(notice.source).toBe('adsb.lol');
    expect(notice.text).toBe('adsb.lol live, 1,234 tracked');
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

  it('says so plainly when a feed has never polled successfully', () => {
    const notice = describeFeed(feed({ healthy: false, last_error: null }));

    expect(notice.text).toBe('adsb.lol down: no successful poll yet');
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
