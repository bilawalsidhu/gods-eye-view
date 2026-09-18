# GodsEye Spatial Context Reader

**Dashboard fields** — Skill Name: `godseye-spatial-context-reader` · Description: Parses and validates the GodsEye §13 spatial-context JSON payload (15 ordered fields), normalises center/visibleBounds/activeLayers/visibleEntities/timeline/userAction, and computes derived spatial facts (view radius, per-layer entity counts, airborne/on-ground counts, emergency squawks, vessels under way). · Category: `engineering` · Sample Prompts:
- "Parse this spatial-context payload and return the normalized fields plus derived facts."
- "Validate the current map-state JSON and list any missing or malformed §13 fields."
- "How many aircraft are airborne and which vessels are under way in this view?"

## When to use this skill
- As the first processing step whenever a raw §13 spatial-context JSON snapshot needs parsing, validation, normalization, and derived-fact computation before intent classification.
- When a caller asks for view radius, per-layer entity counts, airborne/on-ground splits, emergency squawk ids, or vessels-under-way ids computed from a map snapshot.
- When a payload may be incomplete or malformed and the caller needs an explicit `contextWarnings` report rather than a silent failure.

## When NOT to use it
- To decide user intent, tier, or focus — use `godseye-intent-classifier`.
- To pick capabilities, tools, or build API call params — use `godseye-capability-resolver`.
- When the input is already a normalized context object with `derived` and `contextWarnings` present — pass it through unchanged.
- When no spatial-context payload was supplied at all — ask for the payload instead of fabricating one.

## Trigger conditions
- A raw §13 payload arrives from the `session_context` step of the "GodsEye Advanced Spatial Workflow", or from any client emitting the same 15-field shape.
- A user or upstream node asks for view radius, entity counts, airborne/on-ground counts, emergency squawks, or vessels under way.
- A payload is suspected incomplete and the caller wants a `contextWarnings` report.

## Instructions
1. Receive the raw §13 spatial-context JSON object.
2. If the payload is not a single JSON object, set `contextWarnings` to `["root payload is not a JSON object"]` and stop.
3. Check for all 15 fields in order: `camera, viewport, center, altitude, zoom, viewScale, mapStack, visibleBounds, activeLayers, selectedEntity, trackedEntity, visibleEntities, timeline, investigation, userAction`.
4. For each missing field, warn `"missing field: [name]"` and set it to `null` (`[]` for array fields).
5. For each field found out of order, warn `"field out of order: [name]"` but still normalize it.
6. Pass `camera` through unchanged; warn `"camera is not an object"` if it isn't one.
7. Pass `viewport` through unchanged; warn `"viewport is not an object"` if it isn't one.
8. Pass `altitude` through unchanged; warn `"altitude is not numeric"` if it isn't numeric.
9. Pass `zoom` through unchanged; warn `"zoom is not numeric"` if it isn't numeric.
10. Pass `viewScale` through unchanged; accept string or number; warn otherwise.
11. Pass `mapStack` through unchanged; warn `"mapStack is not an array"` and use `[]` if it isn't one.
12. Pass `selectedEntity` through unchanged; accept object or null; warn otherwise.
13. Pass `trackedEntity` through unchanged; accept object or null; warn otherwise.
14. Pass `investigation` through unchanged; accept object or null; warn otherwise.
15. Normalize `center`: require numeric `latitude` in [-90,90] and `longitude` in [-180,180]; coerce numeric strings.
16. If `center` is missing or out of range, warn `"center is missing or out of range"` and set it to `null`.
17. Normalize `visibleBounds`: require numeric `north, south, east, west` with `north > south`.
18. If any `visibleBounds` value is missing, non-numeric, or inverted, warn `"visibleBounds is missing or inverted"` and null it.
19. Normalize `activeLayers` into a flat array of layerId strings, from either strings or `{id: layerId}` objects.
20. If `activeLayers` is missing or not an array, warn `"activeLayers is missing or not an array"` and use `[]`.
21. Normalize `visibleEntities` into an array; drop and warn on any entry missing `id` or `layerId`.
22. Keep every other entity field as given: aviation entities keep `callsign, latitude, longitude, altitudeM, speedKts, headingDeg, squawk, onGround, source`; maritime entities keep `name, latitude, longitude, speedKts, courseDeg, shipType, navStatus, source`; other layers keep at least `latitude, longitude`.
23. Normalize `timeline`: require an ISO-8601 `now` string; keep any other keys (`start, end, playing`) as given.
24. If `timeline.now` is missing or unparsable, warn `"timeline.now is missing or unparsable"` and set `timeline` to `null`; never fabricate a substitute timestamp.
25. Normalize `userAction` into exactly one of `query, select, track, navigate, annotate, unknown`.
26. Keep `userAction` unchanged if it already matches one of those five values.
27. Otherwise map synonyms: click/tap/pick to select; pan/zoom/fly-to/goto to navigate; watch/follow/lock to track; note/mark/flag to annotate; search/ask/lookup to query.
28. If nothing matches, set `userAction` to `unknown` and warn `"userAction did not match a known value"`.
29. Compute `viewRadiusKm` only when `visibleBounds` normalized: take corners (north,west) and (south,east), apply the haversine formula with Earth radius 6371 km, halve the result, round to one decimal place.
30. If `visibleBounds` failed, set `viewRadiusKm` to `null` and warn `"viewRadiusKm skipped: visibleBounds invalid"`.
31. Compute `entityCounts` by grouping normalized `visibleEntities` by `layerId` and counting each group; include every layerId seen, even if absent from `activeLayers`.
32. Compute `airborne` and `onGround` from aviation-layer entities (`flights, military, aircraft`, or any entity carrying `onGround`): count `onGround === false` as `airborne` and `onGround === true` as `onGround`.
33. If an aviation entity lacks `onGround`, count it toward neither, and warn `"entity [id] missing onGround"`.
34. Compute `emergencySquawks` by collecting the `id` of every aviation entity whose `squawk` is `7500`, `7600`, or `7700`, in the order encountered.
35. Compute `vesselsUnderWay` by collecting the `id` of every maritime entity (e.g. layerId `ais-live-vessels`) with `speedKts > 1`, in the order encountered.
36. Never derive a fact from a field that failed normalization; null (or empty) that fact and record which field caused it.
37. If the same `id` appears twice in `visibleEntities`, keep the first, drop the rest, and warn `"duplicate entity id: [id]"`.
38. Assemble the result with exactly three top-level keys: `normalizedContext, derived, contextWarnings`.
39. Return `contextWarnings` as `[]` (never null, never omitted) when everything validated cleanly.
40. Hand the result to the `intent_classifier` step; add no keys beyond the documented shape and invent nothing not present in the source payload.

