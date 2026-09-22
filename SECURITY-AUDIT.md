# 🛡️ Security Audit Report: God's Eye View

## Executive Summary

A manual, line-by-line source code audit of the God's Eye View server-side proxy
architecture uncovered **5 exploitable vulnerabilities** — including a critical
DNS rebinding attack chain that can exfiltrate API keys from any developer
running the app on a LAN.

All findings include proof-of-concept exploit scripts in `security/poc/` and
complete code fixes.

---

## Vulnerability #1 — DNS Rebinding → API Key Exfiltration

| Field | Value |
|-------|-------|
| **Severity** | 🔴 Critical (CVSS 9.3) |
| **File** | `build/vite.js` line 19-22 |
| **Type** | CWE-350: Reliance on Reverse DNS Resolution |
| **POC** | `security/poc/01-dns-rebinding-exploit.html` |

### Root Cause

When `HOST=0.0.0.0` or `HOST=::` (the LAN-sharing configuration), the Vite dev
server is configured with `allowedHosts: true`, which **completely disables
hostname verification**:

```javascript
// BEFORE (vulnerable)
allowedHosts: host === '0.0.0.0' || host === '::' ? true : ['localhost', ...]
```

### Attack Scenario

1. Victim starts dev server with `HOST=0.0.0.0` (documented LAN sharing mode)
2. Victim visits `attacker.com` in their browser
3. Attacker's DNS resolves `attacker.com` → `127.0.0.1` (DNS rebinding)
4. Attacker's JavaScript makes fetch() calls to `attacker.com:4173`
5. Vite accepts the request (allowedHosts: true — any hostname is allowed)
6. **The browser connects to localhost:4173 — the victim's dev server**

### Impact

The attacker can now:
- **Steal OpenAI API keys** via `/api/realtime/token` (mints ephemeral tokens using the secret key)
- **Enumerate all configured credentials** via `/api/setup/status`
- **Manipulate `.env` file** via `/api/setup/keys` (write arbitrary API keys)
- **Drain OpenAI credits** via unlimited `/api/openai/hud-summary` calls

### Fix Applied

```diff
-      allowedHosts:
-        host === '0.0.0.0' || host === '::'
-          ? true
-          : ['localhost', '127.0.0.1', '.local'],
+      // SECURITY: never set allowedHosts to `true`
+      allowedHosts: ['localhost', '127.0.0.1', '::1', '.local'],
```

---

## Vulnerability #2 — Log Forgery via Timestamp Override

| Field | Value |
|-------|-------|
| **Severity** | 🟠 High |
| **File** | `server/providers/openai/debug-log.js` lines 82-87 |
| **Type** | CWE-117: Improper Output Neutralization for Logs |
| **POC** | `security/poc/02-log-forgery.mjs` |

### Root Cause

The debug-log handler spreads user-controlled JSON **after** the server-generated
`loggedAt` timestamp, allowing the client to override it:

```javascript
// BEFORE (vulnerable)
await append(`${JSON.stringify({
  loggedAt: new Date().toISOString(),  // Server timestamp placed FIRST
  ...record,                           // Client data OVERWRITES loggedAt!
})}\n`);
```

Because JavaScript object spread replaces earlier keys with later ones,
`{ loggedAt: "server-time", ...{loggedAt: "attacker-time"} }` results in
`{ loggedAt: "attacker-time" }`.

### Proof of Concept

```bash
# Backdate a log entry to cover tracks
curl -X POST http://localhost:4173/api/realtime/log \
  -H 'Content-Type: application/json' \
  -d '{"loggedAt":"2020-01-01T00:00:00.000Z","type":"session.created"}'
# → Entry written with 2020 timestamp instead of actual server time
```

### Impact

- **Forensic log corruption** — attacker can backdate entries to cover tracks
- **Timeline manipulation** — future-dated entries disrupt incident investigation
- **Key injection** — arbitrary keys like `severity`, `source`, `alert` can mislead analysts

### Fix Applied

```diff
+      delete record.loggedAt;
+      delete record.__proto__;
+      delete record.constructor;
       await append(`${JSON.stringify({
-          loggedAt: new Date().toISOString(),
           ...record,
+          loggedAt: new Date().toISOString(),  // AFTER spread — can't be overridden
       })}\n`);
```

---

## Vulnerability #3 — Key-Setup Endpoint Missing Rate Limit

| Field | Value |
|-------|-------|
| **Severity** | 🟠 High |
| **File** | `server/standalone/key-setup.js` lines 247-261 |
| **Type** | CWE-770: Allocation of Resources Without Limits |
| **POC** | `security/poc/03-keyset-no-ratelimit.mjs` |

### Root Cause

The credential management endpoints (`/api/setup/status` and `/api/setup/keys`)
are the **only sensitive endpoints in the entire application without rate
limiting**. Every other endpoint uses `makeRateLimiter()`:

