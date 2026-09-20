# 0002 — Cloudflare Pages Functions are canonical (no Workers subproject)

Status: accepted (supersedes the pre-merge `cloudflare-workers/` subproject;
reaffirmed 2026-09-10)

## Context

The pre-merge main line developed serverless endpoints in a separate
`cloudflare-workers/` subproject with its own toolchain and deploy path,
while the merge line implemented the same endpoints as Cloudflare Pages
Functions under `functions/api/**` — same runtime (workerd), same repo,
no second deploy artifact. Running both meant two places for every
keyless endpoint and two things to keep in sync.

## Decision

`functions/api/**` Pages Functions are the canonical production runtime
for every serverless endpoint. The `cloudflare-workers/` subproject is
deleted (its gitignored local residue may remain on machines; revival is
a `git checkout` of any pre-cleanup commit). `wrangler.toml` exists for
the Pages project only.

## Consequences

- One serverless surface: dev uses `vite/proxies/*` middlewares, prod
  uses `functions/api/**` — and their shared logic lives in worker-safe
  policy modules (see ADR 0003), so the "two runtimes" cost is paid once
  per endpoint, in shared code, not twice.
- `docs/PWA_CLOUDFLARE_PLAN.md` is marked SUPERSEDED and kept only as
  history; do not implement from it.
