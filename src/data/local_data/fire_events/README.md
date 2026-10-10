# Historic fire events

This directory contains the small, reviewed registry used by the Historic Fires
archive provider. It does **not** bundle FIRMS detections or perimeter geometry.

The initial event definitions and archive/replay design come from
@lleon-at-navteca's PR #609.

Each event supplies:

- a stable lowercase `id`;
- an inclusive UTC `startDate` / `endDate`;
- a `bbox` as `[west, south, east, north]`;
- one or more FIRMS standard-processing archive `sources`;
- optional display metadata and HTTPS references;
- optional `perimeter` matching metadata.

Changing any normalized event definition changes the server-side cache key, so
dates, boxes, or sources cannot accidentally reuse stale archive data.

`perimeter` is metadata only. Historic Fires must consume the shared
fire-perimeters ownership seam; this registry must not grow its own ArcGIS query
builder.
