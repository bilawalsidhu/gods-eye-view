import { describe, expect, it } from 'vitest';

import {
  MAX_REWIND_MS,
  REWIND_STEP_MS,
  clampRewind,
  describeInstant,
  describeRewind,
  historyNotices,
  isLive,
} from './time';

describe('clampRewind', () => {
  it('holds the slider inside its range', () => {
    expect(clampRewind(-1)).toBe(0);
    expect(clampRewind(0)).toBe(0);
    expect(clampRewind(MAX_REWIND_MS + 1000)).toBe(MAX_REWIND_MS);
  });

  it('refuses a value that is not a number rather than propagating it', () => {
    // A NaN here would reach a `JulianDate` and put every satellite at an invalid epoch, which
    // AGENTS.md records as producing a silent empty layer rather than an error.
    expect(clampRewind(NaN)).toBe(0);
    expect(clampRewind(Infinity)).toBe(0);
    expect(clampRewind(-Infinity)).toBe(0);
  });

  it('rounds off a fractional millisecond', () => {
    expect(clampRewind(1500.7)).toBe(1501);
  });
});

describe('isLive', () => {
  it('is the present only at zero', () => {
    expect(isLive(0)).toBe(true);
    expect(isLive(-5)).toBe(true);
    expect(isLive(REWIND_STEP_MS)).toBe(false);
  });
});

describe('describeRewind', () => {
  it('says Live rather than "0 minutes back"', () => {
    expect(describeRewind(0)).toBe('Live');
  });

  it('counts against a plural noun, because "1 hours" reads as a bug', () => {
    expect(describeRewind(60 * 60 * 1000)).toBe('1 hour back');
    expect(describeRewind(2 * 60 * 60 * 1000)).toBe('2 hours back');
    expect(describeRewind(60_000)).toBe('1 minute back');
    expect(describeRewind(120_000)).toBe('2 minutes back');
  });

  it('drops a zero smaller unit rather than printing it', () => {
    // "2 days 0 hours back" is the shape this avoids: two units at most, largest first, and the
    // smaller one only when it is non-zero.
    expect(describeRewind(2 * 24 * 60 * 60 * 1000)).not.toContain('0 hour');
    expect(describeRewind(60 * 60 * 1000)).not.toContain('0 minute');
  });

  it('never exceeds the range it can actually show', () => {
    // Past the cap the satellites stop being drawn at all, so a label promising more than that
    // would describe an empty globe.
    expect(describeRewind(MAX_REWIND_MS * 10)).toBe(describeRewind(MAX_REWIND_MS));
  });
});

describe('describeInstant', () => {
  it('refuses a non-finite instant rather than formatting one', () => {
    expect(describeInstant(NaN)).toBe('unknown');
  });

  it('carries no invisible separator into the DOM', () => {
    // `Intl` emits U+202F between date and time in some ICU versions. It reaches the DOM as a
    // character nobody can type and no test can match, so it is stripped at the boundary.
    const text = describeInstant(Date.UTC(2026, 7, 24, 12, 0, 0));

    expect(text).not.toMatch(/[\u{202F}\u{00A0}]/u);
    expect(text).toContain('UTC');
  });
});

describe('historyNotices', () => {
  it('says nothing while the globe is live', () => {
    expect(historyNotices(0)).toEqual([]);
  });

  it('separates what is true from what is missing, back in time', () => {
    // The whole honesty of this feature is in these strings. The sun, moon and satellites are
    // computed and genuinely were there; the movers were never recorded and are therefore not
    // drawn rather than interpolated, which is the lie this project refuses everywhere else.
    const notices = historyNotices(REWIND_STEP_MS);

    expect(notices.length).toBeGreaterThanOrEqual(2);
    expect(notices.some((line) => /satellite/i.test(line))).toBe(true);
    expect(notices.some((line) => /not drawn rather than guessed/i.test(line))).toBe(true);
  });
});
