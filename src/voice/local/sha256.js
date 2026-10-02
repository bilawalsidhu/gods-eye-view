const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/**
 * Incremental SHA-256 for verifying multi-gigabyte downloads as they stream
 * (WebCrypto only digests whole buffers). update() accepts Uint8Array chunks.
 */
export function createSha256() {
  const state = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
    0x1f83d9ab, 0x5be0cd19,
  ]);
  const words = new Uint32Array(64);
  const block = new Uint8Array(64);
  let blockLength = 0;
  let bytes = 0;

  function compress(data, offset) {
    for (let i = 0; i < 16; i++) {
      const j = offset + i * 4;
      words[i] =
        (data[j] << 24) |
        (data[j + 1] << 16) |
        (data[j + 2] << 8) |
        data[j + 3];
    }
    for (let i = 16; i < 64; i++) {
      const a = words[i - 15];
      const b = words[i - 2];
      const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
      const s1 =
        ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
      words[i] = (words[i - 16] + s0 + words[i - 7] + s1) | 0;
    }
    let a = state[0];
    let b = state[1];
    let c = state[2];
    let d = state[3];
    let e = state[4];
    let f = state[5];
    let g = state[6];
    let h = state[7];
    for (let i = 0; i < 64; i++) {
      const s1 =
        ((e >>> 6) | (e << 26)) ^
        ((e >>> 11) | (e << 21)) ^
        ((e >>> 25) | (e << 7));
      const choice = (e & f) ^ (~e & g);
      const t1 = (h + s1 + choice + K[i] + words[i]) | 0;
      const s0 =
        ((a >>> 2) | (a << 30)) ^
        ((a >>> 13) | (a << 19)) ^
        ((a >>> 22) | (a << 10));
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (s0 + majority) | 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }
    state[0] += a;
    state[1] += b;
    state[2] += c;
    state[3] += d;
    state[4] += e;
    state[5] += f;
    state[6] += g;
    state[7] += h;
  }

  return {
    update(chunk) {
      const data = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
      bytes += data.length;
      let offset = 0;
      if (blockLength) {
        const take = Math.min(64 - blockLength, data.length);
        block.set(data.subarray(0, take), blockLength);
        blockLength += take;
        offset = take;
        if (blockLength < 64) return;
        compress(block, 0);
        blockLength = 0;
      }
      for (; offset + 64 <= data.length; offset += 64) compress(data, offset);
      block.set(data.subarray(offset), 0);
      blockLength = data.length - offset;
    },
    /** Returns the lowercase hex digest; the instance is spent afterwards. */
    digest() {
      const tail = new Uint8Array(blockLength < 56 ? 64 : 128);
      tail.set(block.subarray(0, blockLength));
      tail[blockLength] = 0x80;
      const bits = bytes * 8;
      const view = new DataView(tail.buffer);
      view.setUint32(tail.length - 8, Math.floor(bits / 2 ** 32));
      view.setUint32(tail.length - 4, bits >>> 0);
      for (let offset = 0; offset < tail.length; offset += 64)
        compress(tail, offset);
      return [...state]
        .map((word) => word.toString(16).padStart(8, '0'))
        .join('');
    },
  };
}