## Expected input
```json
{
  "camera": { "headingDeg": 0, "pitchDeg": -90 },
  "viewport": { "widthPx": 1920, "heightPx": 1080 },
  "center": { "latitude": 34.05, "longitude": -118.25 },
  "altitude": 850000,
  "zoom": 6.2,
  "viewScale": "regional",
  "mapStack": ["basemap-satellite", "labels"],
  "visibleBounds": { "north": 40.0, "south": 30.0, "east": -110.0, "west": -125.0 },
  "activeLayers": ["flights", "ais-live-vessels", "earthquakes"],
  "selectedEntity": null,
  "trackedEntity": null,
  "visibleEntities": [
    { "layerId": "flights", "id": "icao24:a1b2c3", "callsign": "UAL123", "latitude": 35.1, "longitude": -117.9, "altitudeM": 10500, "speedKts": 430, "headingDeg": 270, "squawk": "7700", "onGround": false, "source": "adsb" },
    { "layerId": "ais-live-vessels", "id": "mmsi:366123456", "name": "MV EXAMPLE", "latitude": 33.7, "longitude": -118.2, "speedKts": 12.4, "courseDeg": 190, "shipType": "cargo", "navStatus": "under way using engine", "source": "ais" }
  ],
  "timeline": { "now": "2026-09-18T12:00:00Z", "start": null, "end": null, "playing": false },
  "investigation": null,
  "userAction": "query"
}
```

## Expected output
```json
{
  "normalizedContext": {
    "camera": { "headingDeg": 0, "pitchDeg": -90 },
    "viewport": { "widthPx": 1920, "heightPx": 1080 },
    "center": { "latitude": 34.05, "longitude": -118.25 },
    "altitude": 850000,
    "zoom": 6.2,
    "viewScale": "regional",
    "mapStack": ["basemap-satellite", "labels"],
    "visibleBounds": { "north": 40.0, "south": 30.0, "east": -110.0, "west": -125.0 },
    "activeLayers": ["flights", "ais-live-vessels", "earthquakes"],
    "selectedEntity": null,
    "trackedEntity": null,
    "visibleEntities": [ "...validated entities, fields unmodified" ],
    "timeline": { "now": "2026-09-18T12:00:00Z", "start": null, "end": null, "playing": false },
    "investigation": null,
    "userAction": "query"
  },
  "derived": {
    "viewRadiusKm": 823.4,
    "entityCounts": { "flights": 1, "ais-live-vessels": 1 },
    "airborne": 1,
    "onGround": 0,
    "emergencySquawks": ["icao24:a1b2c3"],
    "vesselsUnderWay": ["mmsi:366123456"]
  },
  "contextWarnings": []
}
```

## Never
- Never invent field values, entities, or coordinates absent from the source payload.
- Never fabricate a `timeline.now` timestamp when it is missing — warn instead.
- Never classify intent, choose a tier, or select capabilities/tools.
- Never set `contextWarnings` to `null` or omit the key.
- Never reorder or rename the 15 documented §13 fields.
- Never emit an API key, token, secret, or credential in any field.

## App module mapping
- Mirrors workflow nodes `session_context` and `spatial_context_builder` in the "GodsEye Advanced Spatial Workflow".
- `src/ui/context*.js` — captures and shapes the raw §13 payload in the client.
- `src/app/stateChannel.js` — carries the payload from the UI to the workflow.
- `src/layers/*/evidence.js` — per-layer entity field definitions used when normalizing `visibleEntities`.
- `server/ondemand/workflow-definition.js` — builds and wires the `session_context` / `spatial_context_builder` nodes.

## Version — `godseye-skills v1 — 2026-09-18 — pairs with workflow "GodsEye Advanced Spatial Workflow" v1 (id 6aace534859f7b0abb53d99a)`
