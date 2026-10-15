# Argentina public webcam catalog

`config/cctv_sources.argentina.json` is an opt-in catalog of **74 public feeds**
checked on **2026-10-15**: 25 external players (20 YouTube, two Twitch, two Angelcam and one Roundshot),
24 HLS streams and 25 periodically updated still images. It covers eleven
provinces and CABA. Some feeds rotate views;
this is a count of feeds, not independently located camera mounts.

This data-only pack is based on `main`, separate from the Encarnación work. The
external players require the support in
[PR #1162](https://github.com/bilawalsidhu/gods-eye-view/pull/1162). The Mendoza terrace and Tandil streams also require
[PR #1165](https://github.com/bilawalsidhu/gods-eye-view/pull/1165) for expired old
404 segments and a bounded 12 MiB segment allowance. Merge
these support changes before enabling the complete pack. This PR contains no
player or relay implementation.

## Run locally

After the player and HLS support is available, start a fresh server with:

```bash
CCTV_SOURCES_FILE=config/cctv_sources.argentina.json npm run dev
```

Enable CCTV, then select a city and camera in the panel. A configured pack
replaces the default camera packs unless `CCTV_FORCE_AUSTIN=1` is set. Leave that
flag unset for an Argentina-only session. A custom `CCTV_MAX_SOURCES` below 74
truncates this pack. Restart the server after editing the file, or wait for the
normal source-cache refresh.

## Included feeds

| Operator / group                                                   | Players |    HLS |  Still images |
| ------------------------------------------------------------------ | ------: | -----: | ------------: |
| Buenos Aires: Argentina News, UADE, Buenos Aires Panorama          |       3 |      0 |             0 |
| Bahía Blanca / Ingeniero White: port, Amigos de White, Club Galván |       4 |      0 |             0 |
| Claromecó, Necochea, Power Pinamar, Daireaux                       |       5 |      0 |             0 |
| Las Grutas and Innovación Cipolletti                               |       3 |      0 |             0 |
| Tierra del Fuego Live: Ushuaia, Río Grande, Tolhuin                |       3 |      0 |             0 |
| Portal 5900 Villa María and SISE Puente General Belgrano           |       2 |      0 |             0 |
| Municipalidad de Neuquén                                           |       0 |      7 |             0 |
| Telpin: Pinamar, Ostende, Cariló                                   |       0 |      9 |             0 |
| Ciudad de Mendoza and Las Leñas                                    |       0 |      3 |             0 |
| Chapelco / La Hoya / Catedral / Cerro Bayo                         |       0 |      0 | 3 / 2 / 5 / 5 |
| Multimedios: Pringles, Monte Hermoso (two), Sierra railway station | 0 | 4 | 0 |
| Municipalidad de Tandil: Lago del Fuerte | 0 | 1 | 0 |
| Tucumán Turismo / Mar del Plata Webcam (Twitch) | 2 | 0 | 0 |
| Veladero (Angelcam) / Finca La Anita (Roundshot) | 3 | 0 | 0 |
| Comodoro Turismo / Las Heras, Santa Cruz (IPCamLive stills) | 0 | 0 | 4 / 5 |
| The Vines Resort & Spa | 0 | 0 | 1 |
| **Total** | **25** | **24** | **25** |

Per-feed operator links, credits, location sources and verification dates are in
the configuration. These are deliberately public tourist, weather, traffic and
municipal views. No private camera addresses were scanned.

The eight Misiones feeds are handled by
[PR #1145](https://github.com/bilawalsidhu/gods-eye-view/pull/1145); they remain
in the survey as `covered-by-pr` and are intentionally excluded from this pack.
No Encarnación camera or implementation is included.

## Verification and location limits

- All 20 YouTube embeds played in headful Firefox: each exposed decoded video
  dimensions and an advancing playback time. Public metadata also reported each
  broadcast live. IDs can change when an operator restarts a broadcast; find a
  replacement on the original operator/channel page.
- All 24 included HLS URLs returned manifests and decoded a frame through FFmpeg.
  All 25 still URLs returned decodable images with current HTTP timestamps. Frames were
  visually inspected. This proves availability at the check, not uptime or
  compatibility with every browser.
- The two Twitch and two Angelcam players also decoded advancing video. An
  Angelcam connecting animation is not camera playback: four other Veladero
  views remained in that state and are excluded. Finca La Anita rendered a
  current dated Roundshot panorama, which is periodically captured imagery, not
  continuous video. Provider-owned controls and branding remain intact.
- Tandil periodically stops and restarts its playlist. Mendoza advertises some
  expired segments; the relay recovery fix skips old 404s without tolerating
  failures in the newest pair. Neither check is an uptime guarantee.
- Varitech resort images are published at approximately five-minute intervals,
  not continuous video. This data pack does not change the existing frame-loop
  polling interval. Catedral's Catalina Reynal lens was obscured; Cerro Bayo's
  Telesilla Lagos overlay clock was incorrect, although its image and HTTP
  timestamp updated. Both limitations are recorded.
- Cerro Bayo, Comodoro and Las Heras public snapshot aliases redirect to image hosts on IPCamLive.
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

## Wider survey and disposition

The [dated survey](data/cctv-argentina-survey-2026-10-15.json) preserves the
**115 original additional findings**. They were leads, not 115 extra working
cameras. Eighteen findings now supply **21 additions** to the runtime pack;
Pringles' operator page supplies four distinct feeds. The remaining 97 are:

| Disposition | Findings |
| --- | ---: |
| Discarded: express republication restrictions | 61 |
| Discarded: no verified current public feed | 9 |
| Unavailable at verification | 16 |
| Stale images | 2 |
| Rotating broadcast without one camera location | 1 |
| Misiones, covered by #1145 | 8 |

The original **11 inaccessible sources** were rechecked: two Neuquén manifests
still returned 404, three YouTube broadcasts had ended, one YouTube channel was
offline, and five AGP camera pages failed TLS certificate-chain validation. None
of these eleven checks established a permission denial. AGP's server omits its
Sectigo intermediate certificate. After independently validating that intermediate
against system roots, all five public pages returned 200 without authentication:
they advertise 14 manifests, of which 12 returned LL-HLS/fMP4 playlists. One San
Lorenzo connection closed and not all its manifests were checked. Normal Firefox
still rejects the incomplete chain; fMP4 is also outside the current relay's
MPEG-TS contract. These are technically blocked feeds, not proof of dead cameras;
no actual AGP camera playback is claimed and no insecure TLS bypass is used. The 16 unavailable
findings also include one offline Comodoro IPCamLive camera and four Veladero
players that never progressed beyond their connecting animation.

Of the **12 originally unresolved leads**, three were resolved: Pringles
(four HLS feeds), Tucumán Plaza Independencia (Twitch), and Tandil (HLS).
The other nine were discarded because a current usable public feed could not
be verified. Reasons are retained individually, including Catamarca's HTTP 403
(its cause is not established), an invalid Club Náutico TLS chain, Cotesma's
former webcam host now serving SpeedTest, retired pages, and general TV/network
announcements that do not provide individual public camera feeds. These are
search/check outcomes, not proof that no private or future feed exists.

Explicit republication restrictions exclude all 52 Estado del Mar findings
([operator terms](https://estadodelmar.com.ar/terminos-y-condiciones/)), five
Skyline proprietary streams ([FAQ](https://www.skylinewebcams.com/en/support/faq.html)),
two COTECAL views ([permission requirement](https://www.cotecal.com.ar/disclaimer-link-camaras-en-vivo-parques-nacionales)),
the restricted [Sierra de la Ventana widget](https://sierrasdelaventana.tur.ar/camara-en-vivo-sierra-de-la-ventana/),
and Colón's MyEarthCam player ([terms, section 7B](https://www.earthcam.com/myearthcam/tos.php)).
Colón's player works; it is excluded for its terms, not availability. The included
Multimedios Sierra railway-station view is a separate operator/feed.
Independently published YouTube channels discovered through Skyline are credited
to their actual channels. Excluded source pages remain only as audit evidence.

Discovery combined regional/province searches with SkylineWebcams,
Vision-Environnement, Worldcam and publicly visible ArgosAtlas pages, followed
by original-operator checks. No subscription catalogue, authentication bypass,
private camera scanning, expiring media URLs or tokens are included.

This is a dated inventory, **not a claim to have found every webcam on the
internet**. No verified operator feed was found for several provinces in this
pass; that does not establish absence. Later additions need an original public
page, a recent playback/image check, attribution and coordinate certainty.

## Attribution and maintenance

The repository stores metadata and public URLs, not copied media. Video and
images stay with each operator and are fetched at runtime. Public access does
not imply an open media license. The Mendoza municipal terrace player declares
CC BY 4.0; that claim does not extend to its other camera or other providers.
Keep provider credits and watermarks. OSM-derived location data is © OpenStreetMap
contributors under the [ODbL](https://www.openstreetmap.org/copyright), not the
repository's software license.

The offline integrity test checks unique IDs/media, URL forms, provenance,
location bounds and certainty, verification coverage and separation of inactive
sources. CI does not contact operators. For live revalidation, play each provider iframe (checking the panorama capture
date for Roundshot), decode a current HLS frame, inspect still-image timestamps and content,
and update the survey when the result changes. HTTP success alone is insufficient.
