# Bhote Koshi 2026 event pack

A non-commercial visualization of the 26 August 2026 Bhote Koshi outburst flood.
This is not an official hazard model.

## Provenance and licenses

| File                                                       | Source and modifications                                                                                                                                                                                                | License                                                                                          |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `pre.webp`                                                 | Vantor WorldView-2 scene `10300100C86CED00`, observed 2021-10-16; natural-color crop of 85.295–85.379 E, 28.135–28.292 N, resampled to 2048×4352 and WebP-compressed                                                    | CC BY-NC 4.0                                                                                     |
| `post.webp`                                                | Vantor WorldView-3 scene `B040001100881410`, observed 2026-08-27; same bounds and output geometry, with source clouds retained                                                                                          | CC BY-NC 4.0                                                                                     |
| `event.json`                                               | GeoPera reconstruction, commit `59ee5bd`; every fourth published centerline point inside the image bounds, plus sixteen curated evidence records linking public witness posts and the GeoGeorgeShadrach geolocation map | CC BY-NC 4.0 for the derived centerline; linked posts and map records retain their owners' terms |
| `src/data/bhoteKoshiFloodPath.js` (outside this directory) | Simplified GeoPera centerline from the Debris-Dammed Lake observation to Trishuli Bazaar, compiled into the scene and locator                                                                                           | CC BY-NC 4.0 for the coordinate dataset, separately from the executable code                     |

These third-party assets are **not covered by the application's MIT license**.
Keep attribution and the [CC BY-NC 4.0 license](https://creativecommons.org/licenses/by-nc/4.0/).
For commercial use, obtain separate permission or exclude both this pack and the
derived coordinate dataset in `src/data/bhoteKoshiFloodPath.js` from the source
and build. Deleting this directory alone does not remove the compiled river
data. Excluding the Nepal scene also requires removing its registrations and
imports before building.

Sources:

- [Vantor Open Data Program](https://vantor.com/company/open-data-program)
- [Historical source image](https://vantor-opendata.s3.amazonaws.com/events/Nepal-Flooding-Aug-2026/10300100C86CED00.tif)
- [Post-event source image](https://vantor-opendata.s3.amazonaws.com/events/Nepal-Flooding-Aug-2026/B040001100881410.tif)
- [GeoPera reconstruction](https://github.com/geo-pera/bhotekoshi-2026-reconstruction)
- [GeoGeorgeShadrach public geolocation-map introduction](https://x.com/geogeorgeology/status/2093632283442053371)

Witness clips and cached posters are not bundled. Cards link to the original
source, or use the original platform's embed where available. An unavailable
embed leaves the source link accessible. Capture times remain unverified.

Esri basemap imagery and runtime terrain are fetched separately, not bundled;
their provider attribution remains visible in the application.

The Nepal sequence supports both keyed and keyless map setups. Google 3D is used
for authored 3D shots when available; otherwise those shots use Esri imagery.
Without a Cesium ion token, terrain comes from Re:Earth / Mapterhorn. With an
ion token, the configured Cesium terrain remains available. Vantor comparison
shots use Esri in either mode. Provider resolution does not rewrite saved shots.

## Interpretation limits

The 2021 image is historical context, not an immediate pre-event baseline.
Differences also span development, seasons, sensors, and the July 2025
Rasuwagadhi flood. The amber corridor is a schematic progression along the
published river centerline, not modeled arrival time. Its width and timing
must not be used for emergency planning, exposure analysis, or casualty claims.

Evidence cards identify observations outside the Vantor comparison rectangle.
The Rasuwagadhi witness focus uses the 2021 context image because the 2026
scene does not provide useful coverage at that point. The Timure record groups
five source-map placements, not five independent timing confirmations.
