# 0011 — A post-hoc Prettier formatter gate is declined

Status: accepted (2026-09-20)

## Context

The sibling best-practices review listed dsc's `prettier --check` gate as
an adopt candidate. dsc adopted a formatter at project inception, where
the cost is zero. This repository is mid-life with ~40k lines of
hand-maintained JavaScript and a different hygiene history: the strict
lint gate (sonarjs + unicorn + eslint-jsdoc, `--max-warnings 0`) already
enforces the SEMANTIC consistency layer, and several regression tests
deliberately read source text (source-anchor tests: shell landmarks,
input accessibility census, JSDoc contract anchors) — they pin real
source strings on purpose.

Measured 2026-09-20: `prettier@3.6.2 --check` reports **505 files**
would be rewritten. Landing that means: a blame-painting commit touching
nearly every source file immediately before a release, plus re-pointing
every source-anchor test the reflow disturbs, plus full re-validation of
the 40-suite browser battery — all to normalize whitespace opinions the
codebase does not actually disagree about.

## Decision

Do not adopt Prettier (or any whole-tree reformatter) post-hoc. Style
consistency remains the job of the lint gate; formatting within a PR
should match the surrounding code.

## Consequences

- If a formatter is ever wanted, adopt it as its own reviewed campaign —
  immediately AFTER a release, never inside one — with the source-anchor
  tests re-pointed in the same change.
- The other four sibling-review adopt candidates are resolved: JSDoc
  coverage tooling (done, then promoted into the merge gate), the e2e
  orchestrator (`scripts/qa-all.mjs`, done), `docs/adr/` (adopted — this
  directory), and the ratcheting coverage floor (adopted — c8 threshold
  flags in the `test:coverage` script).
