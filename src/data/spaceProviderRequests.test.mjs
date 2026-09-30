import assert from 'node:assert/strict';
import test from 'node:test';
import {
  celestrakTleUrl,
  launchLibraryRecentUrl,
} from './spaceProviderRequests.js';

test('celestrakTleUrl constructs valid CelesTrak GP query URL with group and format parameters', () => {
  const url = celestrakTleUrl('active');
  assert.equal(url instanceof URL, true);
  assert.equal(url.origin, 'https://celestrak.org');
  assert.equal(url.pathname, '/NORAD/elements/gp.php');
  assert.equal(url.searchParams.get('GROUP'), 'active');
  assert.equal(url.searchParams.get('FORMAT'), 'tle');
});

test('launchLibraryRecentUrl computes exactly 30-day window ending at specified date', () => {
  const end = new Date('2026-09-30T12:00:00.000Z');
  const expectedStart = new Date(end.getTime() - 30 * 86400000);

  const url = launchLibraryRecentUrl(end);
  assert.equal(url instanceof URL, true);
  assert.equal(url.origin, 'https://ll.thespacedevs.com');
  assert.equal(url.pathname, '/2.3.0/launches/');
  assert.equal(url.searchParams.get('net__gte'), expectedStart.toISOString());
  assert.equal(url.searchParams.get('net__lte'), end.toISOString());
  assert.equal(url.searchParams.get('limit'), '100');
  assert.equal(url.searchParams.get('mode'), 'detailed');
});
