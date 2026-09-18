# OnDemand Spatial Seismic Analyst

**Dashboard fields** — Skill Name: `ondemand-spatial-seismic-analyst` · Description: Plans and interprets USGS `earthquake_search` calls for the OnDemand Spatial earthquakes layer, classifying magnitude/depth/distance/recency/tsunami risk while never inventing events a call did not return. · Category: `research` · Sample Prompts:
- "Are there any significant earthquakes near here in the last month?"
- "Turn on the earthquakes layer and tell me about the strongest quake nearby."
- "Is that earthquake close enough that a tsunami is a concern?"

## When to use this skill
- The `earthquakes` layer is active in spatial context, or the user's query concerns seismic activity, earthquakes, tremors, aftershocks, or tsunami risk.
- The workflow has resolved capability `earthquake.search` and needs the actual call planned and/or its results interpreted.

## When NOT to use it
- No seismic intent and the earthquakes layer is inactive — do not proactively suggest a search.
- Do not use this skill to plan MapActions (layer toggles, camera moves); that is `ondemand-spatial-map-action-planner`'s job — this skill only plans/interprets the `earthquake_search` capability call.
- Do not forecast, predict, or estimate future earthquake probability — USGS coverage here is `observed` history only, never a forecast.

## Trigger conditions
- `activeLayers` includes `earthquakes`, OR
- `intent` is `anomaly_scan`, `area_summary`, or `entity_lookup` with a seismic focus, OR
- The user's words match seismic vocabulary: earthquake, quake, tremor, magnitude, aftershock, tsunami, seismic.

## Instructions
1. Confirm the trigger: earthquakes layer active, seismic vocabulary in the query, or `capability_resolver` already selected `earthquake.search`.
2. Identify the point of interest: use a user-named place if given; otherwise use spatial context `center` (the current camera/view center).
3. Decide circle vs bbox; default to a circle around the point of interest unless the user's framing is clearly a rectangular viewport.
4. Circle geometry: set `latitude` and `longitude` to the point of interest and `maxradiuskm` to the search radius.
5. Enforce a minimum circle radius of 100 km unless the user explicitly asks for a tighter search.
6. Never send a partial circle — `latitude`, `longitude`, and `maxradiuskm` must all be present together, or none of them.
7. Bbox geometry: derive `minlatitude`, `maxlatitude`, `minlongitude`, `maxlongitude` directly from spatial context `visibleBounds` when a bbox better fits the request.
8. Never send both a circle and a bbox in the same call — the API rejects that combination with a 400.
9. If both a named place and a rectangular view apply, prefer the circle around the named place and state that choice.
10. Default the time window to the last 30 days: `starttime` = now minus 30 days, `endtime` = now, both UTC as `YYYY-MM-DD` or ISO.
11. Override the default window only when the user names a different one (e.g. "this week", "since Monday", "last 24 hours").
12. Default `minmagnitude` to 2.5; raise it for "significant"/"major" activity, lower it (never below the supported floor) for "any tremor at all".
13. Leave `maxmagnitude` unset unless the user wants an upper bound; the valid range is -2 to 10.
14. Set `orderby` to `magnitude` when the user cares which event was strongest; otherwise leave the default `time` ordering.
15. Use `mode: "query"` to retrieve actual events; use `mode: "count"` only when the user wants a tally, not the events themselves.
16. Cap `limit` between 1 and 200 (default 100); request only as many rows as the question needs.
17. Issue the call only through capability `earthquake.search` (`ondemand_tool earthquake_search`) — never hand-construct a USGS URL or call a different endpoint.
18. If the call did not actually execute this run (blocked, not reached, no response), do not invent, estimate, or recall an earthquake from memory or general knowledge.
19. In that case, add a `sources` entry with `status: "planned_not_executed"` and say plainly that no live seismic data was retrieved this turn.
20. When results are available, treat every field as observed and literal, never rounded or paraphrased: `magnitude`, `depth_km`, `latitude`, `longitude`, `time_utc`, `tsunami`, `place`/`location`, `id`, `url`.
21. Classify magnitude with exactly this wording: below 3 "minor"; 3 to 4.9 "light/moderate"; 5 to 5.9 "moderate-strong"; 6 and above "strong".
22. Classify depth: below 70 km "shallow"; state explicitly that a shallow quake is felt more strongly at the surface than a deeper quake of equal magnitude.
23. Do not repeat the shallow-depth caveat for every deep event in a list — mention it once where it is relevant.
24. Compute and state distance from the search center (or the named point of interest) for each event you highlight.
25. State recency in human terms from `time_utc` versus current time (e.g. "3 hours ago", "18 days ago"); never describe an old event as if it just happened.
26. Surface the `tsunami` flag whenever true; a false/absent flag does not need to be called out for every event in a long list.
27. State the USGS coverage limitation once per response: this is `observed` historical/near-real-time seismicity, never a forecast or prediction.
28. Rank which events to lead with using magnitude, distance, and recency together — do not dump the raw list in API order.
29. Tie every claim back to a literal field value from that event's record — never a vague qualitative claim with no supporting value.
30. When zero events match, report that plainly as a valid, informative result rather than something to fix by inventing data.
31. When multiple events are close in magnitude, break the tie by recency and distance, and say how the choice was made.
32. If the user is really asking about one specific event already seen on the map, find it by id/location in the results before summarizing the whole set.
33. Do not merge or average events into a synthetic "typical earthquake" statistic unless explicitly asked for an aggregate view.
34. Keep each presented event traceable to its own `id` so a follow-up ("tell me more about the second one") can be resolved unambiguously.
35. Answer risk/safety questions only from the literal magnitude/depth/distance/tsunami data returned — no speculative risk assessment beyond what those fields support.
36. Keep the response scoped to `earthquake.search` only — do not pull in aircraft, vessel, or other layer data even if those layers are also active.
37. At tier `DEEP`, it is appropriate to walk through more of the returned events individually; at `ASK`/`INVESTIGATE`, keep the answer to the handful that matter to the question.
38. If the earthquakes layer is active but the question is unrelated to seismic activity, do not force an `earthquake_search` call just because the layer happens to be on.
39. Always report the result's `count` alongside any subset of events highlighted, so the total is known even when only a few are discussed.
40. Preserve the exact `place`/`location` string from the record when naming an event's location — do not re-geocode or rename it.
41. When the point of interest is ambiguous (multiple places share a name), state the coordinates actually used so the search is auditable.
42. Finish by naming which capability and geometry were used (`earthquake.search`, circle or bbox, radius or bounds) so the plan is traceable end-to-end.

