# CCTV ground heights

Precomputed ground height under every camera in the served CCTV catalog and
under the nine support points of its monitor plane, aligned to work with
Google Photorealistic 3D Tiles. Heights are WGS84 ellipsoidal metres. The
client places a camera and its plane from this file with no runtime sampling.

Runtime output: `cctv_ground_heights.json`

```
{
  "schemaVersion": 1,
  "provider": "google-3d-tiles",
  "heightReference": "WGS84-ellipsoid",
  "generatedAt": "<ISO>",
  "cameras": {
    "<camera id>": {
      "poseHash": "p1-…",          // hash of the served pose the entry describes
      "status": "ok" | "miss",
      "mountGroundM": <number>,    // ground under the camera position (absent on a miss)
      "supports": {                // ground under the plane's 3×3 support grid; null where
        "bl","bm","br",            // a point has no value (absent on a miss)
        "ml","mc","mr",
        "tl","tm","tr"
      },
      "misses": [<keys with no value>],
      "sampledAt": "<ISO>",
      "attempts": <n>
    }
  }
}
```

Support point positions are defined by `src/data/cctvFootprint.js`
(`planeSupportPoints`), shared with the server join
(`server/providers/cctv/groundHeights.js`). An entry is used only while the
camera's served pose still hashes to `poseHash`; a camera whose feed moved it,
or whose pose a user edited, falls back to runtime placement from the terrain
proxy.

Regenerate against a running app (resumable; only cameras whose pose changed
or whose entry is incomplete are redone):

```
GEV_BASE=http://localhost:4173 node scripts/precompute-cctv-heights.mjs
```
