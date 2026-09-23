import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isValidCustomStreamUrl,
  normalizeIcao,
  getLiveAtcUrl,
  getCustomStreamUrl,
  setCustomStreamUrl,
  removeCustomStreamUrl,
  getAllCustomStreams,
  safeWindowLocalStorage,
} from './atcCustomStreams.js';

function createMockStorage() {
  const store = new Map();
  return {
    getItem(k) {
      return store.has(k) ? store.get(k) : null;
    },
    setItem(k, v) {
      store.set(k, String(v));
    },
    removeItem(k) {
      store.delete(k);
    },
    key(index) {
      return Array.from(store.keys())[index] || null;
    },
    get length() {
      return store.size;
    },
  };
}

test('normalizeIcao cleans inputs', () => {
  assert.equal(normalizeIcao('kjfk'), 'KJFK');
  assert.equal(normalizeIcao('  egll  '), 'EGLL');
  assert.equal(normalizeIcao(''), null);
  assert.equal(normalizeIcao(null), null);
  assert.equal(normalizeIcao(123), null);
});

test('isValidCustomStreamUrl strictly enforces https', () => {
  assert.equal(isValidCustomStreamUrl('https://example.com/stream.mp3'), true);
  assert.equal(isValidCustomStreamUrl('https://audio.liveatc.net/kjfk_twr'), true);
  // Rejects insecure http
  assert.equal(isValidCustomStreamUrl('http://example.com/stream.mp3'), false);
  // Rejects javascript:, file:, data:
  assert.equal(isValidCustomStreamUrl('javascript:alert(1)'), false);
  assert.equal(isValidCustomStreamUrl('file:///path/to/audio.mp3'), false);
  assert.equal(isValidCustomStreamUrl('data:audio/mp3;base64,...'), false);
  assert.equal(isValidCustomStreamUrl('not-a-url'), false);
  assert.equal(isValidCustomStreamUrl(''), false);
  assert.equal(isValidCustomStreamUrl(null), false);
});

test('getLiveAtcUrl formats search URL with ICAO', () => {
  assert.equal(getLiveAtcUrl('KJFK'), 'https://www.liveatc.net/search/?icao=kjfk');
  assert.equal(getLiveAtcUrl('  egll  '), 'https://www.liveatc.net/search/?icao=egll');
  assert.equal(getLiveAtcUrl(''), null);
  assert.equal(getLiveAtcUrl(null), null);
});

test('get, set, remove, and getAll custom streams with mock storage', () => {
  const storage = createMockStorage();

  assert.equal(getCustomStreamUrl('KJFK', storage), null);

  // Invalid URL rejected
  const badRes = setCustomStreamUrl('KJFK', 'http://insecure.com/audio', storage);
  assert.equal(badRes.ok, false);
  assert.match(badRes.error, /https/);
  assert.equal(getCustomStreamUrl('KJFK', storage), null);

  // Valid HTTPS accepted
  const goodRes = setCustomStreamUrl('KJFK', 'https://secure.com/stream.mp3', storage);
  assert.equal(goodRes.ok, true);
  assert.equal(getCustomStreamUrl('KJFK', storage), 'https://secure.com/stream.mp3');

  // Case insensitive retrieval
  assert.equal(getCustomStreamUrl('kjfk', storage), 'https://secure.com/stream.mp3');

  // Second airport
  setCustomStreamUrl('EGLL', 'https://secure.com/egll.mp3', storage);
  const all = getAllCustomStreams(storage);
  assert.deepEqual(all, {
    KJFK: 'https://secure.com/stream.mp3',
    EGLL: 'https://secure.com/egll.mp3',
  });

  // Remove
  assert.equal(removeCustomStreamUrl('KJFK', storage), true);
  assert.equal(getCustomStreamUrl('KJFK', storage), null);
  assert.equal(getCustomStreamUrl('EGLL', storage), 'https://secure.com/egll.mp3');
});

test('safeWindowLocalStorage handles undefined window gracefully', () => {
  const storage = safeWindowLocalStorage();
  // In node test environment without window, returns null
  assert.equal(storage, null);
});
