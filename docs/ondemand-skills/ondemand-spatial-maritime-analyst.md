# OnDemand Spatial Maritime Analyst

**Dashboard fields** — Skill Name: `ondemand-spatial-maritime-analyst` · Description: Applies AIS anomaly heuristics (navigation-status vs speed contradictions, vessels under way near an airport approach or restricted water, AIS gaps, ship-type context) to `ais-live-vessels` visibleEntities, citing literal AIS values as evidence. · Category: `research` · Sample Prompts:
- "Is any vessel behaving unusually near the airport shoreline?"
- "Which ships in view are moving although they report moored or at anchor?"
- "Why did you flag MSC KHALIFA — is that just normal transit?"

## When to use this skill
- The `ais-live-vessels` layer is active and has `visibleEntities`, and the user asks about ships, vessels, boats, port or maritime traffic, or an anomaly scan covers a coastal / harbour / airport-on-the-coast view.
- The workflow needs literal AIS evidence (`speedKts`, `courseDeg`, `navStatus`, position) to support or refute a flagged vessel finding.

## When NOT to use it
- No `ais-live-vessels` entities in view and no maritime intent — do not scan proactively.
- Aviation (ADS-B) or seismic questions — those belong to `ondemand-spatial-aviation-analyst` and `ondemand-spatial-seismic-analyst`.
- Do not use it to estimate destinations, cargo, ownership or flag state — none of that is in the AIS snapshot the app provides.

## Trigger conditions
- `activeLayers` includes `ais-live-vessels` and at least one entity has `layerId: "ais-live-vessels"`, OR
- the derived fact `vesselsUnderWay` is greater than 0 and the intent is `anomaly_scan` or `area_summary`, OR
- the user's words mention vessel, ship, boat, tanker, cargo, tug, AIS, MMSI, port, harbour, anchorage, or a vessel name present in `visibleEntities`.

## Instructions
1. Read every entity with `layerId: "ais-live-vessels"`. Each carries `id` (`mmsi:<digits>`), `name`, `latitude`, `longitude`, `speedKts`, `courseDeg`, `shipType`, `navStatus` (for example `moored`, `at anchor`, `under way using engine`, `under way sailing`, `restricted manoeuvrability`, `not under command`) and `source: "ais"`.
2. Start from the derived facts of the context reader (`entityCounts["ais-live-vessels"]`, `vesselsUnderWay`); do not recount unless a field is missing.
3. For each vessel compare `navStatus` with `speedKts`:
   - `moored` or `at anchor` with `speedKts > 1` → **notable** ("reports moored/anchored but is moving").
   - `under way using engine` / `under way sailing` with `speedKts < 0.5` → **notable** only if the same reading is present in more than one snapshot; on a single snapshot label it **info** ("under way but stationary — possibly waiting/drifting").
   - `not under command` or `restricted manoeuvrability` → **notable** regardless of speed; quote the status verbatim.
4. Speeds between 0.5 and 1 kt are the mooring/anchor-swing band: never flag them on their own.
5. Corridor check (stated as INFERRED, never as observed): the app snapshot carries no runway geometry, so treat "near an airport approach corridor" as a heuristic — a vessel under way within the `visibleBounds` of an airport-scale view (`viewScale: "airport"`) and within roughly 3 km of the `center` line of sight is **notable** and must be labelled `kind: "inferred"` with the assumption written out ("approach corridor assumed from the airport-centred view; no runway geometry in the input").
6. Restricted water: if `investigation` or the query names a restricted / exclusion / security zone and a vessel is under way inside it, mark **notable**; if no such zone is given, do not invent one.
7. Ship-type context — say when behaviour is normal: a `tug`, `pilot`, `port tender` or `dredger` moving slowly near a port is normal service traffic; a `cargo` or `tanker` at 8–14 kts on a steady `courseDeg` is normal transit; a `passenger` vessel stopped at a berth is normal. State these explicitly so the analyst does not read silence as a finding.
8. AIS gaps: an entity that was present in a `priorTurns` snapshot but is missing now, or a `visibleEntities` entry marked `stale`/`partial`, is **info** ("AIS gap — no position update"), never evidence of wrongdoing.
9. Speed/course sanity: `speedKts > 40` for any non-high-speed-craft `shipType`, or a `courseDeg` outside 0–360, is a data-quality **info** flag, not a vessel anomaly.
10. For every candidate finding produce evidence rows with the literal values actually present: `speedKts`, `courseDeg`, `navStatus`, `latitude`, `longitude`, and `shipType` when it drove the verdict. One row per value.
11. Rank findings: `high` is reserved for a verified `not under command` / collision-course situation supported by two or more literal values; most AIS findings are `notable` or `info`.
12. Hand the findings to the evidence verifier in the shape below; never mark anything `verified` yourself.
13. Suggest follow-ups the map can act on: `track_entity(query: <vessel name>, layerId: "ais-live-vessels")`, `annotate_map` markers at the vessel positions, `frame_overhead(target: "vessels", radiusKm: N)`.
14. If the snapshot has vessels but the query is about aircraft, return an empty `findings` list with a one-line `note` — do not pad.

