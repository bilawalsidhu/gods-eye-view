# Demon Forge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an opt-in, local-first Demon Forge workspace for authorized privacy-exposure cases, reviewed imports, request drafts, and auditable manual follow-up.

**Architecture:** Demon Forge is a self-contained `src/demonForge/` subsystem. Pure policy/import modules feed an encrypted vault and a small modal UI controller. `main.js` owns its only application seam; it does not pass Cesium, live-data, voice, or sharing services to Demon Forge.

**Tech Stack:** Vanilla ES modules, native Web Crypto API, IndexedDB, Node.js built-in test runner, existing Vite/Cesium application.

**Spec:** `docs/superpowers/specs/2026-08-25-demon-forge-design.md`

## Global Constraints

- Demon Forge is disabled by default and has no independent network client.
- Never bundle, invoke, copy, or communicate with Social Analyzer; import a user-selected report file only.
- Never process an unconsenting third party: non-self cases require a signed, valid, in-scope mandate.
- Never auto-confirm an identity match, auto-submit a request, or represent a draft as legal advice.
- Keep personal data out of URL hashes, globe/data layers, general logs, and unencrypted exports.
- Store only minimized case data locally; raw reports are discarded unless explicitly retained as encrypted evidence.
- Use synthetic data only in tests.
- Follow the repository's ES module, two-space-indent, single-quote, semicolon style.
- Before upstream contribution, the owner runs `npm run build`, `npm test`, and `npm run test:track` as required by `CONTRIBUTING.md`.

---

## File structure

| File | Responsibility |
| --- | --- |
| `src/demonForge/types.js` | Versioned records and constants; no DOM/storage access. |
| `src/demonForge/policy.js` | Mandate, scope, review, approval, and state-transition decisions. |
| `src/demonForge/crypto.js` | Passphrase-derived AES-GCM encrypt/decrypt envelopes. |
| `src/demonForge/vault.js` | Encrypted IndexedDB envelopes and testable store adapter. |
| `src/demonForge/socialAnalyzerImport.js` | Strict report parsing and minimization. |
| `src/demonForge/ledger.js` | Append-only local event chain and review-date computation. |
| `src/demonForge/requestStudio.js` | France/EU drafts and approval gate; never sends. |
| `src/demonForge/controller.js` | Modal UI state, file selection, and manual official-route handoff. |
| `src/demonForge/*.test.mjs` | Offline tests with synthetic fixtures. |
| `index.html`, `style.css`, `src/main.js` | Inactive dialog shell, scoped styling, and narrow init seam. |

## Task 1: Define case vocabulary and a fail-closed policy

**Files:**
- Create: `src/demonForge/types.js`
- Create: `src/demonForge/policy.js`
- Test: `src/demonForge/policy.test.mjs`

**Interfaces:**
- Produces `CASE_KIND`, `CANDIDATE_STATUS`, `REQUEST_STATUS`, and `createCaseRecord(input)`.
- Produces `evaluateCaseAuthorization(caseRecord, nowMs)`, `canCreateRequest(caseRecord, candidate, action, nowMs)`, and `transitionRequest(request, nextStatus, approval, nowMs)`.
- Every decision is `{ ok: boolean, code: string, message: string }`; consumers check `ok` only.

- [ ] **Step 1: Write failing policy tests**

