# Shared CCTV HLS integration

## Independent relay scope — 2026-10-29

#1165 builds directly on upstream main's CCTV admission contract. It does not
require #1267 to merge. All CCTV routes retain `admitSameSiteKeyless` before
catalog or upstream work. Forwarded same-origin requests are supported; foreign
or opaque Origin and cross-site Fetch Metadata remain refused. The key-bearing
Street View fallback keeps its separate forwarding-header refusal.

The unmerged socket-owned leases and per-peer quotas from #1267 are removed.
Sessions retain main's capability model: active session and consumer lease
are required for media/init reads, eight leases per session, two global sessions,
15-second idle expiry and last-consumer cancellation. Forwarding headers are
not identities. This does not claim user authentication or session fairness.
Original #1267 commits remain in history for authorship; their independent
branch is unchanged and its release fragment is not shipped by #1165.

## Ownership and landing order

| PR | Remaining contribution | Prerequisites |
| --- | --- | --- |
| #1165 | TS/fMP4 relay, init routes, bounded HD recovery, live-edge startup | Current main; no #1267 dependency |
| #1145 | Eight opt-in Misiones cameras and provenance | #1165 |
| #1162 | Shared provider-owned external players | Current main, independent of #1165/#1267 |
| #1161 | Paraguay packs, RTSP.me, 1 MiB DVR playlist allowance | #1165 and #1162 |
| #1163 | Argentina catalog, snapshot aliases and image redirect policy | #1165 and #1162 |

Land #1165 and #1162 independently, then #1145, #1161 and #1163 as their
prerequisites become available. Regional branches do not need to inherit each
other. Use shared history; replacing entire relay files can discard fMP4 or
recovery behavior. Merge into upstream main remains a maintainer decision.

## Relay invariants and existing evidence

- Media downloads are capped at 12 MiB, init files at 256 KiB, and retained media
  plus init files at 24 MiB per session; in-flight buffers are separately bounded.
- Cold starts/restarts fetch the newest pair, not a full DVR window.
- Only media 404s older than that pair may be skipped, once. Newest-pair, init,
  access, redirect, origin, TLS and oversize failures retain strict cleanup.
- Composite media/init identities survive sliding windows and encoder restarts.
  Retained segments retain their original initialization until eviction.
- Two full-size media files plus an init do not fit the cache; the cap wins over
  readiness. Large HD segments may leave a short two/three-segment playlist.
- Encrypted, byte-range, mixed and switching containers remain unsupported.

Existing multi-poll, HD byte-limit and initialization-generation tests are
retained. Lifecycle coverage retains concurrent admission, full session/lease
budgets, stale tokens, invalid/released leases, expiry, disconnect cancellation,
late bytes and cleanup without stopping another camera. Route regressions cover
proxy playlist/TS/fMP4/init requests, proxy lease release and cross-site denial
before catalog work. Removed assertions belonged only to the discarded per-IP
model; session/lease capability denials remain tested.

Earlier published evidence includes the independent Windows multi-poll checks,
FFmpeg decoder checks, and the 2026-10-28 Node 24.22.1 run (561 focused tests;
8,918 full-suite passes including allocation probes). Those results belong to
their original trees. They are not a browser or CI pass on this changed tree.
Current validation is recorded with the published branch update.

Pending #1165 release notes remain in changelog.d; they are not added to the
already published v0.3.0 CHANGELOG. Live operator availability, browser codec/GPU
acceptance and hosted CI are distinct from mocked relay tests.

## Validation of the independent branches — 2026-10-29

Linux / Node 24.22.1, shared locked dependencies installed with npm ci.
The complete #1165 npm test plan, including required serialized allocation
probes, exited 0. Focused selections passed: relay CCTV 447; external players
447; Misiones 469; Paraguay 540; Argentina 542. Build, formatting, package
boundaries, i18n, changelog and published layer-token checks passed.
Weather #1154 separately passed 68 regional/UI/source tests and the same
repository checks, with all ten non-English catalogs complete.

The final registration-order changes only move unchanged manifest entries to
avoid inter-PR conflicts. A local merge-tree rehearsal in the order #1154,
#1165, #1162, #1145, #1161, #1163 is conflict-free against main f13c60c4.
This rehearsal is not an additional full-suite or browser pass on the combined
tree. Chromium startup is blocked by the environment's process-singleton socket
restriction (Operation not permitted); no browser assertion or socket policy
was weakened. Live operator playback and hosted CI remain unverified.
