# Shared CCTV HLS integration

This reconciles the relay work reviewed on 2026-10-17. The shared implementation
belongs to #1165; source packs stay in their existing PRs. No upstream merge is
implied by the integration branches.

## Ownership and landing order

| PR | Source branch | Changes owned by the PR after prerequisites land |
| --- | --- | --- |
| #1165 | `fix/cctv-hls-recovery` | Shared TS/fMP4 relay, init/media routes, bounded HD downloads, expired-media recovery, live-edge startup, combined regressions and relay documentation. fMP4 is extracted from #1145 without its Misiones catalog. |
| #1145 | `contrib/argentina-misiones-cctv` | Eight opt-in Misiones cameras, coordinate provenance, pack configuration, catalog registration and source tests. Inherits #1165. |
| #1162 | `feat/cctv-youtube-main` | Shared provider-owned external players. Independent of the native HLS relay. |
| #1161 | `feat/paraguay-encarnacion-camera` | Paraguay packs, RTSP.me extension, 1 MiB DVR playlist allowance and DVR regression. Inherits #1165 and #1162; its init cap stays 256 KiB. |
| #1163 | `feat/cctv-argentina-catalog` | Argentina catalog, stable snapshot aliases and restricted image redirect policy. Inherits #1165 and #1162. |

Land #1165 before #1145, #1161 and #1163. Land #1162 before #1161 and #1163.
The three pack branches do not need to inherit one another. The Paraguay-only
playlist allowance may coexist with the other packs when their branches merge.
Use the shared history when merging; copying whole versions of `stream.js`
would discard either fMP4 init ownership or recovery/startup behavior.

Inspected heads before integration:

| PR | Head |
| --- | --- |
| #1145 | `bde7871d392704df80fdb9da5f6cd0abd0e60246` |
| #1165 | `c705213363d339f02618a7e6bcf35b0e49d19aeb` |
| #1161 | `bed0f51f8b7e1357906888353f1e39a6efd470a7` |
| #1163 | `692c82e410701bfaa4254db6565eb7d7561141c5` |
| #1162 | `6487a168a4ffc5dffc432ea5889e453671071e12` |

Upstream baseline: `743ed639e56a037af10385eec01571d966f31205`.

## Reconciliation rules

- A remembered upstream identity is `[media URI, init URI]` for successful
  media, startup omissions and expired 404s. All three paths bound the history.
- Cold sessions and encoder restarts fetch the newest pair with production
  limits. Subsequent polls fetch new entries, not the already omitted tail.
- Only a same-origin media HTTP 404 older than the newest pair is recoverable.
  Init failures, recent 404s, access failures, redirects, changed response URLs,
  TLS failures and body overflows retain retries and shutdown after three failures.
- Init lookup is invalidated on encoder restart and explicit discontinuity.
  Retained media retains its original init object until its last reference is
  evicted. A discontinuity on an expired segment still invalidates the init.
- Each media file is at most 12 MiB, each init at most 256 KiB, and retained
  media plus inits at most 24 MiB per session. There are at most two sessions,
  eight leases each and twelve retained media entries. Temporary streaming
  buffers are separately bounded by the incoming resource caps.
- Two full 12 MiB media files plus an init cannot reach the two-segment
  readiness threshold within 24 MiB. The cache cap takes precedence; no
  special fMP4 allowance silently increases it.
- Encrypted, byte-range, mixed and switching containers remain unsupported.
  Init/media routes require the existing active session and lease; clients
  cannot submit an arbitrary upstream URL.

## Combined regression coverage

`src/data/cctvFmp4Recovery.test.mjs` exercises production-sized 6.5 MiB fMP4
media with a maximum-sized init, unchanged polls, a 404 at a discontinuity,
advancing windows, eviction, sequence rollback and init generations. It also
covers a changed init URI with reused media sequences, both newest 404s,
init 404s, access/redirect/origin/TLS failures, actual streamed byte limits,
the exact 24 MiB boundary, over-budget readiness and container switching.
Mock timers drive multi-poll assertions without sleeps or weakened thresholds.

The existing HLS, fMP4 and route tests are retained; MPEG-TS callers now use the
production `getAsset` contract. The Paraguay DVR test stays in #1161.
Tests use synthetic responses and do not establish live camera availability,
codec support in a browser or reuse permission.
