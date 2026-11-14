import assert from 'node:assert/strict';
import test from 'node:test';
import { deflateRawSync } from 'node:zlib';
import { readZipEntry } from './zipEntry.js';

/** A minimal zip with one deflated entry. */
function zipOf(name, data) {
  const packed = deflateRawSync(data);
  const nameBytes = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(packed.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBytes.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(packed.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(nameBytes.length, 28);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(46 + nameBytes.length, 12);
  eocd.writeUInt32LE(30 + nameBytes.length + packed.length, 16);
  return new Uint8Array(
    Buffer.concat([local, nameBytes, packed, central, nameBytes, eocd]),
  );
}

test('zip entry: read by name, missing and oversize refused', async () => {
  const data = Buffer.from('aircraft rows '.repeat(40));
  const zip = zipOf('aircrafts.json', data);
  assert.deepEqual(
    Buffer.from(await readZipEntry(zip, 'aircrafts.json')),
    data,
  );
  await assert.rejects(readZipEntry(zip, 'types.json'), /not found/);
  await assert.rejects(
    readZipEntry(zip, 'aircrafts.json', 10),
    /over 10 bytes/,
  );
  await assert.rejects(readZipEntry(new Uint8Array(40), 'x'), /not a zip/);
});
