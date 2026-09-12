import test from 'node:test';
import assert from 'node:assert/strict';
import { loadWindyWebcamSources, normalizeWindyWebcams, validWindyFrameUrl } from './windy.js';

const record = (patch = {}) => ({
  webcamId: 123,
  status: 'active',
  title: 'Lausanne lake',
  location: { city: 'Lausanne', region_code: 'CH.VD', latitude: 46.52, longitude: 6.63 },
  images: { current: { preview: 'https://imgproxy.windy.com/_/preview/plain/current/123/original.jpg?v=2' } },
  urls: { detail: 'https://windy.com/webcams/123' },
  ...patch,
});

test('normalizes an active western-Swiss webcam with provider attribution', () => {
  const cameras = normalizeWindyWebcams({ webcams: [record()] });
  assert.equal(cameras.length, 1);
  assert.equal(cameras[0].id, 'windy-123');
  assert.equal(cameras[0].cameraType, 'scenic-webcam');
  assert.match(cameras[0].license, /windy\.com/);
});

test('rejects inactive, out-of-region, and untrusted image sources', () => {
  assert.equal(normalizeWindyWebcams({ webcams: [record({ status: 'inactive' })] }).length, 0);
  assert.equal(normalizeWindyWebcams({ webcams: [record({ location: { city: 'Bern', region_code: 'CH.BE', latitude: 46.9, longitude: 7.4 } })] }).length, 0);
  assert.equal(normalizeWindyWebcams({ webcams: [record({ images: { current: { preview: 'http://127.0.0.1/frame.jpg' } } })] }).length, 0);
  assert.equal(validWindyFrameUrl('https://imgproxy.windy.com.evil.test/_/preview/plain/current/123/original.jpg'), false);
});

test('keyless loader is inert and an outage fails closed', async () => {
  assert.deepEqual(await loadWindyWebcamSources({ apiKey: '' }), []);
  assert.deepEqual(await loadWindyWebcamSources({ apiKey: 'x', fetchImpl: async () => { throw new Error('offline'); } }), []);
});
