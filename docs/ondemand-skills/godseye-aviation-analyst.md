# GodsEye Aviation Analyst

**Dashboard fields** — Skill Name: `godseye-aviation-analyst` · Description: Applies ADS-B anomaly heuristics (emergency squawks, ground-speed, low-altitude, heading/approach checks) to flights/military visibleEntities, citing literal values as evidence. · Category: `research` · Sample Prompts:
- "Is anything unusual happening with air traffic near the airport right now?"
- "Any aircraft squawking an emergency code in view?"
- "Why did you flag that aircraft — is it just on approach?"

## When to use this skill
- The `flights` or `military` layer is active and has `visibleEntities`, and the user asks about air traffic, aircraft, planes, anomalies, or emergencies overhead.
- The workflow needs literal ADS-B evidence (squawk, altitude, speed, heading) to support or refute a flagged aircraft finding.

## When NOT to use it
- No flights/military entities in view and no aviation intent — do not proactively scan.
- Do not use this skill for maritime (AIS) or seismic anomalies — those are separate layers/skills.
- Do not treat a military-layer entity as anomalous purely for being military; military presence is context, not an anomaly.

## Trigger conditions
- `activeLayers` includes `flights` or `military` with non-empty `visibleEntities`, OR
- Derived fact `emergencySquawks` (7500/7600/7700) is non-empty, OR
- `intent` is `anomaly_scan` and focus/layers include an aviation layer, OR
- The user's words mention aircraft, planes, flights, squawk, emergency, hijack, or a specific callsign.

## Instructions
1. Read `visibleEntities` for `flights`/`military` layers; each entity carries `layerId`, `id` (`icao24:<hex>`), `callsign`, `latitude`, `longitude`, `altitudeM`, `speedKts`, `headingDeg`, `squawk`, `onGround`, `source: "adsb"`.
2. Also read the derived facts already computed by the context builder — `airborne`, `onGround`, `emergencySquawks` — and use them as a starting filter rather than recomputing from scratch.
3. For every entity, check `squawk` against the three emergency codes: `7500` hijack, `7600` radio failure, `7700` general emergency.
4. An emergency squawk on an entity that is airborne (`onGround: false`) is `high` severity — the single highest-priority anomaly this skill raises.
5. An emergency squawk on an entity with `onGround: true` is still worth reporting but is not automatically `high`; let severity reflect the full context (e.g. taxiing after a resolved emergency is lower urgency than one airborne).
6. Never relabel or soften an emergency squawk's meaning — name it exactly as 7500 hijack, 7600 radio failure, or 7700 general emergency.
7. For ground entities, `speedKts <= 30` is normal taxi speed — state explicitly that this is NOT anomalous when it applies.
8. For ground entities, `speedKts > 60` while `onGround: true` is `notable` — a runway roll looks the same and is expected, but still call it out rather than silently ignoring it.
9. Ground speeds between 30 and 60 kts are an ambiguous middle band; do not flag these by default, only when combined with another inconsistency (e.g. a heading not aligned with any runway).
10. For airborne entities, read or compute altitude in meters (`altitudeM`) and compare it against the 300 m threshold.
11. An airborne entity below 300 m AND more than ~5 km from the airport/center is `notable` — this distinguishes a genuine low-flight anomaly from normal landing/takeoff near the runway.
12. An airborne entity below 300 m within about 5 km of the airport center is expected departure/arrival behavior, not an anomaly, unless another signal (emergency squawk, erratic heading) is also present.
13. Before flagging a low-altitude entity, check approach-corridor alignment: compute the bearing from the entity to the airport/center and compare it to `headingDeg`.
14. An entity heading roughly along that bearing while descending is normal approach traffic — state so plainly and do not flag it.
15. A descending entity whose heading is NOT aligned with any known approach bearing, or that levels off unexpectedly low outside a corridor, is a heading/altitude inconsistency worth flagging as `notable`.
16. Also treat an abrupt, unexplained heading change inconsistent with a stable approach or departure path (e.g. a sharp turn away from the runway centerline at low altitude) as a heading inconsistency.
17. Treat a sudden altitude value inconsistent with a plausible climb/descent rate as an issue only when prior-context data exists; on a single snapshot, rely on position/heading/altitude instead of inventing a rate.
18. Treat every `military` layer entity as context, never as an anomaly by itself — apply the exact same squawk/altitude/speed/heading heuristics above before calling a military entity notable or high, and do not lower that bar just because it is military.
19. Use classification style from `src/layers/aircraft/classification.js` (civil vs military, callsign pattern) only to label an entity's role/context in the response, never as a substitute for an actual anomaly heuristic.
20. Rank multiple candidate anomalies by severity first (`high` emergency squawks before `notable` low/slow/heading findings), then by proximity to the center/point of interest.
21. For every anomaly, cite literal evidence values as explicit rows: `squawk`, `altitudeM`, `speedKts`, `headingDeg`, plus `callsign`/`id`/`layerId`.
22. Never describe an anomaly in prose only, without literal values a reader could check against the entity record.
23. When an entity is NOT anomalous but close to a threshold (e.g. taxiing at 25 kts, clean approach), state so explicitly with its literal values.
24. Do not flag an entity solely because it is fast, high, low, or slow in isolation — anomaly status always comes from the specific combinations above, never from a single generic "looks odd" judgment.
25. If `visibleEntities` for the aviation layers is empty, state plainly that there is no aircraft in view to analyze — do not invent traffic.
26. Never use altitude/speed/heading/squawk values that are not present in the entity data; if a field is missing, say the field is unavailable rather than estimating it.
27. Use the shared severity vocabulary `info|notable|high` for aviation findings; this skill proposes severity but does not itself mark a finding `verified` — that remains the verification node's job.
28. When both `selectedEntity` and `trackedEntity` are present, check those first — the user is very likely asking about one of them specifically.
29. Use `timeline`/`investigation` context, when present, only to note whether an anomaly is new versus already under review; do not re-derive history not present in the data.
30. At tier `DEEP`, review every visible entity individually; at `ASK`/`INVESTIGATE`, focus on the entities that actually carry an anomaly signal plus one or two notable near-misses.
31. When several aircraft carry emergency squawks simultaneously, list all of them — never suppress one to keep the response short, since each is independently `high` severity.
32. Do not classify an ordinary cruise-altitude, on-course flight with a normal squawk (e.g. an assigned ATC code) as anomalous merely because it appeared in view.
33. Compute the approach bearing from the entity's position and the airport/center coordinates already in spatial context — never guess an airport location.
34. A `military-installations` context layer follows the same rule: presence near it is context, not evidence of anomaly.
35. Do not compare aircraft across unrelated airports/centers unless the user's question spans multiple locations.
36. Keep the response scoped to aviation (flights/military) layers only — do not pull in maritime, seismic, or other layer data even if active.
37. When two heuristics both apply to the same entity (e.g. emergency squawk AND low altitude), report it once with all matching evidence rather than as two separate findings.
38. State distance-from-airport-center in kilometers alongside altitude when invoking the 300 m / 5 km rule, so the basis for "notable" is fully auditable.
39. Preserve the exact `callsign` string as broadcast; do not normalize, translate, or guess an operator/flight-number mapping beyond what is in the data.
40. Finish by naming which heuristics triggered (squawk, ground-speed, low-altitude, heading-inconsistency) for each anomaly, so it is traceable end-to-end.

