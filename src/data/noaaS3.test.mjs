import test from 'node:test';
import assert from 'node:assert/strict';
import {
  fetchObjectBuffer,
  listObjects,
  parseGranuleKey,
  parseS3ListXml,
} from '../../server/providers/common/noaa-s3.js';

const xml =
  '<?xml version="1.0"?><ListBucketResult><Contents><Key>a&amp;b</Key><LastModified>2026-09-14T12:00:00Z</LastModified></Contents><Contents><Key>c</Key></Contents><IsTruncated>true</IsTruncated><NextContinuationToken>next&amp;token</NextContinuationToken></ListBucketResult>';
test('S3 XML and granule parsing', () => {
  const parsed = parseS3ListXml(xml);
  assert.equal(parsed.keys[0].key, 'a&b');
  assert.equal(parsed.isTruncated, true);
  assert.equal(parsed.nextContinuationToken, 'next&token');
  assert.throws(() => parseS3ListXml('<ListBucketResult/>'));
  assert.deepEqual(
    parseGranuleKey(
      'GLM-L2-LCFA/2026/257/12/OR_GLM-L2-LCFA_G19_s20262571200000_e20262571200200_c20262571200212.nc',
    ),
    {
      satelliteCode: 'G19',
      startMs: Date.UTC(2026, 8, 14, 12),
      endMs: Date.UTC(2026, 8, 14, 12, 0, 20),
    },
  );
  assert.equal(parseGranuleKey('bad'), null);
});
test('S3 buffers enforce limits and listings construct query', async () => {
  const tooLarge = {
    ok: true,
    headers: new Headers({ 'content-length': '5' }),
  };
  await assert.rejects(
    fetchObjectBuffer({
      bucket: 'x',
      key: 'y',
      maxBytes: 4,
      fetchImpl: async () => tooLarge,
    }),
  );
  const small = await fetchObjectBuffer({
    bucket: 'x',
    key: 'y',
    fetchImpl: async () => new Response('ok'),
  });
  assert.deepEqual(small, Buffer.from('ok'));
  const stream = new ReadableStream({
    start(c) {
      c.enqueue(new Uint8Array(3));
      c.enqueue(new Uint8Array(3));
      c.close();
    },
  });
  await assert.rejects(
    fetchObjectBuffer({
      bucket: 'x',
      key: 'y',
      maxBytes: 4,
      fetchImpl: async () => new Response(stream),
    }),
  );
  let requested;
  await listObjects({
    bucket: 'x',
    prefix: 'p/',
    maxKeys: 7,
    fetchImpl: async (url) => {
      requested = new URL(url);
      return new Response(
        '<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>',
      );
    },
  });
  assert.equal(requested.searchParams.get('list-type'), '2');
  assert.equal(requested.searchParams.get('prefix'), 'p/');
  assert.equal(requested.searchParams.get('max-keys'), '7');
});
