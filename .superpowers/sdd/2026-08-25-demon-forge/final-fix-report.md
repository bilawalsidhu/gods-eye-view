# Demon Forge final corrective pass

Date: 2026-09-01  
Review range: `0d33ac8..e568e43`  
Runtime/security commit: `d05e9a8`

## Outcome

Every P1/P2 named in the final review task has a bounded corrective implementation. Demon Forge remains local-only and import-only: this pass adds no request transport, automatic sending, network fetching, globe data flow, or voice integration.

## Corrections

### Authorization-aware cases and UI

- Case kind is explicit; omitted kinds no longer silently become self cases.
- The UI distinguishes self cases from non-self cases and captures mandate signing, validation, expiry, allowed source category, and permitted actions.
- Non-self import/review/draft/approval paths re-evaluate mandate validity and enforce both source-category and action scope.
- The approval path now uses the active persisted case instead of constructing an unconditional self case.

### Opaque identifiers and existing-case authentication

- Case IDs and imported candidate IDs are generated with secure opaque UUIDs; report-provided IDs and user-authored case IDs are not trusted.
- The active case ID is read-only in the UI.
- Vault unlock authenticates existing encrypted cases by decrypting their summaries before case actions are enabled.
- Saving an existing case decrypts/authenticates the stored envelope before replacement. A wrong passphrase cannot overwrite it.
- Create-only saves reject ID collisions.

### Durable append-only history

- Case creation, report import, candidate confirmation, request drafting, and approval append encrypted ledger events before the UI reports success.
- Encrypted workflow snapshots preserve imported candidates and draft/approval history across lock/reopen cycles.
- Vault updates reject removal or alteration of any persisted ledger or workflow prefix.
- Existing cases restore candidates, draft state, workflow history, and the verified ledger rather than beginning with empty in-memory state.

### Strict local report import

- The controller checks a trustworthy `File.size` against the 2 MiB cap before calling `File.text()`.
- The importer rejects unexpected root and detected-row fields instead of silently accepting shape drift.
- Import timestamps must be explicit nonnegative integers.
- Optional username/status values are type-checked, HTTPS remains mandatory, and candidate-count/text caps remain fail-closed.

### Honest route boundary and documentation

- No source directory with provenance ships in this slice, so the browser handoff remains disabled even after approval.
- The contact URL is labelled and rendered as an unverified drafting reference; no `window.open` path remains in Demon Forge.
- README, changelog, and current-state documentation now describe encrypted append-only persistence, explicit mandate scope, and the disabled handoff accurately.

### SDD ledger

- Removed the contradictory completed/pending duplicate task statuses.
- Recorded the final corrective pass as complete while preserving the explicit no-test/no-build qualification.

## Synthetic static coverage added

- Strict root/row shapes, invalid timestamps, and opaque candidate IDs.
- Pre-read oversize-file rejection.
- Mandate action/source-category scope and explicit case kind.
- Existing-case authentication before overwrite, create collisions, and append-only history rejection.
- Opaque case creation, mandate-aware persisted state, full ledger/workflow event history, and disabled unverified handoff.
- Documentation boundary assertions for the verified-source-directory and append-only-ledger language.

## Verification performed

- `git diff --check` completed cleanly before the runtime/security commit.
- Read-only searches confirmed Demon Forge has no `window.open`, `fetch`, Cesium, voice, or manual-route event integration in production code.

## Verification deliberately not performed

Per the task instruction, no unit test, integration test, build, or test-tracking command was run. The added tests are synthetic static coverage and must be executed by the owner in the normal validation gate.
