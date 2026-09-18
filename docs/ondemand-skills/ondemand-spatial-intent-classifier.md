# OnDemand Spatial Intent Classifier

**Dashboard fields** — Skill Name: `ondemand-spatial-intent-classifier` · Description: Classifies a user query plus normalized spatial context into one of nine intents with a confidence score, an ASK/INVESTIGATE/DEEP tier, a focus set, and a one-sentence rationale, using low reasoning effort. · Category: `engineering` · Sample Prompts:
- "Classify this query: 'Why did that vessel change course near the strait?'"
- "What tier and intent apply to 'zoom into the earthquake cluster off Japan'?"
- "Does this request need external data, and what's the one-sentence rationale?"

## When to use this skill
- Immediately after the spatial context has been read and normalized, to turn a free-text user query plus the normalized context into a machine-actionable intent, tier, and focus before any capability is chosen.
- Whenever a request needs routing to ASK/INVESTIGATE/DEEP handling based on its complexity and whether it needs a capability beyond what's already on screen.

## When NOT to use it
- To parse or validate the raw §13 spatial-context JSON — that is `ondemand-spatial-spatial-context-reader`; this skill assumes normalized context as input.
- To pick capabilities, build tool call params, or check a capability catalogue — that is `ondemand-spatial-capability-resolver`.
- To produce the final structured response, actions, or evidence — that belongs to later workflow steps (planner, verification, spatial_action_planner, synthesis, structured_response).
- To spend more than one sentence of rationale or add exploratory analysis — this step is intentionally terse (low reasoning effort).

## Trigger conditions
- A user query arrives together with a normalized spatial context (output of `ondemand-spatial-spatial-context-reader`).
- The workflow reaches the `intent_classifier` step of the "OnDemand Spatial Advanced Workflow", immediately after `spatial_context_builder` and before `capability_resolver`.
- A caller needs to know whether a request can be answered from what's already visible (ASK), needs cross-layer reasoning or one external capability (INVESTIGATE), or needs a multi-step evidence chain (DEEP).

