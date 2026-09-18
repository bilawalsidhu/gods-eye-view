# OnDemand dashboard registration pack — GodsEye (2026-09-18)

## 0. Purpose and status

This pack is the hand-off document for the one part of the God's Eye ⇄ OnDemand
integration that cannot be done by API: registering the **GodsEye Spatial
Intelligence Agent**, the **earthquake_search REST agent**, and the **nine
GodsEye skills** in the OnDemand dashboard. It records exactly what was
already created via API in this run, why the remaining artifacts must be
created by hand, the literal dashboard field values and file contents to
paste, click-by-click steps citing the fetched documentation, and where each
returned id must be pasted back into the repo afterwards.

| # | Component | Status | ID / evidence | Citation (URL + UTC) |
|---|---|---|---|---|
| 1 | Workflow "GodsEye Advanced Spatial Workflow" v1 | **CREATED VIA API** | id `6aace534859f7b0abb53d99a`. `POST https://api.on-demand.io/automation/api/workflow/` → HTTP 201 `{"id":"6aace534859f7b0abb53d99a"}` at `2026-09-18T07:16:04.335Z`. A first attempt using a documented `inputText` node got HTTP 400 `{"message":"input: text config missing"}` at `2026-09-18T07:15:04.217Z` and was dropped (not invented). Activated: `POST /workflow/6aace534859f7b0abb53d99a/activate` → HTTP 200 at `2026-09-18T07:16:14.101Z`. Executed: `POST /workflow/{id}/execute` → HTTP 200 at `2026-09-18T07:16:26.986Z`, executionID `6aace54bbb6a9a7035f431fc`, status `success`, duration 163,104 ms, time-to-first-log 657 ms; StructuredResponse valid. Export: `docs/ondemand-workflows/gods-eye-advanced-v1.json`. README: `docs/ondemand-workflows/README.md`. | This run's live API calls, 2026-09-18 (see §1 for the "no create endpoint" finding that makes the workflow API the *only* creatable artifact) |
| 2 | Agent "GodsEye Spatial Intelligence Agent" | **DASHBOARD-ONLY, pending** | Not yet created; no id. Field values and system prompt to paste are in §2. | `https://docs.on-demand.io/docs/rest-based-plugins.md` (fetched 2026-09-18T07:20:32Z); `https://docs.on-demand.io/docs/agent-skills.md` (fetched 2026-09-18T07:20:32Z); live probe below |
| 3 | earthquake_search REST agent | **DASHBOARD-ONLY, pending** | Not yet created; no id (`ondemand_tool_id` is `null` in the registry). Files to paste are in §3. | `https://docs.on-demand.io/docs/rest-based-plugins.md` (fetched 2026-09-18T07:20:32Z); `https://docs.on-demand.io/docs/open-api-schema.md` (fetched 2026-09-18T07:20:33Z) |
| 4 | 9 GodsEye skills | **DASHBOARD-ONLY, pending** | Not yet created; `ondemand.skills[]` all have `skillId: null`. Table and file paths are in §4. | `https://docs.on-demand.io/docs/agent-skills.md` (fetched 2026-09-18T07:20:32Z) |

Live account probe confirming rows 2–4 have nothing to attach yet: `GET
https://api.on-demand.io/plugin/v1/list?page=1&limit=50` → HTTP 200
`{"message":"Agent fetched successfully","page":1,"limit":50,"data":{"total":0}}`
at `2026-09-18T07:09:37.5Z` — the account currently has **no agents at all**.

---

## 1. Why dashboard-only

Two documented gaps, both re-confirmed against the live docs fetched for this
run, mean the agent, the REST agent and the nine skills cannot be created,
attached or invoked by API — only the workflow could be, and was (§0 row 1):

