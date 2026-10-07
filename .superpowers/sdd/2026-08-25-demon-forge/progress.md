# SDD ledger — plan: docs/superpowers/plans/2026-08-25-demon-forge.md

## Workspace

- Execution location: `C:\god eye` on branch `codex/improvements` by explicit user choice; no linked worktree was created.
- Merge base for this plan: `0d33ac808c5ddeaa231472cfd12398d28f185915`.

## Pre-flight consistency scan

| Tasks | Shared file or interface | Finding |
| --- | --- | --- |
| 1 → 2 | `CaseRecord` | Task 1 defines case records; Task 2 stores them as opaque encrypted payloads. Compatible. |
| 1 → 3 | `Candidate` status and source category | Task 3 creates only `unverified` social-profile candidates; Task 1 is the only transition authority. Compatible. |
| 1 → 4 | authorization and request transition decisions | Task 4 consumes `canCreateRequest`; it does not duplicate policy. Compatible. |
| 1 → 5 | policy decisions | Task 5 consumes the Task 1 API for all UI gates. Compatible. |
| 2 → 5 | `createDemonForgeVault` | Task 5 receives the vault only through dependency injection. Compatible. |
| 3 → 5 | `parseSocialAnalyzerReport` | Task 5 passes a locally selected file's text to the importer. Compatible; no process or network interface is introduced. |
| 4 → 5 | ledger and draft APIs | Task 5 provides the UI surface only; Task 4 owns draft approval and ledger hashing. Compatible. |
| 5 → 6 | `controller.test.mjs` and documentation | Task 6 adds static documentation assertions to the controller test. Compatible. |
| 2 internal | salt ownership in the vault envelope | Ruling: `deriveVaultKey` returns an internal `{ key, salt }` key material object even though the plan abbreviates it as “key”; `encryptJson` receives this material and emits its salt. This preserves a fresh persisted salt without storing a passphrase. Cost if wrong: a later vault migration may need an adapter; it avoids an undecryptable envelope now. |

## Task status

- Task 1: complete (commits 0d33ac8..4f4584e; final corrective pass makes case kind explicit and adds mandate source/action regression coverage)
- Task 2: complete (commits 4f4584e..8a63fe9, review clean after fix round 3)
- Task 3: complete (commits 8a63fe9..1f6b78a, review clean)
- Task 4: complete (commits 1f6b78a..69aa3af, review clean after fix round 2)
- Task 5: complete (commits 69aa3af..decfdc0, review clean after fix round 2)
- Task 6: complete (commits decfdc0..e568e43, review clean after fix round 1)
- Final corrective pass: complete — runtime/security fixes committed as `d05e9a8`; documentation and this SDD record are finalized separately. Tests and builds were not run by explicit task constraint.
