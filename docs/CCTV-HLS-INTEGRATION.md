# Shared CCTV HLS integration

This reconciles the relay work reviewed on 2026-10-17 and the session admission
work integrated on 2026-10-20. The shared implementation belongs to #1165; source packs stay in their existing PRs. No upstream merge is
implied by the integration branches.

## Ownership and landing order

| PR | Source branch | Changes owned by the PR after prerequisites land |
| --- | --- | --- |
| #1267 | `codex/fix-cctv-session-admission` | Same-site admission before catalog I/O, socket-owned leases, eight leases per peer across both shared sessions. Original commits by asturksever are retained. |
| #1165 | `fix/cctv-hls-recovery` | Shared TS/fMP4 relay, init/media routes, bounded HD downloads, expired-media recovery, live-edge startup, combined regressions and relay documentation. fMP4 is extracted from #1145 without its Misiones catalog. |
| #1145 | `contrib/argentina-misiones-cctv` | Eight opt-in Misiones cameras, coordinate provenance, pack configuration, catalog registration and source tests. Inherits #1165. |
| #1162 | `feat/cctv-youtube-main` | Shared provider-owned external players. Independent of the native HLS relay. |
| #1161 | `feat/paraguay-encarnacion-camera` | Paraguay packs, RTSP.me extension, 1 MiB DVR playlist allowance and DVR regression. Inherits #1165 and #1162; its init cap stays 256 KiB. |
| #1163 | `feat/cctv-argentina-catalog` | Argentina catalog, stable snapshot aliases and restricted image redirect policy. Inherits #1165 and #1162. |

Recommended order: land the security fix #1267 first, then this combined #1165,
then #1145, #1161 and #1163. #1267 is still an open draft at inspection time;
this integration explicitly merges its head and does not assume it is in main.
Land #1162 before #1161 and #1163.
The three pack branches do not need to inherit one another. The Paraguay-only
playlist allowance may coexist with the other packs when their branches merge.
Use the shared history when merging; copying whole versions of `stream.js`
would discard either fMP4 init ownership or recovery/startup behavior.

Historical heads before the 2026-10-17 relay integration:

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
  eight leases each, eight leases per direct socket peer across both sessions,
  and twelve retained media entries. Temporary streaming buffers are separately
  bounded by the incoming resource caps.
- Two full 12 MiB media files plus an init cannot reach the two-segment
  readiness threshold within 24 MiB. The cache cap takes precedence; no
  special fMP4 allowance silently increases it.
- Encrypted, byte-range, mixed and switching containers remain unsupported.
  Init/media routes require the existing active session, lease and owning socket
  peer; clients cannot submit an arbitrary upstream URL.

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

## Security integration inspected on 2026-10-20

- Upstream main: `713285b554bbc99c8ae0261fe307beb3cbeb2adf`.
- #1165 input: `1d0b6cff7b13e7e12e197399ff48b4fb32031ce4`.
- #1267 input: `5e9c14db83b26242ce8052f96a5ffeae979349ce`.
- All three #1267 commits are retained with their original authors and SHAs:
  `167aa947ce338d90af77eb22af04d08be25eea47`,
  `a7160c62be9794875ecdd757b0f3b8141fd37dd4`,
  `5e9c14db83b26242ce8052f96a5ffeae979349ce`.

Main is merged into #1165 first; then #1267 is merged without squashing or
cherry-picking away its authorship. Its `getSegment` ownership check is adapted
to #1165's `getAsset`, covering local TS, MP4 media and MP4 initialization files
(upstream media may use `.m4s`). All other admission logic is retained, including
checking capacity before reserving a new session. Neither upstream PR is merged
by publishing this branch. The #1267 author branch and regional branches are
not changed by this integration.

