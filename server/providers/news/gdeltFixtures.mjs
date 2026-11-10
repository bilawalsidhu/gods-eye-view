// Test fixtures: GDELT 2.0 export rows and their zip, as the export files
// carry them (61 tab-separated columns, one zipped table).
import { deflateRawSync } from 'node:zlib';

/** One events row; only the columns the reader looks at are filled. */
export function eventRow({
  id,
  code = '190',
  quad = '4',
  mentions = 1,
  geoType = '4',
  place = "Kharkiv, Kharkivs'ka Oblast', Ukraine",
  lat = 49.9935,
  lon = 36.2304,
  added = '20261105114500',
  url,
}) {
  const f = new Array(61).fill('');
  f[0] = String(id);
  f[26] = code;
  f[28] = code.slice(0, 2);
  f[29] = quad;
  f[31] = String(mentions);
  f[51] = geoType;
  f[52] = place;
  f[56] = String(lat);
  f[57] = String(lon);
  f[59] = added;
  f[60] = url;
  return f.join('\t');
}

/** One GKG 2.1 row: an article's address and its page title (27 columns). */
export function gkgRow(url, title) {
  const f = new Array(27).fill('');
  f[4] = url;
  f[26] = `<PAGE_PRECISEPUBTIMESTAMP>20261105114500</PAGE_PRECISEPUBTIMESTAMP><PAGE_TITLE>${title}</PAGE_TITLE>`;
  return f.join('\t');
}

/** A single-entry zip of `text`, deflated, sizes in the central directory. */
export function zipTable(text, name = 'table.export.CSV') {
  const data = Buffer.from(text, 'utf8');
  const packed = deflateRawSync(data);
  const nameBytes = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0x08, 6); // sizes follow the data (left 0 here)
  local.writeUInt16LE(8, 8);
  local.writeUInt16LE(nameBytes.length, 26);
  const dir = Buffer.alloc(46);
  dir.writeUInt32LE(0x02014b50, 0);
  dir.writeUInt16LE(20, 4);
  dir.writeUInt16LE(20, 6);
  dir.writeUInt16LE(0x08, 8);
  dir.writeUInt16LE(8, 10);
  dir.writeUInt32LE(packed.length, 20);
  dir.writeUInt32LE(data.length, 24);
  dir.writeUInt16LE(nameBytes.length, 28);
  dir.writeUInt32LE(0, 42);
  const dirAt = local.length + nameBytes.length + packed.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(dir.length + nameBytes.length, 12);
  end.writeUInt32LE(dirAt, 16);
  return new Uint8Array(
    Buffer.concat([local, nameBytes, packed, dir, nameBytes, end]),
  );
}
