// The HUD's "local time at the camera subpoint" clock — a rough solar-time
// estimate from longitude, the same approximation the summary line's UTC tag
// already used, now given a shared name and a visible clock face. Pins the
// offset rounding, the clock formatting, and that hud.js actually renders
// through this helper instead of re-inlining the math (see hudLocality.test.mjs
// for why hud.js itself can't be imported here: it pulls in the `mgrs`
// CommonJS package, which Vite resolves but plain Node cannot).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { formatLocalClock, formatUtcOffsetTag, localUtcOffsetHours } from './hudLocalClock.js';

test('the offset rounds to the nearest hour, not truncating', () => {
  assert.equal(localUtcOffsetHours(0), 0);
  assert.equal(localUtcOffsetHours(7.6), 1); // Zurich: UTC+1, not UTC+0
  assert.equal(localUtcOffsetHours(-7.6), -1);
  assert.equal(localUtcOffsetHours(179), 12);
  assert.equal(localUtcOffsetHours(-179), -12);
});

test('the offset tag matches the format the HUD has always shown', () => {
  assert.equal(formatUtcOffsetTag(0), 'UTC+0');
  assert.equal(formatUtcOffsetTag(5), 'UTC+5');
  assert.equal(formatUtcOffsetTag(-8), 'UTC-8');
});

test('the local clock shifts wall-clock time by the longitude offset', () => {
  // 2026-01-01 00:00:00 UTC exactly.
  const midnightUtc = Date.UTC(2026, 0, 1, 0, 0, 0);
  assert.deepEqual(formatLocalClock(midnightUtc, 0), { time: '00:00:00', offsetTag: 'UTC+0' });
  // 45°E rounds to UTC+3 — 03:00 local at UTC midnight.
  assert.deepEqual(formatLocalClock(midnightUtc, 45), { time: '03:00:00', offsetTag: 'UTC+3' });
  // 120°W rounds to UTC-8 — wraps back to the previous day, 16:00 local.
  assert.deepEqual(formatLocalClock(midnightUtc, -120), { time: '16:00:00', offsetTag: 'UTC-8' });
});

test('the local clock is independent of the machine running it', () => {
  // formatLocalClock must derive everything from its two arguments — never
  // read the environment's own timezone (Date's local getters, process.env.TZ).
  // A wrong implementation using getHours()/getMinutes() would pass or fail
  // this test depending on the CI runner's TZ; UTC-based getters never do.
  const fixedMs = Date.UTC(2026, 5, 15, 12, 30, 45);
  const result = formatLocalClock(fixedMs, 30); // UTC+2
  assert.deepEqual(result, { time: '14:30:45', offsetTag: 'UTC+2' });
});

test('hud.js actually renders the corner clock through this helper', () => {
  const source = readFileSync(new URL('./hud.js', import.meta.url), 'utf8');
  const has = (pattern) => pattern.test(source);
  assert.equal(
    has(/import \{ formatLocalClock \} from '\.\/hudLocalClock\.js';/),
    true,
    'hud.js must import formatLocalClock from ./hudLocalClock.js',
  );
  assert.equal(
    has(/id="hud-local-clock"/),
    true,
    'the HUD template must carry a #hud-local-clock element',
  );
  assert.equal(
    has(/id="hud-local-offset"/),
    true,
    'the HUD template must carry a #hud-local-offset element — without it the "(UTC+N)" tag silently disappears',
  );
  assert.equal(
    has(/class="hud-rec"[^\n]*id="hud-local-clock"[^\n]*id="hud-local-offset"/),
    true,
    'the local clock and offset must be merged into the .hud-rec line, not rendered as a separate sibling line',
  );
  assert.equal(
    has(/formatLocalClock\(Date\.now\(\), lonDeg\)/),
    true,
    '_updateCameraData must refresh the corner clock through formatLocalClock()',
  );
  assert.equal(
    has(/Math\.round\(\s*[\w.]*lonDeg\s*\/\s*15/),
    false,
    'the longitude/15 offset math must live only in hudLocalClock.js, not re-inlined in hud.js',
  );
  assert.equal(
    has(/hud-timestamp/),
    false,
    'the standalone Zulu #hud-timestamp element must be gone — the corner clock is the local one now',
  );
  assert.equal(
    has(/_formatUTC/),
    false,
    '_formatUTC must be removed — nothing formats a UTC Zulu string for the corner clock anymore',
  );
  assert.equal(
    has(/_timestampInterval/),
    false,
    '_timestampInterval must be removed along with its setInterval and clearInterval calls',
  );
});
