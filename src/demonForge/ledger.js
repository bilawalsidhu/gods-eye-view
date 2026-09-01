const REVIEW_INTERVAL_MS = 31 * 24 * 60 * 60 * 1000;

export class LedgerError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = 'LedgerError';
    this.code = code;
  }
}

function canonicalJson(value, ancestors = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new LedgerError('LEDGER_PAYLOAD_INVALID', 'Payload numbers must be finite.');
    return JSON.stringify(value);
  }
  if (typeof value !== 'object') throw new LedgerError('LEDGER_PAYLOAD_INVALID', 'Payload must contain JSON data only.');
  if (ancestors.has(value)) throw new LedgerError('LEDGER_PAYLOAD_INVALID', 'Payload must not contain cycles.');

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) throw new LedgerError('LEDGER_PAYLOAD_INVALID', 'Payload arrays must not be sparse.');
      }
      return `[${value.map((item) => canonicalJson(item, ancestors)).join(',')}]`;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null || Object.getOwnPropertySymbols(value).length > 0) {
      throw new LedgerError('LEDGER_PAYLOAD_INVALID', 'Payload must contain plain JSON objects only.');
    }
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key], ancestors)}`).join(',')}}`;
  } finally {
    ancestors.delete(value);
  }
}

function rightRotate(value, amount) {
  return (value >>> amount) | (value << (32 - amount));
}

// Kept local and synchronous so the ledger has no browser, storage, or network dependency.
export function sha256Hex(value) {
  const bytes = new TextEncoder().encode(String(value));
  const bitLength = BigInt(bytes.length) * 8n;
  const paddedLength = ((bytes.length + 9 + 63) >> 6) << 6;
  const message = new Uint8Array(paddedLength);
  message.set(bytes);
  message[bytes.length] = 0x80;

  for (let index = 0; index < 8; index += 1) {
    message[paddedLength - 1 - index] = Number((bitLength >> BigInt(index * 8)) & 0xffn);
  }

  const constants = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];
  const hash = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const words = new Uint32Array(64);

  for (let offset = 0; offset < message.length; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      const cursor = offset + index * 4;
      words[index] = (message[cursor] << 24) | (message[cursor + 1] << 16) | (message[cursor + 2] << 8) | message[cursor + 3];
    }
    for (let index = 16; index < 64; index += 1) {
      const a = rightRotate(words[index - 15], 7) ^ rightRotate(words[index - 15], 18) ^ (words[index - 15] >>> 3);
      const b = rightRotate(words[index - 2], 17) ^ rightRotate(words[index - 2], 19) ^ (words[index - 2] >>> 10);
      words[index] = (words[index - 16] + a + words[index - 7] + b) >>> 0;
    }

    let [a, b, c, d, e, f, g, h] = hash;
    for (let index = 0; index < 64; index += 1) {
      const sigma1 = rightRotate(e, 6) ^ rightRotate(e, 11) ^ rightRotate(e, 25);
      const choice = (e & f) ^ (~e & g);
      const first = (h + sigma1 + choice + constants[index] + words[index]) >>> 0;
      const sigma0 = rightRotate(a, 2) ^ rightRotate(a, 13) ^ rightRotate(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const second = (sigma0 + majority) >>> 0;
      h = g; g = f; f = e; e = (d + first) >>> 0; d = c; c = b; b = a; a = (first + second) >>> 0;
    }
    hash[0] = (hash[0] + a) >>> 0; hash[1] = (hash[1] + b) >>> 0;
    hash[2] = (hash[2] + c) >>> 0; hash[3] = (hash[3] + d) >>> 0;
    hash[4] = (hash[4] + e) >>> 0; hash[5] = (hash[5] + f) >>> 0;
    hash[6] = (hash[6] + g) >>> 0; hash[7] = (hash[7] + h) >>> 0;
  }

  return hash.map((part) => part.toString(16).padStart(8, '0')).join('');
}

function digestFor(event) {
  const { sequence, atMs, type, actor, payload, previousHash } = event;
  return sha256Hex(canonicalJson({ sequence, atMs, type, actor, payload, previousHash }));
}

function invalidLedger(code) {
  return { ok: false, code };
}

export function verifyLedger(ledger) {
  if (!Array.isArray(ledger)) return invalidLedger('LEDGER_INVALID');

  let previousHash = null;
  for (let index = 0; index < ledger.length; index += 1) {
    const event = ledger[index];
    if (!event || !Number.isInteger(event.sequence)) return invalidLedger('LEDGER_SEQUENCE_MISSING');
    if (event.sequence !== index + 1) return invalidLedger('LEDGER_SEQUENCE_INVALID');
    if (event.previousHash !== previousHash || typeof event.digest !== 'string') return invalidLedger('LEDGER_TAMPERED');
    try {
      if (digestFor(event) !== event.digest) return invalidLedger('LEDGER_TAMPERED');
    } catch (error) {
      if (error?.code === 'LEDGER_PAYLOAD_INVALID') return invalidLedger('LEDGER_TAMPERED');
      throw error;
    }
    previousHash = event.digest;
  }
  return { ok: true, code: 'LEDGER_VERIFIED' };
}

export function appendLedgerEvent(ledger, event, nowMs) {
  const verified = verifyLedger(ledger);
  if (!verified.ok) throw new LedgerError(verified.code, 'Cannot append to an invalid ledger.');
  if (!event || typeof event.type !== 'string' || !event.type.trim() || typeof event.actor !== 'string' || !event.actor.trim()) {
    throw new LedgerError('LEDGER_EVENT_INVALID', 'Ledger events require a type and actor.');
  }
  if (!Number.isFinite(nowMs)) throw new LedgerError('LEDGER_TIMESTAMP_REQUIRED', 'Ledger events require an explicit timestamp.');
  try {
    canonicalJson(event.payload ?? null);
  } catch (error) {
    if (error?.code === 'LEDGER_PAYLOAD_INVALID') throw error;
    throw new LedgerError('LEDGER_PAYLOAD_INVALID', 'Payload must contain JSON data only.');
  }

  const record = {
    sequence: ledger.length + 1,
    atMs: nowMs,
    type: event.type,
    actor: event.actor,
    payload: event.payload ?? null,
    previousHash: ledger.length === 0 ? null : ledger.at(-1).digest,
  };
  return [...ledger, { ...record, digest: digestFor(record) }];
}

export function followUpDueAt(sentAtMs) {
  if (!Number.isFinite(sentAtMs)) throw new TypeError('A sent timestamp is required for the review date.');
  return sentAtMs + REVIEW_INTERVAL_MS;
}
