# Argentina public webcam catalog

`config/cctv_sources.argentina.json` is an opt-in catalog of **53 public feeds**
checked on **2026-10-15**: 20 YouTube players, 18 HLS streams and 15 periodically
updated still images. It covers eight provinces and CABA. Some feeds rotate views;
this is a count of feeds, not independently located camera mounts.

This data-only pack is based on `main`, separate from the Encarnación work. The
YouTube entries require the player support in
[PR #1162](https://github.com/bilawalsidhu/gods-eye-view/pull/1162). Merge that
support before enabling the complete pack. This PR does not copy its player code.

## Run locally

After the YouTube support is available, start a fresh server with:

```bash
CCTV_SOURCES_FILE=config/cctv_sources.argentina.json npm run dev
```

Enable CCTV, then select a city and camera in the panel. A configured pack
replaces the default camera packs unless `CCTV_FORCE_AUSTIN=1` is set. Leave that
flag unset for an Argentina-only session. A custom `CCTV_MAX_SOURCES` below 53
truncates this pack. Restart the server after editing the file, or wait for the
normal source-cache refresh.

## Included feeds

| Operator / group                                                   | YouTube |    HLS |  Still images |
| ------------------------------------------------------------------ | ------: | -----: | ------------: |
| Buenos Aires: Argentina News, UADE, Buenos Aires Panorama          |       3 |      0 |             0 |
| Bahía Blanca / Ingeniero White: port, Amigos de White, Club Galván |       4 |      0 |             0 |
| Claromecó, Necochea, Power Pinamar, Daireaux                       |       5 |      0 |             0 |
| Las Grutas and Innovación Cipolletti                               |       3 |      0 |             0 |
| Tierra del Fuego Live: Ushuaia, Río Grande, Tolhuin                |       3 |      0 |             0 |
| Portal 5900 Villa María and SISE Puente General Belgrano           |       2 |      0 |             0 |
| Municipalidad de Neuquén                                           |       0 |      7 |             0 |
| Telpin: Pinamar, Ostende, Cariló                                   |       0 |      9 |             0 |
| Ciudad de Mendoza and Las Leñas                                    |       0 |      2 |             0 |
| Chapelco / La Hoya / Catedral / Cerro Bayo                         |       0 |      0 | 3 / 2 / 5 / 5 |
| **Total**                                                          |  **20** | **18** |        **15** |

Per-feed operator links, credits, location sources and verification dates are in
the configuration. These are deliberately public tourist, weather, traffic and
municipal views. No private camera addresses were scanned.

The eight Misiones feeds and their contributor-reviewed coordinates from
[PR #1145](https://github.com/bilawalsidhu/gods-eye-view/pull/1145) are retained in
the survey, pending a playback path for their HEVC streams. The Mendoza terrace
feed is also survey-only because the current relay repeatedly received 404s for
its oldest segment. The Plaza Independencia feed remains included. No Encarnación
camera or player code is included.

## Verification and location limits

- All 20 YouTube embeds played in headful Firefox: each exposed decoded video
  dimensions and an advancing playback time. Public metadata also reported each
  broadcast live. IDs can change when an operator restarts a broadcast; find a
  replacement on the original operator/channel page.
- All 18 included HLS URLs returned manifests and decoded a frame through FFmpeg.
  All 15 still URLs returned decodable images with current HTTP timestamps. Frames were
  visually inspected. This proves availability at the check, not uptime or
  compatibility with every browser.
- Varitech resort images are published at approximately five-minute intervals,
  not continuous video. This data pack does not change the existing frame-loop
  polling interval. Catedral's Catalina Reynal lens was obscured; Cerro Bayo's
  Telesilla Lagos overlay clock was incorrect, although its image and HTTP
  timestamp updated. Both limitations are recorded.
- Cerro Bayo's public snapshot aliases redirect to image hosts on IPCamLive.
  The catalog pins the final public image URLs observed at verification, and
  retains each `snapshotAliasUrl` for maintenance. Re-resolve that operator link
  if the hosting address changes; the proxy's origin checks remain unchanged.
- Most coordinates are **approximate place or area anchors**, sometimes shared
  by several cameras at a resort, not surveyed camera positions. OSM anchors
  retain their object links; the Chapelco ski-area anchor cites its location
  source. The survey preserves the Misiones contributor review without treating it as
  independently verified GPS or operator data.
- No pose is declared calibrated. Heading, pitch, field of view, mount height and
  range are absent. Existing image/HLS geometry may use application defaults;
  it is not evidence of actual camera coverage. YouTube uses the external-player
  behavior from #1162.

## Wider survey

The [dated survey](data/cctv-argentina-survey-2026-10-15.json) contains a receipt
for every runtime entry and **115 additional findings** with original pages and
dispositions. These are not 115 extra working cameras; some overlap operators or
physical views.

Discovery combined regional/province searches with SkylineWebcams,
Vision-Environnement, Worldcam and publicly visible ArgosAtlas pages, followed by
checks of the original operator or YouTube player. All 52 camera pages found in
Estado del Mar's public index are recorded. Its guest player uses expiring
origin-bound tokens and some views require Premium; only original-page links
are retained. No subscription catalogue or tokens are included.

Other findings include Comodoro and Las Heras IPCamLive players, Veladero
Angelcam players, Roundshot panoramas, Twitch, and province-wide rotating
broadcasts without a single camera location. Skyline's proprietary players,
COTECAL's permission requirement and Sierra de la Ventana's embedding restriction
remain source-only. YouTube players discovered through Skyline are credited to
their actual channels.

Stale images, ended videos, 404s, invalid TLS certificates and unresolved leads
are recorded separately. Old Neuquén endpoints were replaced by the current
municipal host; two published streams still returned 404. La Hoya is in Chubut,
and the Las Heras municipal cameras are in Santa Cruz, correcting misleading
directory classifications.

This is a dated inventory, **not a claim to have found every webcam on the
internet**. No verified operator feed was found for several provinces in this
pass; that does not establish absence. Later additions should include an original
public page, a recent playback/image check, attribution and coordinate certainty.

The survey-only Misiones and Mendoza terrace entries retain their public URLs,
metadata, coordinates and successful FFmpeg checks alongside the app failure.
They are not discarded or counted as enabled feeds.

## Attribution and maintenance

The repository stores metadata and public URLs, not copied media. Video and
images stay with each operator and are fetched at runtime. Public access does
not imply an open media license. The survey-only Mendoza municipal terrace player declares
CC BY 4.0; that claim does not extend to its other camera or other providers.
Keep provider credits and watermarks. OSM-derived location data is © OpenStreetMap
contributors under the [ODbL](https://www.openstreetmap.org/copyright), not the
repository's software license.

The offline integrity test checks unique IDs/media, URL forms, provenance,
location bounds and certainty, verification coverage and separation of inactive
sources. CI does not contact operators. For live revalidation, play the YouTube
iframe, decode a current HLS frame, inspect still-image timestamps and content,
and update the survey when the result changes. HTTP success alone is insufficient.
