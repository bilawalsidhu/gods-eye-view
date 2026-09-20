# 0010 — GitForge is the primary CI platform

Status: accepted (standing directive; wired 2026-09-15, aegis gate 2026-09-20)

## Context

The operator's GitForge instance (`/nas/Temp/repos/GitForge`) is the
primary CI/CD/Actions platform; GitHub is a backup/sync mirror only (the
GitHub account is billing-blocked, so a red GitHub Actions run is NOT a
code-failure signal — and must never be "fixed" by addressing GitHub
billing).

## Decision

`.gitforce.yml` mirrors `.github/workflows/ci.yml` gate-for-gate and runs
first on every push (repos keep both remotes; push gitforge first, then
origin). Documented structural differences (no matrix → two explicit node
jobs; linear job chain because jobs share one workspace; images pre-built
on the host; no artifact service) live in the `.gitforce.yml` header.

Gates that CANNOT run on GitHub-hosted runners run ONLY in GitForge —
currently the aegis pattern scan (secrets category, high severity,
baseline-filtered via the committed `.aegis-baseline.json`), whose binary
is baked into the self-hosted `gev-ci-node:1` image (bookworm-built from
the local aegis checkout; host-built binaries die on glibc). The ci.yml
header documents the omission rather than faking the gate with a weaker
scanner.

## Consequences

- A green GitHub run proves nothing by itself; the release bar is
  GitForge green on the release commit.
- Pipeline images are rebuilt on the host when their inputs change
  (package-lock.json → gev-ci-node:1; rust/Cargo.lock → gev-ci-rust:1);
  the runner's 60-second sandbox cap makes pull-at-run-time impossible.
- Credentials never live in repo files or CI config: GitForge auth is the
  operator's interactive `gitforge auth --login`.
