import test from 'node:test';
import assert from 'node:assert/strict';
import { createMessageSignsSource } from './source.js';
import { translateFeedError } from '../../ui/statusText.js';
import { setLocale } from '../../i18n/index.js';

const sign = {
  id: 'V100N01',
  provider: 'mndot',
  lat: 44.9,
  lon: -93.3,
  location: 'T.H.100 NB @ 50th St',
  message: 'msg_AE72DF0B',
  multi: 'FREEWAY TIME TO',
};

function gifBytes(width = 412, height = 100) {
  const bytes = new Uint8Array(32);
  bytes.set([...'GIF89a'].map((c) => c.charCodeAt(0)));
  bytes.set([width & 255, width >> 8, height & 255, height >> 8], 6);
  return bytes;
}

test('the list comes from the same-origin proxy with its data age', async () => {
  let requested;
  const source = createMessageSignsSource({
    fetchImpl: async (url) => {
      requested = url;
      return Response.json({
        provider: 'mndot',
        signs: [sign, { id: 'broken' }],
        joinMisses: 0,
        ageMs: 12_000,
        stale: true,
      });
    },
  });
  const snapshot = await source.getSnapshot();
  assert.equal(requested, '/api/message-signs');
  assert.deepEqual(snapshot, { signs: [sign], ageMs: 12_000, stale: true });
});

test('the caller signal is forwarded so an abort rejects as an abort', async () => {
  const controller = new AbortController();
  const source = createMessageSignsSource({
    fetchImpl: (url, { signal }) =>
      new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason));
      }),
  });
  const pending = source.getSnapshot({ signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
});

test('failures use the shapes the Layers panel translates', async () => {
  const cases = [
    [async () => new Response('{}', { status: 502 }), 'MnDOT HTTP 502'],
    [async () => new Response('<html>'), 'Malformed MnDOT response'],
    [async () => Response.json({ signs: 'no' }), 'Malformed MnDOT response'],
    [
      async () => {
        throw new TypeError('fetch failed');
      },
      'MnDOT network error',
    ],
  ];
  for (const [fetchImpl, message] of cases) {
    await assert.rejects(
      createMessageSignsSource({ fetchImpl }).getSnapshot(),
      { message },
    );
  }
  setLocale('es');
  try {
    assert.equal(translateFeedError('MnDOT HTTP 502'), 'MnDOT: HTTP 502');
    assert.equal(
      translateFeedError('Malformed MnDOT response'),
      'MnDOT: respuesta mal formada',
    );
    assert.equal(
      translateFeedError('MnDOT network error'),
      'MnDOT: error de red',
    );
  } finally {
    setLocale('en');
  }
});

test('a face image is fetched by message name and checked as a GIF', async () => {
  let requested;
  const source = createMessageSignsSource({
    fetchImpl: async (url) => {
      requested = url;
      return new Response(gifBytes(), {
        headers: { 'Content-Type': 'image/gif' },
      });
    },
  });
  const bytes = await source.getFaceImage('msg_AE72DF0B');
  assert.equal(requested, '/api/message-signs/img/msg_AE72DF0B.gif');
  assert.deepEqual(bytes, gifBytes());

  await assert.rejects(source.getFaceImage('../x'), {
    message: 'Malformed MnDOT response',
  });
  const notGif = createMessageSignsSource({
    fetchImpl: async () => new Response('<html>'),
  });
  await assert.rejects(notGif.getFaceImage('msg_AE72DF0B'), {
    message: 'Malformed MnDOT response',
  });
  const gone = createMessageSignsSource({
    fetchImpl: async () => new Response('{}', { status: 404 }),
  });
  await assert.rejects(gone.getFaceImage('msg_AE72DF0B'), {
    message: 'MnDOT HTTP 404',
  });
});
