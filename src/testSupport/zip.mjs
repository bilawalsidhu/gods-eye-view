import { crc32, deflateRawSync } from 'node:zlib';

/**
 * A minimal ZIP archive, no zip64. `files` is `{ name: text }` or
 * `[{ name, text, deflate }]`; an entry is stored unless it (or the
 * `deflate` default) asks for deflate.
 */
export function makeZip(files, { deflate = false } = {}) {
  const entries = Array.isArray(files)
    ? files
    : Object.entries(files).map(([name, text]) => ({ name, text }));
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const deflated = entry.deflate ?? deflate;
    const data = Buffer.from(entry.text, 'utf8');
    const body = deflated ? deflateRawSync(data) : data;
    const nameBytes = Buffer.from(entry.name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(deflated ? 8 : 0, 8);
    local.writeUInt32LE(crc32(data), 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(deflated ? 8 : 0, 10);
    central.writeUInt32LE(crc32(data), 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, body);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}