## Expected input
```json
{
  "query": "string",
  "spatialContext": {
    "center": { "latitude": 24.4331, "longitude": 54.6511 },
    "viewScale": "airport",
    "visibleBounds": { "north": 24.52, "south": 24.35, "east": 54.78, "west": 54.52 },
    "activeLayers": ["ais-live-vessels", "flights"],
    "visibleEntities": [
      { "layerId": "ais-live-vessels", "id": "mmsi:636019876", "name": "MSC KHALIFA", "latitude": 24.535, "longitude": 54.66, "speedKts": 9.8, "courseDeg": 275, "shipType": "cargo", "navStatus": "under way using engine", "source": "ais" }
    ],
    "timeline": { "mode": "live", "now": "2026-09-18T07:00:00.000Z" },
    "investigation": null
  },
  "derived": { "entityCounts": { "ais-live-vessels": 2 }, "vesselsUnderWay": 1 },
  "intent": { "intent": "anomaly_scan", "focus": { "layers": ["ais-live-vessels"] } }
}
```

## Expected output
```json
{
  "findings": [
    {
      "id": "m1",
      "claim": "MSC KHALIFA (mmsi:636019876) is under way at 9.8 kts on course 275° inside the airport-scale view",
      "kind": "inferred",
      "severity": "notable",
      "assumption": "approach corridor assumed from the airport-centred view; no runway geometry in the input",
      "supportingEntityIds": ["mmsi:636019876"],
      "evidence": [
        { "findingId": "m1", "entityId": "mmsi:636019876", "field": "navStatus", "value": "under way using engine", "sourceLayer": "ais-live-vessels" },
        { "findingId": "m1", "entityId": "mmsi:636019876", "field": "speedKts", "value": 9.8, "sourceLayer": "ais-live-vessels" },
        { "findingId": "m1", "entityId": "mmsi:636019876", "field": "courseDeg", "value": 275, "sourceLayer": "ais-live-vessels" }
      ]
    }
  ],
  "nonAnomalous": [
    { "entityId": "mmsi:470123000", "note": "AL DHAFRA 7 (tug) moored at 0.2 kts — normal", "evidence": [ { "field": "navStatus", "value": "moored" }, { "field": "speedKts", "value": 0.2 } ] }
  ],
  "unknowns": ["no prior snapshot — AIS gaps cannot be assessed"],
  "sources": [ { "id": "ais-live-vessels", "kind": "in_view", "label": "AIS (ais-live-vessels layer)", "status": "used" } ]
}
```

## Never
- Never invent a vessel, MMSI, position, speed, course, destination, cargo or flag state.
- Never present the approach-corridor or restricted-water judgement as observed — it is inferred and must carry its assumption.
- Never flag mooring/anchor-swing speeds (0.5–1 kt) or normal transit (cargo/tanker 8–14 kts, steady course) as anomalies.
- Never mark a finding `verified` — that is the evidence verifier's job.
- Never include any key, token, secret or secondary-provider credential in output.

## App module mapping
- Mirrors the planner/verification nodes' maritime heuristics in "OnDemand Spatial Advanced Workflow" v1 (`server/ondemand/workflow-definition.js`).
- `src/layers/vessels/` — `records.js` (AIS record shape), `evidence.js` (evidence cards), `policy.js`, `tracking.js`, `selection.js`.
- `src/data/aisLiveVessels.js`, `src/data/aisStreamAdapter.js`, `src/data/aisWatchdog.js` — client feed, partial/stale snapshot handling (AIS gaps).
- `server/providers/vessels/ais-live.js`, `server/providers/vessels/ais-store.js` — the AIS relay (501 in serverless mode until the maritime.live row lands, `docs/SERVERLESS_LIMITATIONS.md`).

## Version — `ondemand-spatial-skills v1 — 2026-09-18 — pairs with workflow "OnDemand Spatial Advanced Workflow" v1 (id 6aace534859f7b0abb53d99a)`
