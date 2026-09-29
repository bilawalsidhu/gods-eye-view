#!/usr/bin/env node
/**
 * Create a God's Eye View-owned ChatGPT OAuth session for Realtime voice.
 *
 * This does not read or refresh ~/.codex or ~/.hermes. Those refresh tokens
 * are single-use. Run this, then restart `npm run dev`.
 *
 * The client id is the public Codex CLI client, not an app registered to
 * God's Eye View. OpenAI does not offer a third-party OAuth client that
 * mints API keys. The HUD summary still needs OPENAI_API_KEY.
 */
import {
  exchangeDeviceCode,
  requestDeviceCode,
  writeOAuthStore,
  defaultOAuthStorePath,
} from '../server/providers/openai/credential.js';

const ISSUER = 'https://auth.openai.com';

async function poll(device) {
  const deadline = Date.now() + 15 * 60 * 1000;
  const interval = Math.max(3, Number(device.interval) || 5) * 1000;
  while (Date.now() < deadline) {
    const response = await fetch(`${ISSUER}/api/accounts/deviceauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        device_auth_id: device.device_auth_id,
        user_code: device.user_code,
      }),
    });
    if (response.status === 200) return response.json();
    if (response.status !== 403 && response.status !== 404) {
      throw new Error(`Sign-in poll failed (${response.status})`);
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  throw new Error('Sign-in timed out after 15 minutes');
}

const device = await requestDeviceCode();
console.log("ChatGPT sign-in for God's Eye View Realtime voice.");
console.log(
  'This creates a separate session. It does not touch Codex or Hermes.',
);
console.log('');
console.log(`1. Open ${ISSUER}/codex/device`);
console.log(`2. Enter ${device.user_code}`);
console.log('');
console.log('Waiting for sign-in...');
const code = await poll(device);
const tokens = await exchangeDeviceCode({
  authorizationCode: code.authorization_code,
  codeVerifier: code.code_verifier,
});
const file = defaultOAuthStorePath();
writeOAuthStore(file, tokens);
console.log(`Saved a Realtime session to ${file}`);
console.log('Restart npm run dev. The HUD summary still needs OPENAI_API_KEY.');
