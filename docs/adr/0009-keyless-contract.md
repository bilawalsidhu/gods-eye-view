# 0009 — Keyless endpoints answer 200 with `unavailable: true`

Status: accepted (2026-09-16)

## Context

When an optional upstream key is not configured (the norm on dev and QA
machines; also any deployment that has not bought an add-on), endpoints
answered HTTP 503. That poisoned every clean-console assertion in the QA
battery: Chrome logs an un-suppressible "Failed to load resource" for
any non-2xx subresource, so the console was never clean and the
assertions either failed spuriously or had to be weakened.

## Decision

A keyless key-bearing endpoint answers **HTTP 200** with its normal
payload shape plus `unavailable: true` (and an `error` reason), e.g.
google-places → `{ places: [], error, unavailable: true }`; the ais-live
chip uses the same convention. The client treats `unavailable: true` as
"layer legitimately off", rendering its disabled state instead of an
error state.

## Consequences

- Clean-console QA assertions are meaningful again: any non-2xx
  subresource in a run is a REAL failure.
- The contract is part of dev/prod parity (ADR 0003): both runtimes
  implement it in the shared policy module, and both are covered by
  unit tests.
- Do not "fix" a 200-with-`unavailable` payload back to an error status;
  the disabled-chip UX and the QA contract both depend on it.
