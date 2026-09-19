# Endpoint × reasoning-mode benchmark — 2026-09-18

Fixed spatial prompt: _"Summarize seismic activity risk for the Arabian Gulf region in the last 30 days given these events, in at most 120 words, citing the USGS ids: <3-event USGS sample: us7000thr6 M4.7 Caluula, Somalia; us7000th9l M4.3 Kashmar, Iran; us7000tg53 M4.3 Bushehr, Iran>"_. One session per endpoint (`POST /chat/v1/sessions`), then `POST …/query` in `sync` and in `stream` (`reasoningMode: "low"`, a documented example value — §3.1). Endpoint ids are from the documented §12 list; `predefined-claude-opus-5` was excluded (403 `content_policy_violation` on 2026-09-18T04:48Z). Base `https://api.on-demand.io`, header `apikey` `[REDACTED]`.

| endpointId                   | responseMode | reasoningMode | HTTP | total ms | ttfd ms | in/out/total tokens | ragTimeSec / fulfillmentTimeSec | answer chars | UTC                      |
| ---------------------------- | ------------ | ------------- | ---- | -------- | ------- | ------------------- | ------------------------------- | ------------ | ------------------------ |
| `predefined-gpt-5.6-luna`    | sync         | —             | 200  | 4189     | —       | 1149/228/1377       | 0.43 / 3.55                     | 593          | 2026-09-18T06:42:51.954Z |
| `predefined-gpt-5.6-luna`    | stream       | low           | 200  | 5121     | 1880    | 2607/219/2826       | 0.31 / 2.45                     | 612          | 2026-09-18T06:42:56.143Z |
| `predefined-gpt-5.6-terra`   | sync         | —             | 200  | 5687     | —       | 1149/224/1373       | 0.38 / 5.08                     | 633          | 2026-09-18T06:43:01.467Z |
| `predefined-gpt-5.6-terra`   | stream       | low           | 200  | 5637     | 2082    | 2610/196/2806       | 0.31 / 2.96                     | 610          | 2026-09-18T06:43:07.154Z |
| `predefined-claude-sonnet-5` | sync         | —             | 200  | 6480     | —       | 990/454/1444        | 0.45 / 5.85                     | 1081         | 2026-09-18T06:43:12.968Z |
| `predefined-claude-sonnet-5` | stream       | low           | 200  | 8069     | 4053    | 1647/346/1993       | 0.85 / 4.97                     | 726          | 2026-09-18T06:43:19.448Z |
| `predefined-deepseek-v4-pro` | sync         | —             | 200  | 14632    | —       | 1432/711/2143       | 0.5 / 13.97                     | 534          | 2026-09-18T06:43:27.678Z |
| `predefined-deepseek-v4-pro` | stream       | low           | 200  | 15394    | 11653   | 1867/591/2458       | 0.75 / 12.39                    | 550          | 2026-09-18T06:43:42.311Z |
| `predefined-xai-grok4.6`     | sync         | —             | 200  | 29860    | —       | 1324/147/1471       | 0.28 / 29.31                    | 458          | 2026-09-18T06:43:58.077Z |
| `predefined-xai-grok4.6`     | stream       | low           | 200  | 27817    | 23669   | 2649/145/2794       | 0.42 / 25.08                    | 437          | 2026-09-18T06:44:27.937Z |

Stream event mix observed (frames per type): `predefined-gpt-5.6-luna`: {'fulfillment': 167, 'metricsLog': 1, 'undefined': 1}; `predefined-gpt-5.6-terra`: {'fulfillment': 152, 'undefined': 1, 'metricsLog': 1}; `predefined-claude-sonnet-5`: {'undefined': 2, 'fulfillment_thinking': 3, 'fulfillment': 62, 'metricsLog': 1}; `predefined-deepseek-v4-pro`: {'fulfillment_thinking': 52, 'undefined': 5, 'fulfillment': 17, 'metricsLog': 1}; `predefined-xai-grok4.6`: {'fulfillment_thinking': 12, 'undefined': 9, 'fulfillment': 145, 'metricsLog': 1} (`undefined` = frames without an `eventType`, i.e. heartbeat frames). No `[ERROR]` marker in any run; every stream ended with `[DONE]`. No cost field is returned by the API — only `publicMetrics` token counts and timings (metricsLog).

## Chosen defaults (now in `api/ondemand/_config.js` → `TIER_DEFAULTS`)

| Tier        | fulfillment endpointId       | reasoningMode | Why                                                                               |
| ----------- | ---------------------------- | ------------- | --------------------------------------------------------------------------------- |
| ASK         | `predefined-gpt-5.6-luna`    | `low`         | fastest: 4,189 ms sync, 1,880 ms to first delta, adequate 593-char answer         |
| INVESTIGATE | `predefined-claude-sonnet-5` | `low`         | richest answer (1,081 chars, structured risk framing) at 6,480 ms / ttfd 4,053 ms |
| DEEP        | `predefined-claude-sonnet-5` | `high`        | same model with the documented higher reasoning mode for depth over latency       |

Not chosen: `predefined-gpt-5.6-terra` (5,687 ms — close to luna without a quality gain here), `predefined-deepseek-v4-pro` (14.6 s, long thinking phase), `predefined-xai-grok4.6` (29.9 s). Env overrides `ONDEMAND_REASONING_ENDPOINT_ID`, `ONDEMAND_FULFILLMENT_ENDPOINT_ID`, `ONDEMAND_REASONING_MODE` still take precedence; the `reasoningEndpointId` default is now the documented `low`.
