# Demon Forge local case workspace

Demon Forge is an optional workspace for reviewing an externally generated
Social Analyzer report and preparing privacy-request drafts. Open **DEMON FORGE**
from the standalone app. It does not search for people, run Social Analyzer,
fetch profiles, send requests, or add personal records to the globe, voice tools,
MCP tools, or share links.

## Local workflow

1. Authenticate the local vault with a passphrase. Keep that passphrase: there is
   no recovery service. The encrypted cases belong to this browser and origin;
   clearing its site data removes them.
2. Create a self case, or record a non-self case's signed and validated mandate,
   expiry, source category, and permitted actions. The entered mandate metadata
   is an operator attestation, not electronic signature verification.
3. Select a local JSON report, then manually confirm the relevant candidate.
   A reported confidence score does not establish identity.
4. Prepare a draft with the controller name and an HTTPS contact reference.
   Review its text and record the approver. Approval is a local workflow record,
   not delivery or a verified electronic signature.
5. Close or lock the workspace to clear displayed case data. Unlock and select
   an existing case to restore its encrypted workflow and ledger.

The contact reference is unverified. Browser handoff stays disabled because this
version has no verified source directory. France/EU-first draft wording is not
legal advice; it makes no promise of deletion or successful delivery.

## Accepted report

The import accepts a JSON object with `detected`, and optional `unknown` and
`failed` arrays. Only detected entries are retained. Each detected entry requires
`site`, an HTTPS `url`, and a finite `rate` from 0 to 100; `username` and `status`
are optional strings. Unexpected root or detected-entry fields are rejected.
The file limit is 2 MiB and the detected-candidate limit is 500.

```json
{
  "detected": [
    {
      "site": "Synthetic source",
      "url": "https://example.test/synthetic",
      "rate": 90
    }
  ]
}
```

Raw report text is not persisted. Minimized candidates, drafts, approvals, and
workflow events are stored as AES-GCM encrypted IndexedDB records using a
passphrase-derived key. Case and candidate identifiers are generated locally.
The append-only SHA-256 event chain detects inconsistent history; it is not an
external timestamp, independent notarization, or protection against a compromised
browser while the vault is unlocked. There is no backup/export UI in this slice.

## Verification

Focused synthetic tests: `node --test src/demonForge/*.test.mjs`.
Repository gates: `npm test`, `npm run build`, and `npm run test:track` with a
local development server. A real-browser walkthrough should cover unlock,
create, import, confirm, draft, approve, close, and reopen using synthetic data.
