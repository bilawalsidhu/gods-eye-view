# Bucharest public webcams

Opt in with both settings in your local `.env`, then restart the server:

```dotenv
CCTV_SOURCES_FILE=config/cctv_sources.bucharest.json
CCTV_FORCE_AUSTIN=1
```

The second setting retains the existing worldwide live camera packs when using
a custom source file. All three cameras use the native HLS session player, with no
publisher poster substituted for live video.

## Visual calibration

These are hand-curated estimates, not surveyed camera extrinsics. Bearings are
clockwise from true north; FOV is horizontal; negative pitch looks down. Mount
height is above the local street. Range sets the native monitor-plane distance,
not the camera's optical limit. Browser-local calibration offsets can override
these defaults; use **RESET CAL** on either camera to return to this catalog pose.

| Camera          | Latitude | Longitude | Heading | HFOV | Pitch | Height | Range |
| --------------- | -------: | --------: | ------: | ---: | ----: | -----: | ----: |
| Piața Romană    | 44.44673 |  26.09743 |    291° |  87° |   −9° |   10 m | 220 m |
| Magazinul Cocor | 44.43206 |  26.10324 |    155° |  29° |   −6° |   22 m | 180 m |

### Piața Romană

The [camera host's contact page](https://www.notar-radufelix.ro/contact) supplies
the building anchor, approximately 44.4467275, 26.0974294. The
[host's webcam page](https://www.notar-radufelix.ro/live-webcam) identifies the view.
In the [publisher's daytime reference frame](https://webcamromania.ro/media/snapshots/01a0267e-d41c-7149-8451-2ac92a15fccb/20261010-1300.jpg),
Casa Nicolae Petrașcu is on the left, Lascăr Catargiu 1 near the center, and
Casa Gheorghe Petrașcu and the ASE dome on the right. Matching their
[mapped positions](https://www.openstreetmap.org/#map=19/44.4470/26.0970) gives
about 291° heading and 87° HFOV (roughly 17-pixel horizontal residual in a
1280-pixel-wide frame). Height and pitch are less certain, approximately ±4 m
and ±3°. The business coordinate is a building anchor, not a measured lens position.

### Magazinul Cocor

The publisher's location pin is on the store being filmed. The
[daytime reference frame](https://webcamromania.ro/media/timelapse/01a0267e-d70e-7421-9420-dc6f743b4899/2026-10-09.jpg)
shows the [Bărăția bell tower](https://www.openstreetmap.org/way/657987570) left
of Cocor's main B screen. The [screen operator specifies B as 11.52 × 23.04 m](https://cocormediachannel.ro/specificatii-tehnice/).
Its angular size and the tower bearing place the camera on the east frontage of
the apartment building northwest of the store, around the joint between
[these](https://www.openstreetmap.org/way/1456746221)
[building footprints](https://www.openstreetmap.org/way/658012761).
The far west screen fin supplies a weaker third horizontal check, within about
0.7°. A ±10 m mount uncertainty changes the fitted heading by roughly ±2° and
HFOV by ±3°. Exact mounting floor and lens settings remain unverified.

The native renderer displays a flat far-cap monitor plane and lifts it to clear
the 3D mesh. These poses align its view direction and angular coverage; scene
geometry and lens distortion limit pixel-level registration.

### Ground alignment

The default ground-height sidecar contains pose-matched Google 3D mesh samples
for these two cameras, in WGS84 ellipsoidal metres. At the mount coordinates the
mesh hits roofs (146.71 m at Romană and 137.59 m at Cocor), so the floor uses the
nearest mapped roadway: Dacia at 44.4468494, 26.0974273 (113.97 m), and Brătianu
at 44.4320769, 26.1033881 (112.01 m). A second nearby road/sidewalk sample measured
115.07 m and 112.22 m respectively. The nine monitor support heights are sampled
at the exact native footprint positions. These are mesh measurements from
2026-10-11 local time; road slope, mesh error and the estimated mount position
still limit vertical accuracy. A pose change invalidates the sidecar hash and
requires new samples.

## Additional source audit

Checked public publisher pages and playback on 2026-10-11 local time:

- [Elitte Inn Skybar](https://webcamromania.ro/webcam-orase/webcam-bucuresti-elitte-inn/),
  Roșu/Chiajna: included. The publisher exposes a direct HLS URL; its media
  sequence and program timestamps advance, and current MPEG-TS segments return
  successfully. The publisher's coordinate is used; facing, FOV, pitch and
  mounting height remain uncalibrated defaults with low heading confidence.
- [Piața Unirii](https://webcamromania.ro/webcam-orase/webcam-fantanile-din-piata-unirii/):
  the public player uses [this live YouTube broadcast](https://www.youtube.com/watch?v=4eVi8X0FJRU),
  also linked by [Skyline](https://www.skylinewebcams.com/en/webcam/romania/muntenia/bucharest/unirii-square.html).
  YouTube reports live playback and allows embedding. This requires a supported
  embedded player; it cannot be used as a native HLS texture URL. The publisher
  snapshot is cached for 20 minutes and is not added as a live-image fallback.
  Skyline's [terms](https://www.skylinewebcams.com/en/terms-of-use.html) restrict
  extracting footage and frames without written authorization.
- [CFR Gara de Nord](https://cfr.ro/gari/camereweb/index.php): a current indoor
  timetable image embedded as base64 in HTML, requiring a source adapter.
- [EasyParking Otopeni](https://easy-parking.ro/camere): four public player
  embeds, but no functioning native feed verified (player requests returned 403).
- [OTP Parking Otopeni](https://www.otp-parking.ro/camere-live): two working
  public IPCamLive cameras. Their HLS addresses rotate, requiring a provider
  resolver rather than static source records. The operator's
  [terms](https://www.otp-parking.ro/termeni-si-conditii) require written agreement
  to reuse site content, so they are not included in this pack.
- Legacy TrafficGuide Unirii and Otopeni DN1 links return HTTP 410. Municipal
  ASB CCTV has no published public feed; its
  [camera notice](https://aspmb.ro/wp-content/uploads/2023/01/comunicat-de-presa-ASB-camere.pdf)
  restricts disclosure to public authorities.

This is a bounded audit of known public sources, not an exhaustive camera inventory.

## Attribution and use

Streams and reference frames are published by [WebcamRomania](https://webcamromania.ro/).
Per-camera credit and publisher page links are retained in the source records.
Reference images are linked, not bundled. Public accessibility is not a
redistribution licence. Publisher terms apply; this pack asserts no redistribution
permission.