## Expected input
```json
{
  "spatialContext": {
    "center": { "latitude": 0, "longitude": 0 },
    "activeLayers": ["flights", "military"],
    "visibleEntities": [
      { "layerId": "flights", "id": "icao24:abc123", "callsign": "string", "latitude": 0, "longitude": 0, "altitudeM": 0, "speedKts": 0, "headingDeg": 0, "squawk": "string", "onGround": false, "source": "adsb" }
    ]
  },
  "derived": { "airborne": 0, "onGround": 0, "emergencySquawks": ["icao24:abc123"] },
  "userQuery": "string"
}
```

## Expected output
```json
{
  "anomalies": [
    {
      "entityId": "icao24:abc123",
      "layerId": "flights",
      "category": "emergency-squawk|ground-speed|low-altitude|heading-inconsistency",
      "severity": "info|notable|high",
      "explanation": "string",
      "evidence": [
        { "field": "squawk", "value": "7700" },
        { "field": "altitudeM", "value": 0 },
        { "field": "speedKts", "value": 0 },
        { "field": "headingDeg", "value": 0 }
      ]
    }
  ],
  "nonAnomalous": [
    { "entityId": "icao24:def456", "layerId": "flights", "note": "string", "evidence": [ { "field": "speedKts", "value": 22 } ] }
  ],
  "sources": [ { "id": "flights-layer", "kind": "in_view", "label": "ADS-B flights", "status": "used" } ]
}
```

## Never
- Never call a military entity anomalous solely because it is military — apply the same heuristics as any other entity.
- Never treat taxi speed (`<= 30 kts` on the ground) as anomalous.
- Never treat normal approach/departure traffic (aligned heading, descending, near the airport) as anomalous.
- Never report an anomaly without quoting its literal `squawk`/`altitudeM`/`speedKts`/`headingDeg` evidence values.
- Never fabricate an entity, a field value, or a climb/descent rate that is not present in `visibleEntities`.
- Never soften or relabel an emergency squawk's meaning (7500/7600/7700).
- Never include any key, token, secret or secondary-provider credential in output.

## App module mapping
- Mirrors the planner/verification nodes' aviation-specific heuristics in "GodsEye Advanced Spatial Workflow" v1.
- src/layers/flights/ — flights layer rendering and entity feed.
- src/layers/military/ — military layer rendering and entity feed.
- src/layers/aircraft/classification.js — civil/military classification used for context labeling.
- server/providers/aircraft/ — ADS-B provider/source integration.

## Version — `godseye-skills v1 — 2026-09-18 — pairs with workflow "GodsEye Advanced Spatial Workflow" v1 (id 6aace534859f7b0abb53d99a)`
