# GodsEye Map Action Planner

**Dashboard fields** — Skill Name: `godseye-map-action-planner` · Description: Turns verified spatial findings into at most six schema-valid MapActions (framing, tracking, layer control, annotation, follow-up queries) and proposes safe next-step suggestions. · Category: `engineering` · Sample Prompts:
- "Fly to the airport and highlight the aircraft you flagged."
- "Turn on the earthquakes layer and mark the strongest nearby quake."
- "Track that vessel and tell me what else I should check."

## When to use this skill
- The workflow has reached the `spatial_action_planner` stage with verified findings, spatial context, and (optionally) prior suggested actions to build on.
- The user's request implies a concrete map/UI change: fly somewhere, track an entity, toggle a layer, mark a finding, or ask a follow-up data question.

## When NOT to use it
- Do not use this skill to classify intent, resolve capabilities, or run searches — those happen upstream (`intent_classifier`, `capability_resolver`, `planner`, `verification`).
- Do not use it to invent findings; it only converts findings already marked `verified` into actions.
- Do not use it when the request has no spatial/UI component at all (pure explanation with nothing to show).

## Trigger conditions
- Workflow node `spatial_action_planner` is reached with at least one `verified` finding, OR
- `intent` is `navigate`, `layer_control`, `entity_lookup`, or `temporal_query` and a concrete MapAction would satisfy it, OR
- The user says "show", "fly to", "track", "highlight", "mark", "turn on/off <layer>", "zoom", or "look at".

