# Moscow outdoor camera pack

Set `CCTV_SOURCES_FILE=config/cctv_sources.moscow.json` in your local `.env` and restart the server yourself. This optional pack does not change the default catalog. Set `CCTV_FORCE_AUSTIN=1` to retain the built-in live packs as well.

The pack contains 100 distinct outdoor cameras: 97 HLS streams and 3 refreshing JPEG feeds from NIX. The JPEG sources publish still images rather than public video streams; their configured refresh interval is five seconds. Groups contain 87 residential/construction cameras, 8 street/panorama views and 5 outdoor sports views. Labels are short English names, at most 28 characters; RC means residential complex.

## Verification

Public HTTP requests on 10 November 2026 received actual MPEG-TS, fMP4 plus initialization data, or JPEG bytes. Repeated requests confirmed advancing playlists or changing images. A compact record of the active-source checks is in [moscow-verification.json](../config/moscow-verification.json). Research candidates and retired links are excluded from this contribution.

The contributor reports launching the application locally. Automated tests have not been run for this contribution, and a full camera-by-camera browser playback review remains pending. These checks prove media transport at the recorded time, not playback in every browser or continued operator availability. Outdoor views were selected from published descriptions; NIX images were inspected directly. Not every video view has been visually reviewed. Positions and camera directions are approximate. The pack includes New Moscow but does not cover every district evenly.

## Playback and attribution

Cameras use the existing on-map presentation. Clear MPEG-TS/fMP4 HLS uses the bounded local media proxy; JPEG cameras use the existing frame endpoint. Exdesign, anonymous Ivideon and unrestricted RTSP.ME public streams resolve to their current camera-specific media URLs. Deleted, password-protected and domain-restricted players are rejected. There is no separate public iframe player.

The HLS download cap is 16 MiB per segment; retained data remains capped at 24 MiB per session with two simultaneous sessions. No media is cached on disk.

Each camera keeps its publisher link and credit. Public availability is not an open reuse licence; no media files are distributed. See [DATA_SOURCES.md](../DATA_SOURCES.md). Historical research candidates, unavailable players and previously excluded cameras are not part of the active pack.