## Expected input
```json
{
  "spatialContext": {
    "center": { "latitude": 0, "longitude": 0 },
    "visibleBounds": { "minlatitude": 0, "maxlatitude": 0, "minlongitude": 0, "maxlongitude": 0 },
    "activeLayers": ["earthquakes"],
    "timeline": { "start": "ISO-8601", "end": "ISO-8601" }
  },
  "intent": "anomaly_scan|area_summary|entity_lookup|other",
  "focus": { "timeWindow": { "start": "ISO-8601", "end": "ISO-8601" } },
  "userQuery": "string"
}
```

## Expected output
```json
{
  "capability": "earthquake.search",
  "callPlan": {
    "starttime": "YYYY-MM-DD",
    "endtime": "YYYY-MM-DD",
    "minmagnitude": 2.5,
    "maxmagnitude": 10,
    "latitude": 0,
    "longitude": 0,
    "maxradiuskm": 100,
    "limit": 100,
    "orderby": "time|time-asc|magnitude|magnitude-asc",
    "mode": "query|count"
  },
  "result": {
    "source": "USGS",
    "coverage": "observed",
    "count": 0,
    "events": [
      { "id": "string", "time_utc": "ISO-8601", "magnitude": 0, "depth_km": 0, "latitude": 0, "longitude": 0, "place": "string", "tsunami": false, "url": "string" }
    ]
  },
  "interpretation": {
    "summary": "string",
    "highlighted": [
      { "eventId": "string", "magnitudeBand": "minor|light-moderate|moderate-strong|strong", "depthClass": "shallow|deep", "distanceKm": 0, "recency": "string", "tsunami": false }
    ]
  },
  "sources": [ { "id": "earthquake.search", "kind": "capability", "label": "USGS FDSN Event", "status": "used|planned_not_executed" } ]
}
```

## Never
- Never call both circle (`latitude`+`longitude`+`maxradiuskm`) and bbox (`min/max latitude/longitude`) parameters in the same request.
- Never send a partial circle (only one or two of latitude/longitude/maxradiuskm).
- Never use a circle radius below 100 km unless the user explicitly asked for a tighter search.
- Never invent, estimate, or recall an earthquake event from memory or general knowledge.
- Never present USGS observed data as a forecast or prediction of a future quake.
- Never omit the `planned_not_executed` status when the call did not actually run this turn.
- Never include any key, token, secret or secondary-provider credential in output.

## App module mapping
- Mirrors capability `earthquake.search` in `src/registry/capabilities.json`.
- server/sources/usgs-earthquakes.js — USGS FDSN client.
- server/serverless/earthquakes-route.js — `/api/sources/earthquakes` route.
- src/layers/earthquakes/ — map layer rendering.
- src/data/earthquakes.js — client-side data shaping.
- docs/ondemand-workflows/tools/earthquake_search.json — tool parameter/output contract.

## Version — `ondemand-spatial-skills v1 — 2026-09-18 — pairs with workflow "OnDemand Spatial Advanced Workflow" v1 (id 6aace534859f7b0abb53d99a)`
