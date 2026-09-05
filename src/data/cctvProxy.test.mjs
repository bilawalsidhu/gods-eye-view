import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CCTV_FRAME_FETCH_TIMEOUT_MS,
  fetchCctvImageFromUpstream,
  normalizeSourceItem,
  sanitizeCctvSourceUrl,
} from '../../vite.config.js';

test('CCTV upstream frame fetch supplies a bounded abort signal', async () => {
  let observedSignal = null;
  const startedAt = Date.now();
  const result = await fetchCctvImageFromUpstream('https://example.com/frame.jpg', {
    timeoutMs: 20,
    fetchImpl: (_url, options) => new Promise((_resolve, reject) => {
      observedSignal = options.signal;
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
    }),
  });

  assert.equal(result, null);
  assert.ok(observedSignal instanceof AbortSignal);
  assert.equal(observedSignal.aborted, true);
  assert.ok(Date.now() - startedAt < 500, 'test timeout should settle promptly');
  assert.ok(CCTV_FRAME_FETCH_TIMEOUT_MS < 10_000, 'production timeout must beat the active refresh cadence');
});

test('CCTV upstream frame fetch returns a valid image response', async () => {
  const result = await fetchCctvImageFromUpstream('https://example.com/frame.jpg', {
    timeoutMs: 100,
    fetchImpl: async () => new Response(Uint8Array.from([1, 2, 3]), {
      status: 200,
      headers: { 'Content-Type': 'image/jpeg' },
    }),
  });

  assert.equal(result?.ok, true);
  assert.equal(result?.contentType, 'image/jpeg');
  assert.deepEqual(result?.body, Buffer.from([1, 2, 3]));
});

test('CCTV source URL sanitizer keeps valid https URLs with query strings', () => {
  assert.equal(
    sanitizeCctvSourceUrl('https://example.com/cam.jpg?token=abc', 'cam-1'),
    'https://example.com/cam.jpg?token=abc',
  );
  assert.equal(
    sanitizeCctvSourceUrl('  https://example.com/cam.jpg  ', 'cam-1'),
    'https://example.com/cam.jpg',
  );
});

test('CCTV source URL sanitizer drops non-https and malformed URLs', () => {
  assert.equal(sanitizeCctvSourceUrl('http://169.254.169.254/', 'cam-1'), '');
  assert.equal(sanitizeCctvSourceUrl('http://192.168.1.10/cam.jpg', 'cam-1'), '');
  assert.equal(sanitizeCctvSourceUrl('ftp://example.com/x.jpg', 'cam-1'), '');
  assert.equal(sanitizeCctvSourceUrl('data:image/jpeg;base64,AAA', 'cam-1'), '');
  assert.equal(sanitizeCctvSourceUrl('//example.com/x.jpg', 'cam-1'), '');
  assert.equal(sanitizeCctvSourceUrl('not a url', 'cam-1'), '');
  assert.equal(sanitizeCctvSourceUrl('', 'cam-1'), '');
  assert.equal(sanitizeCctvSourceUrl(null, 'cam-1'), '');
  assert.equal(sanitizeCctvSourceUrl(42, 'cam-1'), '');
  assert.equal(sanitizeCctvSourceUrl('https://user:pass@example.com/x.jpg', 'cam-1'), '');
  assert.equal(sanitizeCctvSourceUrl(`https://example.com/${'a'.repeat(2100)}`, 'cam-1'), '');
});

test('CCTV source URL sanitizer allows localhost http for dev', () => {
  assert.equal(
    sanitizeCctvSourceUrl('http://localhost:8080/cam.jpg', 'cam-1'),
    'http://localhost:8080/cam.jpg',
  );
});

test('normalizeSourceItem sanitizes url and snapshotUrl independently', () => {
  const normalized = normalizeSourceItem({
    id: 'cam-1',
    url: 'http://192.168.1.10/cam.jpg',
    snapshotUrl: 'https://example.com/snap.jpg',
  });
  assert.equal(normalized.id, 'cam-1');
  assert.equal(normalized.url, '');
  assert.equal(normalized.snapshotUrl, 'https://example.com/snap.jpg');
});

test('normalizeSourceItem handles missing and non-object input', () => {
  assert.equal(normalizeSourceItem(null).url, '');
  assert.equal(normalizeSourceItem({}).id, '');
});