```js
test('an expired client mandate blocks a draft', () => {
  const record = createCaseRecord({ kind: CASE_KIND.MANDATED,
    mandate: { status: 'valid', expiresAtMs: 100, scope: ['social-profile'] } });
  assert.deepEqual(evaluateCaseAuthorization(record, 101), {
    ok: false, code: 'MANDATE_EXPIRED', message: 'The signed mandate has expired.',
  });
});
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `node --test src/demonForge/policy.test.mjs`  
Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the minimal authorization surface**

```js
export function canCreateRequest(caseRecord, candidate, action, nowMs) {
  const authorization = evaluateCaseAuthorization(caseRecord, nowMs);
  if (!authorization.ok) return authorization;
  if (candidate.status !== CANDIDATE_STATUS.CONFIRMED) {
    return { ok: false, code: 'CANDIDATE_UNCONFIRMED', message: 'Review this candidate before drafting a request.' };
  }
  if (!caseRecord.mandate.scope.includes(candidate.sourceCategory)) {
    return { ok: false, code: 'SOURCE_OUT_OF_SCOPE', message: 'This source is outside the signed mandate.' };
  }
  return { ok: true, code: 'ALLOWED', message: `${action} may be drafted.` };
}
```

- [ ] **Step 4: Add negative transition tests and run them**

```js
assert.equal(transitionRequest(draft, REQUEST_STATUS.SENT, null, nowMs).code, 'APPROVAL_REQUIRED');
assert.equal(transitionRequest(approved, REQUEST_STATUS.SENT, approval, nowMs).ok, false);
```

Run: `node --test src/demonForge/policy.test.mjs`  
Expected: PASS; expired, ambiguous, out-of-scope, and unapproved actions remain blocked.

- [ ] **Step 5: Commit**

```bash
git add src/demonForge/types.js src/demonForge/policy.js src/demonForge/policy.test.mjs && git commit -m "feat: add Demon Forge case policy"
```

## Task 2: Add the encrypted local vault

**Files:**
- Create: `src/demonForge/crypto.js`
- Create: `src/demonForge/vault.js`
- Test: `src/demonForge/crypto.test.mjs`
- Test: `src/demonForge/vault.test.mjs`

**Interfaces:**
- Produces `deriveVaultKey(passphrase, saltBytes)`, `encryptJson(key, value, randomBytes)`, `decryptJson(key, envelope)`, and `createDemonForgeVault({ store, cryptoApi, clock })`.
- Vault methods are `unlock`, `saveCase`, `loadCase`, `listCaseSummaries`, `deleteCase`, and `lock`.

- [ ] **Step 1: Write failing encryption tests**

```js
const key = await deriveVaultKey('test-only passphrase', new Uint8Array(16).fill(7));
const envelope = await encryptJson(key, { displayName: 'Synthetic Person' }, deterministicRandom);
assert.equal(envelope.algorithm, 'AES-GCM-256');
assert.notEqual(envelope.ciphertext, JSON.stringify({ displayName: 'Synthetic Person' }));
assert.deepEqual(await decryptJson(key, envelope), { displayName: 'Synthetic Person' });
```

- [ ] **Step 2: Run the crypto test to verify it fails**

Run: `node --test src/demonForge/crypto.test.mjs`  
Expected: FAIL because the crypto functions do not exist.

- [ ] **Step 3: Implement native Web Crypto envelopes**

Use PBKDF2 SHA-256 with 600000 iterations and a fresh 16-byte salt to derive a non-extractable AES-GCM 256-bit key. Use a fresh 12-byte IV per envelope; serialize only base64url `{ version: 1, algorithm: 'AES-GCM-256', salt, iv, ciphertext }`. Persist neither passphrase nor derived key.

```js
export async function encryptJson(key, value, randomBytes = crypto.getRandomValues.bind(crypto)) {
  const iv = randomBytes(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(value));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);
  return { version: 1, algorithm: 'AES-GCM-256', iv: toBase64Url(iv), ciphertext: toBase64Url(new Uint8Array(ciphertext)) };
}
```

- [ ] **Step 4: Write vault tests with a fake IndexedDB-shaped store**

```js
const vault = createDemonForgeVault({ store: fakeStore(), cryptoApi: webcrypto, clock: () => 42 });
await vault.unlock('test-only passphrase');
await vault.saveCase(syntheticCase);
assert.deepEqual(await vault.loadCase(syntheticCase.id), syntheticCase);
await vault.lock();
await assert.rejects(vault.loadCase(syntheticCase.id), /VAULT_LOCKED/);
```

- [ ] **Step 5: Implement the vault and run focused tests**

Use IndexedDB database `gods-eye-view.demon-forge.v1`, object store `cases`, and envelope-only values keyed by case ID. `listCaseSummaries()` may return only `{ id, status, updatedAtMs }`. A failed AES-GCM authentication throws `DECRYPTION_FAILED` and leaves the vault locked.

Run: `node --test src/demonForge/crypto.test.mjs src/demonForge/vault.test.mjs`  
Expected: PASS; plaintext never reaches the fake store and tampering is rejected.

- [ ] **Step 6: Commit**

```bash
git add src/demonForge/crypto.js src/demonForge/vault.js src/demonForge/crypto.test.mjs src/demonForge/vault.test.mjs && git commit -m "feat: add encrypted Demon Forge vault"
```

## Task 3: Import and minimize reports without executing Social Analyzer

**Files:**
- Create: `src/demonForge/socialAnalyzerImport.js`
- Test: `src/demonForge/socialAnalyzerImport.test.mjs`

**Interfaces:**
- Produces `parseSocialAnalyzerReport(jsonText, { importedAtMs })` as `{ source: 'social-analyzer', importedAtMs, candidates }`.
- Candidate shape: `{ id, sourceCategory: 'social-profile', provider, url, username, confidence, status: 'unverified', importedAtMs }`.
- Throws `ReportImportError` with `REPORT_TOO_LARGE`, `INVALID_JSON`, `UNSUPPORTED_SCHEMA`, or `UNSAFE_URL`.

- [ ] **Step 1: Write a failing known-shape test**

```js
const report = JSON.stringify({
  detected: [{ site: 'Example Social', url: 'https://example.test/synthetic', rate: 91, status: 'good' }],
  unknown: [{ site: 'Other', url: 'https://other.test/u/synthetic' }],
});
const result = parseSocialAnalyzerReport(report, { importedAtMs: 100 });
assert.deepEqual(result.candidates.map(({ provider, confidence, status }) => ({ provider, confidence, status })), [
  { provider: 'Example Social', confidence: 91, status: 'unverified' },
]);
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test src/demonForge/socialAnalyzerImport.test.mjs`  
Expected: FAIL because the importer does not exist.

- [ ] **Step 3: Implement strict minimization**

Accept only object roots with optional `detected`, `unknown`, and `failed` arrays; import `detected` items only. Require HTTPS, a nonempty `site`, and finite 0..100 `rate`. Keep only candidate fields above; discard titles, page text, metadata, screenshots, extraction output, `unknown`, and `failed`. Cap input at 2 MiB and candidates at 500.

```js
if (!url.startsWith('https://')) throw new ReportImportError('UNSAFE_URL');
if (!Number.isFinite(rate) || rate < 0 || rate > 100) continue;
```

- [ ] **Step 4: Run negative cases**

```js
assert.throws(() => parseSocialAnalyzerReport('{"detected":"not-an-array"}', options), /UNSUPPORTED_SCHEMA/);
assert.throws(() => parseSocialAnalyzerReport(JSON.stringify({ detected: [{ site: 'x', url: 'http://x.test', rate: 1 }] }), options), /UNSAFE_URL/);
```

Run: `node --test src/demonForge/socialAnalyzerImport.test.mjs`  
Expected: PASS; importing starts no process, makes no fetch, and retains no raw text.

- [ ] **Step 5: Commit**

```bash
git add src/demonForge/socialAnalyzerImport.js src/demonForge/socialAnalyzerImport.test.mjs && git commit -m "feat: add minimized Social Analyzer report import"
```

## Task 4: Add evidence and request-draft primitives

**Files:**
- Create: `src/demonForge/ledger.js`
- Create: `src/demonForge/requestStudio.js`
- Test: `src/demonForge/ledger.test.mjs`
- Test: `src/demonForge/requestStudio.test.mjs`

**Interfaces:**
- Produces `appendLedgerEvent(ledger, event, nowMs)`, `verifyLedger(ledger)`, `followUpDueAt(sentAtMs)`, `createFranceEuDraft(input)`, and `approveDraft(draft, approval, caseRecord, nowMs)`.
- A draft has `status: 'draft' | 'approved'`, `action`, `controllerName`, `contactRoute`, `body`, and `approval`; no transport field exists.

- [ ] **Step 1: Write failing ledger chain tests**

```js
const first = appendLedgerEvent([], { type: 'REQUEST_DRAFTED', actor: 'operator' }, 100);
const second = appendLedgerEvent(first, { type: 'REQUEST_APPROVED', actor: 'case-owner' }, 101);
assert.equal(verifyLedger(second).ok, true);
second[1].previousHash = 'tampered';
assert.equal(verifyLedger(second).code, 'LEDGER_TAMPERED');
```

- [ ] **Step 2: Run the ledger test to verify it fails**

Run: `node --test src/demonForge/ledger.test.mjs`  
Expected: FAIL because the ledger module does not exist.

- [ ] **Step 3: Implement the deterministic local chain**

Hash canonical JSON for `{ sequence, atMs, type, actor, payload, previousHash }` with SHA-256. Reject missing sequence, broken previous hash, or digest mismatch. `followUpDueAt(sentAtMs)` returns `sentAtMs + 31 * 24 * 60 * 60 * 1000` and is displayed as a review date, not a guaranteed legal deadline.

- [ ] **Step 4: Write failing draft and approval tests**

```js
const draft = createFranceEuDraft({ action: 'erasure', controllerName: 'Synthetic Controller', contactRoute: 'https://controller.test/privacy', candidate });
assert.match(draft.body, /demande d'effacement/i);
assert.equal(approveDraft(draft, { actor: 'operator' }, expiredMandateCase, nowMs).code, 'MANDATE_EXPIRED');
assert.equal(approveDraft(draft, { actor: 'case-owner' }, validCase, nowMs).status, 'approved');
```

- [ ] **Step 5: Implement and run focused tests**

The draft names the selected action, exact URL, controller, and manual review route; it says it is a draft for review and never claims complete deletion. `approveDraft` calls `canCreateRequest` and records actor, timestamp, and rendered-body hash.

Run: `node --test src/demonForge/ledger.test.mjs src/demonForge/requestStudio.test.mjs`  
Expected: PASS; broken ledger, absent approval, expired mandate, and unconfirmed candidate fail closed.

- [ ] **Step 6: Commit**

```bash
git add src/demonForge/ledger.js src/demonForge/requestStudio.js src/demonForge/ledger.test.mjs src/demonForge/requestStudio.test.mjs && git commit -m "feat: add Demon Forge ledger and request drafts"
```

## Task 5: Add the isolated, accessible workspace UI

**Files:**
- Create: `src/demonForge/controller.js`
- Create: `src/demonForge/controller.test.mjs`
- Modify: `index.html`
- Modify: `style.css`
- Modify: `src/main.js`

**Interfaces:**
- Produces `initDemonForge({ document, vault, now })` returning `{ open, close, destroy }`.
- `main.js` calls `initDemonForge({ document })` after normal UI initialization, with no Cesium or `DataLayerManager` parameter.

- [ ] **Step 1: Write failing controller-contract tests**

```js
const demonForge = initDemonForge({ document: fakeDocument(), vault: fakeVault, now: () => 100 });
demonForge.open();
assert.equal(dialog.hidden, false);
assert.equal(fetchCalls, 0);
assert.equal(globeCalls, 0);
demonForge.close();
assert.equal(dialog.hidden, true);
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test src/demonForge/controller.test.mjs`  
Expected: FAIL because the controller does not exist.

- [ ] **Step 3: Add semantic inactive markup and scoped styling**

Add a `DEMON FORGE` button with `aria-controls="demon-forge-dialog"`, then hidden `<dialog id="demon-forge-dialog" aria-labelledby="demon-forge-title">` sections for authorization, import, review, draft, and ledger. Include: `Local case workspace. No search or request is sent automatically.` Keep all personal content runtime-generated, never in markup.

- [ ] **Step 4: Implement controller behavior**

Opening is user-initiated. File selection uses local `<input type="file" accept="application/json">` and passes text only to `parseSocialAnalyzerReport`. Closing/locking clears rendered personal text. `Open official route` stays disabled until approved, calls `window.open(draft.contactRoute, '_blank', 'noopener,noreferrer')`, and appends only a local `MANUAL_ROUTE_OPENED` ledger event.

- [ ] **Step 5: Wire main and run the test**

```js
import { initDemonForge } from './demonForge/controller.js';
const demonForge = initDemonForge({ document });
window.addEventListener('beforeunload', () => demonForge.destroy(), { once: true });
```

Run: `node --test src/demonForge/controller.test.mjs`  
Expected: PASS; close/lock clears UI and no fetch, share-link, or globe-layer access occurs.

- [ ] **Step 6: Commit**

```bash
git add index.html style.css src/main.js src/demonForge/controller.js src/demonForge/controller.test.mjs && git commit -m "feat: add Demon Forge local workspace"
```

## Task 6: Document, review, and run the full suite

**Files:**
- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Modify: `docs/CURRENT-STATE.md`
- Modify: `src/demonForge/controller.test.mjs`

**Interfaces:**
- Documents `initDemonForge` only; this task adds no network, search, or sending interface.

- [ ] **Step 1: Write documentation assertions**

Add static test checks that each document contains `local-first`, `no automatic request submission`, and `signed mandate`.

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `node --test src/demonForge/controller.test.mjs`  
Expected: FAIL because the runtime boundary is not documented.

- [ ] **Step 3: Update user and runtime documentation**

Document optional local operation, external-only Social Analyzer report import, mandate requirements, human confirmation, encrypted evidence, manual sending, France/EU-first policy pack, and non-legal-advice boundary.

- [ ] **Step 4: Run validation gates**

Run: `node --test src/demonForge/*.test.mjs`  
Expected: PASS with synthetic fixtures only.

Run: `npm test`  
Expected: PASS; Node 24 allocation probes run on Node 24 or report their documented skip.

Run: `npm run build`  
Expected: PASS with no Vite import or DOM-reference errors.

Run: `npm run test:track`  
Expected: PASS with its required local dev server; otherwise report the owner-run blocker, never a pass.

- [ ] **Step 5: Review and commit**

```bash
git diff --check && git status --short && git add README.md CHANGELOG.md docs/CURRENT-STATE.md src/demonForge/controller.test.mjs && git commit -m "docs: define Demon Forge privacy boundaries"
```

## Plan self-review

- **Spec coverage:** authorization (Task 1); encrypted local storage (Task 2); external-only minimized import (Task 3); evidence, manual request drafts, and France/EU review (Task 4); opt-in no-network/no-globe UI (Task 5); documentation and repository gates (Task 6).
- **No placeholders:** every task has concrete files, interfaces, tests, commands, and named error behavior.
- **Type consistency:** `CaseRecord`, `Candidate`, `RequestDraft`, `LedgerEvent`, and `{ ok, code, message }` decisions use the interfaces introduced in Tasks 1â€“4.