`src/data/cctvHlsAdmission.test.mjs` uses the production limits to fill both
24 MiB caches and all sixteen session leases, with eight leases per peer across
the two cameras. It exercises concurrent admission, ninth-lease rejection before
upstream I/O, per-session capacity, reclaimed budgets, stale session tokens,
foreign reads/renewals/releases that cannot extend expiry, last-owner cancellation
of pending init/media downloads, and strict 404 cleanup without stopping another
camera. The multi-poll HD recovery test now shares the session between two peers
and checks init ownership through discontinuities, eviction and encoder restart.

Route regressions cover cross-site denial before catalog work, copied TS/MP4/init
URLs, forwarding-header spoof attempts, IPv4-mapped IPv6 normalization, native
same-origin/range request shapes, two-peer sharing and release, disconnect during
init acquisition and server shutdown. Refusals preserve the existing route status
contract: admission 403, unavailable foreign lease renewal 503, asset 404, and
idempotent DELETE 204. A forwarded header is refused rather than trusted as an
identity. Peers behind a shared NAT have one quota; leases are resource ownership,
not user authentication. Retained cache caps do not claim a bound on process RSS
or the separately capped in-flight download buffers.

### Validation and remaining browser gate

On Linux / Node 24.19.0, the focused CCTV/player/same-site selection passed
487/487 tests, including 46 relay/fMP4/media-route cases. A temporary removal of
the asset ownership check makes the foreign-init regression fail; the tested
source is unchanged (the mutation ran in a temporary copy). Full `npm test`
exited 0 with `GEV_REQUIRE_ALLOCATION_GATE=1`, including both serialized
allocation probes. The process used four-CPU affinity to bound ordinary test
parallelism; no test files, assertions or thresholds were removed.
The production build, formatting, package
boundaries, i18n, changelog, published layer-token check and setup doctor pass.

Both browser gates were attempted against a running local dev server. Tracking
exited 2 before its assertions because Chromium's process-singleton socket was
refused by the environment (`Operation not permitted`); CCTV v2 exited 3 during
browser startup (`Target closed`). Neither is a browser pass. No socket policy,
assertion or threshold was weakened. Live playback/codec acceptance on this
combined tree remains unverified; previous PR browser evidence belongs to its
original tree.

## Argentina shared-control integration — 2026-10-21

The #1163 branch merges upstream main
`275513bf2c5a84c379dbed3d57422c6d2a7c5b3a`, including #1306's status badges and
#1309's shared-field CSS ownership. The existing #1162 head
`896bf69d673bac88cb28cc0d7e4aa67328fb6972` and #1165 head
`48b67a794223b460b045d951fd1ef889950b62af` remain ancestors; their landing order
is unchanged. Publishing this branch does not merge any upstream PR.

The only textual conflict was in `scripts/package-boundaries.json`: the CCTV
and composition exports retain both the external-player dependencies and the
new status-badge adapter. CCTV templates use main's shared buttons, select and
badge classes; numeric calibration fields retain the shared field factory and
CCTV-owned 58px width. External players retain their iframe lifecycle and
projection/calibration exclusions. Their source and location labels now use
`updateStatusBadge` directly, without first painting a native calibration label
or rewriting the source live region on identical updates.

The 64-entry catalog (25 external players, 24 HLS streams, 15 images), its 14
IPCamLive aliases, image redirect policy and external-player implementation
are unchanged from the previous #1163 head. `server/providers/cctv/stream.js`
is byte-identical to #1165; the route file retains #1162's player metadata and
native-proxy exclusions alongside #1165's media admission checks. This keeps
the peer lease limits, same-site media gate, recovery behavior and 24 MiB
retained-cache budget intact.

Regression coverage in `src/ui/cctvBadges.test.mjs` now covers English, Spanish
and Russian player labels, native/player/idle transitions, stale native-frame
flags, approximate-location semantics, visibility and zero repeated text writes.
Browser acceptance on this integration tree remains unverified: Chrome
152.0.7977.75 is absent from the executor and its download failed through the
network proxy. The status-badge, form-field, CCTV v2 and tracking gates cannot
reach their assertions without that browser. Earlier browser results do not
validate this new tree. No live camera availability check was repeated.
