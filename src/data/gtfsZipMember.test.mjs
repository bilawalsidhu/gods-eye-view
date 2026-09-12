import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchZipMemberText } from './gtfsZipMember.js';

const STOPS = 'stop_id,stop_name,stop_lat,stop_lon\nA,Delft,52.01,4.48\nB,Gouda,52.02,4.71\n';

/**
 * Build a minimal ZIP holding one STORED (uncompressed) member, with a local
 * header whose extra field is a different length from the central directory's —
 * the case that makes a reader land mid-file if it trusts the wrong copy.
 */
function buildZip(name, content, { localExtra = 4, comment = '' } = {}) {
  const enc = new TextEncoder();
  const nameBytes = enc.encode(name);
  const data = enc.encode(content);
  const put = (arr, off, ...vals) => vals.forEach((v, i) => arr[off + i] = v);
  const u16 = (n) => [n & 0xff, (n >> 8) & 0xff];
  const u32 = (n) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff];

  const local = [
    ...u32(0x04034b50), ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0),
    ...u32(0), ...u32(data.length), ...u32(data.length),
    ...u16(nameBytes.length), ...u16(localExtra),
    ...nameBytes, ...new Array(localExtra).fill(0), ...data,
  ];
  const central = [
    ...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0),
    ...u32(0), ...u32(data.length), ...u32(data.length),
    ...u16(nameBytes.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0),
    ...u32(0), ...nameBytes,
  ];
  const eocd = [
    ...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(1), ...u16(1),
    ...u32(central.length), ...u32(local.length), ...u16(comment.length),
    ...enc.encode(comment),
  ];
  void put;
  return new Uint8Array([...local, ...central, ...eocd]);
}

/** A fetch that honours Range over an in-memory buffer. */
function servingZip(zip, { rangeStatus = 206 } = {}) {
  const calls = [];
  const impl = async (url, init = {}) => {
    if (init.method === 'HEAD') {
      return { status: 200, headers: new Headers({ 'content-length': String(zip.length) }) };
    }
    const m = /bytes=(\d+)-(\d+)/.exec(init.headers?.Range || '');
    calls.push(init.headers?.Range);
    const slice = zip.slice(Number(m[1]), Number(m[2]) + 1);
    return { status: rangeStatus, arrayBuffer: async () => slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength) };
  };
  impl.calls = calls;
  return impl;
}

test('one member is read out of the archive without downloading it whole', async () => {
  const zip = buildZip('stops.txt', STOPS);
  const fetchImpl = servingZip(zip);
  const text = await fetchZipMemberText('https://example.test/gtfs.zip', 'stops.txt', { fetchImpl });

  assert.ok(text.includes('A,Delft,52.01,4.48'));
  assert.ok(text.includes('B,Gouda,52.02,4.71'));
  // Four ranged reads at most: tail, central directory, local header, member.
  assert.ok(fetchImpl.calls.length <= 4, `expected at most 4 ranged reads, got ${fetchImpl.calls.length}`);
});

test('a member nested in a folder is still found', async () => {
  const text = await fetchZipMemberText('https://example.test/gtfs.zip', 'stops.txt', {
    fetchImpl: servingZip(buildZip('gtfs-nl/stops.txt', STOPS)),
  });
  assert.ok(text.includes('A,Delft'));
});

test("the local header's own extra length is what locates the data", async () => {
  // Central says extra=0, local says extra=64. Trusting the central copy here
  // starts the read 64 bytes early and the member comes back as garbage.
  const text = await fetchZipMemberText('https://example.test/gtfs.zip', 'stops.txt', {
    fetchImpl: servingZip(buildZip('stops.txt', STOPS, { localExtra: 64 })),
  });
  assert.ok(text.includes('A,Delft'));
});

test('an archive comment does not hide the end-of-directory record', async () => {
  const text = await fetchZipMemberText('https://example.test/gtfs.zip', 'stops.txt', {
    fetchImpl: servingZip(buildZip('stops.txt', STOPS, { comment: 'built by a tool that adds comments' })),
  });
  assert.ok(text.includes('B,Gouda'));
});

test('a server that ignores Range yields nothing rather than garbage', async () => {
  const text = await fetchZipMemberText('https://example.test/gtfs.zip', 'stops.txt', {
    fetchImpl: servingZip(buildZip('stops.txt', STOPS), { rangeStatus: 200 }),
  });
  assert.equal(text, null);
});

test('a missing member, a broken archive and a dead host all resolve to null', async () => {
  const noMember = await fetchZipMemberText('https://example.test/gtfs.zip', 'stops.txt', {
    fetchImpl: servingZip(buildZip('agency.txt', 'agency_id\nX\n')),
  });
  assert.equal(noMember, null);

  const notAZip = await fetchZipMemberText('https://example.test/gtfs.zip', 'stops.txt', {
    fetchImpl: servingZip(new Uint8Array(200)),
  });
  assert.equal(notAZip, null);

  const dead = await fetchZipMemberText('https://example.test/gtfs.zip', 'stops.txt', {
    fetchImpl: async () => { throw new Error('network down'); },
  });
  assert.equal(dead, null);
});
