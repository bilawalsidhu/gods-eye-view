# Paraguay public cameras

Four cameras are included in the default CCTV catalog. Custom catalogs retain
the existing `CCTV_SOURCES_FILE` / `CCTV_FORCE_AUSTIN` policy.

| Camera | Operator source | Playback | Disable |
| --- | --- | --- | --- |
| Sambódromo / Costanera, Encarnación | [Municipal live page](https://encarnacion.gov.py/en-vivo/) | Original RTSP.me public player | `CCTV_ENCARNACION_ENABLED=0` |
| Puente de la Amistad / customs, Ciudad del Este | [Atacado Connect](https://atacadoconnect.com/camera-da-ponte-da-amizade-ao-vivo) | Native HLS, one PTZ feed rotating between views | `CCTV_ALTO_PARANA_ENABLED=0` |
| San Lorenzo CAM1, Presidente Franco | [Grupo Ibarra](https://www.gibarra.com.py/) | Native HLS, published 1024×576 variant | `CCTV_ALTO_PARANA_ENABLED=0` |
| San Lorenzo CAM2, Presidente Franco | [Grupo Ibarra](https://www.gibarra.com.py/) | Native HLS, published 1024×576 variant | `CCTV_ALTO_PARANA_ENABLED=0` |

## Provenance and location

The stable HLS entry published by Atacado's player is
`https://video02.logicahost.com.br/brimostech/camatg01.stream/playlist.m3u8`.
Do not replace it with a transient child playlist. Atacado Games is the former
brand; its mirrors and three alternating angles are not additional cameras.

Ibarra's `stream1.m3u8` and `stream2.m3u8` master playlists publish three quality
variants each. This pack selects `v1_1/cam.m3u8` and `v2_1/cam.m3u8` to keep
bandwidth bounded. The same operator also publishes `cam1.jpg` and `cam2.jpg`
with periodic refreshes; these are alternate formats of the same two cameras.
Their roughly 700 KiB media lists contain 48 hours of history. The relay reads
at most 1 MiB and downloads only its existing 12-segment live tail, never the
archive. Atacado's observed HD segments exceed 6 MiB, so the per-segment cap is
12 MiB. The cache remains capped at 24 MiB per session, with at most two sessions.

All locations are **approximate anchors, not verified camera mounts**:

- Encarnación uses the Centro Cívico / Sambódromo venue from the
  [municipal tourism page](https://encarnacion.gov.py/turismo/cicuito-recreacion-y-areas-verdes/).
- Atacado uses the bridge-area anchor from
  [Worldviewstream](https://worldviewstream.com/es/ciudad-del-este-panorama-es/).
- Both Ibarra cameras share the San Lorenzo area anchor in
  [OpenCCTV](https://opencctv.org/cameras/paraguay/alto-parana/presidente-franco/presidente-franco-north-east-312669).
  This does not establish that they share a physical mount, nor which directory
  orientation label belongs to either feed.

No camera pose is supplied as calibrated. Native feeds retain the app's normal
raw pose controls; their generated heading, geometry and monitor placement are
not evidence of real coverage. The panel displays location uncertainty. The
municipal external player has no projection or calibration controls.

## Access and attribution

Operator names, original-page links in Data Credits and watermarks are retained.
These are deliberately published public feeds; no credentials, signed URLs or
video files are bundled. **Public availability is not an open video license.**
The source review on 2026-10-15 found no express republication prohibition on
the reviewed Atacado or Ibarra pages; it did not establish an affirmative license.
Encarnación retains its original provider player and published access controls.

The broader survey is not a list of cameras to enable indiscriminately:

- KDM's RTSP.me players expressly restrict embedding to KDM domains; excluded.
- Skyline's proprietary feed is excluded under its express reuse restrictions.
- Mega Electrónicos has an incomplete video-server TLS chain and WebSocket
  MPEG-1 transport, not a supported HLS feed. Its bridge view did not produce video.
- CATVE liveness and TVC's multi-location YouTube playback were not verified.
- DINAC SGEN cameras are marked INOP. Historical Itá Enramada, San Bernardino,
  Alto Paraná Al Día and Julián Augusto Saldívar references yielded no verified
  current public feed.
- Brazilian border cameras, duplicate mirrors and unattributed IP-camera
  listings are not added as independent Paraguayan cameras.

## Verification

On 2026-10-15, the three new HLS sources returned public manifests and MPEG-TS
segments without cookies or fabricated origin headers. Both Ibarra cameras
decoded advancing video on the original operator page in Firefox; Atacado
decoded through FFmpeg. The existing municipal player also played in Firefox.

The production app was also checked in Firefox on this PC: both Ibarra feeds
played at 1024×576 with advancing decoded frames. Atacado played at 2688×1520
after an initial startup timeout and a fresh session; its availability is not
continuous-uptime evidence. No player or relay recovery feature is added here.

The regression tests cover catalog registration and independent disable switches,
attribution and unverified poses, bounded DVR-tail ingestion, HD segment sizes,
and the panel's uncertainty label. Availability can change; this catalog is not
an exhaustive census or a guarantee of future operator access.
