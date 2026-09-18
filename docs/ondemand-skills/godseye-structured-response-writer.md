# GodsEye Structured Response Writer

**Dashboard fields** — Skill Name: `godseye-structured-response-writer` · Description: Writes the analyst-facing answer (3–8 plain sentences that quote literal values and separate verified from unverified and unchecked) and emits the God's Eye StructuredResponse with exactly the seven keys message, entities, actions, evidence, sources, suggestedNextActions, runMeta. · Category: `engineering` · Sample Prompts:
- "Turn these verified findings and actions into the final StructuredResponse."
- "Write the analyst message for this run — verified first, then unverified, then what could not be checked."
- "Format the answer as the seven-key contract and drop any action that is not a known MapAction."

## When to use this skill
- As the last step of every God's Eye analysis: the findings are verified, the MapActions are planned, and the client now needs the contract object it renders and executes.
- Whenever a response must be machine-consumed by the God's Eye UI (`actions` are dispatched to the map; `entities` drive selection; `sources` drive provenance labels).

## When NOT to use it
- Before verification has run — an unverified plan must not be dressed up as a final answer.
- For free-form chat where no spatial context exists (plain `/api/ondemand/chat` answers are prose, not this contract).
- To add analysis: this skill formats and phrases; it does not create findings, actions or evidence.

## Trigger conditions
- Input contains verified `findings`, `evidence`, `actions` (from the map-action planner) and `state.query`.
- The caller asks for "the final answer", "the StructuredResponse", "the response object" or the workflow reaches its sink node.

## Instructions
1. Write `message` first, as plain text (no Markdown, no bullet characters, 3–8 sentences):
   1. Lead with the `verified` findings, most severe first. Name each entity by callsign or vessel name plus id, and quote the literal values that support it (e.g. "squawking 7700 at 3350 m and 240 kts").
   2. Then state `unverified` findings, explicitly labelled as such ("not confirmed: …", "assumed corridor: …").
   3. Then say what could not be checked: every entry of `unknowns`, and every planned capability call whose result was not available ("the planned earthquake search was not executed inside this run").
   4. If nothing was verified, say so in the first sentence; never fill the gap with speculation.
2. Build `entities`: one object per entity referenced in the message — `{id, layerId, label (callsign or name), role: "finding" | "context", latitude, longitude}` — values copied from `visibleEntities`.
3. Copy `actions` from the planner unchanged, then filter: drop any action whose `name` is not one of the 28 MapAction names (`fly_to_location, select_nearest_aircraft, adjust_camera_zoom, zoom_to_globe, set_layer_visibility, show_data_layers_menu, set_panel_open, set_context_mode, control_cockpit, set_visual_style, get_entity_context, get_current_view_state, set_hud, set_detection, set_map_stack, set_post_processing, control_scene, control_cctv, control_radio, track_entity, stop_tracking, frame_overhead, annotate_map, clear_annotations, move_camera, fly_route, analyst_query, next_iss_pass`) and any action whose `findingIds` point only at `rejected` findings. Keep each as `{name, params, reason, findingIds}`.
4. Copy `evidence` unchanged (`{findingId, entityId, field, value, sourceLayer}` rows from the verifier).
5. Build `sources`: one entry per distinct `sourceLayer` in the evidence — `{id: <layerId>, kind: "in_view", label, status: "used"}` with labels `ADS-B (flights layer)`, `ADS-B (military layer)`, `AIS (ais-live-vessels layer)`, `USGS (earthquakes layer)` — plus one per planned capability call — `{id: <capabilityId>, kind: "capability", label: "USGS FDSN Event (earthquake_search)", status: "planned_not_executed"}` (or `"used"` when its result was present and cited).
6. Copy `suggestedNextActions` unchanged — `[{label, action: {name, params} | null}]` — applying the same 28-name filter to `action.name`.
7. Build `runMeta`: `{workflow: "GodsEye Advanced Spatial Workflow", flowVersion: 1, mode: state.mode ("live" | "selftest"), intent: intent.intent, tier: intent.tier, confidence: intent.confidence, selectedCapabilityIds: [ids from calls], unknowns: [...], nodeChain: ["session_context","spatial_context_builder","intent_classifier","capability_resolver","planner","verification","spatial_action_planner","synthesis","structured_response"], generatedAtUtc: state.spatialContext.timeline.now}`.
8. Emit ONE JSON object with exactly these seven keys in this order: `message, entities, actions, evidence, sources, suggestedNextActions, runMeta`. No extra keys (no `debug`, `findings`, `state`), no missing keys, no prose around the object.
9. Self-check before emitting: every key present; `message` non-empty; every list is an array; every `actions[].name` is in the 28; every entity in the message appears in `entities`; every `sources[].status` is `used` or `planned_not_executed`.
10. Keep numbers as numbers and ids as strings; never round evidence values in the message differently from the evidence rows.

