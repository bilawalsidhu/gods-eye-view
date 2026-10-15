# Cámaras de Misiones integration candidate

An opt-in source pack for the eight public camera paths on
[camarasdemisiones.com](https://camarasdemisiones.com/). The public catalog mixes
cameras, television, radio and external players, and contains no geographic
fields. This integration accepts only `cam01` through `cam08` on the pinned
HTTPS stream origin.

The pack ships eight installation coordinates finalized by the contributor on
2026-10-15 at 02:26:04.444Z. Enable it with `CCTV_MISIONES_ENABLED=1`; no location
file override is needed. It stays off by default because provider reuse
authorization has not been established and HEVC playback depends on the browser/device.

## Location data and provenance

The [default location file](../config/cctv_misiones_locations.json) preserves the
contributor's WGS84 values, camera identities, stream URLs, individual confirmation
timestamps and finalization metadata. Its stated verification scope is
`physical_camera_location`, its source is `user_review`, and its method is review
of screenshots and OSM maps, accepted by the contributor as definitive for this
project. These are project-reviewed positions; no operator GPS survey or separate
independent verification is claimed. The supplied decimal values are preserved
without implying measured positional accuracy. The OSM attribution also travels
with each camera's displayed credit.

The final review is the runtime position source. The earlier preliminary report
below remains historical evidence, and is not automatically promoted into camera
positions. Selecting that older file as an override still yields zero cameras.

### Preliminary research, 2026-10-14

The [contributor report](data/cctv-misiones-2026-10-14.json) is preserved in its
original Spanish, including uncertainty, source links, timestamps and attribution.
It reports inspection of eight live frames and eight covers on 2026-10-14,
21:36:23–21:36:49 in `America/Argentina/Cordoba`, with OSM maps, Esri satellite
imagery and official ATM references. It does not include operator GPS data.

| Camera | Published place | Meaning in the preliminary report |
| --- | --- | --- |
| cam01 | Parque La Cantera / Puente, Posadas | Park reference |
| cam02 | El Arco, RN 12 km 1326 | Checkpoint reference |
| cam03 | Centinela, RN 14 km 785, San José | Checkpoint reference |
| cam04 | Costanera / Pedernera | Unconfirmed association with an OSM camera node |
| cam05 | El Brete, Posadas | Beach reference |
| cam06 | Coastal roundabout / international bridge | Unconfirmed association with an OSM camera node |
| cam07 | Zaimán / Puente | Unresolved; no coordinate |
| cam08 | Monumento Andrés Guacurarí, Posadas | Observed landmark, not the camera viewpoint |

`reference_point` and `candidate_camera_position` are never read as installation
positions by the source loader. Decimal places are not measured camera accuracy.
The `evidencia/...` paths in the report are contributor-local references: those
image files were not supplied with this contribution, are not bundled, and were
not independently inspected for this PR. The report's visual and cartographic
assessments remain contributor evidence, not operator confirmation.

OSM-derived coordinates retain **© OpenStreetMap contributors,
[ODbL 1.0](https://www.openstreetmap.org/copyright)**. That attribution and
license apply to the OSM-derived data; the repository's code license does not
replace them. No stream recordings, covers or satellite imagery are bundled.

## Configuration

Enable the bundled eight-camera location catalog and restart the server:

```dotenv
CCTV_MISIONES_ENABLED=1
```

The default is `config/cctv_misiones_locations.json`, resolved from the
application's source root. An optional `CCTV_MISIONES_LOCATIONS_FILE` replaces
that document for installations maintaining their own positions. Invalid or
missing overrides do not silently fall back to the bundled data.

The bundled schema records `coordinate_system: "WGS84"`, `status: "definitive"`,
`requires_further_review: false`, a finalization date, and the contributor's
physical-location review source/method. Each camera has `camera_id`, numeric
`latitude`/`longitude`, `certainty: "definitive"` and `confirmed_at`. Incomplete
reviews are rejected. This validation checks the recorded assertions; it does
not independently establish their real-world accuracy.

The original per-camera override format also remains available: copy
`config/cctv_misiones_locations.example.json`, then replace each confirmed
`verified_camera_position: null` with numeric `latitude`, numeric `longitude`,
`crs: "WGS84"` and a nonempty `verification_source`. Leave unresolved cameras
null. Neither format falls back to `reference_point` or
`candidate_camera_position`. Numeric strings, missing provenance, positions
outside a broad Misiones sanity envelope and duplicate identities are rejected.
Files are limited to 64 KiB.

Acquisition uses the existing live-pack catalog gate and cache. A configured
`CCTV_SOURCES_FILE` or `CCTV_SOURCES_JSON` normally replaces live packs; the
existing `CCTV_FORCE_AUSTIN=1` setting forces all enabled live packs in that case.
The loader requests the catalog only after opt-in and at least one valid position,
using a 15-second timeout, a 256 KiB response cap and no redirects. Unknown
status values do not establish stream health; explicit offline records are
skipped. URLs are synthesized from the eight reviewed paths, and covers are
ignored. Facing and projection dimensions remain the existing low-confidence
priors, not measured pose; no `curated` calibration badge is set.

## Transport

The existing Node HLS relay now accepts clear whole-file fragmented MP4 with
`EXT-X-MAP`. It fetches the master/variant playlist, initialization file and
media segments, and serves local session-and-lease-scoped routes. Init and
segment references must remain on the registered origin. Redirects, encryption,
byte ranges and mixed MPEG-TS/fMP4 containers are rejected.

Each init file is capped at 256 KiB, each segment at 4 MiB, and each playlist at
256 KiB. Shared init bytes count toward the same 24 MiB per-session cache as the
12 retained segments. Unreferenced init files are evicted, and encoder restarts
or discontinuities refetch reused init URLs. Two sessions and eight leases per
session remain the limits; idle leases expire after 15 seconds. Nothing is
written to disk, and no subprocess or transcoder is introduced.

Local media routes resolve cached assets only; clients cannot supply an upstream
URL. MP4 assets use `video/mp4`; existing MPEG-TS routes keep `video/mp2t`.
HEVC decoding still depends on the browser/device. A working relay does not
prove playback compatibility. The existing player reports fatal playback failure
and uses its labeled fallback; this source does not supply a live snapshot URL.

## Contributor-reported access verification

The following observations were supplied by the contributor, from 2026-10-14
at approximately 21:12 Argentina time (UTC−03). They were not independently
reproduced in the PR development environment:

- The public JSON catalog at `https://feeder.camarasdemisiones.com/streams`
  returned `status`, `url`, `title`, `cover`, `order`, and CORS `*`.
- All eight `https://stream.camarasdemisiones.com/cam0N/index.m3u8` master
  playlists returned HTTP 200 to curl without cookies, authentication, Origin
  or Referer. They advertised HEVC `hvc1.1.6.L90.b0` and a
  `video1_stream.m3u8` variant.
- FFprobe confirmed HEVC at 704×480 for cam02, and FFmpeg decoded a contemporary
  frame. Its variant contained an MP4 initialization file and roughly five-second
  MP4 media segments, with no `EXT-X-KEY`. Other cameras were not decoder-tested
  in that access check. No token or signature was observed in the URLs.
- Video responses allowed only `https://camarasdemisiones.com` in CORS, with
  credentials enabled, even when requested with another Origin/Referer.
  Cross-origin HLS.js is therefore expected to be blocked; no real browser test
  was performed. The main page sent `X-Frame-Options: SAMEORIGIN`.
- curl, FFprobe and FFmpeg worked; Python urllib received Cloudflare HTTP 403,
  error 1010. The actual Node fetch client was subsequently validated on 2026-10-15 (see below). This pack
  keeps the relay's honest user agent and does not spoof cookies or Referer.

Public reachability is not redistribution authorization. Reuse permission,
official API support, use limits and continuity have not been established.
Revalidate access, current terms, Node client behavior and HEVC playback before
using the pack. A proxy changes the browser transport path; it supplies neither
provider permission nor codec support.

## Validation status and commands

Local validation on 2026-10-15 uses Node 24.22.0 on Linux. The full suite passed
6,723 tests, including both allocation gates, with one Windows-only native DACL
test skipped. The focused HLS/fMP4/source/middleware suite passed 31 tests.
Build, formatting, package boundaries and published-token checks passed.
The HLS eviction fixtures now admit all three candidate segments before asserting
eviction by the byte budget, instead of truncating one during playlist parsing.
Synthetic test media verifies transport bookkeeping only, not video decoding.

```bash
node --test src/data/cctvHlsStream.test.mjs src/data/cctvFmp4.test.mjs src/data/cctvFmp4Routes.test.mjs src/data/cctvMisiones.test.mjs
npm run format
npm run format:check
npm run check:boundaries
npm test
npm run build
# With the dev server running:
npm run test:track
node scripts/qa-cctv-v2.mjs --url http://localhost:4173
```

The application's real Node client loaded all eight reviewed locations and
read master playlists, media playlists, initialization files and media segments
for seven cameras. cam05 timed out; reachability is a point-in-time observation,
not a guarantee that every feed remains online.

The eight positions already have the supplied project review; future location
changes should retain their own provenance.

### Local playback evidence, 2026-10-15

Firefox 157 on this Linux desktop played cam02 through the application relay
for 122 seconds of wall time: media time advanced by 127.5 seconds and 3,823
additional frames decoded at 704×480. Both the map projection and panel video
were visually inspected. Disabling CCTV released the consumer lease; a formerly
valid cached initialization URL then returned 404. There were no uncaught page
errors. This is a short live smoke test, not long-term availability evidence.

Chrome's native AMD/ANGLE path on this PC lost rendering when starting HEVC.
Disabling accelerated video decoding preserved the map but did not produce
playable HEVC. Firefox worked with its default decoder settings. Browser and
driver compatibility therefore remains a deployment constraint; the pack stays
opt-in. No browser preferences or system codec configuration were changed.

The general `qa-cctv-v2` gate was run headful with `CCTV_MAX_SOURCES=64`: 52
checks passed and one failed because the keyless scene supplied no 3D mesh
ground samples. The gate is not reported as green; its real-mesh assertion
requires a configured 3D tile source. No CCTV ground/rendering code changed.
