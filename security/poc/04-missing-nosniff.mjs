/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║  POC #4 — Missing X-Content-Type-Options: nosniff              ║
 * ║                                                                ║
 * ║  VULNERABILITY: ALL server proxy handlers                      ║
 * ║  No API endpoint sets X-Content-Type-Options: nosniff.         ║
 * ║  This allows MIME-type sniffing attacks where a browser        ║
 * ║  interprets JSON/text responses as HTML, enabling XSS.         ║
 * ║                                                                ║
 * ║  IMPACT: Medium — Content-type confusion can lead to XSS       ║
 * ║  when JSON responses containing user-controlled data are       ║
 * ║  rendered by browsers that perform MIME sniffing.              ║
 * ║                                                                ║
 * ║  HOW TO REPRODUCE: node security/poc/04-missing-nosniff.mjs    ║
 * ╚══════════════════════════════════════════════════════════════════╝
 */

const TARGET = process.env.TARGET || 'http://localhost:4173';

const ENDPOINTS = [
  { path: '/api/firms/status', method: 'GET', desc: 'FIRMS status' },
  { path: '/api/setup/status', method: 'GET', desc: 'Key setup status' },
  { path: '/api/ais-live', method: 'GET', desc: 'AIS vessel data' },
  { path: '/api/route?profile=foot&coords=0,0;1,1', method: 'GET', desc: 'Route proxy' },
  { path: '/api/military-installations?south=0&west=0&north=1&east=1', method: 'GET', desc: 'Military installations' },
  { path: '/api/gbfs/missing', method: 'GET', desc: 'GBFS proxy' },
];

async function exploit() {
  console.log('=== POC #4: Missing X-Content-Type-Options: nosniff ===\n');
  console.log('Scanning API endpoints for missing security headers...\n');

  let vulnerable = 0;
  let total = 0;

  for (const ep of ENDPOINTS) {
    total++;
    try {
      const res = await fetch(`${TARGET}${ep.path}`, {
        method: ep.method,
        headers: ep.method === 'POST' ? { 'Content-Type': 'application/json' } : {},
        body: ep.method === 'POST' ? '{}' : undefined,
      });

      const nosniff = res.headers.get('x-content-type-options');
      const csp = res.headers.get('content-security-policy');
      const xframe = res.headers.get('x-frame-options');
      const contentType = res.headers.get('content-type');

      const missing = [];
      if (!nosniff) missing.push('X-Content-Type-Options');
      // Note: CSP and X-Frame-Options are only on key-setup, not on other endpoints
      // This is itself a finding — inconsistent security headers

      if (missing.length > 0) {
        vulnerable++;
        console.log(`  ✗ ${ep.desc} (${ep.path})`);
        console.log(`    Status: ${res.status} | Content-Type: ${contentType}`);
        console.log(`    Missing: ${missing.join(', ')}`);
        console.log(`    X-Content-Type-Options: ${nosniff || 'NOT SET ← VULNERABLE'}`);
        console.log(`    X-Frame-Options: ${xframe || 'not set'}`);
        console.log(`    CSP: ${csp || 'not set'}`);
        console.log();
      } else {
        console.log(`  ✓ ${ep.desc} — headers present`);
      }
    } catch (e) {
      console.log(`  ? ${ep.desc} — ${e.message}`);
    }
  }

  console.log(`\nResults: ${vulnerable}/${total} endpoints missing nosniff header`);

  if (vulnerable > 0) {
    console.log('\n✓ VULNERABLE: MIME-type sniffing attacks possible');
    console.log('\nAttack scenario:');
    console.log('  1. Attacker crafts a URL to an API endpoint that echoes user input');
    console.log('  2. In older browsers (IE11, some mobile browsers), the browser');
    console.log('     may MIME-sniff the response as HTML despite Content-Type: application/json');
    console.log('  3. If the JSON response contains HTML/script from user-controlled data,');
    console.log('     the browser executes it as HTML');
    console.log('\nFix: Add X-Content-Type-Options: nosniff to ALL API responses.');
    console.log('This header tells browsers to strictly honor Content-Type.');
    console.log('\nNote: Only /api/setup/status and /api/setup/keys set security headers.');
    console.log('Every other endpoint is missing ALL defensive response headers.');
  }
}

exploit().catch(console.error);