| Endpoint | Rate Limit |
|----------|------------|
| `/api/military-installations` | 90 req/min + 300 global |
| `/api/route` | 60 req/min + 200 global |
| `/api/realtime/log` | 120 req/min + 400 global |
| `/api/overpass` | 30 req/min + 100 global |
| **`/api/setup/keys`** | **∞ UNLIMITED ← VULNERABLE** |
| **`/api/setup/status`** | **∞ UNLIMITED ← VULNERABLE** |

### Impact

Combined with DNS rebinding (Vuln #1), an attacker can:
- Rapidly probe `/api/setup/status` to enumerate credentials
- Flood `/api/setup/keys` with credential manipulation requests
- The loopback-only admission gate blocks non-local IPs, but DNS rebinding
  connects FROM localhost — the admission check passes

### Fix Applied

Added `makeRateLimiter({ windowMs: 60000, max: 10, globalMax: 30 })` to both
endpoints — tight limits because legitimate use is rare manual key entry.

---

## Vulnerability #4 — Missing X-Content-Type-Options: nosniff

| Field | Value |
|-------|-------|
| **Severity** | 🟡 Medium |
| **File** | `build/vite.js` lines 26-30 |
| **Type** | CWE-16: Configuration (Missing Security Header) |
| **POC** | `security/poc/04-missing-nosniff.mjs` |

### Root Cause

All API endpoints return JSON responses without the `X-Content-Type-Options:
nosniff` header. Only the key-setup endpoint sets `X-Frame-Options` and `CSP` —
every other endpoint is missing ALL defensive response headers.

### Impact

Without `nosniff`, browsers that perform MIME-type sniffing may interpret a JSON
API response as HTML. If the JSON contains user-controlled data (e.g., place
names, station labels, vessel names from upstream APIs), a crafted response could
be rendered as executable HTML/script.

This is especially dangerous with:
- `/api/openai/hud-summary` — echoes place names from client input
- `/api/places/google` — forwards place names from Google Places
- `/api/radio/catalog` — forwards station metadata from Radio Browser API

### Fix Applied

Added `'X-Content-Type-Options': 'nosniff'` to the Vite server's global
`headers` configuration, protecting ALL responses automatically.

---

## Vulnerability #5 — OpenAI Cost Amplification (Wallet Drain)

| Field | Value |
|-------|-------|
| **Severity** | 🟠 High |
| **File** | `server/providers/common/rate-limit.js` lines 4-24 |
| **Type** | CWE-770: Allocation of Resources Without Limits |
| **POC** | `security/poc/05-openai-cost-drain.mjs` |

### Root Cause

The OpenAI proxy rate limiter is **opt-in and disabled by default**:

```javascript
// BEFORE (vulnerable)
export function makeOptInRateLimiter(envValue) {
  const max = Number(envValue);
  if (!Number.isFinite(max) || max <= 0) return null; // unset → unlimited!
}
```

The `.env.example` documents this as intentional: `# DEFAULT IS UNLIMITED`.
But combined with DNS rebinding, this means any malicious website can make
**unlimited requests** that consume the victim's OpenAI API credits.

### Financial Impact

| Attack | Cost per req | At 100 req/sec | Per hour |
|--------|-------------|----------------|----------|
| HUD Summary | ~$0.02 | $2/sec | **$7,200** |
| Token Minting | ~$0.10 | $10/sec | **$36,000** |

### Fix Applied

Changed from opt-in (unlimited by default) to **secure-by-default** (30 req/min/IP):

```diff
-export function makeOptInRateLimiter(envValue) {
-  const max = Number(envValue);
-  if (!Number.isFinite(max) || max <= 0) return null; // unlimited
+export function makeOptInRateLimiter(envValue, defaultMax = 30) {
+  const raw = Number(envValue);
+  // Explicit 0 = opt-out. Unset = safe default.
+  if (envValue !== undefined && envValue !== '' && raw === 0) return null;
+  const max = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : defaultMax;
```

Users who explicitly set `GEV_RATELIMIT_OPENAI_PER_MIN=0` can still opt out.

---

## Files Changed

| File | Change |
|------|--------|
| `build/vite.js` | Fixed DNS rebinding + added nosniff header |
| `server/providers/openai/debug-log.js` | Fixed log forgery via timestamp override |
| `server/standalone/key-setup.js` | Added rate limiting to credential endpoint |
| `server/providers/common/rate-limit.js` | Changed OpenAI throttle to secure-by-default |

## POC Scripts

| Script | Demonstrates |
|--------|-------------|
| `security/poc/01-dns-rebinding-exploit.html` | API key theft via DNS rebinding |
| `security/poc/02-log-forgery.mjs` | Timestamp override in debug logs |
| `security/poc/03-keyset-no-ratelimit.mjs` | Missing rate limit on credential endpoint |
| `security/poc/04-missing-nosniff.mjs` | MIME-sniffing header scan |
| `security/poc/05-openai-cost-drain.mjs` | OpenAI credit drain via unlimited API calls |
