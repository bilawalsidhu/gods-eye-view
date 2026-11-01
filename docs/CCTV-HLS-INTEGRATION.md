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
not identities. A lease identifies a decoder's demand and lifetime, not a person
or an IP owner. A party that learns the active tokens can use them; the same-site
gate does not authenticate non-browser clients. One consumer can fill both global
sessions or all eight leases, so these bounds provide no session fairness or
per-user quota. Binding leases to direct socket IPs would group reverse-proxy/NAT
users and break requests whose proxy connection changes without solving that
starvation scenario. IP ownership and per-peer quotas are outside this relay PR.
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

## Reverification against current main — 2026-10-31

Reconciled with upstream main `b4c75749e880a45ffb76056e818cb3f53de64933`.
The previously published independent relay commit `d11e3693` already removed
strict media admission and peer ownership; the PR description was stale.
The incremental route regression now also checks catalog file probes/reads and
spoofed forwarding-host or chained-protocol headers, including OPTIONS requests.
The same-site gate implementation remains identical to main.

On Linux / Node 24.22.1 with locked dependencies (`npm ci --ignore-scripts`):

- The complete required `GEV_REQUIRE_ALLOCATION_GATE=1 npm test` plan passed:
  9,133 ordinary tests plus all 15 serialized allocation probes, zero failures;
  two platform skips (Docker Compose unavailable and Windows-only DACL checks).
- The focused HLS/fMP4/admission/media selection passed 50 tests.
- Production build, formatting (1,525 files), package boundaries, all ten locale
  catalogs, changelog check and token ledger against upstream/main passed.
- Runtime relay recovery and memory limits are unchanged by this reconciliation.
  Original asturksever commits remain ancestors; #1267 itself is untouched.

Regional reconciliation retains Misiones opt-in/provenance, Paraguay's separate
1 MiB DVR playlist limit and RTSP.me support, and Argentina's snapshot aliases,
external/no-public-feed handling and visible-camera integration from #1485.
The regional branches must inherit this independent relay, not restore the old
strict gate, socket-owner arguments, per-peer quota or #1267 release fragment.
#1162 remains the independent public-player prerequisite for Paraguay/Argentina.
No duplicate pull request is needed. Browser playback, live operator availability
and hosted CI were not verified in this run.

After the full run, upstream added #1493 (only the deterministic localhost
FIRMS test fixture). It was merged through main `3824a47d`; all 16 FIRMS tests
passed on that final tree. No CCTV runtime or memory-budget code changed.
