# Gate 3 row 1 — `earthquake_search` registration in the OnDemand dashboard (copy-paste pack)

Status 2026-09-18T09:30Z: **`ondemand_tool_id: null`, registry status `registered-unverified`.** `docs/ONDEMAND_API_CURRENT.md` §8 documents **no programmatic agent-tool / plugin registration endpoint** — the only REST surface is `GET https://api.on-demand.io/plugin/v1/list` (re-probed with the runtime key on 2026-09-18T09:18:11Z → HTTP 200, `total: 0`); creation is dashboard-only ("My Agents → Create Agents", REST agents defined by an OpenAPI schema — https://docs.on-demand.io/docs/rest-based-plugins.md, retrieved 2026-09-17T05:56:31Z / re-read 2026-09-18T07:20:32Z). No endpoint was invented, nothing was registered by API, and the status can only move to `CREATED` / `TESTED` after the steps below.

## 0. Prerequisite — a stable public URL

The tool must point at a host OnDemand can reach for the lifetime of the agent. As of this record there is none: no Vercel preview could be created from the agent build environment (the `vercel` CLI is a guardrail shim; the deployment API is off-limits there) and the credential supplied as `VERCEL_TOKEN` was the OnDemand API key. Create the preview from an operator machine:

```bash
export VERCEL_TOKEN=<token>            # shell only — never in a file
npm ci && npm run build
node scripts/vercel-file-deploy.mjs \
  --team team_aft8hHPiYnHp6I534L3DQScA \
  --project prj_VbHbEhFSDFkdXCqlq8XqONoFWQHO --name ondemand-eand-spatial
# → { "id": "dpl_…", "url": "https://ondemand-eand-spatial-….vercel.app", "readyState": "READY" }
```

Then `curl -s "https://<that host>/api/sources/earthquakes?minmagnitude=5&limit=3"` must return `200` with USGS events (it does on the emulator — `docs/audit/deployment-verification.md` §9). **Never register the sandbox emulator host** (`sb-….vercel.run`): it expires within 90 minutes.

## 1. Tool identity

| Field | Value |
|---|---|
| Tool / agent name | `earthquake_search` |
| Agent type | REST API agent (OpenAPI schema) |
| Endpoint | `GET https://<deployment>/api/sources/earthquakes` |
| Authentication | none (public read-only route; rate-limited upstream by USGS) |
| Description | Search recent/historical earthquakes from USGS FDSN Event by time window, magnitude range and geographic area (circle or bounding box). Returns observed events with UTC time, magnitude, depth, location, tsunami flag and USGS URL, plus a provenance block. |
| Category (dashboard list) | Research |
| Conversation starters (≥2 required) | "List earthquakes above magnitude 4.5 in the last 24 hours" · "Any earthquakes within 500 km of Abu Dhabi this month?" · "Count M6+ events worldwide since 2026-01-01" |
| Attribution to display | Earthquake data: U.S. Geological Survey (USGS) Earthquake Hazards Program, FDSN Event Web Service |

## 2. Query parameters (all optional; unknown names → 400)

| name | type | required | description |
|---|---|---|---|
| `starttime` | string | no | Limit to events on or after this time (UTC). Accepts `YYYY-MM-DD` or `YYYY-MM-DDTHH:MM:SS(Z)`; a date with no time means midnight UTC. |
| `endtime` | string | no | Limit to events on or before this time (UTC). Same accepted formats as `starttime`. |
| `minmagnitude` | number (-2…10) | no | Minimum event magnitude, inclusive. |
| `maxmagnitude` | number (-2…10) | no | Maximum event magnitude, inclusive. |
| `latitude` | number (-90…90) | no | Circle-search center latitude, degrees. Requires `longitude` and `maxradiuskm` together. |
| `longitude` | number (-180…180) | no | Circle-search center longitude, degrees. Requires `latitude` and `maxradiuskm` together. |
| `maxradiuskm` | number (0…20001.6) | no | Circle-search radius, kilometers (max is USGS's own limit, half the Earth's circumference). Requires `latitude` and `longitude` together. |
| `minlatitude` | number (-90…90) | no | Bounding-box south edge, degrees. Must be <= `maxlatitude`. |
| `maxlatitude` | number (-90…90) | no | Bounding-box north edge, degrees. Must be >= `minlatitude`. |
| `minlongitude` | number (-180…180) | no | Bounding-box west edge, degrees. Must be <= `maxlongitude`. |
| `maxlongitude` | number (-180…180) | no | Bounding-box east edge, degrees. Must be >= `minlongitude`. |
| `limit` | integer (1…200) | no | Maximum number of events to return. USGS itself allows up to 20000; this adapter caps it at 200. Defaults to 100. |
| `orderby` | string enum time/time-asc/magnitude/magnitude-asc | no | Sort order for the returned events. |
| `mode` | string enum query/count | no | Local switch (not forwarded to USGS): 'query' returns matching events, 'count' returns only the number of matching events (uses the FDSN `co |

Rules enforced by the adapter (`server/sources/usgs-earthquakes.js`): circle (`latitude`+`longitude`+`maxradiuskm`, all three) and bounding box are mutually exclusive; `limit` is capped at 200; `mode=count` returns only the count; times are UTC.

## 3. Full OpenAPI schema to paste (identical to `docs/ondemand-tools/earthquake_search.json`)

Replace `https://<deployment>` in `servers[0].url` with the READY deployment host first.

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
      "description": "God's Eye deployment host — REPLACE with the READY Vercel preview URL or project domain before importing (see x-godseye.deployment); the sandbox emulator host is ephemeral"
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
            "schema": {
              "type": "string",
              "example": "2024-01-01"
            },
            "description": "Limit to events on or after this time (UTC). Accepts `YYYY-MM-DD` or `YYYY-MM-DDTHH:MM:SS(Z)`; a date with no time means midnight UTC."
          },
          {
            "name": "endtime",
            "in": "query",
            "required": false,
            "schema": {
              "type": "string",
              "example": "2024-01-31T23:59:59Z"
            },
            "description": "Limit to events on or before this time (UTC). Same accepted formats as `starttime`."
          },
          {
            "name": "minmagnitude",
            "in": "query",
            "required": false,
            "schema": {
              "type": "number",
              "minimum": -2,
              "maximum": 10
            },
            "description": "Minimum event magnitude, inclusive."
          },
          {
            "name": "maxmagnitude",
            "in": "query",
            "required": false,
            "schema": {
              "type": "number",
              "minimum": -2,
              "maximum": 10
            },
            "description": "Maximum event magnitude, inclusive."
          },
          {
            "name": "latitude",
            "in": "query",
            "required": false,
            "schema": {
              "type": "number",
              "minimum": -90,
              "maximum": 90
            },
            "description": "Circle-search center latitude, degrees. Requires `longitude` and `maxradiuskm` together."
          },
          {
            "name": "longitude",
            "in": "query",
            "required": false,
            "schema": {
              "type": "number",
              "minimum": -180,
              "maximum": 180
            },
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
            "schema": {
              "type": "number",
              "minimum": -90,
              "maximum": 90
            },
            "description": "Bounding-box south edge, degrees. Must be <= `maxlatitude`."
          },
          {
            "name": "maxlatitude",
            "in": "query",
            "required": false,
            "schema": {
              "type": "number",
              "minimum": -90,
              "maximum": 90
            },
            "description": "Bounding-box north edge, degrees. Must be >= `minlatitude`."
          },
          {
            "name": "minlongitude",
            "in": "query",
            "required": false,
            "schema": {
              "type": "number",
              "minimum": -180,
              "maximum": 180
            },
            "description": "Bounding-box west edge, degrees. Must be <= `maxlongitude`."
          },
          {
            "name": "maxlongitude",
            "in": "query",
            "required": false,
            "schema": {
              "type": "number",
              "minimum": -180,
              "maximum": 180
            },
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
              "enum": [
                "time",
                "time-asc",
                "magnitude",
                "magnitude-asc"
              ],
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
              "enum": [
                "query",
                "count"
              ],
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
                "schema": {
                  "$ref": "#/components/schemas/EarthquakeSearchResponse"
                }
              }
            }
          },
          "400": {
            "description": "Invalid query -- an unknown parameter, an out-of-range or malformed value, a mixed circle/bbox request, a partial circle, or an inverted bounding box. Also carries a USGS-rejected request (HTTP 400) passed through unchanged from the upstream FDSN service.",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/InvalidQueryError"
                }
              }
            }
          },
          "502": {
            "description": "Upstream error: USGS was unreachable or timed out after one retry, USGS returned a 5xx or a response body that was not valid JSON, or an unhandled exception occurred in the route handler. (The live route may occasionally surface this same failure under a different HTTP status, e.g. 404/500/503/504, depending on how USGS itself responded -- see server/sources/usgs-earthquakes.js `requestUsgs()`; this document models every such upstream failure uniformly under 502 per this schema's scope.)",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/UpstreamError"
                }
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
          "source": {
            "type": "string",
            "enum": [
              "USGS"
            ]
          },
          "coverage": {
            "type": "string",
            "enum": [
              "observed"
            ]
          },
          "count": {
            "type": "integer",
            "description": "Number of events returned (mode=query) or matched (mode=count)."
          },
          "events": {
            "type": "array",
            "items": {
              "$ref": "#/components/schemas/EarthquakeEvent"
            }
          },
          "provenance": {
            "$ref": "#/components/schemas/Provenance"
          },
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
          "id": {
            "type": "string",
            "nullable": true,
            "description": "USGS event id."
          },
          "time_utc": {
            "type": "string",
            "nullable": true,
            "description": "ISO-8601 UTC origin time."
          },
          "magnitude": {
            "type": "number",
            "nullable": true
          },
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
          "lat": {
            "type": "number",
            "nullable": true
          },
          "lon": {
            "type": "number",
            "nullable": true
          },
          "place": {
            "type": "string",
            "nullable": true,
            "description": "USGS human-readable location string."
          },
          "tsunami": {
            "type": "integer",
            "enum": [
              0,
              1
            ],
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
          "source": {
            "type": "string",
            "enum": [
              "USGS"
            ]
          },
          "coverage": {
            "type": "string",
            "enum": [
              "observed"
            ]
          },
          "retrieved_at_utc": {
            "type": "string",
            "description": "ISO-8601 UTC time this route fetched the data."
          }
        }
      },
      "Provenance": {
        "type": "object",
        "properties": {
          "source": {
            "type": "string",
            "enum": [
              "USGS FDSN Event Web Service"
            ]
          },
          "url": {
            "type": "string",
            "description": "The exact upstream request URL, including format=geojson and all forwarded params."
          },
          "generated": {
            "type": "string",
            "nullable": true,
            "description": "ISO-8601 UTC time USGS generated the response (from GeoJSON metadata.generated)."
          },
          "api": {
            "type": "string",
            "nullable": true
          },
          "title": {
            "type": "string",
            "nullable": true
          },
          "retrieved_at_utc": {
            "type": "string"
          },
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
          "error": {
            "type": "string",
            "example": "invalid_query"
          },
          "message": {
            "type": "string",
            "description": "Human-readable reason, e.g. \"Invalid limit: expected an integer >= 1\" or \"circle (latitude/longitude/maxradiuskm) and bbox (...) are mutually exclusive\"."
          },
          "unknown": {
            "type": "array",
            "items": {
              "type": "string"
            },
            "description": "Names of any query parameters not recognised by the adapter. Empty when the failure was a value/range/mutual-exclusivity error rather than an unknown key."
          }
        },
        "required": [
          "error",
          "message",
          "unknown"
        ]
      },
      "UpstreamError": {
        "description": "Either the route's own unhandled-exception fallback (SourcesError) or a pass-through USGS/network failure (AdapterError). No `unknown` key -- that is what distinguishes this from InvalidQueryError.",
        "oneOf": [
          {
            "$ref": "#/components/schemas/SourcesError"
          },
          {
            "$ref": "#/components/schemas/AdapterError"
          }
        ]
      },
      "SourcesError": {
        "type": "object",
        "description": "server/serverless/earthquakes-route.js's outer catch-all: any unhandled exception in the handler.",
        "properties": {
          "error": {
            "type": "string",
            "enum": [
              "sources_error"
            ]
          }
        },
        "required": [
          "error"
        ]
      },
      "AdapterError": {
        "type": "object",
        "description": "server/sources/usgs-earthquakes.js requestUsgs(): a USGS-side or network-side failure passed through by the route as `{error, detail}`.",
        "properties": {
          "error": {
            "type": "string",
            "enum": [
              "usgs_rejected",
              "usgs_unavailable",
              "usgs_timeout"
            ]
          },
          "detail": {
            "type": "string",
            "description": "Up to 200 characters of the upstream response body, or the underlying network/timeout error message."
          }
        },
        "required": [
          "error",
          "detail"
        ]
      }
    }
  },
  "x-godseye": {
    "capability_id": "earthquake.search",
    "registry_status": "registered-unverified",
    "ondemand_tool_id": null,
    "adapter": "server/sources/usgs-earthquakes.js",
    "note": "copy of docs/ondemand-workflows/tools/earthquake_search.openapi.json (row 1) so every Gate 3 tool definition lives under docs/ondemand-tools/",
    "deployment": {
      "stable_url": null,
      "status": "no Vercel deployment exists yet (2026-09-18T09:30Z): the build environment cannot create one (CLI guardrail; deployment API off-limits) and the credential supplied as VERCEL_TOKEN was the OnDemand API key, not a Vercel token — run scripts/vercel-file-deploy.mjs from an operator machine, then replace <deployment> with the READY preview URL (or the project domain)",
      "last_emulator_host": "https://sb-63r5liykgi73.vercel.run (ephemeral sandbox, 2026-09-18 — expires within ~90 minutes; never register it in the dashboard)",
      "planned_project": "ondemand-eand-spatial (prj_VbHbEhFSDFkdXCqlq8XqONoFWQHO, team_aft8hHPiYnHp6I534L3DQScA) — preview target only; production and the opal alias must not be touched"
    }
  }
}
```

## 4. Click-by-click (dashboard, per https://docs.on-demand.io/docs/rest-based-plugins.md)

1. Open **My Agents** (`https://app.on-demand.io/rag-agents/my-agents`) → **Create Agents** → choose the **REST API** agent type.
2. **Define your API** → *Example Schema* → replace the editor content with the JSON from §3 (or *Import from URL* if you host the file on the deployment, e.g. `https://<deployment>/docs/ondemand-tools/earthquake_search.json` — not served by default, paste is simpler).
3. **Agent Information**: Agent Name `earthquake_search`; Description from §1; Category `Research`; Conversation Starters from §1; Logo optional.
4. **Configuration Fields**: none — leave empty (the route is unauthenticated; do not add any key field).
5. **Test** in the dashboard with `minmagnitude=5&limit=3` → expect `200` and a JSON body with `events[]` and `provenance`.
6. Save. Keep the agent **private**. Note the returned agent id (format `plugin-<digits>`).

