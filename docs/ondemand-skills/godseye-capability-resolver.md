# GodsEye Capability Resolver

**Dashboard fields** — Skill Name: `godseye-capability-resolver` · Description: Selects capabilities strictly from the supplied catalogue, builds each tool call's params from only that entry's declared params, and lists needs the catalogue cannot meet — never inventing a capability, tool, route, or parameter. · Category: `engineering` · Sample Prompts:
- "Given this catalogue and intent, which capability (if any) should handle an earthquake search near the current view?"
- "Build the earthquake_search call params for a 30-day window around the current center."
- "This need has no matching capability — what goes in unmetNeeds?"

## When to use this skill
- After `godseye-intent-classifier` produces an intent/tier/focus with `needsExternalData: true` (or the planner needs an external capability call), to translate that need into a concrete, catalogue-backed tool call.
- Whenever a capability catalogue (`src/registry/capabilities.json`-shaped) is supplied and a need must be matched against it strictly by entry.
- To compute `earthquake_search`'s circle-search params (latitude/longitude/maxradiuskm/starttime/minmagnitude/orderby/limit) from spatial context and derived facts.

## When NOT to use it
- To classify intent or tier — that is `godseye-intent-classifier`.
- To parse or normalize the raw spatial context — that is `godseye-spatial-context-reader`.
- When `needsExternalData` is `false` and no other explicit need exists — return empty `selectedCapabilityIds`/`calls`, noting `unmetNeeds` only if something was actually unmet.
- To invent a capability absent from the supplied catalogue, even if one would help — record it in `unmetNeeds` instead.

## Trigger conditions
- The workflow reaches `capability_resolver` in the "GodsEye Advanced Spatial Workflow", immediately after `intent_classifier` and before `planner`.
- The intent classification carries `needsExternalData: true`, or the focus names a need not covered by what's already on screen.
- A caller supplies a capability catalogue and asks which entries apply and what params to call them with.