## Instructions
1. Receive two inputs: the user's free-text query, and the normalized spatial context (plus derived facts) from `ondemand-spatial-spatial-context-reader`.
2. Read the query once; classify with the information given — do not ask follow-up questions.
3. Select exactly one intent from: `anomaly_scan, entity_lookup, area_summary, navigate, layer_control, temporal_query, compare, explain, other`.
4. Use `anomaly_scan` when the query looks for something unusual, unexpected, or emergency-related (e.g. squawk 7700, erratic vessel behavior, unexplained cluster).
5. Use `entity_lookup` when the query asks about one specific, already-identified entity (a callsign, an mmsi, a named vessel, a quake id).
6. Use `area_summary` when the query asks "what's happening here / in this region" without naming a specific entity.
7. Use `navigate` when the query asks to move the view (pan, zoom, fly to, center on, track).
8. Use `layer_control` when the query asks to show, hide, filter, or toggle a layer or layer set.
9. Use `temporal_query` when the query is primarily about a time window (e.g. last 24 hours, since yesterday).
10. Use `compare` when the query asks to compare two or more entities, layers, or time periods.
11. Use `explain` when the query asks why or how something happened.
12. Use `other` only when none of the eight named intents fit; never leave intent blank.
13. Assign `confidence` between 0 and 1; use values below 0.5 when the query is vague or fits more than one intent.
14. Select exactly one tier from `ASK, INVESTIGATE, DEEP`.
15. Choose `ASK` when the answer is one fact already in the context/derived facts, or one navigation step, needing no external capability.
16. Choose `INVESTIGATE` when the query needs reasoning across more than one layer, or exactly one external capability call.
17. Choose `DEEP` when the query needs a multi-step investigation producing a chain of evidence.
18. Never choose `DEEP` for a one-step query; never choose `ASK` for a query that needs an external capability call.
19. This skill only names the tier; downstream, `ASK` maps to `predefined-gpt-5.6-luna` at reasoning `low`, `INVESTIGATE` to `predefined-claude-sonnet-5` at `low`, `DEEP` to `predefined-claude-sonnet-5` at `high`, per `TIER_DEFAULTS` in `server/ondemand/config.js`.
20. Build `focus.entityIds` from every entity the query names explicitly, plus any current `selectedEntity`/`trackedEntity`; use `[]` if none.
21. Build `focus.layers` from every layerId the query concerns, preferring layers already in `activeLayers`; if layer-agnostic, use the layers with the largest `entityCounts`.
22. Build `focus.timeWindow` from any explicit time phrase (e.g. "last 24 hours" → `start` = `timeline.now` minus 24h, `end` = `timeline.now`); otherwise set both to `null`.
23. Set `needsExternalData` to `true` only when answering requires a capability call beyond what's already in the normalized context/derived facts; otherwise `false`.
24. Set `needsExternalData` to `false` whenever tier is `ASK`, by definition.
25. Write exactly one sentence for `rationale` stating the deciding factor; no second sentence, no list, no hedging.
26. Keep the whole output terse: no step-by-step reasoning, no restated context — this node runs at low reasoning effort.
27. For an empty, unintelligible, or off-topic query, use intent `other`, tier `ASK`, `confidence` at or below 0.3, `needsExternalData` false, empty focus lists, and a one-sentence rationale saying the query could not be mapped.
28. Never guess an entityId, layer, or time window not supported by the query text or context; leave the field empty instead.
29. If the query plausibly matches more than one intent, prefer `entity_lookup` over `area_summary` over `anomaly_scan` when several apply, and lower confidence accordingly.
30. If the query names an entity id absent from the context, still include it in `focus.entityIds`, but do not raise confidence above 0.6.
31. Treat a bare navigation phrase ("zoom in", "go north") as `navigate` at tier `ASK` unless it also asks a factual question, in which case favor the factual intent.
32. Treat a request to add/remove/toggle a layer ("hide vessels", "turn on earthquakes") as `layer_control` at tier `ASK`.
33. Never output `needsExternalData: true` unless tier is `INVESTIGATE` or `DEEP`.
34. Never name a specific capability, tool, or route anywhere in this skill's output — that decision belongs entirely to `ondemand-spatial-capability-resolver`.
35. Never repeat the raw query text verbatim inside `rationale`; state the reason in your own words.
36. Do not let non-empty `contextWarnings` change the intent or tier by themselves unless the query concerns the specific field the warning names.
37. Keep `focus.layers` limited to layerIds that actually appear in `activeLayers` or `entityCounts`; never invent a layerId not seen in the context.
38. Round `confidence` to two decimal places.
39. Assemble the result with exactly six top-level keys: `intent, confidence, tier, focus, needsExternalData, rationale`.
40. Hand the result to the `capability_resolver` step; add no keys beyond the documented shape.

## Expected input
```json
{
  "query": "Why did that vessel change course near the strait?",
  "normalizedContext": { "center": { "latitude": 34.05, "longitude": -118.25 }, "activeLayers": ["ais-live-vessels"] },
  "derived": { "entityCounts": { "ais-live-vessels": 1 }, "vesselsUnderWay": ["mmsi:366123456"] },
  "contextWarnings": []
}
```

## Expected output
```json
{
  "intent": "explain",
  "confidence": 0.72,
  "tier": "INVESTIGATE",
  "focus": {
    "entityIds": ["mmsi:366123456"],
    "layers": ["ais-live-vessels"],
    "timeWindow": { "start": null, "end": null }
  },
  "needsExternalData": false,
  "rationale": "The query asks for a causal explanation of one already-visible vessel's course change, needing cross-layer reasoning but no external capability."
}
```

## Never
- Never emit an intent outside the nine-value enum, or a tier outside ASK/INVESTIGATE/DEEP.
- Never write more than one sentence for `rationale`.
- Never select a capability, tool, route, or param — out of scope for this skill.
- Never fabricate an entityId, layerId, or timeWindow not supported by the query or context.
- Never re-run or second-guess `ondemand-spatial-spatial-context-reader`'s normalization; trust its output as given.
- Never emit an API key, token, secret, or credential in any field.

## App module mapping
- Mirrors workflow node `intent_classifier` in the "OnDemand Spatial Advanced Workflow".
- `api/ondemand/chat.js` — sends the query and context into the workflow and receives this node's output.
- `server/ondemand/config.js` — `tierDefaults()` / `TIER_DEFAULTS` define the model and reasoning effort applied per tier downstream of this classification.

## Version — `ondemand-spatial-skills v1 — 2026-09-18 — pairs with workflow "OnDemand Spatial Advanced Workflow" v1 (id 6aace534859f7b0abb53d99a)`
