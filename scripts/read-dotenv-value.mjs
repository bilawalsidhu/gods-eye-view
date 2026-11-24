#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { loadEnv } from 'vite';

/**
 * Read one dotenv key with Vite's parser; no file content is executed.
 *
 * Reports what the FILES say. `loadEnv` lets `process.env` override the parsed
 * files, so an inherited export — an empty one above all, which is how a shell
 * says "unset" to this script's callers — would otherwise mask the value the
 * user wrote down. The key is hidden for the duration of the read and restored
 * afterwards, leaving the caller's environment untouched.
 */
export function readDotenvValue(variableName, rootDir = process.cwd(), mode = 'development') {
  const key = String(variableName || '').trim();
  if (!/^[A-Z_][A-Z0-9_]*$/i.test(key)) return '';
  const inherited = Object.prototype.hasOwnProperty.call(process.env, key)
    ? process.env[key]
    : undefined;
  if (inherited !== undefined) delete process.env[key];
  try {
    const env = loadEnv(mode, path.resolve(rootDir), '');
    return String(env[key] ?? '');
  } finally {
    if (inherited !== undefined) process.env[key] = inherited;
  }
}

/**
 * Every value the dotenv FILES supply, merged in Vite's order — .env,
 * .env.local, .env.<mode>, .env.<mode>.local; a later file wins — and never
 * process.env. Keys live in .env.local and settings in .env, so callers must
 * read the whole ladder, not one file. Unreadable or malformed files are
 * skipped (an operator may deny this account the secrets file).
 */
export function readDotenvFiles(rootDir = process.cwd(), mode = 'development') {
  const values = {};
  for (const name of ['.env', '.env.local', `.env.${mode}`, `.env.${mode}.local`]) {
    const file = path.join(path.resolve(rootDir), name);
    if (!existsSync(file)) continue;
    try {
      Object.assign(values, parseEnv(readFileSync(file, 'utf8')));
    } catch {
      // skipped: see above
    }
  }
  return values;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  process.stdout.write(readDotenvValue(process.argv[2], process.argv[3] || process.cwd()));
}
