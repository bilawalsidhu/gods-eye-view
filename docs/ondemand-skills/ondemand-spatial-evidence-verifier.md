# OnDemand Spatial Evidence Verifier

**Dashboard fields** — Skill Name: `ondemand-spatial-evidence-verifier` · Description: Adversarially re-checks every candidate finding against the raw spatial context, marks it verified / unverified / rejected, downgrades unjustified severity and emits one evidence row per literal supporting value, keeping observed, inferred and unknown strictly apart. · Category: `research` · Sample Prompts:
- "Verify these findings against the raw context and reject anything not literally supported."
- "Which of the flagged anomalies are actually backed by field values in the snapshot?"
- "Produce the evidence table for finding f1 and downgrade its severity if it is not justified."

## When to use this skill
- After a planner / analyst step has produced candidate findings and before anything is shown to the analyst or turned into map actions — it is the gate between "claimed" and "reported".
- Whenever a finding will be quoted as fact, drive a `track_entity` / `annotate_map` action, or be recorded in an investigation.

## When NOT to use it
- On raw context with no candidate findings (nothing to verify — run the analysts first).
- To generate new findings: this skill only confirms, weakens or rejects claims it is given; new observations go back to the analyst skills.
- To validate a capability result that is not present in the run (e.g. an `earthquake_search` that was planned but not executed) — that goes to `unknowns`, never to `verified`.

## Trigger conditions
- Input contains `plan.candidateFindings` (or `findings`) with at least one entry, plus the `spatialContext` they refer to.
- The intent tier is `INVESTIGATE` or `DEEP`, or any finding has severity `high`.
- A downstream step is about to emit actions with non-empty `findingIds`.

## Instructions
1. Load `spatialContext` (the 15 §13 fields) and `derived`. Treat `visibleEntities` as the only source of entity facts; treat `derived` values as computed facts that must themselves be re-derivable from `visibleEntities` (spot-check at least the counts you rely on).
2. For each candidate finding, list every value the claim depends on: entity ids, field names and the literal values (e.g. `squawk = "7700"`, `onGround = false`, `altitudeM = 3350`).
3. Locate each value in `visibleEntities` (or in the named `spatialContext` field). Record a hit as an evidence row `{findingId, entityId, field, value, sourceLayer}` with the value copied exactly as it appears (same type, same spelling).
4. Decide the status:
   - `verified` — every supporting value exists and the claim follows from those values alone.
   - `unverified` — support is partial (a value is missing, or the claim needs an assumption such as a corridor, a threshold or a prior snapshot).
   - `rejected` — a supporting value is absent, contradicts the claim, or the claim references an entity/field that is not in the input.
5. Re-read every `kind`: a claim built on a threshold, geometry assumption or domain rule is `inferred`, not `observed`, even when its inputs are observed. Correct the kind and say why in `note`.
6. Re-judge severity from the evidence, never from the wording: an emergency squawk (7500/7600/7700) on an airborne aircraft stays `high`; a vessel under way "near the approach" with no corridor geometry in the input is at most `notable`; anything `unverified` cannot be `high`; anything `rejected` gets `severity: null`.
7. Cross-check contradictions across findings (the same entity described as moored in one and moving in another) and reject the weaker one, citing the conflicting evidence rows.
8. Every capability call whose result is not present in the run (`calls[]` without a matching result object) is copied into `unknowns` with the wording "result of <capabilityId> not available inside this run" — it is neither evidence for nor against any finding.
9. Add to `unknowns` anything a diligent analyst would want that the input cannot provide (prior snapshots, runway geometry, NOTAMs, weather, vessel destinations).
10. Preserve the finding ids exactly (`f1`, `m1`, …) so later steps can reference them; never renumber.
11. Keep notes short and literal: quote the field and value that decided the status.
12. Pass the whole pipeline state through unchanged in `state`; append, never replace, `unknowns`.

## Expected input
```json
{
  "plan": {
    "candidateFindings": [
      { "id": "f1", "claim": "SWR9DE is airborne and squawking 7700", "kind": "observed", "supportingEntityIds": ["icao24:4b1a0c"], "supportingFields": ["squawk", "onGround", "altitudeM"], "severity": "high" },
      { "id": "f2", "claim": "MSC KHALIFA is under way inside the approach corridor", "kind": "observed", "supportingEntityIds": ["mmsi:636019876"], "supportingFields": ["navStatus", "speedKts", "courseDeg"], "severity": "high" }
    ],
    "unknowns": ["result of earthquake.search not available inside this run"]
  },
  "calls": [ { "capabilityId": "earthquake.search", "ondemandTool": "earthquake_search", "route": "/api/sources/earthquakes", "params": {} } ],
  "intent": { "intent": "anomaly_scan", "tier": "INVESTIGATE" },
  "state": { "spatialContext": { "visibleEntities": [ { "layerId": "flights", "id": "icao24:4b1a0c", "callsign": "SWR9DE", "squawk": "7700", "onGround": false, "altitudeM": 3350 } ] }, "derived": {} }
}
```

## Expected output
```json
{
  "findings": [
    { "id": "f1", "claim": "SWR9DE is airborne and squawking 7700", "kind": "observed", "status": "verified", "severity": "high", "supportingEntityIds": ["icao24:4b1a0c"], "note": "squawk \"7700\", onGround false, altitudeM 3350 all present" },
    { "id": "f2", "claim": "MSC KHALIFA is under way inside the approach corridor", "kind": "inferred", "status": "unverified", "severity": "notable", "supportingEntityIds": ["mmsi:636019876"], "note": "navStatus/speedKts/courseDeg present; corridor geometry not in input — kind corrected to inferred, severity downgraded from high" }
  ],
  "evidence": [
    { "findingId": "f1", "entityId": "icao24:4b1a0c", "field": "squawk", "value": "7700", "sourceLayer": "flights" },
    { "findingId": "f1", "entityId": "icao24:4b1a0c", "field": "onGround", "value": false, "sourceLayer": "flights" },
    { "findingId": "f1", "entityId": "icao24:4b1a0c", "field": "altitudeM", "value": 3350, "sourceLayer": "flights" }
  ],
  "unknowns": ["result of earthquake.search not available inside this run", "no runway/approach geometry in the input"],
  "calls": "<copied>",
  "intent": "<copied>",
  "state": "<copied unchanged>"
}
```

## Never
- Never mark a finding `verified` on the strength of its wording, a derived value you did not re-check, or a capability result that is not in the run.
- Never let an `unverified` or `inferred` finding keep `severity: high`.
- Never invent a supporting value, round a value, or change its type (a squawk is the string `"7700"`, not the number 7700).
- Never drop or renumber finding ids; never delete an upstream `unknowns` entry.
- Never include any key, token, secret or secondary-provider credential in output.

## App module mapping
- Mirrors the `verification` node of "OnDemand Spatial Advanced Workflow" v1 (`server/ondemand/workflow-definition.js`; the node prompt is the authoritative wording).
- `docs/audit/media-grounding-verification.md` — provenance-labelling rules (observed vs inferred) applied to media, reused here for entity evidence.
- `src/layers/flights/evidence.js`, `src/layers/vessels/evidence.js` — the evidence cards the UI renders from the same field names.
- `server/ondemand/workflow-definition.js#validateStructuredResponse` — the shape check that runs on the final output downstream.

## Version — `ondemand-spatial-skills v1 — 2026-09-18 — pairs with workflow "OnDemand Spatial Advanced Workflow" v1 (id 6aace534859f7b0abb53d99a)`
