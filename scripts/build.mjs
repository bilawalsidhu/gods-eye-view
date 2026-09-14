#!/usr/bin/env node
/**
 * Guarded production build (`npm run build`).
 *
 * Wraps `vite build` and fails on Node-core externalization warnings in
 * browser chunks — Vite's
 * `Module "node:…" has been externalized for browser compatibility` lines.
 * Those warnings mean a browser bundle references a Node builtin, which
 * works only until the first real browser load touches that path (issue #34:
 * the whole suite once depended on such a path silently existing). The build
 * was clean when this gate landed (2026-09-13); the gate keeps it that way
 * with a check instead of vigilance.
 *
 * All vite output still streams through to the caller so a failure is
 * readable in place.
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** Matches vite's externalization warning in both dev and build phrasings. */
const EXTERNALIZED_WARNING = /has been externalized for browser compatibility/;
const SPECIFIER = /Module "(node:[^"]+)"/;

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

export function scanForExternalizedWarnings(output) {
  const seen = new Set();
  for (const line of String(output).split('\n')) {
    if (!EXTERNALIZED_WARNING.test(line)) continue;
    // One offending module can produce several near-duplicate lines; keep the
    // first mention per externalized specifier.
    const specifier = SPECIFIER.exec(line)?.[1] || line.trim();
    seen.add(specifier);
  }
  return [...seen];
}

if (invokedDirectly) {
  let output = '';
  const tee = (stream) => (chunk) => {
    const text = chunk.toString();
    output += text;
    stream.write(text);
  };
  const child = spawn('npx', ['vite', 'build'], {
    stdio: ['inherit', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
  });
  child.stdout.on('data', tee(process.stdout));
  child.stderr.on('data', tee(process.stderr));
  child.on('close', (code) => {
    const warnings = scanForExternalizedWarnings(output);
    if (warnings.length) {
      console.error(
        `\nBUILD-GATE FAIL — ${warnings.length} Node-core externalization warning(s) in `
        + `browser chunks (issue #34). A browser bundle references a Node builtin; `
        + `remove the import or move the code behind a server-only module: `
        + `${warnings.join(' | ')}`,
      );
      process.exitCode = 1;
      return;
    }
    if (code !== 0) {
      process.exitCode = code ?? 1;
      return;
    }
    console.log('BUILD-GATE PASS — no Node-core externalization warnings in browser chunks');
  });
}
