import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeScannerFeedList,
  normalizeScannerCalls,
  takeNewCalls,
  scannerEntityId,
  scannerFeedIdFromEntityId,
} from './model.js';

test('feed list keeps only well-formed, unique feeds', () => {
  const feeds = normalizeScannerFeedList({
    feeds: [
      { id: 'a-pd', name: ' A PD ', lat: 30, lon: -97, type: 'stream' },
      { id: 'a-pd', name: 'dup', lat: 30, lon: -97, type: 'stream' },
      { id: 'Bad Id', name: 'x', lat: 0, lon: 0, type: 'stream' },
      { id: 'b', name: 'x', lat: 95, lon: 0, type: 'stream' },
      { id: 'c', name: 'x', lat: 0, lon: 0, type: 'ftp' },
      { id: 'd', name: '  ', lat: 0, lon: 0, type: 'stream' },
      { id: 'e-calls', name: 'E', lat: 1, lon: 2, type: 'openmhz' },
    ],
  });
  assert.deepEqual(
    feeds.map((feed) => [feed.id, feed.name]),
    [
      ['a-pd', 'A PD'],
      ['e-calls', 'E'],
    ],
  );
  assert.equal(normalizeScannerFeedList({}), null);
});

test('calls are ordered oldest first and queued once', () => {
  const calls = normalizeScannerCalls({
    calls: [
      { id: 'b', time: 20, url: '/b.m4a' },
      { id: 'a', time: 10, url: '/a.m4a' },
      { id: 'x', time: 5 },
    ],
  });
  assert.deepEqual(
    calls.map((call) => call.id),
    ['a', 'b'],
  );
  const played = new Set();
  assert.equal(takeNewCalls(calls, played).length, 2);
  assert.equal(takeNewCalls(calls, played).length, 0);
});

test('entity ids round-trip and foreign ids are ignored', () => {
  assert.equal(scannerFeedIdFromEntityId(scannerEntityId('a-pd')), 'a-pd');
  assert.equal(scannerFeedIdFromEntityId('earthquake:1'), null);
  assert.equal(scannerFeedIdFromEntityId(undefined), null);
});