## Instructions
1. Read the spatial context (§13 fields: camera, viewport, center, altitude, zoom, viewScale, mapStack, visibleBounds, activeLayers, selectedEntity, trackedEntity, visibleEntities, timeline, investigation, userAction) and the findings handed in from `verification`.
2. Only plan actions for findings whose status is `verified`. Never emit an action whose sole justification is an `unverified` or `rejected` finding — drop those from consideration.
3. Select at most 6 actions total for `actions[]`. Fewer is fine; never pad the list just to reach 6.
4. Choose action names ONLY from the 28 names listed in "Allowed actions (28)" below. Never invent a name, alias, or shorthand for one of them.
5. For each action, populate `params` using ONLY the parameter keys documented for that exact action below. Never add an extra key, and never drop a required key (one with no trailing `?`).
6. Where a parameter is `enum[...]`, its value must come verbatim from that list. Never supply a value outside the listed set and never guess a plausible-looking member.
7. Where a parameter is `string`, `number`, `boolean`, `array<object>`, `array<string>`, or `object`, supply a value of that type; omit optional (`?`) parameters entirely rather than sending `null`.
8. To frame the area of interest, emit `fly_to_location` with `latitude`, `longitude`, `rangeM`, and `viewMode` — `close` for one entity, `overview` for a wider area.
9. For a verified anomalous entity, emit `track_entity` with `query` set to its callsign (aviation) or name (maritime) and `layerId` set to that entity's layer.
10. When findings require a layer that is not already active (or must be hidden), emit `set_layer_visibility` with that `layerId` and `enabled`.
11. To mark verified findings on the map, emit `annotate_map` with `annotations` (an array of `{type, latitude, longitude, label}` objects, one per finding worth marking), plus `flyTo` and `persist`.
12. When a question needs data the current view does not contain, emit `analyst_query` with `layers` and `followUp: true` instead of guessing an answer.
13. To review moving traffic over an area, emit `frame_overhead` with `target` and `radiusKm`.
14. Every action object is exactly `{name, params, reason, findingIds}`: one plain-language `reason`, and `findingIds` listing the verified finding id(s) it serves (empty array only for pure navigation/framing with no associated finding).
15. After `actions[]`, propose 0-4 `suggestedNextActions`, each `{label, action}`, where `action` is `null` (a suggestion needing the user's words to confirm) or a fully schema-valid `{name, params}` — e.g. `control_cctv` with `action: "nearest"` and `cameraQuery`, or `control_radio` with `action: "select"` and `category: "aviation-marine"`.
16. Never emit an action whose only purpose is acting on a `rejected` finding.
17. If there is no verified finding and no explicit navigation/layer/query request, return an empty `actions[]` with zero or few `suggestedNextActions` rather than manufacturing work.
18. Keep every parameter value literal and traceable to a finding or the user's request; never infer a coordinate, callsign, or id absent from context or findings.

## Allowed actions (28)
Reproduced verbatim from the MapAction schema (`GEV_ACTION_SCHEMAS`). Names, parameter keys, and enum members below are the ONLY ones this skill may emit; a trailing `?` marks an optional parameter.

```
fly_to_location(locationId?:enum[austin|sf|nyc|tokyo|london|paris|dubai|dc], query?:string, latitude?:number, longitude?:number, viewMode?:enum[close|overview], rangeM?:number, waitForArrival?:boolean)
select_nearest_aircraft(layerId:enum[flights|military], locationId?:enum[austin|sf|nyc|tokyo|london|paris|dubai|dc], locationQuery?:string, latitude?:number, longitude?:number)
adjust_camera_zoom(direction:enum[in|out], amount:enum[little|medium|lot])
zoom_to_globe()
set_layer_visibility(layerId:enum[flights|military|earthquakes|satellites|rocket-launches|traffic|cctv|radio|bikeshare|ais-live-vessels|local-datacenters|local-dams|telegeography-submarine-cables|local-firms|alpr-cameras], enabled:boolean)
show_data_layers_menu(layerId?:enum[flights|military|earthquakes|satellites|traffic|cctv|radio|bikeshare|ais-live-vessels|local-datacenters|local-dams|telegeography-submarine-cables|local-firms|alpr-cameras])
set_panel_open(panelId:enum[data-panel|location-bar|control-panel|cctv-panel|radio-panel|scene-panel|pp-toggles|global-context-panel], open:boolean)
set_context_mode(mode:enum[off|contacts|flights|space-missions|missions])
control_cockpit(action:enum[enter|exit|previous|next|prev|status], targetLayer?:enum[flights|military|ais-live-vessels|military-installations], aircraftClass?:string)
set_visual_style(style:enum[normal|retro|surveillance|thermal|anime|noir|snow])
get_entity_context(scope?:enum[auto|selected|in_view], layerId?:enum[local-datacenters|local-dams|telegeography-submarine-cables|local-firms], limit?:number)
get_current_view_state()
set_hud(visible?:enum[on|off|auto], layout?:enum[tactical|operator|minimal])
set_detection(enabled?:boolean, mode?:enum[sparse|balanced|dense], densityPct?:number, allocationStrategy?:enum[elastic|weighted])
set_map_stack(stack:enum[photoreal|bing-aerial|bing-labels|esri-imagery|osm])
set_post_processing(bloom?:object, sharpen?:object)
control_scene(action:enum[list|play|stop|next|status], sceneId?:string)
control_cctv(action:enum[enable|disable|select|next|prev|nearest|focus|coverage|viewshed|adjust|projection|autohop], cameraQuery?:string, enabled?:boolean)
control_radio(action:enum[enable|disable|play|resume|pause|stop|next|previous|volume|select|status], volumePct?:number, category?:enum[all|news|talk|weather|public-safety|aviation-marine|traffic-transit|music], locationId?:enum[austin|sf|nyc|tokyo|london|paris|dubai|dc], locationQuery?:string, latitude?:number, longitude?:number, country?:string, stationQuery?:string)
track_entity(query:string, layerId?:string)
stop_tracking()
frame_overhead(target:enum[flights|military|satellites|vessels], radiusKm?:number)
annotate_map(annotations:array<object>, flyTo?:boolean, persist?:boolean)
clear_annotations()
move_camera(motion:enum[orbit|pan|tilt|rotate|stop], direction?:enum[left|right|up|down], speed?:enum[slow|normal|fast], mode?:enum[once|continuous])
fly_route(label?:string, speed?:enum[slow|normal|fast])
analyst_query(layers?:array<string>, scope?:object, filters?:array<object>, sortBy?:string, sortDir?:enum[asc|desc], limit?:number, followUp?:boolean)
next_iss_pass(latitude?:number, longitude?:number, minElevationDeg?:number)
```

## Expected input
```json
{
  "spatialContext": {
    "center": { "latitude": 0, "longitude": 0 },
    "activeLayers": ["flights"],
    "visibleEntities": [],
    "selectedEntity": null,
    "trackedEntity": null,
    "visibleBounds": {}
  },
  "findings": [
    { "id": "string", "status": "verified|unverified|rejected", "severity": "info|notable|high", "entityId": "string", "layerId": "string", "summary": "string" }
  ],
  "intent": "anomaly_scan|entity_lookup|area_summary|navigate|layer_control|temporal_query|compare|explain|other",
  "tier": "ASK|INVESTIGATE|DEEP"
}
```

## Expected output
```json
{
  "actions": [
    { "name": "one of the 28 action names", "params": {}, "reason": "string", "findingIds": ["string"] }
  ],
  "suggestedNextActions": [
    { "label": "string", "action": { "name": "one of the 28 action names", "params": {} } }
  ]
}
```

## Never
- Never emit an action name outside the 28 in "Allowed actions (28)".
- Never send a parameter key that is not part of that action's own signature.
- Never send an enum value that is not in that parameter's own enum list.
- Never emit more than 6 actions in `actions[]`.
- Never act on a finding whose status is `unverified` or `rejected`.
- Never fabricate a latitude/longitude/callsign/id not present in context or findings.
- Never include any key, token, secret or secondary-provider credential in output.

## App module mapping
- Mirrors workflow node `spatial_action_planner` in "GodsEye Advanced Spatial Workflow" v1.
- src/voice/actionSchemas.js — `GEV_ACTION_SCHEMAS`, the schema this skill's output must satisfy.
- src/voice/commands.js — dispatches a validated MapAction to the app.
- src/voice/session.js — carries context and findings into this planning step.

## Version — `godseye-skills v1 — 2026-09-18 — pairs with workflow "GodsEye Advanced Spatial Workflow" v1 (id 6aace534859f7b0abb53d99a)`