## Expected input
```json
{
  "message": null,
  "actions": [ { "name": "track_entity", "params": { "query": "SWR9DE", "layerId": "flights" }, "reason": "Track aircraft squawking 7700", "findingIds": ["f1"] } ],
  "suggestedNextActions": [ { "label": "Enable CCTV near approach area", "action": { "name": "control_cctv", "params": { "action": "nearest", "cameraQuery": "airport approach" } } } ],
  "findings": [ { "id": "f1", "claim": "SWR9DE is airborne and squawking 7700", "kind": "observed", "status": "verified", "severity": "high", "supportingEntityIds": ["icao24:4b1a0c"] } ],
  "evidence": [ { "findingId": "f1", "entityId": "icao24:4b1a0c", "field": "squawk", "value": "7700", "sourceLayer": "flights" } ],
  "unknowns": ["result of earthquake.search not available inside this run"],
  "calls": [ { "capabilityId": "earthquake.search", "ondemandTool": "earthquake_search" } ],
  "intent": { "intent": "anomaly_scan", "tier": "INVESTIGATE", "confidence": 0.98 },
  "state": { "mode": "selftest", "query": "What is unusual around this airport?", "spatialContext": { "timeline": { "now": "2026-09-18T07:00:00.000Z" }, "visibleEntities": [ { "layerId": "flights", "id": "icao24:4b1a0c", "callsign": "SWR9DE", "latitude": 24.489, "longitude": 54.571 } ] } }
}
```

## Expected output
```json
{
  "message": "The clearest verified anomaly is aircraft SWR9DE (icao24:4b1a0c), airborne and squawking 7700. No other finding was verified. The planned earthquake search was not executed inside this run, so seismic context could not be checked.",
  "entities": [ { "id": "icao24:4b1a0c", "layerId": "flights", "label": "SWR9DE", "role": "finding", "latitude": 24.489, "longitude": 54.571 } ],
  "actions": [ { "name": "track_entity", "params": { "query": "SWR9DE", "layerId": "flights" }, "reason": "Track aircraft squawking 7700", "findingIds": ["f1"] } ],
  "evidence": [ { "findingId": "f1", "entityId": "icao24:4b1a0c", "field": "squawk", "value": "7700", "sourceLayer": "flights" } ],
  "sources": [
    { "id": "flights", "kind": "in_view", "label": "ADS-B (flights layer)", "status": "used" },
    { "id": "earthquake.search", "kind": "capability", "label": "USGS FDSN Event (earthquake_search)", "status": "planned_not_executed" }
  ],
  "suggestedNextActions": [ { "label": "Enable CCTV near approach area", "action": { "name": "control_cctv", "params": { "action": "nearest", "cameraQuery": "airport approach" } } } ],
  "runMeta": {
    "workflow": "GodsEye Advanced Spatial Workflow",
    "flowVersion": 1,
    "mode": "selftest",
    "intent": "anomaly_scan",
    "tier": "INVESTIGATE",
    "confidence": 0.98,
    "selectedCapabilityIds": ["earthquake.search"],
    "unknowns": ["result of earthquake.search not available inside this run"],
    "nodeChain": ["session_context", "spatial_context_builder", "intent_classifier", "capability_resolver", "planner", "verification", "spatial_action_planner", "synthesis", "structured_response"],
    "generatedAtUtc": "2026-09-18T07:00:00.000Z"
  }
}
```

## Never
- Never add, rename or omit one of the seven keys; never wrap the object in prose or Markdown fences.
- Never present an `unverified` or `inferred` finding as fact in `message`, and never omit the "could not be checked" sentence when `unknowns` is non-empty.
- Never emit an action or suggested action whose name is outside the 28 MapAction names, or one tied only to rejected findings.
- Never invent an entity, coordinate, source or capability result.
- Never include any key, token, secret or secondary-provider credential in output.

## App module mapping
- Mirrors the `synthesis` and `structured_response` nodes of "GodsEye Advanced Spatial Workflow" v1 (`server/ondemand/workflow-definition.js`); `validateStructuredResponse()` in the same module is the reference check (7 keys, 28 names).
- `src/voice/actionSchemas.js` — `GEV_ACTION_SCHEMAS`, the 28 names and parameter schemas the client enforces before dispatch; `src/voice/session.js` — action dispatch.
- `api/ondemand/chat.js`, `api/ondemand/workflow.js` — the proxy routes that return fulfillment text / workflow node outputs to the client.
- `docs/ondemand-workflows/verification-2026-09-18.json` — a real StructuredResponse produced by the live workflow, useful as a reference sample.

## Version — `godseye-skills v1 — 2026-09-18 — pairs with workflow "GodsEye Advanced Spatial Workflow" v1 (id 6aace534859f7b0abb53d99a)`