> **§8** (agent/REST-agent creation): *"Created: via the dashboard only — My
> Agents → Create Agents (https://app.on-demand.io/rag-agents/my-agents) …
> No create/update/publish REST endpoint is documented."*
> — source `docs/ONDEMAND_API_CURRENT.md` §8, citing
> `https://docs.on-demand.io/docs/rest-based-plugins.md` (retrieved
> 2026-09-17T05:56:31Z) and `https://docs.on-demand.io/docs/open-api-schema.md`
> (retrieved 2026-09-17T05:56:31Z). Both pages were re-read for this pack on
> 2026-09-18T07:20:32Z / 07:20:33Z respectively and neither documents a
> create/update/publish REST endpoint for agents.

> **§9** (skill creation/attach/invoke): *"Create / attach / invoke via REST
> API: NOT FOUND IN LIVE DOCS."*
> — source `docs/ONDEMAND_API_CURRENT.md` §9, citing
> `https://docs.on-demand.io/docs/agent-skills.md` (retrieved
> 2026-09-17T05:56:31Z, re-read 2026-09-18T07:20:32Z for this pack). The
> re-read confirms the entire skills lifecycle described there (Create Skill →
> Skill Name/Description/Category/Icon/Sample Prompts → paste or zip
> `SKILL.md` → automatic safety scan → private/publish → "Add the skill to an
> agent or a Playground session") is dashboard-driven; no REST verb for any of
> those steps appears on the page.

The live probe in §0 corroborates this from the account side, not just the
docs side: with this run's own API key, `GET /plugin/v1/list` returns
`data.total: 0` — the account holds zero agents, so nothing could have been
created programmatically even indirectly (e.g. by a script silently
succeeding earlier). Only the Agents Flow Builder workflow endpoints
(`POST /workflow/`, `/activate`, `/execute`, `GET /workflow/{id}`) are
documented and were used; no analogous endpoint exists for agents or skills.

---

## 2. Agent: GodsEye Spatial Intelligence Agent

### Dashboard field values

| Field | Value |
|---|---|
| Agent Name | `GodsEye Spatial Intelligence Agent` |
| Agent Description | "Analyses the live God's Eye globe view — aircraft, vessels, earthquakes and other in-view layers — and answers analyst questions with verified, citation-backed findings and a client-executable action plan. Consolidates the 9-stage GodsEye Advanced Spatial Workflow (context → classify → resolve → plan → verify → act → synthesise → respond) into one agent." |
| Agent Category | **Research** — chosen from the documented option list: Education, Sports, Travel, Writing, **Research**, Lifestyle, Programming, Astrology, Health, News, Food, Music, Gaming, Finance (`rest-based-plugins.md`, "Agent Category") |
| Conversation Starters (≥3) | 1. "Scan the current view for anomalies." · 2. "What is that aircraft near the airport squawking?" · 3. "Summarise everything happening in this area right now." · 4. "Is anything unusual happening near the coastline in view?" |
| Logo | Optional — not supplied in this run |

### System behaviour / prompt

The block below is a single-agent consolidation of the workflow's 9 node
prompts (`session_context → spatial_context_builder → intent_classifier →
capability_resolver → planner → verification → spatial_action_planner →
synthesis → structured_response`, builder `server/ondemand/workflow-definition.js`),
read verbatim from `/tmp/g6docs/node-prompts-excerpt.txt` and merged into one
system prompt. Paste this whole block into the agent's system-prompt /
instructions field:

```
ROLE
You are the GodsEye Spatial Intelligence Agent, the single-agent
consolidation of the God's Eye spatial-intelligence pipeline (workflow
"GodsEye Advanced Spatial Workflow" v1, id 6aace534859f7b0abb53d99a; node
chain: session_context -> spatial_context_builder -> intent_classifier ->
capability_resolver -> planner -> verification -> spatial_action_planner ->
synthesis -> structured_response). You analyse the live God's Eye globe view
for an analyst and answer strictly from what is in view, from your attached
capabilities, and from your attached skills.

OUTPUT RULE (applies at every stage and to your final answer)
Respond in JSON only: your final reply is a single valid JSON object and
nothing else -- no markdown fencing, no prose outside the object, no
trailing commentary. This mirrors the JSON-only directive embedded in every
node's system prompt in the source workflow.

STAGE 1 -- READ CONTEXT (session_context + spatial_context_builder)
Normalise the raw input into a session envelope: mode ("live", or
"selftest" if the input is empty/missing/an unresolved placeholder/not
JSON), session {sessionId, externalUserId, locale, tier, priorTurns}, query,
capabilityCatalogue, investigation.
Then build "spatialContext" with EXACTLY these 15 fields, in this order:
camera, viewport, center, altitude, zoom, viewScale, mapStack,
visibleBounds, activeLayers, selectedEntity, trackedEntity, visibleEntities,
timeline, investigation, userAction.
Rules: copy present values; set absent ones to null (arrays to []); "center"
is {latitude, longitude}; "visibleBounds" is {north, south, east, west};
"activeLayers" is an array of layer ids; "visibleEntities" is an array of
objects each keeping at least layerId, id, latitude, longitude plus every
other field present; "timeline" keeps mode and now; "userAction" is one of
query|select|track|navigate|annotate|unknown.
Compute "derived": viewRadiusKm (half the visibleBounds diagonal,
great-circle, rounded to 0.1), entityCounts ({"<layerId>": count}), airborne
(count of visibleEntities with onGround === false), onGround (count with
onGround === true), emergencySquawks (ids whose squawk is 7500, 7600 or
7700), vesselsUnderWay (count of vessel entities whose speedKts > 1).
Record any missing or malformed field as a context warning; never invent a
value for a field that is genuinely absent -- set it null/[] instead.

STAGE 2 -- CLASSIFY (intent_classifier)
Classify the query against the spatial context, tersely (low effort -- no
analysis beyond one sentence of rationale): intent (one of anomaly_scan |
entity_lookup | area_summary | navigate | layer_control | temporal_query |
compare | explain | other), confidence (0-1), tier (ASK | INVESTIGATE | DEEP
-- ASK = one fact or one navigation step; INVESTIGATE = needs cross-layer
reasoning or an external capability; DEEP = multi-step investigation with
evidence chains), focus {entityIds, layers, timeWindow{start,end}},
needsExternalData (boolean), rationale (one short sentence).

TIER RULES (reasoning depth carried over from the source workflow's
per-node model routing -- apply the matching depth of effort to your own
reasoning for the rest of the turn)
- ASK        -> predefined-gpt-5.6-luna,   reasoningMode low
- INVESTIGATE -> predefined-claude-sonnet-5, reasoningMode low
- DEEP        -> predefined-claude-sonnet-5, reasoningMode high

STAGE 3 -- RESOLVE CAPABILITIES (capability_resolver)
Choose capabilities ONLY from the capability catalogue carried in the input
(each entry: id, ondemand_tool, route, provider, coverage, description,
params[]). NEVER invent a capability, tool, route or parameter name. Select
every capability whose description serves the intent and the active layers
(e.g. for an anomaly scan over an airport with the earthquakes layer active,
seismic context within a few hundred km over the last 30 days is relevant).
For each selected capability build "params" using ONLY the names listed in
that entry's params[]; derive geographic values from spatialContext.center /
visibleBounds and time values from spatialContext.timeline.now. Record
selectedCapabilityIds, calls[] ({capabilityId, ondemandTool, route, params,
purpose}), and unmetNeeds[] (data the query needs but no catalogued
capability provides). Delegate the mechanics of any one capability's call
construction to its dedicated attached skill when available.

STAGE 4 -- PLAN (planner)
Produce an evidence-first analysis plan and the candidate findings the
in-view data already supports. Distinguish OBSERVED facts (present
literally in visibleEntities / derived) from INFERENCES (a conclusion you
draw from observed facts) and from UNKNOWNS (anything you cannot determine
from what's in view or from an executed capability call) -- never present
an inference as an observation. Build steps[] ({id, kind:
observe|call_capability|compare|infer|present, description,
usesCapabilityId, inputs}), candidateFindings[] ({id, claim, kind:
observed|inferred, supportingEntityIds, supportingFields, severity:
info|notable|high}) -- an emergency squawk (7500/7600/7700) on an airborne
aircraft, an aircraft moving fast while onGround, a vessel under way inside
an airport approach corridor, or a recent M>=4 earthquake within the view
radius are all at least "notable" -- assumptions[], and unknowns[]
(including every capability call whose result is not available inside this
run). Draw on the attached seismic / aviation / maritime analyst skills for
domain-specific thresholds and phrasing.

STAGE 5 -- VERIFY ADVERSARIALLY (verification)
Re-check every candidate finding against the raw spatialContext fields and
reject anything not literally supported by the input. For each finding,
locate the supporting entity/field values in spatialContext; mark
"verified" only if every supporting value exists and the claim follows from
it; "unverified" if support is partial; "rejected" if contradicted or
unsupported. Downgrade any severity that is not justified. Build
evidence[] ({findingId, entityId, field, value, sourceLayer}) with one entry
per supporting value actually found -- every finding must cite the literal
values that support it.

STAGE 6 -- PLAN MAP ACTIONS (spatial_action_planner)
Plan at most 6 actions that best present the verified findings to the
analyst (e.g. fly_to_location to frame the area of interest, track_entity
for a verified anomalous entity, set_layer_visibility to enable a layer the
findings need, annotate_map to mark verified findings, analyst_query for a
follow-up data question, frame_overhead to review traffic). Never emit an
action for a rejected finding. You may ONLY use the 28 action names below,
and ONLY the parameter keys listed for each (a trailing "?" marks an
optional parameter; enum[...] lists the only legal values). Any action name
or parameter key not in this list is forbidden:

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

Each action is {"name": <one of the 28 names above>, "params": {<only legal
keys for that name>}, "reason": short, "findingIds": [ids]}. Also produce
suggestedNextActions[] ({label, action: {name, params} | null}).

STAGE 7 -- SYNTHESISE (synthesis)
Write the analyst-facing answer: precise, calm, operational; lead with
verified findings, then unverified ones clearly labelled, then what could
not be checked. Never present an inference as an observation. "message" is
3-8 sentences of plain text (no Markdown) answering the query for the
current view; name entities by callsign/name and id; quote the literal
values (squawk, altitude, speed, distance) that support each verified
finding; state explicitly when a capability call (e.g. earthquake_search)
was planned but its data was not available inside this run. Build
"entities" ({id, layerId, label: callsign or name, role: finding|context,
latitude, longitude}) for every entity referenced in the message.

STAGE 8 -- EMIT STRUCTUREDRESPONSE (structured_response)
Reshape everything above into the client contract. Your final output object
must have EXACTLY these 7 keys and no others -- never add, rename or omit
one: message, entities, actions, evidence, sources, suggestedNextActions,
runMeta.
- "message": the synthesis message, unchanged.
- "entities": the synthesis entities, unchanged.
- "actions": the actions list, unchanged (each {name, params, reason,
  findingIds}) -- drop any action whose name is not one of the 28.
- "evidence": the evidence list, unchanged.
- "sources": [{id, kind: in_view|capability, label (e.g. "ADS-B (flights
  layer)", "AIS (ais-live-vessels layer)", "USGS FDSN Event
  (earthquake_search)"), status: used|planned_not_executed}] -- one entry
  per distinct source layer in the evidence plus one per planned capability
  call.
- "suggestedNextActions": unchanged.
- "runMeta": {workflow: "GodsEye Advanced Spatial Workflow", flowVersion: 1,
  mode, intent, tier, confidence, selectedCapabilityIds, unknowns,
  nodeChain: ["session_context","spatial_context_builder",
  "intent_classifier","capability_resolver","planner","verification",
  "spatial_action_planner","synthesis","structured_response"],
  generatedAtUtc: spatialContext.timeline.now}.

NON-NEGOTIABLE RULES (apply throughout every stage)
1. Never invent: a capability, tool, route or parameter name not in the
   supplied catalogue; a MapAction name or parameter key not in the 28-name
   list above; or a value for a field that is genuinely absent (use
   null/[] instead).
2. Observed vs inferred vs unknown: always say which one a claim is; never
   present an inference as an observation; every finding must cite the
   literal values that support it.
3. Tiers select reasoning depth, not the JSON contract -- the 7-key
   StructuredResponse output shape is identical at every tier.
4. JSON-only output: your final reply is the single StructuredResponse JSON
   object described in Stage 8 -- nothing else.
```

---

## 3. Tool: earthquake_search

### (a) `docs/ondemand-workflows/tools/earthquake_search.json` — verbatim

```json
{
  "name": "earthquake_search",
  "description": "Search recent/historical earthquakes from USGS by time window, magnitude range and geographic area (circle or bbox). Returns observed events with UTC time, magnitude, depth, location, tsunami flag and USGS URL.",
  "provider": "USGS FDSN Event Web Service",
  "http": {
    "method": "GET",
    "url": "https://<preview-host>/api/sources/earthquakes",
    "note": "replace <preview-host> with the deployed God's Eye host; the route is served by the api/[...route].js catch-all"
  },
  "input_schema": {
    "$schema": "http://json-schema.org/draft-07/schema#",
    "title": "earthquake_search input",
    "type": "object",
    "additionalProperties": false,
    "description": "All fields are optional query parameters forwarded to the USGS FDSN Event Web Service `query` (or `count`) method. A circle search (`latitude` + `longitude` + `maxradiuskm`) and a bounding-box search (`minlatitude`/`maxlatitude`/`minlongitude`/`maxlongitude`) are mutually exclusive — supplying keys from both is a 400 error, and a partial circle (e.g. `latitude` without `maxradiuskm`) is also a 400 error.",
    "properties": {
      "starttime": {
        "type": "string",
        "description": "Limit to events on or after this time (UTC). Accepts `YYYY-MM-DD` or `YYYY-MM-DDTHH:MM:SS(Z)`; a date with no time means midnight UTC.",
        "examples": ["2024-01-01", "2024-01-01T00:00:00Z"]
      },
      "endtime": {
        "type": "string",
        "description": "Limit to events on or before this time (UTC). Same accepted formats as `starttime`.",
        "examples": ["2024-01-31T23:59:59Z"]
      },
      "minmagnitude": {
        "type": "number",
        "minimum": -2,
        "maximum": 10,
        "description": "Minimum event magnitude, inclusive."
      },
      "maxmagnitude": {
        "type": "number",
        "minimum": -2,
        "maximum": 10,
        "description": "Maximum event magnitude, inclusive."
      },
      "latitude": {
        "type": "number",
        "minimum": -90,
        "maximum": 90,
        "description": "Circle-search center latitude, degrees. Requires `longitude` and `maxradiuskm` together."
      },
      "longitude": {
        "type": "number",
        "minimum": -180,
        "maximum": 180,
        "description": "Circle-search center longitude, degrees. Requires `latitude` and `maxradiuskm` together."
      },
      "maxradiuskm": {
        "type": "number",
        "exclusiveMinimum": 0,
        "maximum": 20001.6,
        "description": "Circle-search radius, kilometers (max is USGS's own limit, half the Earth's circumference). Requires `latitude` and `longitude` together."
      },
      "minlatitude": {
        "type": "number",
        "minimum": -90,
        "maximum": 90,
        "description": "Bounding-box south edge, degrees. Must be <= `maxlatitude`."
      },
      "maxlatitude": {
        "type": "number",
        "minimum": -90,
        "maximum": 90,
        "description": "Bounding-box north edge, degrees. Must be >= `minlatitude`."
      },
      "minlongitude": {
        "type": "number",
        "minimum": -180,
        "maximum": 180,
        "description": "Bounding-box west edge, degrees. Must be <= `maxlongitude`."
      },
      "maxlongitude": {
        "type": "number",
        "minimum": -180,
        "maximum": 180,
        "description": "Bounding-box east edge, degrees. Must be >= `minlongitude`."
      },
      "limit": {
        "type": "integer",
        "minimum": 1,
        "maximum": 200,
        "default": 100,
        "description": "Maximum number of events to return. USGS itself allows up to 20000; this adapter caps it at 200. Defaults to 100."
      },
      "orderby": {
        "type": "string",
        "enum": ["time", "time-asc", "magnitude", "magnitude-asc"],
        "default": "time",
        "description": "Sort order for the returned events."
      },
      "mode": {
        "type": "string",
        "enum": ["query", "count"],
        "default": "query",
        "description": "Local switch (not forwarded to USGS): 'query' returns matching events, 'count' returns only the number of matching events (uses the FDSN `count` endpoint)."
      }
    }
  },
  "output_schema": {
    "$schema": "http://json-schema.org/draft-07/schema#",
    "title": "earthquake_search output",
    "type": "object",
    "description": "Success body for mode=query (default). For mode=count, `events` is omitted and `count` alone reflects the number of matching events.",
    "properties": {
      "source": { "type": "string", "const": "USGS" },
      "coverage": { "type": "string", "const": "observed" },
      "count": {
        "type": "integer",
        "description": "Number of events returned (mode=query) or matched (mode=count)."
      },
      "events": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "id": { "type": "string", "description": "USGS event id." },
            "time_utc": {
              "type": "string",
              "description": "ISO-8601 UTC origin time."
            },
            "magnitude": { "type": ["number", "null"] },
            "mag_type": {
              "type": ["string", "null"],
              "description": "Magnitude scale, e.g. 'mww', 'mb'."
            },
            "depth_km": {
              "type": ["number", "null"],
              "description": "Hypocenter depth, kilometers."
            },
            "lat": { "type": ["number", "null"] },
            "lon": { "type": ["number", "null"] },
            "place": {
              "type": ["string", "null"],
              "description": "USGS human-readable location string."
            },
            "tsunami": {
              "type": "integer",
              "enum": [0, 1],
              "description": "1 if USGS flagged tsunami potential."
            },
            "alert": {
              "type": ["string", "null"],
              "description": "PAGER alert level ('green'/'yellow'/'orange'/'red') or null."
            },
            "url": {
              "type": ["string", "null"],
              "description": "USGS event page URL."
            },
            "source": { "type": "string", "const": "USGS" },
            "coverage": { "type": "string", "const": "observed" },
            "retrieved_at_utc": {
              "type": "string",
              "description": "ISO-8601 UTC time this route fetched the data."
            }
          }
        }
      },
      "provenance": {
        "type": "object",
        "properties": {
          "source": {
            "type": "string",
            "const": "USGS FDSN Event Web Service"
          },
          "url": {
            "type": "string",
            "description": "The exact upstream request URL, including format=geojson and all forwarded params."
          },
          "generated": {
            "type": ["string", "null"],
            "description": "ISO-8601 UTC time USGS generated the response (from GeoJSON metadata.generated)."
          },
          "api": { "type": ["string", "null"] },
          "title": { "type": ["string", "null"] },
          "retrieved_at_utc": { "type": "string" },
          "license": {
            "type": "string",
            "const": "USGS data are in the public domain (https://www.usgs.gov/information-policies-and-instructions/copyrights-and-credits)"
          }
        }
      },
      "query": {
        "type": "object",
        "description": "The request's own query parameters, exactly as forwarded from the HTTP layer into the adapter."
      }
    }
  },
  "ondemand_registration": {
    "status": "NOT FOUND IN LIVE DOCS",
    "reason": "docs/ONDEMAND_API_CURRENT.md §8: agent/tool creation and publishing are dashboard-only; the public REST surface documents only GET /plugin/v1/list. No create/attach endpoint was invented.",
    "dashboard_path": "REST API Agent (docs.on-demand.io/docs/rest-based-plugins.md) — import this schema as the agent's OpenAPI operation",
    "ondemand_tool_id": null
  },
  "openapi_fragment": {
    "openapi": "3.0.3",
    "info": {
      "title": "God's Eye View — earthquake.search",
      "version": "1.0.0",
      "description": "USGS FDSN Event Web Service earthquake search, proxied by God's Eye View."
    },
    "servers": [{ "url": "https://<preview-host>" }],
    "paths": {
      "/api/sources/earthquakes": {
        "get": {
          "operationId": "earthquake_search",
          "summary": "Search recent/historical earthquakes (USGS FDSN)",
          "description": "Search recent/historical earthquakes from USGS by time window, magnitude range and geographic area (circle or bbox). Returns observed events with UTC time, magnitude, depth, location, tsunami flag and USGS URL.",
          "parameters": [
            {
              "name": "starttime",
              "in": "query",
              "required": false,
              "schema": { "type": "string" },
              "description": "YYYY-MM-DD or YYYY-MM-DDTHH:MM:SS(Z), UTC."
            },
            {
              "name": "endtime",
              "in": "query",
              "required": false,
              "schema": { "type": "string" },
              "description": "YYYY-MM-DD or YYYY-MM-DDTHH:MM:SS(Z), UTC."
            },
            {
              "name": "minmagnitude",
              "in": "query",
              "required": false,
              "schema": { "type": "number", "minimum": -2, "maximum": 10 }
            },
            {
              "name": "maxmagnitude",
              "in": "query",
              "required": false,
              "schema": { "type": "number", "minimum": -2, "maximum": 10 }
            },
            {
              "name": "latitude",
              "in": "query",
              "required": false,
              "schema": { "type": "number", "minimum": -90, "maximum": 90 },
              "description": "Circle center latitude; requires longitude + maxradiuskm."
            },
            {
              "name": "longitude",
              "in": "query",
              "required": false,
              "schema": { "type": "number", "minimum": -180, "maximum": 180 },
              "description": "Circle center longitude; requires latitude + maxradiuskm."
            },
            {
              "name": "maxradiuskm",
              "in": "query",
              "required": false,
              "schema": {
                "type": "number",
                "exclusiveMinimum": 0,
                "maximum": 20001.6
              },
              "description": "Circle radius km; requires latitude + longitude."
            },
            {
              "name": "minlatitude",
              "in": "query",
              "required": false,
              "schema": { "type": "number", "minimum": -90, "maximum": 90 },
              "description": "Bbox south edge; mutually exclusive with the circle params."
            },
            {
              "name": "maxlatitude",
              "in": "query",
              "required": false,
              "schema": { "type": "number", "minimum": -90, "maximum": 90 },
              "description": "Bbox north edge; mutually exclusive with the circle params."
            },
            {
              "name": "minlongitude",
              "in": "query",
              "required": false,
              "schema": { "type": "number", "minimum": -180, "maximum": 180 },
              "description": "Bbox west edge; mutually exclusive with the circle params."
            },
            {
              "name": "maxlongitude",
              "in": "query",
              "required": false,
              "schema": { "type": "number", "minimum": -180, "maximum": 180 },
              "description": "Bbox east edge; mutually exclusive with the circle params."
            },
            {
              "name": "limit",
              "in": "query",
              "required": false,
              "schema": {
                "type": "integer",
                "minimum": 1,
                "maximum": 200,
                "default": 100
              }
            },
            {
              "name": "orderby",
              "in": "query",
              "required": false,
              "schema": {
                "type": "string",
                "enum": ["time", "time-asc", "magnitude", "magnitude-asc"],
                "default": "time"
              }
            },
            {
              "name": "mode",
              "in": "query",
              "required": false,
              "schema": {
                "type": "string",
                "enum": ["query", "count"],
                "default": "query"
              },
              "description": "Local switch; 'count' uses the FDSN count endpoint instead of query. Not forwarded to USGS."
            }
          ],
          "responses": {
            "200": {
              "description": "Matching earthquakes (or their count, if mode=count).",
              "content": {
                "application/json": {
                  "schema": {
                    "$ref": "#/components/schemas/EarthquakeSearchResponse"
                  }
                }
              }
            },
            "400": {
              "description": "Invalid query — unknown parameter, out-of-range value, or mixed circle/bbox.",
              "content": {
                "application/json": {
                  "schema": { "$ref": "#/components/schemas/InvalidQueryError" }
                }
              }
            },
            "502": {
              "description": "Unhandled internal error.",
              "content": {
                "application/json": {
                  "schema": { "$ref": "#/components/schemas/SourcesError" }
                }
              }
            },
            "504": {
              "description": "USGS did not respond in time, or was unreachable, after one retry.",
              "content": {
                "application/json": {
                  "schema": { "$ref": "#/components/schemas/AdapterError" }
                }
              }
            }
          }
        }
      }
    },
    "components": {
      "schemas": {
        "EarthquakeSearchResponse": {
          "type": "object",
          "properties": {
            "source": { "type": "string", "example": "USGS" },
            "coverage": { "type": "string", "example": "observed" },
            "count": { "type": "integer" },
            "events": { "type": "array", "items": { "type": "object" } },
            "provenance": { "type": "object" },
            "query": { "type": "object" }
          }
        },
        "InvalidQueryError": {
          "type": "object",
          "properties": {
            "error": { "type": "string", "example": "invalid_query" },
            "message": { "type": "string" },
            "unknown": { "type": "array", "items": { "type": "string" } }
          }
        },
        "AdapterError": {
          "type": "object",
          "properties": {
            "error": {
              "type": "string",
              "enum": ["usgs_rejected", "usgs_unavailable", "usgs_timeout"]
            },
            "detail": { "type": "string" }
          }
        },
        "SourcesError": {
          "type": "object",
          "properties": {
            "error": { "type": "string", "example": "sources_error" }
          }
        }
      }
    }
  }
}
```

### (b) `docs/ondemand-workflows/tools/earthquake_search.openapi.json` — verbatim

```json
{
  "openapi": "3.0.3",
  "info": {
    "title": "God's Eye earthquake_search",
    "version": "1.0.0",
    "description": "Search recent/historical earthquakes from the USGS FDSN Event Web Service by time window, magnitude range and geographic area (circle or bounding box), proxied by the God's Eye View serverless route `api/[...route].js` -> `server/serverless/earthquakes-route.js` -> `server/sources/usgs-earthquakes.js`. Returns observed events with UTC time, magnitude, depth, location, tsunami flag and USGS URL. No authentication is required."
  },
  "servers": [
    {
      "url": "https://<deployment>",
      "description": "God's Eye deployment host (replace)"
    }
  ],
  "paths": {
    "/api/sources/earthquakes": {
      "get": {
        "operationId": "earthquake_search",
        "summary": "Search recent/historical earthquakes (USGS FDSN)",
        "description": "All query parameters are optional and are forwarded to the USGS FDSN Event Web Service `query` (or `count`) method after validation. A circle search (`latitude` + `longitude` + `maxradiuskm`) and a bounding-box search (`minlatitude`/`maxlatitude`/`minlongitude`/`maxlongitude`) are mutually exclusive -- supplying keys from both is a 400 error, and a partial circle (e.g. `latitude` without `maxradiuskm`) is also a 400 error. Any query parameter not listed below is rejected with 400 (`additionalProperties: false` on the underlying input schema).",
        "parameters": [
          {
            "name": "starttime",
            "in": "query",
            "required": false,
            "schema": { "type": "string", "example": "2024-01-01" },
            "description": "Limit to events on or after this time (UTC). Accepts `YYYY-MM-DD` or `YYYY-MM-DDTHH:MM:SS(Z)`; a date with no time means midnight UTC."
          },
          {
            "name": "endtime",
            "in": "query",
            "required": false,
            "schema": { "type": "string", "example": "2024-01-31T23:59:59Z" },
            "description": "Limit to events on or before this time (UTC). Same accepted formats as `starttime`."
          },
          {
            "name": "minmagnitude",
            "in": "query",
            "required": false,
            "schema": { "type": "number", "minimum": -2, "maximum": 10 },
            "description": "Minimum event magnitude, inclusive."
          },
          {
            "name": "maxmagnitude",
            "in": "query",
            "required": false,
            "schema": { "type": "number", "minimum": -2, "maximum": 10 },
            "description": "Maximum event magnitude, inclusive."
          },
          {
            "name": "latitude",
            "in": "query",
            "required": false,
            "schema": { "type": "number", "minimum": -90, "maximum": 90 },
            "description": "Circle-search center latitude, degrees. Requires `longitude` and `maxradiuskm` together."
          },
          {
            "name": "longitude",
            "in": "query",
            "required": false,
            "schema": { "type": "number", "minimum": -180, "maximum": 180 },
            "description": "Circle-search center longitude, degrees. Requires `latitude` and `maxradiuskm` together."
          },
          {
            "name": "maxradiuskm",
            "in": "query",
            "required": false,
            "schema": {
              "type": "number",
              "minimum": 0,
              "exclusiveMinimum": true,
              "maximum": 20001.6
            },
            "description": "Circle-search radius, kilometers (max is USGS's own limit, half the Earth's circumference). Requires `latitude` and `longitude` together."
          },
          {
            "name": "minlatitude",
            "in": "query",
            "required": false,
            "schema": { "type": "number", "minimum": -90, "maximum": 90 },
            "description": "Bounding-box south edge, degrees. Must be <= `maxlatitude`."
          },
          {
            "name": "maxlatitude",
            "in": "query",
            "required": false,
            "schema": { "type": "number", "minimum": -90, "maximum": 90 },
            "description": "Bounding-box north edge, degrees. Must be >= `minlatitude`."
          },
          {
            "name": "minlongitude",
            "in": "query",
            "required": false,
            "schema": { "type": "number", "minimum": -180, "maximum": 180 },
            "description": "Bounding-box west edge, degrees. Must be <= `maxlongitude`."
          },
          {
            "name": "maxlongitude",
            "in": "query",
            "required": false,
            "schema": { "type": "number", "minimum": -180, "maximum": 180 },
            "description": "Bounding-box east edge, degrees. Must be >= `minlongitude`."
          },
          {
            "name": "limit",
            "in": "query",
            "required": false,
            "schema": {
              "type": "integer",
              "minimum": 1,
              "maximum": 200,
              "default": 100
            },
            "description": "Maximum number of events to return. USGS itself allows up to 20000; this adapter caps it at 200. Defaults to 100."
          },
          {
            "name": "orderby",
            "in": "query",
            "required": false,
            "schema": {
              "type": "string",
              "enum": ["time", "time-asc", "magnitude", "magnitude-asc"],
              "default": "time"
            },
            "description": "Sort order for the returned events."
          },
          {
            "name": "mode",
            "in": "query",
            "required": false,
            "schema": {
              "type": "string",
              "enum": ["query", "count"],
              "default": "query"
            },
            "description": "Local switch (not forwarded to USGS): 'query' returns matching events, 'count' returns only the number of matching events (uses the FDSN `count` endpoint)."
          }
        ],
        "responses": {
          "200": {
            "description": "Matching earthquakes (mode=query, the default), or their count only (mode=count -- in which case `events` is omitted and `count` alone reflects the number of matching events).",
            "content": {
              "application/json": {
                "schema": { "$ref": "#/components/schemas/EarthquakeSearchResponse" }
              }
            }
          },
          "400": {
            "description": "Invalid query -- an unknown parameter, an out-of-range or malformed value, a mixed circle/bbox request, a partial circle, or an inverted bounding box. Also carries a USGS-rejected request (HTTP 400) passed through unchanged from the upstream FDSN service.",
            "content": {
              "application/json": {
                "schema": { "$ref": "#/components/schemas/InvalidQueryError" }
              }
            }
          },
          "502": {
            "description": "Upstream error: USGS was unreachable or timed out after one retry, USGS returned a 5xx or a response body that was not valid JSON, or an unhandled exception occurred in the route handler. (The live route may occasionally surface this same failure under a different HTTP status, e.g. 404/500/503/504, depending on how USGS itself responded -- see server/sources/usgs-earthquakes.js `requestUsgs()`; this document models every such upstream failure uniformly under 502 per this schema's scope.)",
            "content": {
              "application/json": {
                "schema": { "$ref": "#/components/schemas/UpstreamError" }
              }
            }
          }
        }
      }
    }
  },
  "components": {
    "schemas": {
      "EarthquakeSearchResponse": {
        "type": "object",
        "description": "Success body for mode=query (default). For mode=count, `events` is omitted and `count` alone reflects the number of matching events.",
        "properties": {
          "source": { "type": "string", "enum": ["USGS"] },
          "coverage": { "type": "string", "enum": ["observed"] },
          "count": {
            "type": "integer",
            "description": "Number of events returned (mode=query) or matched (mode=count)."
          },
          "events": {
            "type": "array",
            "items": { "$ref": "#/components/schemas/EarthquakeEvent" }
          },
          "provenance": { "$ref": "#/components/schemas/Provenance" },
          "query": {
            "type": "object",
            "description": "The request's own query parameters, exactly as forwarded from the HTTP layer into the adapter.",
            "additionalProperties": true
          }
        }
      },
      "EarthquakeEvent": {
        "type": "object",
        "properties": {
          "id": { "type": "string", "nullable": true, "description": "USGS event id." },
          "time_utc": {
            "type": "string",
            "nullable": true,
            "description": "ISO-8601 UTC origin time."
          },
          "magnitude": { "type": "number", "nullable": true },
          "mag_type": {
            "type": "string",
            "nullable": true,
            "description": "Magnitude scale, e.g. 'mww', 'mb'."
          },
          "depth_km": {
            "type": "number",
            "nullable": true,
            "description": "Hypocenter depth, kilometers."
          },
          "lat": { "type": "number", "nullable": true },
          "lon": { "type": "number", "nullable": true },
          "place": {
            "type": "string",
            "nullable": true,
            "description": "USGS human-readable location string."
          },
          "tsunami": {
            "type": "integer",
            "enum": [0, 1],
            "description": "1 if USGS flagged tsunami potential."
          },
          "alert": {
            "type": "string",
            "nullable": true,
            "description": "PAGER alert level ('green'/'yellow'/'orange'/'red') or null."
          },
          "url": {
            "type": "string",
            "nullable": true,
            "description": "USGS event page URL."
          },
          "source": { "type": "string", "enum": ["USGS"] },
          "coverage": { "type": "string", "enum": ["observed"] },
          "retrieved_at_utc": {
            "type": "string",
            "description": "ISO-8601 UTC time this route fetched the data."
          }
        }
      },
      "Provenance": {
        "type": "object",
        "properties": {
          "source": { "type": "string", "enum": ["USGS FDSN Event Web Service"] },
          "url": {
            "type": "string",
            "description": "The exact upstream request URL, including format=geojson and all forwarded params."
          },
          "generated": {
            "type": "string",
            "nullable": true,
            "description": "ISO-8601 UTC time USGS generated the response (from GeoJSON metadata.generated)."
          },
          "api": { "type": "string", "nullable": true },
          "title": { "type": "string", "nullable": true },
          "retrieved_at_utc": { "type": "string" },
          "license": {
            "type": "string",
            "enum": [
              "USGS data are in the public domain (https://www.usgs.gov/information-policies-and-instructions/copyrights-and-credits)"
            ]
          }
        }
      },
      "InvalidQueryError": {
        "type": "object",
        "description": "server/serverless/earthquakes-route.js maps a validateQuery() failure (server/sources/usgs-earthquakes.js) to this shape; `unknown` is always present (possibly empty) and is what distinguishes this from UpstreamError.",
        "properties": {
          "error": { "type": "string", "example": "invalid_query" },
          "message": {
            "type": "string",
            "description": "Human-readable reason, e.g. \"Invalid limit: expected an integer >= 1\" or \"circle (latitude/longitude/maxradiuskm) and bbox (...) are mutually exclusive\"."
          },
          "unknown": {
            "type": "array",
            "items": { "type": "string" },
            "description": "Names of any query parameters not recognised by the adapter. Empty when the failure was a value/range/mutual-exclusivity error rather than an unknown key."
          }
        },
        "required": ["error", "message", "unknown"]
      },
      "UpstreamError": {
        "description": "Either the route's own unhandled-exception fallback (SourcesError) or a pass-through USGS/network failure (AdapterError). No `unknown` key -- that is what distinguishes this from InvalidQueryError.",
        "oneOf": [
          { "$ref": "#/components/schemas/SourcesError" },
          { "$ref": "#/components/schemas/AdapterError" }
        ]
      },
      "SourcesError": {
        "type": "object",
        "description": "server/serverless/earthquakes-route.js's outer catch-all: any unhandled exception in the handler.",
        "properties": {
          "error": { "type": "string", "enum": ["sources_error"] }
        },
        "required": ["error"]
      },
      "AdapterError": {
        "type": "object",
        "description": "server/sources/usgs-earthquakes.js requestUsgs(): a USGS-side or network-side failure passed through by the route as `{error, detail}`.",
        "properties": {
          "error": {
            "type": "string",
            "enum": ["usgs_rejected", "usgs_unavailable", "usgs_timeout"]
          },
          "detail": {
            "type": "string",
            "description": "Up to 200 characters of the upstream response body, or the underlying network/timeout error message."
          }
        },
        "required": ["error", "detail"]
      }
    }
  }
}
```

### (c) Notes

- **Replace the host placeholder before importing.** Both files use a
  placeholder server host — `earthquake_search.json` uses
  `https://<preview-host>` (in `http.url` and `openapi_fragment.servers[0].url`),
  `earthquake_search.openapi.json` uses `https://<deployment>`. Replace either
  placeholder with the actual deployed God's Eye host before pasting the
  OpenAPI document into the dashboard's schema field.
- **The route is unauthenticated.** Per the OpenAPI `info.description`: *"No
  authentication is required."* No Configuration Fields (API key header,
  query param, etc.) need to be defined for this agent (`rest-based-plugins.md`,
  "Configuration Fields").
- **Circle vs bbox are mutually exclusive.** `latitude`+`longitude`+`maxradiuskm`
  (circle) and `minlatitude`/`maxlatitude`/`minlongitude`/`maxlongitude` (bbox)
  must not be mixed — supplying keys from both, or a partial circle (e.g.
  `latitude` without `maxradiuskm`), returns HTTP 400 with the
  `InvalidQueryError` shape.

---

## 4. The nine skills

Each skill's `SKILL.md` body already lives at `docs/ondemand-skills/<slug>.md`
in this repo; paste that file's full content into the dashboard's skill
editor as described in §5(C). Dashboard fields (name/description/category/
sample prompts) to enter alongside the paste are below.

| # | slug | Skill Name | Description | Category | Sample Prompts | File |
|---|---|---|---|---|---|---|
| 1 | `godseye-spatial-context-reader` | GodsEye Spatial Context Reader | Validates and normalises a God's Eye viewport payload into the canonical 15-field spatial-context object and derives view-radius, entity-count, airborne/on-ground and emergency-squawk facts. | engineering | "Normalise this viewport payload into the spatial-context object." / "What is the current view radius and how many aircraft are airborne right now?" | `docs/ondemand-skills/godseye-spatial-context-reader.md` |
| 2 | `godseye-intent-classifier` | GodsEye Intent Classifier | Classifies an analyst query against the live spatial context into one of nine intents, assigns an ASK/INVESTIGATE/DEEP tier, and extracts the query's entity/layer/time focus. | engineering | "Classify this query: 'is anything unusual near the airport?'" / "What tier and focus does 'show me vessels near the port over the last hour' need?" | `docs/ondemand-skills/godseye-intent-classifier.md` |
| 3 | `godseye-capability-resolver` | GodsEye Capability Resolver | Selects which catalogued external capabilities (e.g. earthquake_search) apply to a classified intent, building call parameters only from each capability's documented params — never inventing a tool, route or field. | engineering | "Which capabilities apply to an anomaly scan over an airport with the earthquakes layer active?" / "Build the earthquake_search call for a 300 km radius around the current view center." | `docs/ondemand-skills/godseye-capability-resolver.md` |
| 4 | `godseye-map-action-planner` | GodsEye Map Action Planner | Plans up to six client MapActions from a verified finding set, using only the 28 documented action names and their legal parameter keys. | engineering | "Plan actions to frame and annotate this verified anomaly." / "Which MapAction tracks a specific aircraft by callsign?" | `docs/ondemand-skills/godseye-map-action-planner.md` |
| 5 | `godseye-seismic-analyst` | GodsEye Seismic Analyst | Interprets earthquake_search (USGS FDSN) results for the current view, flagging recent M≥4 events within the view radius as notable-or-higher findings with literal supporting values. | research | "Are there any recent earthquakes worth flagging near this view?" / "Summarise the seismic activity returned by earthquake_search for the last 30 days." | `docs/ondemand-skills/godseye-seismic-analyst.md` |
| 6 | `godseye-aviation-analyst` | GodsEye Aviation Analyst | Reads ADS-B flights/military entities for emergency squawks (7500/7600/7700), abnormal on-ground speed and other airborne/on-ground anomalies, citing literal callsign, altitude, speed and squawk values. | research | "Is any aircraft in view squawking an emergency code?" / "Which aircraft are on the ground but moving unusually fast?" | `docs/ondemand-skills/godseye-aviation-analyst.md` |
| 7 | `godseye-maritime-analyst` | GodsEye Maritime Analyst | Reads AIS vessel entities for vessels under way (speedKts > 1), navStatus anomalies and vessels inside sensitive corridors, citing literal MMSI, speed and navStatus values. | research | "Which vessels in view are currently under way?" / "Is any vessel inside the airport approach corridor?" | `docs/ondemand-skills/godseye-maritime-analyst.md` |
| 8 | `godseye-evidence-verifier` | GodsEye Evidence Verifier | Adversarially re-checks every candidate finding against the raw spatial-context fields, marking each verified/unverified/rejected and building the literal evidence list that supports it. | engineering | "Verify this candidate finding against the current spatial context." / "Which of these findings are unsupported and should be rejected?" | `docs/ondemand-skills/godseye-evidence-verifier.md` |
| 9 | `godseye-structured-response-writer` | GodsEye StructuredResponse Writer | Reshapes a synthesised analysis into the exact 7-key StructuredResponse contract (message, entities, actions, evidence, sources, suggestedNextActions, runMeta) the God's Eye client expects. | engineering | "Format this synthesis into the StructuredResponse contract." / "What sources entry corresponds to a used capability call versus a planned-but-not-executed one?" | `docs/ondemand-skills/godseye-structured-response-writer.md` |

Category values follow `agent-skills.md` ("Category — where it belongs, such
as `documents`, `productivity`, or `engineering`"); `research` is used for the
three domain-analyst skills whose job is interpreting data rather than
shaping the pipeline, `engineering` for the six pipeline-mechanics skills.

---

## 5. Click-by-click dashboard steps

### (A) Create the earthquake_search REST agent

1. Go to **My Agents** (`https://app.on-demand.io/rag-agents/my-agents`) and
   click **Create Agents**. *(`rest-based-plugins.md`, "Getting Started" step 1)*
2. Define the API structure with the **OpenAPI schema**: paste the contents
   of §3(b) (`docs/ondemand-workflows/tools/earthquake_search.openapi.json`,
   host placeholder replaced) into the schema editor, or use **Import from
   URL** if that file is hosted somewhere reachable. *(`rest-based-plugins.md`,
   "Defining the OpenAPI Schema")*
3. Fill in **Agent Information**: Agent Name (e.g. `earthquake_search`),
   Agent Description (copy the `description` field from §3(a)), Agent
   Category — pick **Research** from the same 14-option list as §2, and at
   least 2 Conversation Starters (e.g. "Find earthquakes above M5 in the last
   week", "Search for earthquakes within 300km of these coordinates").
   *(`rest-based-plugins.md`, "Agent Information")*
4. Review **Configuration Fields** — none are required here because the
   route takes no header/query/body auth key (§3c). Leave this section
   empty. *(`rest-based-plugins.md`, "Configuration Fields"; leaving it
   empty for an unauthenticated API is **not spelled out explicitly on this
   page — confirm in the dashboard**)*
5. Add a **Privacy Policy** URL if the form requires one. *(`rest-based-plugins.md`,
   "Privacy Policy" — whether this field is mandatory for an internal/private
   agent is **not in docs — confirm in the dashboard**)*
6. **Test and validate** the agent against the live route before saving.
   *(`rest-based-plugins.md`, "Getting Started" step 4)*
7. Leave the agent **private** — do not publish it to the marketplace. *(The
   fetched `rest-based-plugins.md` does not itself state a private/public
   toggle for agents the way `agent-skills.md` does for skills; treat this as
   **not in docs — confirm in the dashboard**, applying the same
   private-by-default posture agent-skills.md documents for skills.)*

### (B) Create the GodsEye Spatial Intelligence Agent and attach the REST agent + nine skills

1. From **My Agents**, click **Create Agents** again, this time creating the
   agent as a persona/chat agent rather than a REST agent. *(The exact agent
   type selector for a non-REST agent is **not in docs — confirm in the
   dashboard**; the fetched `rest-based-plugins.md` documents only the REST
   agent flow.)*
2. Fill in **Agent Information** with the §2 values: Agent Name `GodsEye
   Spatial Intelligence Agent`, Description, Category **Research**, and the
   4 Conversation Starters from §2. *(`rest-based-plugins.md`, "Agent
   Information")*
3. Paste the full fenced system prompt from §2 into the agent's
   instructions/system-prompt field. *(The exact field name for a non-REST
   agent's persona prompt is **not in docs — confirm in the dashboard**; the
   closest documented analogue is the workflow LLM node's "Fulfillment
   Prompt" / "Instruction Prompt" fields — `workflow-nodes.md`, "LLM Node".)*
4. Attach the **earthquake_search** REST agent created in (A) so the agent
   can invoke it as a capability. *(Analogous to `workflow-nodes.md`'s LLM
   node "Agents Integration: Select specific Agents … whose context or
   execution results should be made available"; the exact control on a chat
   agent is **not in docs — confirm in the dashboard**.)*
5. Attach all **nine skills** from §4 (created in step C below) to this
   agent. *(`agent-skills.md`, "Add the skill to an agent or a Playground
   session.")*
6. Test the agent in the **Playground** using the conversation starters and
   a couple of the skills' sample prompts. *(`agent-skills.md`, Step 4 —
   "Add your skill in the Playground and try your sample prompts.")*
7. Leave the agent **private** until it has been fully verified (§7).
   *(`agent-skills.md`, "Your skill starts out private, visible only to your
   company" — applied here to the agent by the same convention; **confirm
   in the dashboard** that agents default to private the same way.)*

### (C) Create each of the nine skills

Repeat for each of the 9 rows in §4:

1. Dashboard → **Skills** → **Create Skill**. *(`agent-skills.md`, "Step 1 —
   Set up the Skill")*
2. **Skill Name**: the `slug` column value (lowercase-with-dashes, unique
   platform-wide — use **Suggest** if it's taken). *(`agent-skills.md`)*
3. **Description**: the table's 1–2 sentence description. *(`agent-skills.md`)*
4. **Category**: `engineering` or `research` per the table. *(`agent-skills.md`)*
5. **Icon**: optional, skip. *(`agent-skills.md`)*
6. **Sample Prompts**: the table's 2 prompts. *(`agent-skills.md`)*
7. Paste the full body of `docs/ondemand-skills/<slug>.md` into the editor as
   `SKILL.md` (or zip it and upload). *(`agent-skills.md`, "Step 2 — Write
   the instructions" / "Step 3 — Add helper files")*
8. Click **Validate** to confirm the file list before committing (only
   relevant if uploading a zip). *(`agent-skills.md`, "Uploading")*
9. Wait for the automatic **safety scan** to clear. *(`agent-skills.md`, "We
   check it")*
10. Confirm the skill is **private** (the default). *(`agent-skills.md`,
    "Your skill starts out private")*
11. Test it in the **Playground** with its sample prompts. *(`agent-skills.md`,
    "Step 4 — Test it")*

### (D) Read the workflow's webhook trigger URL and invoke it

1. Go to **Agents** (`https://app.on-demand.io/agents`) and open the
   workflow **GodsEye Advanced Spatial Workflow** (id
   `6aace534859f7b0abb53d99a`). *(`creating-a-workflow.md`, "Accessing the
   Workflow Canvas"; live fact: `GET /workflow/{id}` returns
   `trigger.webhook = {auth:{username:"",password:""}}` only — the URL
   itself is not returned by the API, checked live 2026-09-18T07:16:13Z)*
2. Click the canvas's **Webhook** trigger node to reveal its generated
   webhook URL. *(`workflow-nodes.md`, "Webhook Trigger": "A unique endpoint
   generated for the workflow.")*
3. Send an HTTP POST to that URL with a JSON body containing a `payload`
   field, e.g. `{"payload": {"query": "...", "spatialContext": {...}}}`.
   *(`workflow-nodes.md`, "Webhook Trigger" → "Payload Format": "The request
   body must contain a JSON object with a payload field.")*

### (E) Optional — attach earthquake_search to the workflow's LLM nodes

1. After (A) returns the REST agent's `pluginId`, add that id to the
   relevant node's `llm.plugins[{id}]` array in the workflow builder source
   (`server/ondemand/workflow-definition.js`), mirroring the documented LLM
   node "Agents Integration" control. *(`workflow-nodes.md`, "LLM Node")*
2. Push the updated definition to the already-created workflow with
   `node scripts/ondemand-workflow.mjs update 6aace534859f7b0abb53d99a` (this
   is a repo script wrapping the documented workflow API, not a manual
   dashboard step).

---

## 6. ID paste table

Current registry state before this pack's ids are pasted back
(`src/registry/capabilities.json`): `ondemand.workflow.id` =
`6aace534859f7b0abb53d99a`; `ondemand.agent.pluginId` = `null`;
`ondemand.skills[]` holds nine `{slug, skillId: null}` entries;
`capabilities[id=earthquake.search]` has `ondemand_tool_id` = `null` and
`status` = `"registered-unverified"`.

Related environment variable names (`server/ondemand/config.js`):
`ONDEMAND_API_KEY`; `ONDEMAND_BASE_URL` (alias `ONDEMAND_API_BASE`);
`ONDEMAND_SPATIAL_AGENT_ID` (default `pluginIds` for chat sessions, no
alias); `ONDEMAND_SPATIAL_FLOW_ID` (default `FLOW_DEFAULTS.spatialFlowId` =
`6aace534859f7b0abb53d99a`); `GODS_EYE_FLOW_VERSION` (default
`FLOW_DEFAULTS.flowVersion` = `"1"`); `ONDEMAND_REASONING_ENDPOINT_ID` /
`ONDEMAND_FULFILLMENT_ENDPOINT_ID` (alias `ONDEMAND_ENDPOINT_ID`);
`ONDEMAND_REASONING_MODE`; `ONDEMAND_SELFTEST_TOKEN`.

| Returned id | Paste into | Key / field | Then |
|---|---|---|---|
| REST agent `pluginId` (from §5A) | `src/registry/capabilities.json` | `capabilities[id="earthquake.search"].ondemand_tool_id` | Set `status` to `"live"` once an end-to-end query has actually invoked it |
| GodsEye agent `pluginId` (from §5B) | `src/registry/capabilities.json` **and** env `ONDEMAND_SPATIAL_AGENT_ID` | `ondemand.agent.pluginId`; Vercel project env + `.env.example` comment | `api/ondemand/sessions.js` starts defaulting `pluginIds` to it, and selftest step 4 stops being skipped |
| Each skill id (from §5C, one per slug) | `src/registry/capabilities.json` | `ondemand.skills[<slug>].skillId` | — |
| Workflow id | *(already set)* `server/ondemand/config.js` `FLOW_DEFAULTS.spatialFlowId`, re-exported by `api/ondemand/_config.js`; `.env.example` `ONDEMAND_SPATIAL_FLOW_ID`; `capabilities.json` `ondemand.workflow.id` | — | Nothing further to do — recorded here for completeness only |
| Workflow version | *(already set)* `GODS_EYE_FLOW_VERSION` / `FLOW_DEFAULTS.flowVersion` = `1` | — | Nothing further to do — recorded here for completeness only |

---

## 7. Verification after registration

Run these after pasting the ids from §6:

1. `npm run ondemand:contract -- --mode direct` (or `GET /api/ondemand/selftest`
   with header `x-selftest-token`) → step 4 is expected to change from
   skipped to **PASS** once `ONDEMAND_SPATIAL_AGENT_ID` is set.
2. `node scripts/ondemand-workflow.mjs verify 6aace534859f7b0abb53d99a` — re-checks
   the live workflow against its exported definition.
3. `GET /api/ondemand/health?envNames=1` — confirm the response shows
   `defaultPluginIds` sourced from `ONDEMAND_SPATIAL_AGENT_ID`.

---

## 8. Security notes

- The API key used for this run's live calls (workflow create/activate/
  execute, the agents-listing probe) was supplied only as a runtime
  environment variable. It was never written into this repository or this
  pack; anywhere a key value would otherwise appear it is shown redacted as
  `****`. No credentials exist in, or are needed by, this pack.
- Do not attach any secondary voice-provider key, or any retired plugin-id
  list, to the GodsEye Spatial Intelligence Agent or to any of the nine
  skills — neither is part of this pipeline's documented contract (§2, §4).
- Skills must not contain secrets of any kind. Per `agent-skills.md`,
  "What's not allowed": no passwords, API keys, tokens or private keys; no
  compiled executables; no scripts that download and run code from the
  internet or open a remote connection back to a machine you control; no
  destructive/encrypting/mining commands; no obfuscated code; no
  instructions telling the agent to ignore its rules or its user. All nine
  `docs/ondemand-skills/<slug>.md` files referenced in §4 are plain
  Markdown instructions with no embedded credentials.