## Instructions
1. Receive three inputs: the intent-classifier output (`intent, tier, focus, needsExternalData, rationale`), the normalized spatial context/derived facts, and the capability catalogue (array shaped like `src/registry/capabilities.json`: `id, provider, route, ondemand_tool, ondemand_tool_id, coverage, auth, status, definition, notes, params`).
2. Treat the catalogue as the only source of truth for what capabilities exist; never assume one exists because it seems logical.
3. If the catalogue is empty, or no entry's `definition`/`notes` addresses the need, return empty `selectedCapabilityIds` and `calls`, and describe the gap in `unmetNeeds`; stop.
4. Match the need (from `intent`, `focus`, `rationale`) to catalogue entries by documented purpose; today's catalogue holds exactly one entry, `earthquake.search` (USGS FDSN Event, route `/api/sources/earthquakes`, tool `earthquake_search`, coverage `observed`, auth `none`) — select it only for a seismic need.
5. Never select a capability whose `status` marks it unavailable, or whose `coverage`/`auth` cannot satisfy the need — route that need to `unmetNeeds` instead.
6. For each selected capability, look up its `params[]` (`earthquake_search`: `starttime, endtime, minmagnitude, maxmagnitude, latitude, longitude, maxradiuskm, minlatitude, maxlatitude, minlongitude, maxlongitude, limit, orderby, mode`) and build params using only those keys.
7. Never add a param key that is not declared on the matched entry, and never rename a declared key.
8. For `earthquake_search`, always build a circle search (never bbox) unless the need explicitly requires a rectangular region: set `latitude`/`longitude` from the normalized context's `center`.
9. Set `maxradiuskm` from the derived `viewRadiusKm`, but never below 100 km — use `max(viewRadiusKm, 100)` for regional context.
10. Set `starttime` to `timeline.now` minus 30 days, in the format the catalogue entry documents; leave `endtime` unset unless `focus.timeWindow.end` specifies an earlier cutoff.
11. Set `minmagnitude` to `2.5` unless the query/focus asks for a different threshold, staying within the entry's documented -2..10 range.
12. Set `orderby` to `time` unless the need specifically calls for magnitude ordering, in which case use `magnitude`.
13. Set `limit` to a value ≤ 200 (the entry's documented cap); default `100` unless the need justifies otherwise.
14. Never populate both circle params (`latitude, longitude, maxradiuskm`) and bbox params (`minlatitude, maxlatitude, minlongitude, maxlongitude`) on the same call — the API rejects mixed requests with 400.
15. Never submit a partial circle or partial bbox — the API rejects it with 400; if one of the three circle values is unavailable, add the need to `unmetNeeds` instead of guessing it.
16. Prefer `focus.timeWindow.start`/`end` over the 30-day default when the query specifies an explicit window (e.g. "the last year"), still formatted per the entry's documented format.
17. Set each call's `purpose` to a short phrase describing why it answers the need (e.g. "regional earthquake context for the current view").
18. Set `ondemandTool` from the matched entry's `ondemand_tool` field; never fabricate a tool name.
19. Set `route` from the matched entry's `route` field; never fabricate a route.
20. Set `capabilityId` from the matched entry's `id` field; list every selected id, in call order, in `selectedCapabilityIds`.
21. If a need cannot be matched to any catalogue entry, do not build a call for it — add a short, specific description to `unmetNeeds`.
22. If a need matches an entry only partially, still build the closest valid call from its declared params, and note the shortfall in `unmetNeeds`.
23. Never call more than one capability per distinct need; skip building a call for a need already answered by the normalized context/derived facts.
24. Never treat `activeLayers` or `visibleEntities` as callable capabilities — they are already-known data, not tools.
25. Assemble `calls` as an array of objects with exactly the five keys `capabilityId, ondemandTool, route, params, purpose`, in that order.
26. Assemble the result with exactly three top-level keys: `selectedCapabilityIds, calls, unmetNeeds`.
27. Return `selectedCapabilityIds: []` and `calls: []` (never null, never omitted) when no capability applies; populate `unmetNeeds` only if there was an actual unmet need.
28. Never reformat a catalogue-declared key or tool name; copy it exactly as it appears in the entry.
29. If two entries could both serve the same need, prefer coverage `observed` over `inferred`/`unknown`, and note the tie-break in that call's `purpose`.
30. Do not select a capability solely because it is the only one available — confirm its `definition`/`notes` genuinely addresses the current need first.
31. When the catalogue grows beyond `earthquake.search`, apply the same discipline: read every entry's `id, provider, coverage, auth, status, definition, notes` before choosing.
32. Treat `mode` on `earthquake_search` as `query` by default; use `mode: "count"` only when the need is explicitly "how many", not "list them".
33. Leave `endtime` absent from `params` entirely when no explicit end is required, rather than setting it to an empty string or null.
34. If both `minmagnitude` and `maxmagnitude` are set, ensure `minmagnitude <= maxmagnitude` and both fall in -2..10; drop the invalid one and note it in `unmetNeeds` rather than sending an invalid pair.
35. Always resolve against whatever entries are actually supplied at run time; never assume the catalogue is fixed to what this brief describes today.
36. If `needsExternalData` is false and no other explicit need is present, return all three output arrays empty rather than searching for a capability to justify a call.
37. Keep `purpose` to one short phrase per call; do not restate the full intent-classifier rationale.
38. Never leak catalogue `auth` values, keys, or tokens into `params`, `purpose`, or `unmetNeeds` — only structural fields (ids, routes, tool names) belong in the output.
39. Hand the result to the `planner` step; add no keys beyond the documented shape.
40. Return the three-key object even when both `calls` and `unmetNeeds` are empty — never omit a key.

## Expected input
```json
{
  "intentResult": {
    "intent": "area_summary",
    "confidence": 0.81,
    "tier": "INVESTIGATE",
    "focus": { "entityIds": [], "layers": ["earthquakes"], "timeWindow": { "start": null, "end": null } },
    "needsExternalData": true,
    "rationale": "The query asks for seismic activity in the current view, needing an external USGS search."
  },
  "normalizedContext": { "center": { "latitude": 34.05, "longitude": -118.25 } },
  "derived": { "viewRadiusKm": 82.3 },
  "capabilityCatalogue": [
    {
      "id": "earthquake.search",
      "provider": "USGS FDSN Event",
      "route": "/api/sources/earthquakes",
      "ondemand_tool": "earthquake_search",
      "ondemand_tool_id": "catalogue-supplied-id",
      "coverage": "observed",
      "auth": "none",
      "status": "active",
      "definition": "Search USGS earthquake events by circle or bbox.",
      "notes": "Circle and bbox are mutually exclusive.",
      "params": ["starttime","endtime","minmagnitude","maxmagnitude","latitude","longitude","maxradiuskm","minlatitude","maxlatitude","minlongitude","maxlongitude","limit","orderby","mode"]
    }
  ]
}
```

## Expected output
```json
{
  "selectedCapabilityIds": ["earthquake.search"],
  "calls": [
    {
      "capabilityId": "earthquake.search",
      "ondemandTool": "earthquake_search",
      "route": "/api/sources/earthquakes",
      "params": {
        "latitude": 34.05,
        "longitude": -118.25,
        "maxradiuskm": 100,
        "starttime": "2026-08-19",
        "minmagnitude": 2.5,
        "orderby": "time",
        "limit": 100
      },
      "purpose": "regional earthquake context for the current view"
    }
  ],
  "unmetNeeds": []
}
```

## Never
- Never select a capability, tool, route, or param not present in the supplied catalogue.
- Never mix circle params (latitude, longitude, maxradiuskm) with bbox params (minlatitude, maxlatitude, minlongitude, maxlongitude) on one call.
- Never submit a partial circle or a partial bbox.
- Never set `maxradiuskm` below 100 km, or `limit` above 200.
- Never omit `selectedCapabilityIds`, `calls`, or `unmetNeeds` from the output, even when empty.
- Never emit an API key, token, secret, or credential in any field.

## App module mapping
- Mirrors workflow node `capability_resolver` in the "GodsEye Advanced Spatial Workflow".
- `src/registry/capabilities.json` — the capability catalogue this skill must resolve against, never extend from imagination.
- `docs/ondemand-workflows/tools/earthquake_search.json` — the declared param list and constraints for the `earthquake_search` tool.
- `server/serverless/earthquakes-route.js` — the live route (`/api/sources/earthquakes`) the resolved call ultimately reaches.

## Version — `godseye-skills v1 — 2026-09-18 — pairs with workflow "GodsEye Advanced Spatial Workflow" v1 (id 6aace534859f7b0abb53d99a)`
