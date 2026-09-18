# Gate 3 · Row 1 — `earthquake.search` (USGS FDSN Event) — live verification 2026-09-18

Branch `ondemand-serverless`, code commit `5da207c` (adapter, route, tool JSON, registry). Deploy tier **T2**: fresh node24 Vercel Sandbox `sbx_Fp2WF0A4uY1XmiGmDU3vphQWqtfS`, preview `https://sb-pg1bhjba1gcs.vercel.run`, `npm run dev:serverless` over `dist/` + `api/**`; runtime-only env (ONDEMAND_API_KEY masked `G7Gg…VjnL`, ONDEMAND_SELFTEST_TOKEN, ONDEMAND_BASE_URL, ONDEMAND_ENDPOINT_ID / ONDEMAND_REASONING_ENDPOINT_ID / ONDEMAND_FULFILLMENT_ENDPOINT_ID, ONDEMAND_REASONING_MODE=dynamic, GODS_EYE_FLOW_VERSION=0, VITE_SERVERLESS_MODE=1) — no `.env` file in the sandbox. Function count unchanged at 9 (`/api/sources/earthquakes` is served by `api/[...route].js`).

## Verification table

| # | Check | Expected | HTTP | Latency ms | UTC | Result |
|---|---|---|---|---|---|---|
| a | `GET /api/sources/earthquakes?starttime=<now-24h>&minmagnitude=4.5&limit=20` | 200 + real USGS events | **200** | 296 | 2026-09-18T06:13:42Z | count **12**; top 3 by time: `us7000ti79` M4.5 Izu Islands, Japan region, `us7000ti70` M4.6 20 km ESE of Tsunō, Japan, `us7000ti5y` M4.7 24 km SW of Sipí, Colombia; strongest in window `us7000ti1p` M6.5 165 km W of Nikolski, Alaska; provenance api 2.7.0, generated 2026-09-18T06:13:42.000Z |
| b | `GET /api/sources/earthquakes?latitude=25.2&longitude=55.3&maxradiuskm=1500&starttime=<now-30d>&minmagnitude=4` | 200 (Gulf circle) | **200** | 342 | 2026-09-18T06:13:42Z | count **14**; e.g. `us7000thr6` M4.7 161 km N of Caluula, Somalia, `us7000th9l` M4.3 53 km NNE of Kāshmar, Iran, `us7000tg53` M4.3 115 km SE of Bushehr, Iran |
| c | `GET /api/sources/earthquakes?foo=bar` | 400 | **400** | 79 | 2026-09-18T06:13:42Z | `{"error": "invalid_query", "message": "Unknown parameter(s): foo", "unknown": ["foo"]}` |
| d | `GET /api/ondemand/health` | 200, chat/media/workflow healthy | **200** | 364 | 2026-09-18T06:13:42Z | ondemand healthy, chat healthy, speech degraded (by design), media healthy, workflow healthy; configured True; sources: baseUrl←ONDEMAND_BASE_URL, reasoningEndpointId←ONDEMAND_REASONING_ENDPOINT_ID, fulfillmentEndpointId←ONDEMAND_FULFILLMENT_ENDPOINT_ID, reasoningMode←ONDEMAND_REASONING_MODE, flowVersion←GODS_EYE_FLOW_VERSION, spatialFlowId←unset |
| e | OnDemand end-to-end: documented `POST /chat/v1/sessions` + `POST …/query` (sync, `endpointId predefined-gpt-5.6-luna`) with the (a) events injected as context | tool invoked / USGS ids cited | **201 / 200** | 291 / 7682 | 2026-09-18T06:13:43Z | **tool NOT attached** — REST agent creation is dashboard-only (docs §8, NOT FOUND IN LIVE DOCS), so the query ran with the USGS results injected as context; answer mentions USGS: True; cites **10/10** injected event ids (`us7000ti79`, `us7000ti70`, `us7000ti5y`, `us7000ti5b`, `us7000ti5c`, …); 2123 chars; session id hashed |
| f | `GET /api/ondemand/selftest` with `x-selftest-token` | 200, unchanged pass count | **200** | 29253 | 2026-09-18T06:13:51Z | ok True; passed 8 / failed 0 / skipped 2 (unchanged vs 05:47Z run); SSE ttfd 1967 ms |

## Answer excerpt (step e, secret-free)

```
Based on USGS observations retrieved at **2026-09-18 06:13:43 UTC**, the strongest worldwide earthquakes in the preceding 24 hours were:

1. **Magnitude 6.5 mww** — depth **111.666 km** — **165 km W of Nikolski, Alaska** — [us7000ti1p] ([USGS](https://earthquake.usgs.gov/earthquakes/eventpage/us7000ti1p)); tsunami flag: **1**.
2. **Magnitude 5.3 mww** — depth **10 km** — **191 km SE of Mata-Utu, Wallis and Futuna** — [us7000thzw] ([USGS](https://earthquake.usgs.gov/earthquakes/eventpage/us7000thzw)); tsunami flag: **0**.
3. **Magnitude 5.0 mb** — depth **10 km** — **South Atlantic Ocean** — [u…
```

## OnDemand tool registration

`ondemand_tool_id: null` — **NOT FOUND IN LIVE DOCS**: `docs/ONDEMAND_API_CURRENT.md` §8 documents only `GET /plugin/v1/list`; agent/tool creation and publishing are dashboard-only (REST API Agent, docs.on-demand.io/docs/rest-based-plugins.md). No create/attach endpoint was invented. The dashboard-importable definition (JSON schema + OpenAPI fragment, HTTP target `https://<preview-host>/api/sources/earthquakes`) is `docs/ondemand-workflows/tools/earthquake_search.json`. Note for the eventual dashboard registration: the sandbox host is ephemeral; point the agent at a durable deployment host.

## Registry row (src/registry/capabilities.json)

```json
{
  "id": "earthquake.search",
  "provider": "USGS FDSN Event",
  "route": "/api/sources/earthquakes",
  "ondemand_tool": "earthquake_search",
  "ondemand_tool_id": null,
  "coverage": "observed",
  "auth": "none",
  "persistent_connection": false,
  "status": "registered-unverified",
  "definition": "docs/ondemand-workflows/tools/earthquake_search.json",
  "notes": "REST agent creation is dashboard-only in the live OnDemand docs (\u00a78); status becomes 'live' once the tool is created in the dashboard and the end-to-end query invokes it."
}
```

Status stays `registered-unverified` until the tool exists in the OnDemand dashboard and an end-to-end query shows it being invoked (statusLog `executedAgents`).

