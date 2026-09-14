# CCTV ground heights

Precomputed ground height under every camera in the served CCTV catalog and
under the nine support points of its monitor plane, so the client can place a
camera and its plane with no runtime sampling. Shared placement data: any
consumer that renders these cameras on the same photorealistic surface can
reuse it.

Source surface: Google Photorealistic 3D Tiles, sampled at maximum detail with
CesiumJS `scene.sampleHeightMostDetailed` from a running God's Eye View
(scripts/precompute-cctv-heights.mjs). Heights are WGS84 **ellipsoidal**
metres; no geoid conversion is needed or applied. This is placement data
derived from the rendered surface, not imagery.

Runtime output: `cctv_ground_heights.json`

```
{
  "schemaVersion": 1,
  "provider": "google-photorealistic-3d",
  "heightReference": "WGS84-ellipsoid",
  "generatedAt": "<ISO>",
  "cameras": {
    "<camera id>": {
      "poseHash": "p1-…",          // hash of the served pose the samples describe
      "status": "ok" | "miss",
      "mountGroundM": <number>,    // ground under the camera position (absent on a miss)
      "supports": {                // ground under the plane's 3×3 support grid; a value is
                                   // null where that point had no sample (absent on a miss)
        "bl","bm","br",            // bottom row (left, middle, right)
        "ml","mc","mr",            // middle row
        "tl","tm","tr"             // top row
      },
      "misses": [<keys with no sample: "mount" and/or support keys>],
      "sampledAt": "<ISO>",
      "attempts": <n>
    }
  }
}
```

Support point positions are defined by `src/data/cctvFootprint.js`
(`planeSupportPoints`), which the client, the server join
(`server/providers/cctv/groundHeights.js`) and the precompute all share. An
entry is used only while the camera's served pose still hashes to
`poseHash`; a camera whose feed moved it, or whose pose a user edited, falls
back to runtime placement from the Re:Earth DEM.

Regenerate (resumable; only cameras whose pose changed or whose entry is
incomplete are re-sampled):

```
GEV_BASE=http://localhost:4173 node scripts/precompute-cctv-heights.mjs
```

Coverage at generation (2026-09-14): 3,445 of 3,446 cameras `ok` (six of them
with one or more null supports), 34,444 sampled heights, 43 minutes on a real
GPU. Regenerate whenever a pack changes its poses or a new pack lands.
