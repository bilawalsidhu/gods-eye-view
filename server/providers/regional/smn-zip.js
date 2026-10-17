import { crc32, inflateRawSync } from 'node:zlib';

export const SMN_ZIP_MAX_BYTES = 256 * 1024;
const MAX_TEXT_BYTES = 512 * 1024;

/** Read the single Latin-1 TXT in an SMN archive, without extracting files. */
export function readSmnZip(bytes, expectedName) {
  const zip = Buffer.from(bytes);
  const invalid = () => {
    throw new Error('Invalid SMN archive');
  };
  if (zip.length < 22 || zip.length > SMN_ZIP_MAX_BYTES) invalid();
  let end = zip.length - 22;
  const minimum = Math.max(0, end - 65535);
  while (end >= minimum && zip.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < minimum || end + 22 + zip.readUInt16LE(end + 20) !== zip.length)
    invalid();
  if (
    zip.readUInt16LE(end + 4) ||
    zip.readUInt16LE(end + 6) ||
    zip.readUInt16LE(end + 8) !== 1 ||
    zip.readUInt16LE(end + 10) !== 1
  )
    invalid();
  const centralSize = zip.readUInt32LE(end + 12);
  const central = zip.readUInt32LE(end + 16);
  if (
    central + centralSize !== end ||
    centralSize < 46 ||
    zip.readUInt32LE(central) !== 0x02014b50
  )
    invalid();
  const flags = zip.readUInt16LE(central + 8);
  const method = zip.readUInt16LE(central + 10);
  const checksum = zip.readUInt32LE(central + 16);
  const size = zip.readUInt32LE(central + 20);
  const textSize = zip.readUInt32LE(central + 24);
  const nameLength = zip.readUInt16LE(central + 28);
  const extraLength = zip.readUInt16LE(central + 30);
  const commentLength = zip.readUInt16LE(central + 32);
  const local = zip.readUInt32LE(central + 42);
  if (
    flags & ~0x800 ||
    ![0, 8].includes(method) ||
    !textSize ||
    textSize > MAX_TEXT_BYTES ||
    size > SMN_ZIP_MAX_BYTES ||
    zip.readUInt16LE(central + 34) ||
    46 + nameLength + extraLength + commentLength !== centralSize ||
    local + 30 > central ||
    zip.readUInt32LE(local) !== 0x04034b50
  )
    invalid();
  const name = zip
    .subarray(central + 46, central + 46 + nameLength)
    .toString('ascii');
  if (
    !expectedName.test(name) ||
    zip.readUInt16LE(local + 6) !== flags ||
    zip.readUInt16LE(local + 8) !== method ||
    zip.readUInt32LE(local + 14) !== checksum ||
    zip.readUInt32LE(local + 18) !== size ||
    zip.readUInt32LE(local + 22) !== textSize ||
    zip.readUInt16LE(local + 26) !== nameLength
  )
    invalid();
  const data = local + 30 + nameLength + zip.readUInt16LE(local + 28);
  if (
    data + size > central ||
    zip.subarray(local + 30, local + 30 + nameLength).toString('ascii') !== name
  )
    invalid();
  const compressed = zip.subarray(data, data + size);
  const text =
    method === 8
      ? inflateRawSync(compressed, { maxOutputLength: MAX_TEXT_BYTES })
      : compressed;
  if (text.length !== textSize || crc32(text) !== checksum) invalid();
  return text.toString('latin1');
}
