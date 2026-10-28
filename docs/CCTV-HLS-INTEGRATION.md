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

## v0.3.0 main integration — 2026-10-28

The updated branch contains upstream main
`e608fee7935b21251ca8f601003d7d47c813797d`, including release PR #1439
(`72eb3fdc739991a1286b7f1251de908e9744bb2a`). Both `package.json` and
`package-lock.json` retain upstream version `0.3.0`. The published v0.3.0
changelog is unchanged. Pending #1165 and #1267 fragments remain in
`changelog.d/` for a subsequent release; they must not be presented as features
already shipped in v0.3.0 or assembled again into that release.

The prior #1165 head `c702de826af72bd1d03c50669e01fb29dc6c7131` and current
#1267 head `0f268efb7190d7a8322cff3f255a07267a35ec70` are retained as ancestry.
The latter adds only a main merge to the three original asturksever commits
listed above. No original commit was rewritten or reattributed, and no write
was made to #1267's branch. Conflicts in `docs/CURRENT-STATE.md` preserve both
new main behavior and the peer-owned TS/fMP4/init contract. Upstream's removal
of unused `toFiniteNumber` and unneeded `sameOriginHlsUrl` export are retained.
No relay algorithm, admission check or resource budget was relaxed.

The direct-peer ownership model still shares identity and quotas behind a NAT;
it does not distinguish authenticated users. The 24 MiB limit includes retained
init files and media, not process RSS or separately bounded in-flight buffers.
Only expired media 404s older than the newest pair are recoverable; init errors,
newest-pair errors, oversized responses and origin/redirect failures stay strict.

#1267 remains open and unmerged. Its security changes are included here, but
its independent review/landing remains the recommended prerequisite. The
regional PRs #1145, #1161 and #1163 still depend on this shared relay; this update
does not synchronize or merge those branches. #1161 and #1163 additionally
retain their separate #1162 prerequisite.

### Validation of the updated tree

Linux, Node 24.22.1, locked dependencies installed with `npm ci`.

| Check | Result |
| --- | --- |
| Focused `node --test` selection of all CCTV test files, including admission and route security | 561 passed, zero failures/skips |
| `GEV_REQUIRE_ALLOCATION_GATE=1 taskset -c 0-3 npm test` | Passed: 8,903 ordinary tests plus all 15 serialized allocation probes (8,918 passed total), 2 ordinary skips, zero failures |
| `npm run build` | Passed; Vite reports the existing large-chunk advisory |
| `npm run format:check` | Passed, 1,522 source files |
| `npm run check:boundaries` | Passed |
| `npm run i18n` | Passed; all four non-English catalogs complete |
| `npm run layer-token:check -- --base-ref upstream/main` | Passed; 32 published tokens, no new allocation |
| `npm run changelog:check` | Passed; pending fragments remain pending |
| `npm run doctor -- --json` | Passed |
| `git diff --check` | Passed |
| `node scripts/qa-cctv-v2.mjs --url http://127.0.0.1:4173` | Blocked before assertions; exit 3, Chromium `Target closed` |
| `npm run test:track -- --url http://127.0.0.1:4173` | Blocked before assertions; exit 2, Chromium process-singleton `socket() failed: Operation not permitted` |

Both browser attempts used a reachable local Vite server and the installed
Puppeteer-pinned Chrome 152.0.7977.75. No socket restrictions, assertions or
thresholds were changed. These are not browser passes; live HLS/fMP4 playback,
codec acceptance, native-GPU rendering and hosted CI remain separate gates.
Prior browser evidence does not validate this updated tree. Node 26 and Windows
were not executed locally. The ordinary suite skips the Docker Compose contract
because Compose is absent and the Windows-native DACL check because this is Linux.
