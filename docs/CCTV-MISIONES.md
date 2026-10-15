# Cámaras de Misiones integration candidate

An opt-in source pack for the eight public camera paths on
[camarasdemisiones.com](https://camarasdemisiones.com/). The public catalog mixes
cameras, television, radio and external players, and contains no geographic
fields. This integration accepts only `cam01` through `cam08` on the pinned
HTTPS stream origin.

**No installation position is confirmed in the contributed evidence.** The
pack is off by default and registers no cameras until an operator supplies
verified installation coordinates. The research JSON is not a runtime catalog;
using it as the location configuration still registers zero cameras and makes
no Misiones network request.

## Geographic evidence

The [contributor report](data/cctv-misiones-2026-10-14.json) is preserved in its
original Spanish, including uncertainty, source links, timestamps and attribution.
It reports inspection of eight live frames and eight covers on 2026-10-14,
21:36:23–21:36:49 in `America/Argentina/Cordoba`, with OSM maps, Esri satellite
imagery and official ATM references. It does not include operator GPS data.

| Camera | Published place | Coordinate meaning |
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

OSM-derived research coordinates retain **© OpenStreetMap contributors,
[ODbL 1.0](https://www.openstreetmap.org/copyright)**. That attribution and
license apply to the OSM-derived data; the repository's code license does not
replace them. No stream recordings, covers or satellite imagery are bundled.

## Configuration

1. Establish the actual installation position for each camera you intend to
   enable, documenting the source of that verification. A nearby landmark or a
   plausible OSM camera node is insufficient.
2. Copy `config/cctv_misiones_locations.example.json` to a local configuration.
   Leave unresolved cameras at `verified_camera_position: null`.
3. For a confirmed camera, replace that null with an object containing numeric
   `latitude`, numeric `longitude`, `crs: "WGS84"`, and a nonempty
   `verification_source` describing the installation evidence. The source
   validates these assertions; it cannot independently verify an installation.
4. After checking the provider's current reuse conditions for your intended
   deployment, set the two environment variables below and restart the server.

```dotenv
CCTV_MISIONES_ENABLED=1
CCTV_MISIONES_LOCATIONS_FILE=/absolute/path/to/verified-misiones-locations.json
```

The document has a `cameras` array; each item uses `camera_id: "cam01"` through
`"cam08"`. No invented numeric example is supplied as a camera location. Numeric
strings, missing provenance, non-WGS84 coordinates, positions outside a broad
Misiones sanity envelope and duplicate identities are rejected. Relative paths
resolve against the application's source root. Files are limited to 64 KiB.

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
  error 1010. The actual Node fetch client still needs validation. This pack
  keeps the relay's honest user agent and does not spoof cookies or Referer.

Public reachability is not redistribution authorization. Reuse permission,
official API support, use limits and continuity have not been established.
Revalidate access, current terms, Node client behavior and HEVC playback before
using the pack. A proxy changes the browser transport path; it supplies neither
provider permission nor codec support.

## Validation status and commands

This contribution is a draft. The cloud environment remained pending/offline;
Node tests, formatting, the build, browser gates and live playback have not run.
The PR description records the limited isolated-JavaScript checks separately.
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

Before marking ready, run the repository gates and verify actual upstream
responses with the application's Node client, HEVC playback on intended browsers,
lease cleanup and stream stability. Confirm installation evidence before enabling
any map point, and keep unresolved entries out of camera geometry.
