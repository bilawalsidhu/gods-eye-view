#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function isPinokioShareEnabled(value) {
  return /^(1|true)$/i.test(String(value || '').trim());
}

export function validatePinokioSharing(env = process.env) {
  const cloudflare = isPinokioShareEnabled(env.PINOKIO_SHARE_CLOUDFLARE);
  const local = isPinokioShareEnabled(env.PINOKIO_SHARE_LOCAL);
  const shareVariable = String(env.PINOKIO_SHARE_VAR || '').trim();
  if (cloudflare || local || shareVariable !== '__gev_sharing_disabled__') {
    throw new Error(
      'Pinokio sharing is unavailable because the current supported release can expose the app after child preflight '
      + 'and logs successful tunnel-login passcodes. Keep PINOKIO_SHARE_CLOUDFLARE=false, '
      + 'PINOKIO_SHARE_LOCAL=false, and PINOKIO_SHARE_VAR=__gev_sharing_disabled__.',
    );
  }
  return { cloudflare: false, local: false, protected: false };
}

function run() {
  validatePinokioSharing();
  console.log('[Pinokio] Local-only launch.');
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    run();
  } catch (error) {
    console.error(`[Pinokio] ${error.message}`);
    process.exitCode = 1;
  }
}