## 5. Paste the returned id (nothing else changes in code)

| returned value | destination |
|---|---|
| agent id `plugin-<digits>` | `src/registry/capabilities.json` → `capabilities[id="earthquake.search"].ondemand_tool_id`; set `status` to `CREATED` |
| same id | env `ONDEMAND_SPATIAL_AGENT_ID` on the deployment (Vercel project env, preview + production) so `api/ondemand/sessions.js` attaches it by default (`pluginIds`) and selftest step 4 stops being skipped |
| same id | optional: `docs/ondemand-workflows/README.md` → add `{"id": "plugin-<digits>"}` under `llm.plugins` of the workflow's `capability_resolver` / `planner` nodes and run `node scripts/ondemand-workflow.mjs update 6aace534859f7b0abb53d99a` |

## 6. End-to-end test WITHOUT context injection → status `TESTED`

```bash
# key in the shell only
ONDEMAND_API_KEY=… ONDEMAND_SPATIAL_AGENT_ID=plugin-<digits> \
  node scripts/ondemand-contract-test.mjs --mode direct --json-out /tmp/contract.json
# step 4 "built-in tool/plugin invocation" must PASS and its statusLog must list executedAgents=[plugin-<digits>]
```

Or ask through the deployed proxy: `POST https://<deployment>/api/ondemand/chat` `{"userId":"row1-test","query":"List earthquakes above magnitude 5 in the last 24 hours with their USGS ids","responseMode":"sync","pluginIds":["plugin-<digits>"]}` — the answer must cite USGS event ids that also appear in `GET https://<deployment>/api/sources/earthquakes?starttime=<now-24h>&minmagnitude=5`. Only then set `status: "TESTED"` in the registry. Until that happens the interim path is the capability loop (`mode: "capability-loop"`, `docs/ONDEMAND_PROXY_DESIGN.md` §11c), which already selects and executes `earthquake.search` without any injected context (verified 2026-09-18T09:29:47Z, `docs/audit/deployment-verification.md` §9).

## 7. Row 2 (`fire_detection_search`) follows the same steps

Schema: `docs/ondemand-tools/fire_detection_search.json`; endpoint `GET https://<deployment>/api/sources/fires`; **before** registering, set `NASA_FIRMS_MAP_KEY` on the deployment (free key from https://firms.modaps.eosdis.nasa.gov/api/area/) — until then the route answers `503 not_configured` by design and the dashboard test would fail. Attribution: `NASA FIRMS / LANCE`.
