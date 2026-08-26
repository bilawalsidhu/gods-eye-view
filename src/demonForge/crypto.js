const PBKDF2_ITERATIONS = 600000;
const SALT_LENGTH = 16;
const IV_LENGTH = 12;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function createCryptoError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function requireCrypto(cryptoApi) {
  if (!cryptoApi?.subtle || typeof cryptoApi.getRandomValues !== 'function') {
    throw new Error('Web Crypto API is required.');
  }
  return cryptoApi;
}

function asBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw new TypeError('Expected byte data.');
}

function encodeBase64Url(value) {
  const bytes = asBytes(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

function decodeBase64Url(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]*$/u.test(value)) {
    throw createCryptoError('DECRYPTION_FAILED');
  }
  const padded = `${value.replaceAll('-', '+').replaceAll('_', '/')}${'='.repeat((4 - (value.length % 4)) % 4)}`;
  try {
    const binary = atob(padded);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    throw createCryptoError('DECRYPTION_FAILED');
  }
}

function validateKeyMaterial(keyMaterial) {
  if (!keyMaterial?.key || asBytes(keyMaterial.salt).length !== SALT_LENGTH) {
    throw new TypeError('Expected vault key material.');
  }
}

export async function deriveVaultKey(passphrase, saltBytes, cryptoApi = globalThis.crypto) {
  const api = requireCrypto(cryptoApi);
  const salt = asBytes(saltBytes);
  if (typeof passphrase !== 'string' || salt.length !== SALT_LENGTH) {
    throw new TypeError('A passphrase and 16-byte salt are required.');
  }

  const sourceKey = await api.subtle.importKey(
    'raw',
    textEncoder.encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  const key = await api.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    sourceKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
  return { key, salt: new Uint8Array(salt) };
}

export async function encryptJson(keyMaterial, value, randomBytes, cryptoApi = globalThis.crypto) {
  const api = requireCrypto(cryptoApi);
  validateKeyMaterial(keyMaterial);
  const iv = asBytes(randomBytes);
  if (iv.length !== IV_LENGTH) throw new TypeError('Expected a 12-byte IV.');

  const plaintext = textEncoder.encode(JSON.stringify(value));
  const ciphertext = await api.subtle.encrypt({ name: 'AES-GCM', iv }, keyMaterial.key, plaintext);
  return {
    version: 1,
    algorithm: 'AES-GCM-256',
    salt: encodeBase64Url(keyMaterial.salt),
    iv: encodeBase64Url(iv),
    ciphertext: encodeBase64Url(ciphertext),
  };
}

export async function decryptJson(keyMaterial, envelope, cryptoApi = globalThis.crypto) {
  const api = requireCrypto(cryptoApi);
  validateKeyMaterial(keyMaterial);
  try {
    if (envelope?.version !== 1 || envelope?.algorithm !== 'AES-GCM-256') {
      throw createCryptoError('DECRYPTION_FAILED');
    }
    const salt = decodeBase64Url(envelope.salt);
    const iv = decodeBase64Url(envelope.iv);
    if (salt.length !== SALT_LENGTH || iv.length !== IV_LENGTH || encodeBase64Url(salt) !== encodeBase64Url(keyMaterial.salt)) {
      throw createCryptoError('DECRYPTION_FAILED');
    }
    const ciphertext = decodeBase64Url(envelope.ciphertext);
    const plaintext = await api.subtle.decrypt({ name: 'AES-GCM', iv }, keyMaterial.key, ciphertext);
    return JSON.parse(textDecoder.decode(plaintext));
  } catch (error) {
    if (error?.code === 'DECRYPTION_FAILED') throw error;
    throw createCryptoError('DECRYPTION_FAILED');
  }
}

export const VAULT_CRYPTO = Object.freeze({ PBKDF2_ITERATIONS, SALT_LENGTH, IV_LENGTH });
