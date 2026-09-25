// src/data/atcStreamPreference.test.mjs
// Gates on the viewer's own ATC stream URL: what is accepted, and what happens
// when the browser will not let us remember it.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  ATC_STREAM_STORAGE_KEY as KEY,
  readStreamUrl,
  validateStreamUrl,
  writeStreamUrl,
} from './atcStreamPreference.js';

/** A localStorage stand-in whose every seam can be made to throw. */
function fakeStorage({
  throwOnAccess = false,
  throwOnGet = false,
  throwOnSet = false,
} = {}) {
  const map = new Map();
  const storage = {
    getItem(k) {
      if (throwOnGet) throw new DOMException('blocked', 'SecurityError');
      return map.has(k) ? map.get(k) : null;
    },
    setItem(k, v) {
      if (throwOnSet) throw new DOMException('quota', 'QuotaExceededError');
      map.set(k, String(v));
    },
    removeItem: (k) => map.delete(k),
    _map: map,
  };
  if (throwOnAccess) {
    globalThis.window = Object.defineProperty({}, 'localStorage', {
      get() {
        throw new DOMException('blocked', 'SecurityError');
      },
    });
  } else {
    globalThis.window = { localStorage: storage };
  }
  return storage;
}

beforeEach(() => fakeStorage());
afterEach(() => {
  delete globalThis.window;
});

test('an https stream URL is accepted and normalised', () => {
  const result = validateStreamUrl('  https://sdr.example.org/atc/kaus.mp3  ');
  assert.equal(result.ok, true);
  assert.equal(result.url, 'https://sdr.example.org/atc/kaus.mp3');
});

test('http is refused with the reason a viewer actually needs', () => {
  // This is THE case a viewer hits: they paste a stream that works in VLC, and
  // the page is silent with nothing in the UI to explain it, because the
  // browser blocked mixed content without telling them.
  const result = validateStreamUrl('http://sdr.example.org/atc.mp3');
  assert.equal(result.ok, false);
  assert.match(result.error, /https/);
  assert.match(result.error, /silently/);
});

test('no other scheme gets through', () => {
  for (const url of [
    'javascript:alert(1)',
    'data:audio/mpeg;base64,AAAA',
    'blob:https://example.org/abc',
    'file:///etc/passwd',
    'ftp://example.org/a.mp3',
    'ws://example.org/a',
  ]) {
    const result = validateStreamUrl(url);
    assert.equal(result.ok, false, `${url} must be refused`);
  }
});

test('empty, junk and absurdly long input are refused distinctly', () => {
  assert.match(validateStreamUrl('').error, /Enter/);
  assert.match(validateStreamUrl('   ').error, /Enter/);
  assert.match(validateStreamUrl(null).error, /Enter/);
  assert.match(validateStreamUrl('not a url').error, /valid URL/);
  assert.match(
    validateStreamUrl(`https://x.org/${'a'.repeat(3000)}`).error,
    /stream URL/,
  );
});

test('a stored URL survives a round trip', () => {
  const written = writeStreamUrl('https://sdr.example.org/atc.mp3');
  assert.equal(written.ok, true);
  assert.equal(readStreamUrl(), 'https://sdr.example.org/atc.mp3');
});

test('passing null or blank forgets it', () => {
  writeStreamUrl('https://sdr.example.org/atc.mp3');
  assert.equal(writeStreamUrl(null).url, null);
  assert.equal(readStreamUrl(), null);
  writeStreamUrl('https://sdr.example.org/atc.mp3');
  assert.equal(writeStreamUrl('   ').url, null);
  assert.equal(readStreamUrl(), null);
});

test('a bad URL is refused before it reaches storage', () => {
  const storage = fakeStorage();
  const result = writeStreamUrl('http://sdr.example.org/atc.mp3');
  assert.equal(result.ok, false);
  assert.equal(storage._map.size, 0, 'nothing may be written on a refusal');
});

test('what comes OUT of storage is re-validated', () => {
  // The stored value was written by an older build, or by hand in devtools.
  // Neither is a reason to hand it to an audio element.
  const storage = fakeStorage();
  storage.setItem(KEY, 'javascript:alert(1)');
  assert.equal(readStreamUrl(), null);
  storage.setItem(KEY, 'http://sdr.example.org/atc.mp3');
  assert.equal(readStreamUrl(), null);
  storage.setItem(KEY, 'https://sdr.example.org/atc.mp3');
  assert.equal(readStreamUrl(), 'https://sdr.example.org/atc.mp3');
});

test('reading the localStorage PROPERTY can throw, and that is survivable', () => {
  // Not the getItem call — the property access itself, under blocked site
  // data. This is the trap src/layers/cctv/model.js documents.
  fakeStorage({ throwOnAccess: true });
  assert.equal(readStreamUrl(), null);
  // ...and a write still reports success, because the URL is good even if it
  // cannot be remembered.
  const result = writeStreamUrl('https://sdr.example.org/atc.mp3');
  assert.equal(result.ok, true);
  assert.equal(result.url, 'https://sdr.example.org/atc.mp3');
});

test('a throwing getItem is survivable too', () => {
  fakeStorage({ throwOnGet: true });
  assert.equal(readStreamUrl(), null);
});

test('a full or blocked storage does not refuse the URL', () => {
  // Quota exceeded, or private mode. Losing persistence is not a reason to
  // stop the viewer listening in this session.
  fakeStorage({ throwOnSet: true });
  const result = writeStreamUrl('https://sdr.example.org/atc.mp3');
  assert.equal(result.ok, true);
  assert.equal(result.url, 'https://sdr.example.org/atc.mp3');
  assert.equal(readStreamUrl(), null, 'and it simply is not remembered');
});

test('with no window at all nothing throws', () => {
  delete globalThis.window;
  assert.equal(readStreamUrl(), null);
  assert.equal(writeStreamUrl('https://sdr.example.org/atc.mp3').ok, true);
  assert.equal(writeStreamUrl(null).ok, true);
});
