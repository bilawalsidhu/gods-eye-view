# Nebraska 511 road headings

Precomputed camera bearings for the Nebraska 511 (NDOT) CCTV source pack.

## Why this exists

Nebraska 511 publishes no camera bearing, so the pack falls back to a
deterministic id-hash heading. That is stable but arbitrary: it aims a camera's
cone across the highway as often as along it.

Each entry here is instead the bearing of the nearest OSM road segment.

## Provenance

- **Source:** OpenStreetMap way geometry via the Overpass API.
- **License:** ODbL 1.0 — attribution and share-alike apply to this data.
  "© OpenStreetMap contributors" (https://www.openstreetmap.org/copyright).
- **Generator:** `scripts/precompute-ne511-headings.mjs`
- **Consumer:** `server/providers/cctv/headings.js` joins it at catalog load.

## Regenerating

```bash
node scripts/precompute-ne511-headings.mjs          # resumes; queries only what's missing
node scripts/precompute-ne511-headings.mjs --force  # re-queries everything
```

It runs offline rather than at catalog load: `server/providers/cctv` may not
import the overpass package (check:boundaries), and one `around` query per
camera on every refresh is the API sweep the Overpass usage policy asks heavy
consumers to replace with a local extract. The script paces itself, rotates
mirrors, retries with backoff, and checkpoints after every chunk.

## Accuracy

A road axis fixes the line a camera looks along, not which way down it. Titles
carrying a true `EB`/`WB` token break the tie; otherwise the id-hash prior
picks the nearer end. Both ends keep the cone on the roadway, so
`headingConfidence` stays `low` and the in-app calibration badge still reports
a raw prior. Entries whose camera has moved are dropped by the `positionKey`
guard rather than applied stale.
