# OnDemand Public API — Current Contract (live-docs audit)

<!-- Intended repository path: docs/ONDEMAND_API_CURRENT.md -->

## 0. Header

| Field | Value |
|---|---|
| Title | OnDemand Public API — Current Contract (live-docs audit) |
| Generated (UTC) | 2026-09-17T06:14:03Z |
| Method | Every statement below was taken from documentation fetched **live** on 2026-09-17 (no memory, no prior knowledge). Three sources were fetched: (a) the public marketing/app shells `https://on-demand.io/`, `https://app.on-demand.io/api-reference`, `https://app.on-demand.io/documentation` (all three return an 8–10 KB JavaScript shell with no API text, so they are cited only as "checked"); (b) the public documentation site `https://docs.on-demand.io` — its `llms.txt` index plus **all 85** guide (`/docs/*.md`) and API-reference (`/reference/*.md`) pages, each of which embeds the endpoint's OpenAPI 3.0.3 definition; (c) the in-app API-reference data that `app.on-demand.io/api-reference` renders, served by the authenticated docs API `GET /config/v1/public/docs/categories` and `GET /config/v1/public/docs/reference/api/<slug>` (40 operation specs). The 40 in-app OpenAPI specs were compared field-by-field with the 40 public `/reference/*.md` specs and are **identical** (`paths` and `servers` JSON equal for all 40). |
| Citation format | `(src: <URL>, retrieved <UTC>)`. `docs.on-demand.io` page URLs are cited with the `.md` suffix that was actually fetched; the human-readable page is the same URL without `.md`. |
| Not-found rule | Where a surface is not in any fetched document it is marked **NOT FOUND IN LIVE DOCS** together with the URLs that were checked. |
| Counts | 136 URLs fetched: 131 × HTTP 200, 5 × HTTP 404 (probes for `sitemap.xml`, `llms-full.txt`, `openapi.json`, `/docs/api-reference`, and `https://api.on-demand.io/` root). |

### 0.1 Every documentation URL fetched (HTTP status, UTC retrieval time)

| # | URL fetched | HTTP | Retrieved (UTC) | Bytes | Note |
|---|---|---|---|---|---|
| 1 | https://app.on-demand.io/api-reference | 200 | 2026-09-17T05:55:52Z | 8866 |  |
| 2 | https://app.on-demand.io/documentation | 200 | 2026-09-17T05:55:52Z | 8866 |  |
| 3 | https://on-demand.io/ | 200 | 2026-09-17T05:55:52Z | 9792 |  |
| 4 | https://docs.on-demand.io/ | 200 | 2026-09-17T05:55:52Z | 202275 | → https://docs.on-demand.io/docs/getting-started |
| 5 | https://api.on-demand.io/ | 404 | 2026-09-17T05:55:54Z | 36 |  |
| 6 | https://docs.on-demand.io/sitemap.xml | 404 | 2026-09-17T05:56:10Z | 0 |  |
| 7 | https://docs.on-demand.io/llms.txt | 200 | 2026-09-17T05:56:10Z | 9493 |  |
| 8 | https://docs.on-demand.io/llms-full.txt | 404 | 2026-09-17T05:56:10Z | 115830 |  |
| 9 | https://docs.on-demand.io/openapi.json | 404 | 2026-09-17T05:56:10Z | 115825 |  |
| 10 | https://docs.on-demand.io/docs/api-reference | 404 | 2026-09-17T05:56:11Z | 116546 |  |
| 11 | https://docs.on-demand.io/docs/getting-started.md | 200 | 2026-09-17T05:56:30Z | 7476 |  |
| 12 | https://docs.on-demand.io/docs/authentication.md | 200 | 2026-09-17T05:56:30Z | 4795 |  |
| 13 | https://docs.on-demand.io/docs/rate-limiting.md | 200 | 2026-09-17T05:56:30Z | 1874 |  |
| 14 | https://docs.on-demand.io/docs/response-codes.md | 200 | 2026-09-17T05:56:30Z | 1998 |  |
| 15 | https://docs.on-demand.io/docs/pagination.md | 200 | 2026-09-17T05:56:30Z | 743 |  |
| 16 | https://docs.on-demand.io/docs/webhooks.md | 200 | 2026-09-17T05:56:30Z | 1401 |  |
| 17 | https://docs.on-demand.io/docs/videos.md | 200 | 2026-09-17T05:56:30Z | 3381 |  |
| 18 | https://docs.on-demand.io/docs/what-is-playground.md | 200 | 2026-09-17T05:56:30Z | 7514 |  |
| 19 | https://docs.on-demand.io/docs/what-are-plugins.md | 200 | 2026-09-17T05:56:30Z | 5652 |  |
| 20 | https://docs.on-demand.io/docs/open-api-schema.md | 200 | 2026-09-17T05:56:31Z | 16875 |  |
| 21 | https://docs.on-demand.io/docs/knowledge-plugin.md | 200 | 2026-09-17T05:56:31Z | 13678 |  |
| 22 | https://docs.on-demand.io/docs/rest-based-plugins.md | 200 | 2026-09-17T05:56:31Z | 8993 |  |
| 23 | https://docs.on-demand.io/docs/rest-api-plugin-examples.md | 200 | 2026-09-17T05:56:31Z | 17607 |  |
| 24 | https://docs.on-demand.io/docs/rules-to-publish-a-rest-api-plugin.md | 200 | 2026-09-17T05:56:31Z | 2618 |  |
| 25 | https://docs.on-demand.io/docs/mqttiot-plugins.md | 200 | 2026-09-17T05:56:31Z | 11722 |  |
| 26 | https://docs.on-demand.io/docs/terminal-agent.md | 200 | 2026-09-17T05:56:31Z | 23976 |  |
| 27 | https://docs.on-demand.io/docs/agent-skills.md | 200 | 2026-09-17T05:56:31Z | 13394 |  |
| 28 | https://docs.on-demand.io/docs/what-are-connectors.md | 200 | 2026-09-17T05:56:31Z | 3112 |  |
| 29 | https://docs.on-demand.io/docs/creating-byoi-endpoint.md | 200 | 2026-09-17T05:56:31Z | 6932 |  |
| 30 | https://docs.on-demand.io/docs/creating-byom-model-and-endpoint.md | 200 | 2026-09-17T05:56:31Z | 11514 |  |
| 31 | https://docs.on-demand.io/docs/serverless-application.md | 200 | 2026-09-17T05:56:31Z | 8575 |  |
| 32 | https://docs.on-demand.io/docs/what-are-chat-sessions.md | 200 | 2026-09-17T05:56:31Z | 2428 |  |
| 33 | https://docs.on-demand.io/docs/query-and-responses-modes.md | 200 | 2026-09-17T05:56:31Z | 32036 |  |
| 34 | https://docs.on-demand.io/docs/chat-wokflow.md | 200 | 2026-09-17T05:56:31Z | 3587 |  |
| 35 | https://docs.on-demand.io/docs/fulfillment-models.md | 200 | 2026-09-17T05:56:31Z | 4454 |  |
| 36 | https://docs.on-demand.io/docs/fulfillment-prompts.md | 200 | 2026-09-17T05:56:31Z | 26073 |  |
| 37 | https://docs.on-demand.io/docs/projects.md | 200 | 2026-09-17T05:56:31Z | 13589 |  |
| 38 | https://docs.on-demand.io/docs/agents-flow-builder.md | 200 | 2026-09-17T05:56:31Z | 962 |  |
| 39 | https://docs.on-demand.io/docs/creating-a-workflow.md | 200 | 2026-09-17T05:56:31Z | 5256 |  |
| 40 | https://docs.on-demand.io/docs/workflow-nodes.md | 200 | 2026-09-17T05:56:31Z | 7072 |  |
| 41 | https://docs.on-demand.io/docs/media-api.md | 200 | 2026-09-17T05:56:31Z | 11742 |  |
| 42 | https://docs.on-demand.io/docs/cloud-services-api.md | 200 | 2026-09-17T05:56:31Z | 7741 |  |
| 43 | https://docs.on-demand.io/docs/plugin-api.md | 200 | 2026-09-17T05:56:31Z | 5837 |  |
| 44 | https://docs.on-demand.io/docs/chat-api.md | 200 | 2026-09-17T05:56:31Z | 16084 |  |
| 45 | https://docs.on-demand.io/docs/workflow-api.md | 200 | 2026-09-17T05:56:31Z | 12033 |  |
| 46 | https://docs.on-demand.io/docs/execution-api.md | 200 | 2026-09-17T05:56:31Z | 8888 |  |
| 47 | https://docs.on-demand.io/docs/plugins.md | 200 | 2026-09-17T05:56:32Z | 4347 |  |
| 48 | https://docs.on-demand.io/docs/serverless.md | 200 | 2026-09-17T05:56:32Z | 1180 |  |
| 49 | https://docs.on-demand.io/docs/byom.md | 200 | 2026-09-17T05:56:32Z | 2217 |  |
| 50 | https://docs.on-demand.io/docs/general-faqs.md | 200 | 2026-09-17T05:56:32Z | 1261 |  |
| 51 | https://docs.on-demand.io/reference/intro-to-ondemand-api.md | 200 | 2026-09-17T05:56:32Z | 2957 |  |
| 52 | https://docs.on-demand.io/reference/how-to-do-authentication.md | 200 | 2026-09-17T05:56:32Z | 1872 |  |
| 53 | https://docs.on-demand.io/reference/how-to-paginate.md | 200 | 2026-09-17T05:56:32Z | 4849 |  |
| 54 | https://docs.on-demand.io/reference/rate-limits.md | 200 | 2026-09-17T05:56:32Z | 634 |  |
| 55 | https://docs.on-demand.io/reference/errors.md | 200 | 2026-09-17T05:56:32Z | 4225 |  |
| 56 | https://docs.on-demand.io/reference/fetchmedia.md | 200 | 2026-09-17T05:56:32Z | 9760 |  |
| 57 | https://docs.on-demand.io/reference/createmediaurl.md | 200 | 2026-09-17T05:56:32Z | 14297 |  |
| 58 | https://docs.on-demand.io/reference/deletemedia.md | 200 | 2026-09-17T05:56:32Z | 2035 |  |
| 59 | https://docs.on-demand.io/reference/convertaudiototext.md | 200 | 2026-09-17T05:56:32Z | 4416 |  |
| 60 | https://docs.on-demand.io/reference/converttexttoaudio.md | 200 | 2026-09-17T05:56:32Z | 5286 |  |
| 61 | https://docs.on-demand.io/reference/translatetext.md | 200 | 2026-09-17T05:56:32Z | 4767 |  |
| 62 | https://docs.on-demand.io/reference/createmqttuser.md | 200 | 2026-09-17T05:56:32Z | 3161 |  |
| 63 | https://docs.on-demand.io/reference/deletemqttuser.md | 200 | 2026-09-17T05:56:32Z | 2272 |  |
| 64 | https://docs.on-demand.io/reference/post_public-projects.md | 200 | 2026-09-17T05:56:32Z | 9552 |  |
| 65 | https://docs.on-demand.io/reference/get_public-projects.md | 200 | 2026-09-17T05:56:32Z | 10992 |  |
| 66 | https://docs.on-demand.io/reference/get_public-projects-projectid.md | 200 | 2026-09-17T05:56:32Z | 8122 |  |
| 67 | https://docs.on-demand.io/reference/patch_public-projects-projectid.md | 200 | 2026-09-17T05:56:32Z | 10083 |  |
| 68 | https://docs.on-demand.io/reference/delete_public-projects-projectid.md | 200 | 2026-09-17T05:56:33Z | 7305 |  |
| 69 | https://docs.on-demand.io/reference/get_public-sessions.md | 200 | 2026-09-17T05:56:33Z | 10772 |  |
| 70 | https://docs.on-demand.io/reference/post_approvalgate-executionid-approval-nodekey-approve.md | 200 | 2026-09-17T05:56:33Z | 3020 |  |
| 71 | https://docs.on-demand.io/reference/post_approvalgate-executionid-approval-nodekey-reject.md | 200 | 2026-09-17T05:56:33Z | 3015 |  |
| 72 | https://docs.on-demand.io/reference/get_execution-executionid.md | 200 | 2026-09-17T05:56:33Z | 4215 |  |
| 73 | https://docs.on-demand.io/reference/get_execution-executionid-delivery-track-email.md | 200 | 2026-09-17T05:56:33Z | 4726 |  |
| 74 | https://docs.on-demand.io/reference/get_execution-executionid-logs.md | 200 | 2026-09-17T05:56:33Z | 3805 |  |
| 75 | https://docs.on-demand.io/reference/get_execution-executionid-node-outputs.md | 200 | 2026-09-17T05:56:33Z | 3700 |  |
| 76 | https://docs.on-demand.io/reference/post_execution-executionid-report-problem.md | 200 | 2026-09-17T05:56:33Z | 3071 |  |
| 77 | https://docs.on-demand.io/reference/get_execution-executionid-transcript.md | 200 | 2026-09-17T05:56:33Z | 4142 |  |
| 78 | https://docs.on-demand.io/reference/get_execution-list.md | 200 | 2026-09-17T05:56:33Z | 4414 |  |
| 79 | https://docs.on-demand.io/reference/post_workflow.md | 200 | 2026-09-17T05:56:33Z | 11222 |  |
| 80 | https://docs.on-demand.io/reference/get_workflow.md | 200 | 2026-09-17T05:56:33Z | 11778 |  |
| 81 | https://docs.on-demand.io/reference/get_workflow-id.md | 200 | 2026-09-17T05:56:33Z | 11429 |  |
| 82 | https://docs.on-demand.io/reference/patch_workflow-id.md | 200 | 2026-09-17T05:56:33Z | 11028 |  |
| 83 | https://docs.on-demand.io/reference/delete_workflow-id.md | 200 | 2026-09-17T05:56:34Z | 1382 |  |
| 84 | https://docs.on-demand.io/reference/post_workflow-id-activate.md | 200 | 2026-09-17T05:56:34Z | 1318 |  |
| 85 | https://docs.on-demand.io/reference/post_workflow-id-deactivate.md | 200 | 2026-09-17T05:56:34Z | 1326 |  |
| 86 | https://docs.on-demand.io/reference/post_workflow-id-execute.md | 200 | 2026-09-17T05:56:34Z | 1814 |  |
| 87 | https://docs.on-demand.io/reference/patch_workflow-id-name.md | 200 | 2026-09-17T05:56:34Z | 1833 |  |
| 88 | https://docs.on-demand.io/reference/post_workflow-upload-config.md | 200 | 2026-09-17T05:56:34Z | 1629 |  |
| 89 | https://docs.on-demand.io/reference/createchatsession.md | 200 | 2026-09-17T05:56:34Z | 6326 |  |
| 90 | https://docs.on-demand.io/reference/getchatsessions.md | 200 | 2026-09-17T05:56:34Z | 7578 |  |
| 91 | https://docs.on-demand.io/reference/getchatsession.md | 200 | 2026-09-17T05:56:34Z | 5416 |  |
| 92 | https://docs.on-demand.io/reference/getchatmessages.md | 200 | 2026-09-17T05:56:34Z | 11513 |  |
| 93 | https://docs.on-demand.io/reference/getchatmessage.md | 200 | 2026-09-17T05:56:34Z | 9333 |  |
| 94 | https://docs.on-demand.io/reference/submitquery.md | 200 | 2026-09-17T05:56:34Z | 10816 |  |
| 95 | https://docs.on-demand.io/reference/updatelivesessionsettings.md | 200 | 2026-09-17T05:56:34Z | 5804 |  |
| 96 | https://gateway.on-demand.io/config/v1/public/docs/categories | 200 | 2026-09-17T05:57:04Z | 2918 |  |
| 97 | https://gateway.on-demand.io/config/v1/public/docs/reference/api/fetchmedia | 200 | 2026-09-17T05:57:05Z | 4539 |  |
| 98 | https://gateway.on-demand.io/config/v1/public/docs/reference/api/createmediaurl | 200 | 2026-09-17T05:57:06Z | 6963 |  |
| 99 | https://gateway.on-demand.io/config/v1/public/docs/reference/api/deletemedia | 200 | 2026-09-17T05:57:06Z | 961 |  |
| 100 | https://gateway.on-demand.io/config/v1/public/docs/reference/api/convertaudiototext | 200 | 2026-09-17T05:57:07Z | 1974 |  |
| 101 | https://gateway.on-demand.io/config/v1/public/docs/reference/api/converttexttoaudio | 200 | 2026-09-17T05:57:07Z | 2326 |  |
| 102 | https://gateway.on-demand.io/config/v1/public/docs/reference/api/translatetext | 200 | 2026-09-17T05:57:08Z | 2166 |  |
| 103 | https://gateway.on-demand.io/config/v1/public/docs/reference/api/createmqttuser | 200 | 2026-09-17T05:57:08Z | 1450 |  |
| 104 | https://gateway.on-demand.io/config/v1/public/docs/reference/api/deletemqttuser | 200 | 2026-09-17T05:57:09Z | 1093 |  |
| 105 | https://gateway.on-demand.io/config/v1/public/docs/reference/api/post_public-projects | 200 | 2026-09-17T05:57:09Z | 5290 |  |
| 106 | https://gateway.on-demand.io/config/v1/public/docs/reference/api/get_public-projects | 200 | 2026-09-17T05:57:10Z | 5886 |  |
| 107 | https://gateway.on-demand.io/config/v1/public/docs/reference/api/get_public-projects-projectid | 200 | 2026-09-17T05:57:10Z | 4496 |  |
| 108 | https://gateway.on-demand.io/config/v1/public/docs/reference/api/patch_public-projects-projectid | 200 | 2026-09-17T05:57:11Z | 5586 |  |
| 109 | https://gateway.on-demand.io/config/v1/public/docs/reference/api/delete_public-projects-projectid | 200 | 2026-09-17T05:57:11Z | 3940 |  |
| 110 | https://gateway.on-demand.io/config/v1/public/docs/reference/api/get_public-sessions | 200 | 2026-09-17T05:57:12Z | 5564 |  |
| 111 | https://gateway.on-demand.io/config/v1/public/docs/reference/api/post_approvalgate-executionid-approval-nodekey-approve | 200 | 2026-09-17T05:57:13Z | 1487 |  |
| 112 | https://gateway.on-demand.io/config/v1/public/docs/reference/api/post_approvalgate-executionid-approval-nodekey-reject | 200 | 2026-09-17T05:57:13Z | 1484 |  |
| 113 | https://gateway.on-demand.io/config/v1/public/docs/reference/api/get_execution-executionid | 200 | 2026-09-17T05:57:14Z | 1990 |  |
| 114 | https://gateway.on-demand.io/config/v1/public/docs/reference/api/get_execution-executionid-delivery-track-email | 200 | 2026-09-17T05:57:14Z | 2194 |  |
| 115 | https://gateway.on-demand.io/config/v1/public/docs/reference/api/get_execution-executionid-logs | 200 | 2026-09-17T05:57:15Z | 1728 |  |
| 116 | https://gateway.on-demand.io/config/v1/public/docs/reference/api/get_execution-executionid-node-outputs | 200 | 2026-09-17T05:57:15Z | 1709 |  |
| 117 | https://gateway.on-demand.io/config/v1/public/docs/reference/api/post_execution-executionid-report-problem | 200 | 2026-09-17T05:57:16Z | 1500 |  |
| 118 | https://gateway.on-demand.io/config/v1/public/docs/reference/api/get_execution-executionid-transcript | 200 | 2026-09-17T05:57:16Z | 1904 |  |
| 119 | https://gateway.on-demand.io/config/v1/public/docs/reference/api/get_execution-list | 200 | 2026-09-17T05:57:17Z | 1998 |  |
| 120 | https://gateway.on-demand.io/config/v1/public/docs/reference/api/post_workflow | 200 | 2026-09-17T05:57:17Z | 5314 |  |
| 121 | https://gateway.on-demand.io/config/v1/public/docs/reference/api/get_workflow | 200 | 2026-09-17T05:57:18Z | 5567 |  |
| 122 | https://gateway.on-demand.io/config/v1/public/docs/reference/api/get_workflow-id | 200 | 2026-09-17T05:57:18Z | 5447 |  |
| 123 | https://gateway.on-demand.io/config/v1/public/docs/reference/api/patch_workflow-id | 200 | 2026-09-17T05:57:19Z | 5267 |  |
| 124 | https://gateway.on-demand.io/config/v1/public/docs/reference/api/delete_workflow-id | 200 | 2026-09-17T05:57:19Z | 629 |  |
| 125 | https://gateway.on-demand.io/config/v1/public/docs/reference/api/post_workflow-id-activate | 200 | 2026-09-17T05:57:20Z | 600 |  |
| 126 | https://gateway.on-demand.io/config/v1/public/docs/reference/api/post_workflow-id-deactivate | 200 | 2026-09-17T05:57:20Z | 606 |  |
| 127 | https://gateway.on-demand.io/config/v1/public/docs/reference/api/post_workflow-id-execute | 200 | 2026-09-17T05:57:21Z | 804 |  |
| 128 | https://gateway.on-demand.io/config/v1/public/docs/reference/api/patch_workflow-id-name | 200 | 2026-09-17T05:57:21Z | 795 |  |
| 129 | https://gateway.on-demand.io/config/v1/public/docs/reference/api/post_workflow-upload-config | 200 | 2026-09-17T05:57:22Z | 740 |  |
| 130 | https://gateway.on-demand.io/config/v1/public/docs/reference/api/createchatsession | 200 | 2026-09-17T05:57:22Z | 3623 |  |
| 131 | https://gateway.on-demand.io/config/v1/public/docs/reference/api/getchatsessions | 200 | 2026-09-17T05:57:23Z | 4436 |  |
| 132 | https://gateway.on-demand.io/config/v1/public/docs/reference/api/getchatsession | 200 | 2026-09-17T05:57:23Z | 3031 |  |
| 133 | https://gateway.on-demand.io/config/v1/public/docs/reference/api/getchatmessages | 200 | 2026-09-17T05:57:24Z | 6990 |  |
| 134 | https://gateway.on-demand.io/config/v1/public/docs/reference/api/getchatmessage | 200 | 2026-09-17T05:57:25Z | 5589 |  |
| 135 | https://gateway.on-demand.io/config/v1/public/docs/reference/api/submitquery | 200 | 2026-09-17T05:57:25Z | 6196 |  |
| 136 | https://gateway.on-demand.io/config/v1/public/docs/reference/api/updatelivesessionsettings | 200 | 2026-09-17T05:57:26Z | 2993 |  |

---

## 1. Authentication

| Item | Value | Source |
|---|---|---|
| Header name | **`apikey`** — every OpenAPI spec declares `securitySchemes: { apikey | ApiKeyAuth: { type: apiKey, in: header, name: "apikey" } }`; the Services specs declare it as an explicit required header parameter `apikey`. | `(src: https://docs.on-demand.io/reference/submitquery.md, retrieved 2026-09-17T05:56:34Z)`; `(src: https://docs.on-demand.io/reference/post_workflow.md, retrieved 2026-09-17T05:56:33Z)`; `(src: https://docs.on-demand.io/reference/convertaudiototext.md, retrieved 2026-09-17T05:56:32Z)`; `(src: https://docs.on-demand.io/reference/how-to-do-authentication.md, retrieved 2026-09-17T05:56:32Z)` — "set the API key in request header named `apikey` in each API" |
| ⚠ Documentation inconsistency | The guide page `docs/authentication` contains one sentence "We use the Authorization header with the Bearer token type", but every example on that same page and every OpenAPI spec uses `apikey: <key>`. Treat `apikey` as the contract; no `Authorization: Bearer` example exists anywhere in the fetched docs. | `(src: https://docs.on-demand.io/docs/authentication.md, retrieved 2026-09-17T05:56:30Z)` |
| Key format / prefix | **NOT FOUND IN LIVE DOCS** — neither authentication page describes a prefix, length or format; the key "will be displayed on screen only once". Checked: `https://docs.on-demand.io/docs/authentication.md`, `https://docs.on-demand.io/reference/how-to-do-authentication.md`, `https://docs.on-demand.io/docs/getting-started.md`. | as listed |
| How keys are issued | Dashboard only: Settings → **API Key Management** (`https://app.on-demand.io/api-keys-management`) → "Create New API Key"; multiple keys per account are allowed; revoke a compromised key immediately. | `(src: https://docs.on-demand.io/docs/authentication.md, retrieved 2026-09-17T05:56:30Z)`; `(src: https://docs.on-demand.io/reference/how-to-do-authentication.md, retrieved 2026-09-17T05:56:32Z)` |
| Base URL — documented default | `https://api.on-demand.io/` | `(src: https://docs.on-demand.io/reference/intro-to-ondemand-api.md, retrieved 2026-09-17T05:56:32Z)`; `(src: https://docs.on-demand.io/docs/getting-started.md, retrieved 2026-09-17T05:56:30Z)` |
| Base URL per API family (OpenAPI `servers[].url`) | Chat API: `https://api.on-demand.io` (paths `/chat/v1/...`) · Media API: `https://api.on-demand.io` (paths `/media/v1/public/file...`) · Services API: `https://api.on-demand.io/services/v1/public/service` (paths `/execute/...`) · Projects API: `https://api.on-demand.io/chat/v1` (paths `/public/projects...`, `/public/sessions`) · Agents Flow Builder API: `https://api.on-demand.io/automation/api` (paths `/workflow...`, `/execution...`, `/approvalgate...`) · Agents API (guide only): `https://api.on-demand.io/plugin/v1/list` · MQTT User Management: the spec's `servers[].url` is **`https://gateway-dev.on-demand.io`** ("Development server") — the only family whose spec does not point at `api.on-demand.io`. | `(src: https://docs.on-demand.io/reference/createchatsession.md, retrieved 2026-09-17T05:56:34Z)`; `(src: https://docs.on-demand.io/reference/createmediaurl.md, retrieved 2026-09-17T05:56:32Z)`; `(src: https://docs.on-demand.io/reference/converttexttoaudio.md, retrieved 2026-09-17T05:56:32Z)`; `(src: https://docs.on-demand.io/reference/post_public-projects.md, retrieved 2026-09-17T05:56:32Z)`; `(src: https://docs.on-demand.io/reference/post_workflow.md, retrieved 2026-09-17T05:56:33Z)`; `(src: https://docs.on-demand.io/docs/plugin-api.md, retrieved 2026-09-17T05:56:31Z)`; `(src: https://docs.on-demand.io/reference/createmqttuser.md, retrieved 2026-09-17T05:56:32Z)` |
| Scoping | Keys are company-scoped: responses carry `companyId`; approval-gate calls state "companyID and userID are taken from the auth context". Per-key scopes/permissions: **NOT FOUND IN LIVE DOCS** (checked the two authentication pages above). | `(src: https://docs.on-demand.io/reference/createchatsession.md, retrieved 2026-09-17T05:56:34Z)`; `(src: https://docs.on-demand.io/llms.txt, retrieved 2026-09-17T05:56:10Z)` |
| Rate limits | Global: "All the endpoints have a rate-limit set against an origin IP address — 10,000 requests per minute". Free-plan object limits: Media Upload 5/min; RAG Calls 100/min; max GPU memory 40 GB per company; max vCPU 10 per company; increases via Settings → Limit → Increase Your Limits (answer within 2 business days). HTTP 429 `rate_limit_exceeded` on breach. Rate-limit response headers: **NOT FOUND IN LIVE DOCS**. | `(src: https://docs.on-demand.io/reference/rate-limits.md, retrieved 2026-09-17T05:56:32Z)`; `(src: https://docs.on-demand.io/docs/rate-limiting.md, retrieved 2026-09-17T05:56:30Z)`; `(src: https://docs.on-demand.io/reference/errors.md, retrieved 2026-09-17T05:56:32Z)` |
| Error envelope | `{ "errorCode": "<machine code>", "message": "<text>" }`; common codes `invalid_request` 400, `unauthenticated` 401, `unauthorized` 403, `not_found` 404, `method_not_allowed` 405, `rate_limit_exceeded` 429, `server_error` 500, `bad_gateway` 502, `resource_unavailable` 503; chat-specific `plugin_execution_timeout` 504 (plugin timeout 2.5 min), `context_length_exceeded` 400, `model_error` 500. | `(src: https://docs.on-demand.io/reference/errors.md, retrieved 2026-09-17T05:56:32Z)`; `(src: https://docs.on-demand.io/docs/response-codes.md, retrieved 2026-09-17T05:56:30Z)` |

---

## 2. Chat Sessions

Sources for this section unless stated otherwise: OpenAPI specs `(src: https://docs.on-demand.io/reference/createchatsession.md, retrieved 2026-09-17T05:56:34Z)`, `(src: https://docs.on-demand.io/reference/getchatsessions.md, retrieved 2026-09-17T05:56:34Z)`, `(src: https://docs.on-demand.io/reference/getchatsession.md, retrieved 2026-09-17T05:56:34Z)`; guide `(src: https://docs.on-demand.io/docs/chat-api.md, retrieved 2026-09-17T05:56:31Z)`; identical in-app specs `(src: https://gateway.on-demand.io/config/v1/public/docs/reference/api/createchatsession, retrieved 2026-09-17T05:57:22Z)`, `.../getchatsessions` (05:57:23Z), `.../getchatsession` (05:57:23Z).

**Reuse semantics.** A session "represents a single, continuous interaction… maintains the context of the conversation"; create a new one for a new user, a distinct topic, a long time gap, or after logout; keep using the existing one for ongoing conversations, short breaks and contextual answers `(src: https://docs.on-demand.io/docs/what-are-chat-sessions.md, retrieved 2026-09-17T05:56:31Z)`. Plugins set on the session apply to every query "if set here and not overwritten through `/query`"; a query-level list replaces the session list; with none at either level "the system will bypass the RAG and proceed directly to execute the fulfillment" (createchatsession + submitquery specs above). A `title` is auto-generated "when the first query is submitted in the session" (createchatsession spec).

**User-identity field.** `externalUserId` — "An identifier of the external user creating this chat session… external to OnDemand but internal to your own system… can be used for filtering sessions and auditing. If not managing chat users internally, use any unique string." It is **required** in the OpenAPI schema (`required: ["externalUserId"]`) but the Chat API guide table marks it "Required: No" — send it always. It is also a filter on `GET /chat/v1/sessions?externalUserId=` and `GET …/messages?externalUserId=`.

**TTL / context fields.** No TTL, expiry or `contextMetadata` field exists on the Chat API session schema (request or response). `contextMetadata` appears only (a) in the Projects API "Delete project" request schema as `contextMetadata: [{key, value}]` `(src: https://docs.on-demand.io/reference/delete_public-projects-projectid.md, retrieved 2026-09-17T05:56:33Z)` and (b) as the phrase "Update Chat Session — Update a specific chat session's context metadata" in the API index, whose link points to the *Get Chat Session* page — **no update-session endpoint spec is published** `(src: https://docs.on-demand.io/reference/intro-to-ondemand-api.md, retrieved 2026-09-17T05:56:32Z)`. Session-level plugin selection is `pluginIds` (max 20).

### 2.1 Create session — `POST https://api.on-demand.io/chat/v1/sessions`

Headers: `apikey: <YOUR_API_KEY>`, `Content-Type: application/json`.

Request JSON (schema): `externalUserId` string **required**; `pluginIds` string[] optional, `maxItems: 20`.

```json
{ "externalUserId": "user-app-12345", "pluginIds": [] }
```

Response 200 JSON (schema): `message` string ("Chat session created successfully"); `data.id` (session id), `data.companyId`, `data.externalUserId`, `data.pluginIds[]`, `data.title`, `data.createdBy`, `data.createdAt`, `data.updatedAt`. 4XX/5XX → `{errorCode, message}`.

```bash
curl -X POST https://api.on-demand.io/chat/v1/sessions \
  -H "apikey: $ONDEMAND_API_KEY" -H "Content-Type: application/json" \
  -d '{"externalUserId":"user-app-12345","pluginIds":[]}'
```

```js
// Node 18+, ESM
const res = await fetch("https://api.on-demand.io/chat/v1/sessions", {
  method: "POST",
  headers: { apikey: process.env.ONDEMAND_API_KEY, "Content-Type": "application/json" },
  body: JSON.stringify({ externalUserId: "user-app-12345", pluginIds: [] }),
});
const { data } = await res.json();
const sessionId = data.id;
```

> ⚠ Naming drift inside the live docs: the reference spec and the Chat API guide use `pluginIds`, but the guide pages `reference/how-to-do-authentication`, `reference/how-to-paginate`, `docs/query-and-responses-modes`, `docs/fulfillment-prompts` and `docs/terminal-agent` show the same body with **`agentIds`** (e.g. `{"agentIds": [], "externalUserId": "d3cbaaab-…"}`) `(src: https://docs.on-demand.io/reference/how-to-do-authentication.md, retrieved 2026-09-17T05:56:32Z)`, `(src: https://docs.on-demand.io/docs/terminal-agent.md, retrieved 2026-09-17T05:56:31Z)`. See §13 and §15.

### 2.2 List sessions — `GET https://api.on-demand.io/chat/v1/sessions`

Query params: `externalUserId` (filter), `sort` enum `asc|desc` default `desc`, `cursor` (omit on first call; then `pagination.next`), `limit` int 1–50 default 10 (values below the minimum reset to default, above the maximum reset to 50). Response: `message`, `data[]` (session objects as in 2.1), `pagination.next` (empty string when exhausted), `pagination.limit`. Cursor pagination is documented at `(src: https://docs.on-demand.io/reference/how-to-paginate.md, retrieved 2026-09-17T05:56:32Z)`.

```bash
curl "https://api.on-demand.io/chat/v1/sessions?limit=10&sort=desc" -H "apikey: $ONDEMAND_API_KEY"
```

```js
const r = await fetch("https://api.on-demand.io/chat/v1/sessions?limit=10&sort=desc", { headers: { apikey: process.env.ONDEMAND_API_KEY } });
const { data, pagination } = await r.json(); // next page: ?cursor=<pagination.next>
```

### 2.3 Get session — `GET https://api.on-demand.io/chat/v1/sessions/{sessionId}`

Path param `sessionId` required. Response: `message` ("Chat session fetched successfully") + `data` session object.

```bash
curl "https://api.on-demand.io/chat/v1/sessions/$SESSION_ID" -H "apikey: $ONDEMAND_API_KEY"
```

```js
const s = await (await fetch(`https://api.on-demand.io/chat/v1/sessions/${sessionId}`, { headers: { apikey: process.env.ONDEMAND_API_KEY } })).json();
```

### 2.4 Delete session — **NOT FOUND IN LIVE DOCS**

No delete-session operation exists in the categories index (Chat API lists exactly: Create Chat Session, Get Chat Sessions, Get Chat Session, Get Chat Messages, Get Chat Message, Submit Query, Update Live Session Settings) `(src: https://gateway.on-demand.io/config/v1/public/docs/categories, retrieved 2026-09-17T05:57:04Z)`, nor in `llms.txt` `(src: https://docs.on-demand.io/llms.txt, retrieved 2026-09-17T05:56:10Z)`, nor in the Chat API guide. The only documented deletion that removes sessions is **Delete project** (`DELETE https://api.on-demand.io/chat/v1/public/projects/{projectId}` — "Every session filed under the project is deleted… permanently erased about 30 days later") `(src: https://docs.on-demand.io/docs/projects.md, retrieved 2026-09-17T05:56:31Z)`.

### 2.5 Related, documented session surfaces

- **Messages:** `GET /chat/v1/sessions/{sessionId}/messages` (query `externalUserId`, `sort` asc|desc, `cursor`, `limit` 1–50 default 10) and `GET /chat/v1/sessions/{sessionId}/messages/{messageId}`. Message object: `id, sessionId, companyId, externalUserId, pluginIds[], endpointId, responseMode (sync|stream|webhook), status (processing|completed|failed), type (text|media), media{id,name,source(document|video|audio|youtube|image),url,context}, query, answer, createdBy, createdAt, updatedAt` `(src: https://docs.on-demand.io/reference/getchatmessages.md, retrieved 2026-09-17T05:56:34Z)`, `(src: https://docs.on-demand.io/reference/getchatmessage.md, retrieved 2026-09-17T05:56:34Z)`.
- **Live session settings:** `PUT /chat/v1/sessions/{sessionId}/live-settings` with `enabled` boolean (required), `mode` enum `proactive|onevents` (required; "proactive — the assistant initiates messages on its own; onevents — the assistant only responds to triggered events"), `destinations.email{enabled, recipient}`, `destinations.slack{enabled}`; response echoes the settings `(src: https://docs.on-demand.io/reference/updatelivesessionsettings.md, retrieved 2026-09-17T05:56:34Z)`. This is message/notification "live mode", not voice.
- **Project-scoped sessions (guide only):** `POST /v1/public/sessions` with `{externalUserId, projectId}` and `GET /v1/public/sessions?projectId=…` (listing without `projectId` returns only sessions outside any project); only the GET has a published spec (`GET https://api.on-demand.io/chat/v1/public/sessions?projectId=…&status=draft|initiated|processing|completed|failed`) `(src: https://docs.on-demand.io/docs/projects.md, retrieved 2026-09-17T05:56:31Z)`, `(src: https://docs.on-demand.io/reference/get_public-sessions.md, retrieved 2026-09-17T05:56:33Z)`.

---

## 3. Chat Query (sync and stream) — `POST https://api.on-demand.io/chat/v1/sessions/{sessionId}/query`

Primary source: OpenAPI spec `(src: https://docs.on-demand.io/reference/submitquery.md, retrieved 2026-09-17T05:56:34Z)` (identical to `(src: https://gateway.on-demand.io/config/v1/public/docs/reference/api/submitquery, retrieved 2026-09-17T05:57:25Z)`); guides `(src: https://docs.on-demand.io/docs/chat-api.md, retrieved 2026-09-17T05:56:31Z)`, `(src: https://docs.on-demand.io/docs/query-and-responses-modes.md, retrieved 2026-09-17T05:56:31Z)`, `(src: https://docs.on-demand.io/docs/fulfillment-prompts.md, retrieved 2026-09-17T05:56:31Z)`, `(src: https://docs.on-demand.io/docs/fulfillment-models.md, retrieved 2026-09-17T05:56:31Z)`.

Headers: `apikey`, `Content-Type: application/json`. Path: `sessionId` required.

### 3.1 Every body field

| Field | Type | Allowed values / constraints | Default | Where documented |
|---|---|---|---|---|
| `query` | string | the user's message | — (required) | OpenAPI `required: [query, endpointId, responseMode]` |
| `endpointId` | string | "Endpoint ID of the fulfillment model… predefined, BYOI or BYOM"; predefined IDs are enumerated on the Models page (§12); BYOI/BYOM IDs come from `https://app.on-demand.io/byoi-management` and `https://app.on-demand.io/byom-management/endpoints` | — (required) | OpenAPI + `docs/fulfillment-models.md` |
| `responseMode` | string | enum **`sync` \| `stream` \| `webhook`** | OpenAPI: required (no default). Guide `docs/chat-api.md` says "Optional… Defaults to `sync`" — a documented contradiction; send it explicitly. | OpenAPI; guide |
| `pluginIds` | string[] | `maxItems: 20`; "replace the plugin IDs set during session creation"; empty/absent → session plugins; none anywhere → RAG bypassed | session value | OpenAPI. Guide samples use **`agentIds`** instead (see §13). |
| `fulfillmentOnly` | boolean | `true` skips RAG (and therefore plugin execution) even when plugins are set | `false` | OpenAPI |
| `modelConfigs` | object | wrapper for model configuration; "If not passed, default configuration will be used" | — | OpenAPI |
| `modelConfigs.fulfillmentPrompt` | string | system-style instructions; the Fulfillment Prompts guide uses the placeholders `{context}` and `{question}` inside it | model default | OpenAPI; `docs/fulfillment-prompts.md` |
| `modelConfigs.stopSequences` | string[] | "Up to 4 sequences" | — | OpenAPI |
| `modelConfigs.temperature` | number (float) | 0 – 2 | 0.7 | OpenAPI |
| `modelConfigs.topP` | number (float) | 0 – 1 | 1 | OpenAPI |
| `modelConfigs.presencePenalty` | number (float) | 0 – 2 | 0 | OpenAPI |
| `modelConfigs.frequencyPenalty` | number (float) | 0 – 2 | 0 | OpenAPI |
| `reasoningMode` | string | **Not in the OpenAPI schema.** Guide: "Controls reasoning detail in `stream` mode (e.g., `low`, `high`) — relevant only for `responseMode: stream`"; guide samples send `"reasoningMode": "low"` and `"reasoningMode": "grok-4-fast"`. No enumerated list of allowed values is published. | — | `docs/chat-api.md`; `docs/query-and-responses-modes.md` |
| `maxTokens` / `max_tokens` | — | **NOT FOUND IN LIVE DOCS** (0 hits across all 85 pages + 40 specs) | — | — |
| structured / JSON output (`responseFormat`, `json_schema`, …) | — | **NOT FOUND IN LIVE DOCS** for Submit Query (the only `structured`/`json_schema` hits are in the REST-agent OpenAPI-schema guides, unrelated to the query body) | — | checked `docs/open-api-schema.md`, `docs/agent-skills.md`, `docs/general-faqs.md`, `docs/what-are-connectors.md` |
| file / media attachment field on the query | — | **NOT FOUND IN LIVE DOCS** on the query body. Media is attached to a conversation by uploading it with the Media API and passing the same `sessionId` (§5); the resulting message appears in the session with `type: "media"`. | — | `docs/media-api.md`; `reference/getchatmessage.md` |
| `agentIds` / `tools` | — | `agentIds` appears only in guide code samples (never in a schema); `tools` — **NOT FOUND IN LIVE DOCS** | — | see §13 |

Plugin/agent selection naming: **the schemas say `pluginIds`; the newer guide samples say `agentIds`** (both live). Streaming status events name executed tools `retrievedAgents[].agentId` / `executedAgents[].agentId` (§4).

### 3.2 Sync request / response

```json
{ "query": "What is AI?", "endpointId": "predefined-claude-sonnet-5", "responseMode": "sync", "pluginIds": [], "modelConfigs": { "temperature": 0.7 } }
```

Response 200 ("Sync Mode Response"): `message` ("Chat query submitted successfully"), `data.sessionId`, `data.messageId`, `data.answer` (the full answer), `data.status` enum `processing|completed|failed`.

```bash
curl -X POST "https://api.on-demand.io/chat/v1/sessions/$SESSION_ID/query" \
  -H "apikey: $ONDEMAND_API_KEY" -H "Content-Type: application/json" \
  -d '{"query":"What is AI?","endpointId":"predefined-claude-sonnet-5","responseMode":"sync","pluginIds":[]}'
```

```js
const r = await fetch(`https://api.on-demand.io/chat/v1/sessions/${sessionId}/query`, {
  method: "POST",
  headers: { apikey: process.env.ONDEMAND_API_KEY, "Content-Type": "application/json" },
  body: JSON.stringify({ query: "What is AI?", endpointId: "predefined-claude-sonnet-5", responseMode: "sync", pluginIds: [] }),
});
const { data } = await r.json(); // data.answer, data.messageId, data.status
```

### 3.3 Webhook mode (for completeness)

`responseMode: "webhook"` returns immediately `{ "message": "Chat query submitted successfully", "data": { "sessionId", "messageId", "status": "processing" } }`; the answer is posted to the webhook URL configured at `https://app.on-demand.io/settings/webhooks` (endpoint URL, webhook secret, success response codes, retry mechanism exponential/sequential). The webhook **payload schema and signature header are NOT FOUND IN LIVE DOCS** `(src: https://docs.on-demand.io/docs/webhooks.md, retrieved 2026-09-17T05:56:30Z)`, `(src: https://docs.on-demand.io/docs/query-and-responses-modes.md, retrieved 2026-09-17T05:56:31Z)`.

### 3.4 Stream request / response

```json
{ "query": "Get the city based on ip \"122.108.92.210\" and find the current weather in that city", "endpointId": "predefined-claude-sonnet-5", "responseMode": "stream", "pluginIds": [], "reasoningMode": "low" }
```

Response: HTTP 200 with a Server-Sent-Events body (see §4 for the event schema and a verbatim stream).

```bash
curl -N -X POST "https://api.on-demand.io/chat/v1/sessions/$SESSION_ID/query" \
  -H "apikey: $ONDEMAND_API_KEY" -H "Content-Type: application/json" \
  -d '{"query":"What is AI?","endpointId":"predefined-claude-sonnet-5","responseMode":"stream","pluginIds":[]}'
```

```js
// Node 18+, ESM — minimal SSE reader for the documented event/data framing
const r = await fetch(`https://api.on-demand.io/chat/v1/sessions/${sessionId}/query`, {
  method: "POST",
  headers: { apikey: process.env.ONDEMAND_API_KEY, "Content-Type": "application/json" },
  body: JSON.stringify({ query: "What is AI?", endpointId: "predefined-claude-sonnet-5", responseMode: "stream", pluginIds: [] }),
});
let answer = "", buf = "", event = "message";
const dec = new TextDecoder();
for await (const chunk of r.body) {
  buf += dec.decode(chunk, { stream: true });
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trimEnd(); buf = buf.slice(nl + 1);
    if (line.startsWith("event:")) { event = line.slice(6).trim(); continue; }
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (data === "[DONE]") { /* terminal marker */ break; }
    if (data.startsWith("[ERROR]:")) throw new Error(data.slice(8));
    if (event === "heartbeat") continue;
    const evt = JSON.parse(data);
    if (evt.eventType === "fulfillment") answer += evt.answer;
  }
}
```

---

## 4. Streaming transport & event schema

Source for everything in this section: `(src: https://docs.on-demand.io/docs/query-and-responses-modes.md, retrieved 2026-09-17T05:56:31Z)`.

- **Transport:** Server-Sent Events over the HTTP response of `POST …/query` with `responseMode: "stream"` ("you get the answer through server-side events (SSE)… Each event is preceded by an `event` field… also includes the `data` field"). No WebSocket transport is documented (0 hits for `websocket`/`wss://` in all fetched pages).
- **Event names (`event:` field):** `heartbeat`, `thinking`, `message`. (`thinking` is listed as a possible value; its payload is not further specified on the page.)
- **`heartbeat` payload:** `{"sessionId","messageId","time"}` (ISO-8601) — "Clients can safely ignore this event".
- **`message` payload (JSON in `data:`):** `sessionId`, `messageId`, `eventType` enum `statusLog | metricsLog | fulfillment`, `eventIndex` (starts at 1 **per event type**, use it to re-order out-of-order chunks), `answer` (set only for `fulfillment` — append the chunks), `status` (`"processing"`), and for `statusLog` a `currentStatusLog` object.
- **Delta shape:** `{"sessionId":"…","messageId":"…","answer":" IP","status":"processing","eventIndex":13,"eventType":"fulfillment"}`.
- **Tool/plugin events (`eventType: "statusLog"`):** `currentStatusLog.statusType` values seen in the documented stream: `analyzing`, `plan_created`, `reanalyzing`, `agents_retrieved`, `executing`, `execution_completed`, `fulfilling`, `fulfillment_completed`; with `stepQuery`, `statusMessage`, `retrievedAgents[]` / `executedAgents[]` (each `{agentId, name, identifier (e.g. rest_api | internet), url, method, queryParams?, statusCode?}`) and `time`.
- **Metrics event (`eventType: "metricsLog"`):** `publicMetrics: {inputTokens, outputTokens, totalTokens, ragTimeSec, fulfillmentTimeSec, totalTimeSec}`.
- **Terminal marker:** `event:message` / `data:[DONE]` — "Once you receive that, the connection is closed".
- **Error marker:** `event:message` / `data:[ERROR]:<JSON error>` — e.g. `[ERROR]:{"message":"Model context length exceeded","errorCode":"context_length_exceeded"}`; the connection is closed after it.

Verbatim example stream from the docs (abridged only by omitting repeated single-token `fulfillment` deltas between `eventIndex` 14 and 45):

```text
event:message
data:{"sessionId":"67cdf850f010b118a8433904","messageId":"67cdfa0e3bc093c29d67de44","eventIndex":1,"eventType":"statusLog","status":"processing","currentStatusLog":{"stepQuery":"","statusType":"analyzing","statusMessage":"Analyzing the prompt...","retrievedAgents":[],"executedAgents":[],"time":"2025-03-09T20:31:03.231Z"}}
event:message
data:{"sessionId":"67cdf850f010b118a8433904","messageId":"67cdfa0e3bc093c29d67de44","eventIndex":4,"eventType":"statusLog","status":"processing","currentStatusLog":{"stepQuery":"Retrieve the location details, including the city, for the IP address 122.108.92.210.","statusType":"agents_retrieved","statusMessage":"Retrieved the agents","retrievedAgents":[{"agentId":"agent-1714419354","name":"IPbase agent","identifier":"rest_api","url":"https://api.ipbase.com/v2/info","method":"GET"}],"executedAgents":[],"time":"2025-03-09T20:31:13.993Z"}}
event:message
data:{"sessionId":"67cdf850f010b118a8433904","messageId":"67cdfa0e3bc093c29d67de44","eventIndex":6,"eventType":"statusLog","status":"processing","currentStatusLog":{"stepQuery":"Retrieve the location details, including the city, for the IP address 122.108.92.210.","statusType":"execution_completed","statusMessage":"Agents execution completed","retrievedAgents":[],"executedAgents":[{"agentId":"agent-1714419354","name":"IPbase agent","identifier":"rest_api","url":"https://api.ipbase.com/v2/info","method":"GET","queryParams":{"ip":"122.108.92.210"},"statusCode":200}],"time":"2025-03-09T20:31:14.265Z"}}
event:message
data:{"sessionId":"67cdf850f010b118a8433904","messageId":"67cdfa0e3bc093c29d67de44","eventIndex":11,"eventType":"statusLog","status":"processing","currentStatusLog":{"stepQuery":"","statusType":"fulfilling","statusMessage":"Fulfilling the prompt...","retrievedAgents":[],"executedAgents":[],"time":"2025-03-09T20:31:22.662Z"}}
event:message
data:{"sessionId": "67cdf850f010b118a8433904", "messageId": "67cdfa0e3bc093c29d67de44", "answer": "The", "status": "processing", "eventIndex":12, "eventType": "fulfillment"}
event:message
data:{"sessionId": "67cdf850f010b118a8433904", "messageId": "67cdfa0e3bc093c29d67de44", "answer": " IP", "status": "processing", "eventIndex":13, "eventType": "fulfillment"}
event:message
data:{"sessionId": "67cdf850f010b118a8433904", "messageId": "67cdfa0e3bc093c29d67de44", "answer": ".", "status": "processing", "eventIndex":46, "eventType": "fulfillment"}
event:message
data:{"sessionId":"67cdf850f010b118a8433904","messageId":"67cdfa0e3bc093c29d67de44","eventIndex":47,"eventType":"statusLog","status":"processing","currentStatusLog":{"stepQuery":"","statusType":"fulfillment_completed","statusMessage":"Fulfillment completed","retrievedAgents":[],"executedAgents":[],"time":"2025-03-09T20:31:23.99Z"}}
event:message
data:{"sessionId":"67cdf850f010b118a8433904","messageId":"67cdfa0e3bc093c29d67de44","eventIndex":48,"eventType":"metricsLog","status":"processing","publicMetrics":{"inputTokens":1262,"outputTokens":35,"totalTokens":1297,"ragTimeSec":19.43,"fulfillmentTimeSec":1.33,"totalTimeSec":20.76}}
event:message
data:[DONE]
```

Heartbeat example (verbatim): `event:heartbeat` / `data:{"sessionId":"69b40bffd988dfb1082fe688", "messageId":"69b40c14d988dfb1082fe689", "time":"2026-03-13T13:07:38Z"}`.

---

## 5. Media API

Sources: OpenAPI `(src: https://docs.on-demand.io/reference/createmediaurl.md, retrieved 2026-09-17T05:56:32Z)`, `(src: https://docs.on-demand.io/reference/fetchmedia.md, retrieved 2026-09-17T05:56:32Z)`, `(src: https://docs.on-demand.io/reference/deletemedia.md, retrieved 2026-09-17T05:56:32Z)`; guides `(src: https://docs.on-demand.io/docs/media-api.md, retrieved 2026-09-17T05:56:31Z)`, `(src: https://docs.on-demand.io/docs/knowledge-plugin.md, retrieved 2026-09-17T05:56:31Z)`; in-app specs `.../reference/api/createmediaurl` (05:57:06Z), `.../fetchmedia` (05:57:05Z), `.../deletemedia` (05:57:06Z).

**Analyze semantics.** "The OnDemand platform allows users to upload different types of media… It then thoroughly analyses the uploaded content to extract valuable insights. Users can interact with the platform's chat feature to ask questions… based on the insights." Processing is driven by the `plugins` list (required): the guides name the file agents **YouTube Agent `plugin-1713961903`, Video Agent `plugin-1713967141`, Document Agent `plugin-1713954536`, Audio Agent `plugin-1713958830`** and the image sample uses `plugin-1713958591`; knowledge ingestion adds the **Agent Knowledge Ingest Agent `plugin-1716472791`** plus `pluginInputs: [{ "plugin-1716472791": { "postProcess": { "chatPluginId": "<your knowledge agent id>" } } }]`. Response fields `context` ("context or transcript of the media content"), `extractedText`, `extractedTextUrl`, `transcriptionHours`, `actionStatus` (`processing|completed`), `failedReason`.

**Supported types.** Document: doc, docx, pdf, epub, txt, ppt, pptx, xls, csv, xlsx · Audio: mp3, wav, wma, ogg, flac, aac, m4a, ac3, aiff, au, mpga · Video: mp4, avi, mov, wmv, mkv, flv, mpeg, mpg, m4v, webm, 3gp · Image: png, jpg, jpeg · plus `source: youtube` URLs. **Size limits: NOT FOUND IN LIVE DOCS** (only the rate limit "Media Upload Per Minute – 5" on the free plan; `sizeBytes` is a caller-supplied field, not a limit) — checked `docs/media-api.md`, `reference/createmediaurl.md`, `docs/rate-limiting.md`.

**Link to a chat session.** Pass the chat `sessionId` in the create/upload body; the media then appears as a session message with `type: "media"` and `media{id,name,source,url,context}` `(src: https://docs.on-demand.io/reference/getchatmessage.md, retrieved 2026-09-17T05:56:34Z)`. `externalUserId` may also be set on the media.

### 5.1 Create media from URL — `POST https://api.on-demand.io/media/v1/public/file`

Headers `apikey`, `Content-Type: application/json`. Body (schema): `url` string(uri) **required**; `plugins` string[] **required**; `responseMode` enum `sync|webhook` **required**; optional `createdBy`, `updatedBy`, `sessionId`, `externalUserId`, `name`, `sizeBytes` integer, `pluginInputs` object[].

```json
{ "url": "https://example.com/report.pdf", "name": "report.pdf", "plugins": ["plugin-1713954536"], "sessionId": "<sessionId>", "externalUserId": "user-app-12345", "sizeBytes": 7834093, "responseMode": "sync" }
```

Response 200: `message` ("Media Created"), `data{ id, companyId, sessionId, externalUserId, url, sourceUrl, extractedTextUrl, name, sizeBytes, source (document|audio|video|youtube|image), mimeType, extension, plugins[], context, extractedText, actionStatus, failedReason, isDeleted, responseMode, createdBy, updatedBy, pluginInputs[], transcriptionHours, createdAt, updatedAt }`.

```bash
curl -X POST https://api.on-demand.io/media/v1/public/file -H "apikey: $ONDEMAND_API_KEY" -H "Content-Type: application/json" \
  -d '{"url":"https://example.com/report.pdf","plugins":["plugin-1713954536"],"sessionId":"'$SESSION_ID'","responseMode":"sync"}'
```

```js
const m = await (await fetch("https://api.on-demand.io/media/v1/public/file", { method: "POST",
  headers: { apikey: process.env.ONDEMAND_API_KEY, "Content-Type": "application/json" },
  body: JSON.stringify({ url: "https://example.com/report.pdf", plugins: ["plugin-1713954536"], sessionId, responseMode: "sync" }) })).json();
const mediaId = m.data.id;
```

### 5.2 Upload raw file — `POST https://api.on-demand.io/media/v1/public/file/raw` (guide-documented; no OpenAPI page)

`multipart/form-data` fields shown in the guides: `file` (binary), `createdBy`, `updatedBy`, `name`, `sessionId`, `plugins` (repeated form field, or a JSON-string array `"[\"plugin-…\"]"`), `sizeBytes`, `responseMode`, optional `pluginInputs[0]` (JSON string). Response shape is the same `Media Created` object as 5.1. `(src: https://docs.on-demand.io/docs/media-api.md, retrieved 2026-09-17T05:56:31Z)`, `(src: https://docs.on-demand.io/docs/knowledge-plugin.md, retrieved 2026-09-17T05:56:31Z)`.

```bash
curl -X POST https://api.on-demand.io/media/v1/public/file/raw -H "apikey: $ONDEMAND_API_KEY" \
  -F 'file=@/path/to/file.png' -F 'name=file.png' -F 'sessionId='$SESSION_ID -F 'plugins=plugin-1713958591' -F 'sizeBytes=1234' -F 'responseMode=sync'
```

```js
const fd = new FormData();
fd.append("file", new Blob([pngBytes], { type: "image/png" }), "file.png");
fd.append("name", "file.png"); fd.append("sessionId", sessionId); fd.append("plugins", "plugin-1713958591");
fd.append("sizeBytes", String(pngBytes.length)); fd.append("responseMode", "sync");
const up = await (await fetch("https://api.on-demand.io/media/v1/public/file/raw", { method: "POST", headers: { apikey: process.env.ONDEMAND_API_KEY }, body: fd })).json();
```

### 5.3 Fetch media — `GET https://api.on-demand.io/media/v1/public/file`

Query: `sort` (default `-createdAt`; `createdAt`/`updatedAt`, prefix `-` for descending), `page` (default 1), `limit` (default 1 in the spec; pagination guide: default 10, max 50), `plugins` (pluginId filter), `externalUserId`, `source` enum `document|audio|video|youtube|image`. Response: `message`, `data[]` media objects, `pagination{page, limit}` (offset pagination) `(src: https://docs.on-demand.io/reference/how-to-paginate.md, retrieved 2026-09-17T05:56:32Z)`.

```bash
curl "https://api.on-demand.io/media/v1/public/file?page=1&limit=10&source=image" -H "apikey: $ONDEMAND_API_KEY"
```

```js
const list = await (await fetch("https://api.on-demand.io/media/v1/public/file?page=1&limit=10", { headers: { apikey: process.env.ONDEMAND_API_KEY } })).json();
```

### 5.4 Delete media — `DELETE https://api.on-demand.io/media/v1/public/file/{fileId}`

Path `fileId` required. Response 200 `{ "message": "Media Deleted!" }`.

```bash
curl -X DELETE "https://api.on-demand.io/media/v1/public/file/$MEDIA_ID" -H "apikey: $ONDEMAND_API_KEY"
```

```js
await fetch(`https://api.on-demand.io/media/v1/public/file/${mediaId}`, { method: "DELETE", headers: { apikey: process.env.ONDEMAND_API_KEY } });
```

---

## 6. Services API

Base URL (OpenAPI `servers[].url`): `https://api.on-demand.io/services/v1/public/service`. Precondition: "make sure you have subscribed to these services on the dashboard" (`https://app.on-demand.io/cloud-services/explore-services`); 400 = "Invalid Request: Not subscribed to the service"; 401 = incorrect API key (`{message, request_id}`) `(src: https://docs.on-demand.io/docs/cloud-services-api.md, retrieved 2026-09-17T05:56:31Z)`.

### 6.1 Audio → text (STT) — `POST …/execute/speech_to_text`

`(src: https://docs.on-demand.io/reference/convertaudiototext.md, retrieved 2026-09-17T05:56:32Z)`, `(src: https://docs.on-demand.io/docs/cloud-services-api.md, retrieved 2026-09-17T05:56:31Z)`, in-app `.../reference/api/convertaudiototext` (05:57:07Z).

- Request JSON: `audioUrl` string **required** — "The URL of the audio file". Supported formats: `wav, mp3, m4a, flac, aac, ogg, wma, mp4`.
- Language selection, response format, streaming / partial transcripts, timestamps, diarization: **NOT FOUND IN LIVE DOCS** (the body has exactly one field; there is no upload-bytes variant — host the file or upload it with the Media API first and use the returned `data.url`).
- Response 200: `{ "message": "Service executed successfully", "data": { "text": "<transcript>" } }`.

```bash
curl -X POST https://api.on-demand.io/services/v1/public/service/execute/speech_to_text \
  -H "apikey: $ONDEMAND_API_KEY" -H "Content-Type: application/json" -d '{"audioUrl":"https://example.com/audio.wav"}'
```

```js
const stt = await (await fetch("https://api.on-demand.io/services/v1/public/service/execute/speech_to_text", { method: "POST",
  headers: { apikey: process.env.ONDEMAND_API_KEY, "Content-Type": "application/json" }, body: JSON.stringify({ audioUrl }) })).json();
const transcript = stt.data.text;
```

### 6.2 Text → audio (TTS) — `POST …/execute/text_to_speech`

`(src: https://docs.on-demand.io/reference/converttexttoaudio.md, retrieved 2026-09-17T05:56:32Z)`, `(src: https://docs.on-demand.io/docs/cloud-services-api.md, retrieved 2026-09-17T05:56:31Z)`, in-app `.../reference/api/converttexttoaudio` (05:57:07Z).

- Request JSON: `input` string **required**; `model` enum `tts-1 | tts-1-hd` (default `tts-1`; "tts-1: real-time/low latency, lower quality; tts-1-hd: higher quality"); `voice` enum `alloy | echo | fable | onyx | nova | shimmer` (default `alloy`).
- Streaming audio, output format/sample-rate selection, language: **NOT FOUND IN LIVE DOCS**. Output is a URL: "returns the URL of the audio file. The audio file has permanent storage and is not deleted over time" (the sample URL is an `.mp3`).
- Response 200: `{ "message": "Service executed successfully", "data": { "audioUrl": "https://…mp3" } }`.

```bash
curl -X POST https://api.on-demand.io/services/v1/public/service/execute/text_to_speech \
  -H "apikey: $ONDEMAND_API_KEY" -H "Content-Type: application/json" -d '{"input":"Hello from OnDemand","voice":"alloy","model":"tts-1"}'
```

```js
const tts = await (await fetch("https://api.on-demand.io/services/v1/public/service/execute/text_to_speech", { method: "POST",
  headers: { apikey: process.env.ONDEMAND_API_KEY, "Content-Type": "application/json" }, body: JSON.stringify({ input: "Hello", voice: "alloy", model: "tts-1" }) })).json();
const audioBytes = new Uint8Array(await (await fetch(tts.data.audioUrl)).arrayBuffer());
```

### 6.3 Translate text — `POST …/execute/language_translation`

`(src: https://docs.on-demand.io/reference/translatetext.md, retrieved 2026-09-17T05:56:32Z)`, in-app `.../reference/api/translatetext` (05:57:08Z). Note: the Cloud Services guide says "Currently, two APIs are available" (TTS, STT) while the reference lists three — translation is in the reference but not the guide.

- Request JSON: `input` string **required**; `languageCode` string **required** ("target language, e.g. 'en', 'es'"). Source-language detection/field and a list of supported language codes: **NOT FOUND IN LIVE DOCS**.
- Response 200: `{ "message": "…", "data": { "translatedText": "…" } }`.

```bash
curl -X POST https://api.on-demand.io/services/v1/public/service/execute/language_translation \
  -H "apikey: $ONDEMAND_API_KEY" -H "Content-Type: application/json" -d '{"input":"Hello, how are you?","languageCode":"es"}'
```

```js
const tr = await (await fetch("https://api.on-demand.io/services/v1/public/service/execute/language_translation", { method: "POST",
  headers: { apikey: process.env.ONDEMAND_API_KEY, "Content-Type": "application/json" }, body: JSON.stringify({ input: "Hello, how are you?", languageCode: "es" }) })).json();
```

---

## 7. Agents Flow Builder / Workflows

Base URL: `https://api.on-demand.io/automation/api`; header `apikey` (scheme `ApiKeyAuth`, header `apikey`). Sources: OpenAPI pages `reference/post_workflow.md`, `get_workflow.md`, `get_workflow-id.md`, `patch_workflow-id.md`, `delete_workflow-id.md`, `patch_workflow-id-name.md`, `post_workflow-id-activate.md`, `post_workflow-id-deactivate.md`, `post_workflow-id-execute.md`, `post_workflow-upload-config.md`, `get_execution-list.md`, `get_execution-executionid.md`, `get_execution-executionid-logs.md`, `get_execution-executionid-node-outputs.md`, `get_execution-executionid-transcript.md`, `get_execution-executionid-delivery-track-email.md`, `post_execution-executionid-report-problem.md`, `post_approvalgate-executionid-approval-nodekey-approve.md`, `post_approvalgate-executionid-approval-nodekey-reject.md` (all `https://docs.on-demand.io/reference/…`, retrieved 2026-09-17T05:56:33Z–05:56:34Z; identical in-app copies at `https://gateway.on-demand.io/config/v1/public/docs/reference/api/<slug>`, retrieved 2026-09-17T05:57:13Z–05:57:22Z); guides `(src: https://docs.on-demand.io/docs/workflow-api.md, retrieved 2026-09-17T05:56:31Z)`, `(src: https://docs.on-demand.io/docs/execution-api.md, retrieved 2026-09-17T05:56:31Z)`, `(src: https://docs.on-demand.io/docs/workflow-nodes.md, retrieved 2026-09-17T05:56:31Z)`, `(src: https://docs.on-demand.io/docs/creating-a-workflow.md, retrieved 2026-09-17T05:56:31Z)`, `(src: https://docs.on-demand.io/docs/agents-flow-builder.md, retrieved 2026-09-17T05:56:31Z)`.

### 7.1 Endpoint table

| Operation | Method & path | Request | Response |
|---|---|---|---|
| Create workflow | `POST /workflow/` | JSON: `name` (req), `trigger` (req), `nodes[]` (req), `delivery[]` (req), `enableMemory` bool | 201 `{ "id": "<workflowId>" }` |
| List workflows | `GET /workflow/?after=&limit=&keyword=` | — | 200 array of workflow objects (guide shows `{message, data[]}` with `triggerType`) |
| Get workflow | `GET /workflow/{id}` | — | 200 workflow object; 404 |
| Update workflow | `PATCH /workflow/{id}` | JSON: `trigger`, `nodes`, `delivery` (all req), `enableMemory` | 200 (no body) |
| Update name | `PATCH /workflow/{id}/name` | `{ "name": "…" }` | 200 |
| Delete workflow | `DELETE /workflow/{id}` | — | 200 |
| **Activate** | `POST /workflow/{id}/activate` | no body | 200 "Workflow activated successfully"; 500 |
| **Deactivate** | `POST /workflow/{id}/deactivate` | no body | 200; 500 |
| **Execute** | `POST /workflow/{id}/execute` | **no request body is defined in the spec** | 200 `{ "executionID": "…" }` ("Workflow execution started"); 400 "Invalid request or workflow inactive"; 404 |
| Upload configuration | `POST /workflow/upload/config` | `multipart/form-data` `file` (binary) | 200 "Configuration uploaded successfully"; 400 "Invalid request or file format" |
| List executions | `GET /execution/list?workflowID=<req>&afterID=` | — | 200 `{message, data[]}`: `id, workflowID, trigger{id,type (e.g. "api"),actorID}, status (e.g. "executing"), startedAtInMilliseconds, endedAtInMilliseconds, timeTakenInMilliseconds` |
| Get execution | `GET /execution/{executionID}` | — | 200 execution record (as above) |
| Get logs | `GET /execution/{executionID}/logs` | — | 200 `{message, data[]}`: `executionID, requestID, task, timestamp, workflowID, nodeKey, message, fields` |
| Node outputs | `GET /execution/{executionID}/node/outputs` | — | 200 `{ data: { outputs: { "<nodeKey>": { id, executionID, nodeType, key, value, startedAtInMilliseconds, endedAtInMilliseconds, timeTakenInMilliseconds } } } }` |
| Voice transcript | `GET /execution/{executionID}/transcript` | — | 200 `data[]` `{executionID, workflowID, content, responseID, eventID, itemID, author (user \| voice-server \| ond), createdAtInMilliseconds}`; 401 "Unauthorized access or non-voice mode workflow" |
| Email delivery status | `GET /execution/{executionID}/delivery/track/email?afterID=&limit=` | — | 200 (schema not detailed) |
| Report problem | `POST /execution/{executionID}/report-problem` | `{ "type": "…", "message": "…" }` (both req) | 200 |
| Approve / reject gate | `POST /approvalgate/{executionID}/approval/{nodeKey}/approve` · `…/reject` | no body ("companyID and userID are taken from the auth context") | 200; 400 `{status, message}` |
| **Stream workflow logs** | **NOT FOUND IN LIVE DOCS** — only the polling `GET …/logs` exists (0 hits for a streaming-logs endpoint in all pages/specs). | | |

### 7.2 Input / output schema (workflow object)

`trigger`: `type` enum **`cron` \| `webhook`** (required), `cron.expression` (6-place CRON, seconds first; guide samples also carry `cron.type: basic|advanced`), `webhook.url`, `webhook.auth{username,password}`, `webhook.whiteListedIPs[]`, `position{x,y}` (required), `measured{width,height}`, `nextNodeKeys[]`. The nodes guide additionally describes **API**, **EMAIL** and **Webhook** triggers ("The request body must contain a JSON object with a `payload` field") — only `cron`/`webhook` are in the schema enum. `nodes[]`: `key` (req), `type` enum **`llm` \| `inputText` \| `advancedVoiceMode` \| `approvalGate`** (req; guide samples also use `o_analyzer`), `kind` enum `source|intermediate|sink|action` (req), `dependencies[{nodeKey}]`, `nextNodeKeys[]`, `llm{ fulfillmentPrompt, prompt (req), model (req = endpointId), plugins[{id}] }`, `advancedVoiceMode{ instructionPrompt (req), conversationStarter (req), plugins[{id}], reasoningMode, model }`, `approvalGate{ timeoutInMinutes (req), approverEmail }`. `delivery[]`: `channel` enum **`email` \| `slack` \| `webhook` \| `phone`**, `config.slack.webhook`, `config.webhook{url, method, basicAuth{username,password}}`, `config.email{addresses[], file{id,name,recordsCount}}`, `config.phone{toNumbers[{countryCode,number}], file{…}}`. Workflow object also returns `id, name, companyID, createdByUserID, isActive, enableMemory, createdAtInMilliseconds, lastModifiedAtInMilliseconds`.

### 7.3 Async / long-running behaviour, webhooks/callbacks, versioning, export

- Execution is asynchronous: `execute` returns an `executionID` immediately; progress is read by polling `GET /execution/{executionID}` (`status`, `endedAtInMilliseconds`), `…/logs` and `…/node/outputs`. A workflow must be **active** to execute (400 "workflow inactive").
- Callback/webhook support: outbound results go through the `webhook` delivery channel (`config.webhook.url/method/basicAuth`), Slack, email or phone; inbound triggering via the `webhook` trigger URL with a `payload` JSON field, or the API trigger (`execute`). Approval-gate nodes pause the run until `…/approve` or `…/reject` is called (`timeoutInMinutes`).
- **Versioning:** NOT FOUND IN LIVE DOCS (no version field on the workflow object; checked the workflow specs and `docs/workflow-api.md`).
- **Export / "Get Code":** NOT FOUND IN LIVE DOCS. The nearest documented capability is `POST /workflow/upload/config` (upload a workflow configuration file); no download/export/"Get Code" operation is documented. (The only "export" hits are unrelated: projects — "export them first — sessions can't be moved out of a project"; terminal agent — "data export" as a task type.)
- The in-app "Run" button triggers "an immediate, real-time execution" with logs and per-node outputs visible on the canvas `(src: https://docs.on-demand.io/docs/creating-a-workflow.md, retrieved 2026-09-17T05:56:31Z)`.

### 7.4 Samples

```bash
curl -X POST "https://api.on-demand.io/automation/api/workflow/$WORKFLOW_ID/activate" -H "apikey: $ONDEMAND_API_KEY"
curl -X POST "https://api.on-demand.io/automation/api/workflow/$WORKFLOW_ID/execute"  -H "apikey: $ONDEMAND_API_KEY"   # → {"executionID":"…"}
curl "https://api.on-demand.io/automation/api/execution/$EXECUTION_ID"      -H "apikey: $ONDEMAND_API_KEY"
curl "https://api.on-demand.io/automation/api/execution/$EXECUTION_ID/logs" -H "apikey: $ONDEMAND_API_KEY"
curl -X POST "https://api.on-demand.io/automation/api/workflow/$WORKFLOW_ID/deactivate" -H "apikey: $ONDEMAND_API_KEY"
```

```js
const base = "https://api.on-demand.io/automation/api", h = { apikey: process.env.ONDEMAND_API_KEY };
await fetch(`${base}/workflow/${workflowId}/activate`, { method: "POST", headers: h });
const { executionID } = await (await fetch(`${base}/workflow/${workflowId}/execute`, { method: "POST", headers: h })).json();
const exec = await (await fetch(`${base}/execution/${executionID}`, { headers: h })).json();   // exec.data.status
const logs = await (await fetch(`${base}/execution/${executionID}/logs`, { headers: h })).json();
```

Create-workflow body example (from the guide, cron trigger + advanced voice mode node + phone delivery) is reproduced verbatim at `(src: https://docs.on-demand.io/docs/workflow-api.md, retrieved 2026-09-17T05:56:31Z)`.

---

## 8. Agent Tools

- **Terminology.** The in-app API reference groups the chat operations under "Chat & Agent Tools API" (the Chat API guide links to `https://app.on-demand.io/api-reference#/chat-&-agent-tools-api/submitquery`), and the docs call the tools **Agents** (formerly "plugins"; the `pluginIds` field name survives). Categories: Knowledge Agents, REST API Agents, IoT (MQTT) Agents, the Terminal Agent, and Connectors (agents whose OAuth is hosted by OnDemand; "connectors can only be created by On Demand") `(src: https://docs.on-demand.io/docs/chat-api.md, retrieved 2026-09-17T05:56:31Z)`, `(src: https://docs.on-demand.io/docs/what-are-plugins.md, retrieved 2026-09-17T05:56:30Z)`, `(src: https://docs.on-demand.io/docs/what-are-connectors.md, retrieved 2026-09-17T05:56:31Z)`.
- **Created:** via the dashboard only — My Agents → Create Agents (`https://app.on-demand.io/rag-agents/my-agents`; Knowledge: `https://app.on-demand.io/rag-agents/create/knowledge`), REST agents defined by an OpenAPI schema (import from URL or example), then configured, tested and optionally published to the Marketplace (`https://app.on-demand.io/rag-agents/marketplace`). **No create/update/publish REST endpoint is documented** `(src: https://docs.on-demand.io/docs/rest-based-plugins.md, retrieved 2026-09-17T05:56:31Z)`, `(src: https://docs.on-demand.io/docs/knowledge-plugin.md, retrieved 2026-09-17T05:56:31Z)`, `(src: https://docs.on-demand.io/docs/open-api-schema.md, retrieved 2026-09-17T05:56:31Z)`.
- **Listed:** `GET https://api.on-demand.io/plugin/v1/list?pluginIds=<comma-separated>&page=&limit=` (header `apikey`) → `{ message, page, limit, data: { plugins: [ … ] } }`; HTTP 206 "Partial Success" when an id's "plugin subscription not active" `(src: https://docs.on-demand.io/docs/plugin-api.md, retrieved 2026-09-17T05:56:31Z)`. This operation is **not** in the OpenAPI reference set — guide only.
- **Metadata schema (from the list response):** `id, name, identifier (e.g. rest_api, internet), description, category, conversationStarters, logoUrl, type (chat), source (external), status (private), pluginId (plugin-<digits>), companyId, fileSubType (PRIMARYINGEST), chatSubType (PRIMARYCHAT), privacyPolicy, createdAt, updatedAt`.
- **Attached:** at session level (`pluginIds` on `POST /chat/v1/sessions`), per query (`pluginIds` on `…/query`, max 20, replaces the session list), on media (`plugins`), in workflow nodes (`llm.plugins[{id}]`, `advancedVoiceMode.plugins[{id}]`), and in knowledge ingestion via `pluginInputs`. Documented built-in ids: Terminal Agent **`plugin-1775547203`** ("Pass it in `agentIds`… Workflow: `{ "id": "plugin-1775547203" }`") `(src: https://docs.on-demand.io/docs/terminal-agent.md, retrieved 2026-09-17T05:56:31Z)`; file agents `plugin-1713961903` (YouTube), `plugin-1713967141` (Video), `plugin-1713954536` (Document), `plugin-1713958830` (Audio), knowledge ingest `plugin-1716472791` `(src: https://docs.on-demand.io/docs/knowledge-plugin.md, retrieved 2026-09-17T05:56:31Z)`; the stream example shows `agent-1713924030` "Internet Agent" (identifier `internet`) and `agent-1714419354` "IPbase agent" (identifier `rest_api`) `(src: https://docs.on-demand.io/docs/query-and-responses-modes.md, retrieved 2026-09-17T05:56:31Z)`.

---

## 9. Skills

Documented as a dashboard/marketplace feature only: a Skill is a `SKILL.md` (optionally zipped with `scripts/`, `references/`, `assets/`; limits zip 50 MB, single file 25 MB, `SKILL.md` 2 MB), created in Dashboard → Skills → Create Skill, automatically safety-scanned, private by default, publishable to the marketplace, subscribed per company, and used by adding it "to an agent or a Playground session". **Create / attach / invoke via REST API: NOT FOUND IN LIVE DOCS** — no skill endpoint in `llms.txt`, the categories index or any spec `(src: https://docs.on-demand.io/docs/agent-skills.md, retrieved 2026-09-17T05:56:31Z)`, `(src: https://docs.on-demand.io/llms.txt, retrieved 2026-09-17T05:56:10Z)`, `(src: https://gateway.on-demand.io/config/v1/public/docs/categories, retrieved 2026-09-17T05:57:04Z)`. The Terminal Agent "selects from a library of specialised skills on its own" `(src: https://docs.on-demand.io/docs/terminal-agent.md, retrieved 2026-09-17T05:56:31Z)`.

---

## 10. REST API Key Management

**Generate / delete API keys over REST: NOT FOUND IN LIVE DOCS.** The categories index lists no key-management service `(src: https://gateway.on-demand.io/config/v1/public/docs/categories, retrieved 2026-09-17T05:57:04Z)`; `llms.txt` has no such reference page `(src: https://docs.on-demand.io/llms.txt, retrieved 2026-09-17T05:56:10Z)`; 0 hits for "generateapikey" / "api-keys" endpoints in the 85 pages. Keys are managed in the dashboard: Settings → API Key Management (`https://app.on-demand.io/api-keys-management`) → Create New API Key; shown once; multiple keys allowed; revoke on compromise `(src: https://docs.on-demand.io/docs/authentication.md, retrieved 2026-09-17T05:56:30Z)`, `(src: https://docs.on-demand.io/reference/how-to-do-authentication.md, retrieved 2026-09-17T05:56:32Z)`. No curl/Node sample can be given without inventing an endpoint.

---

## 11. MQTT User Management (note only)

Two documented operations exist: `POST /config/v1/public/mqtt_user` with body `{ "type": "admin" }` → 200 `{ "msg": "MqttUser Created Successfully", "password": "…" }` (400 "Invalid payload or user already exists"), and `DELETE /config/v1/public/mqtt_user/{userId}` → 200 `{ "msg": "MqttUser Deleted Successfully" }` (404 not found); both use the `apikey` header (`ApiKeyAuth`). Note that these two specs are the only ones whose `servers[].url` is `https://gateway-dev.on-demand.io` ("Development server") rather than `https://api.on-demand.io`; the broker/topic conventions are in the IoT agents guide. `(src: https://docs.on-demand.io/reference/createmqttuser.md, retrieved 2026-09-17T05:56:32Z)`, `(src: https://docs.on-demand.io/reference/deletemqttuser.md, retrieved 2026-09-17T05:56:32Z)`, `(src: https://docs.on-demand.io/docs/mqttiot-plugins.md, retrieved 2026-09-17T05:56:31Z)`.

---

## 12. Reasoning Modes & Endpoints

**Endpoint / model IDs (fulfillment models).** "Endpoint ID is used as the value of `endpointId` in Submit Query" `(src: https://docs.on-demand.io/docs/fulfillment-models.md, retrieved 2026-09-17T05:56:31Z)` (page updatedAt 2026-08-24):

| Model | Endpoint name | `endpointId` |
|---|---|---|
| GPT-5.6 Luna | `gpt-5.6-luna` | `predefined-gpt-5.6-luna` |
| GPT-5.6 Terra | `gpt-5.6-terra` | `predefined-gpt-5.6-terra` |
| GPT-5.6 Sol | `gpt-5.6-sol` | `predefined-gpt-5.6-sol` |
| Claude Opus 5 | `claude-opus-5` | `predefined-claude-opus-5` |
| Claude Sonnet 5 | `claude-sonnet-5` | `predefined-claude-sonnet-5` |
| Claude Fable 5 | `claude-fable-5` | `predefined-claude-fable-5` |
| Gemini 3.7 Flash | `gemini-3.7-flash` | `predefined-gemini-3.7-flash` |
| Gemini 3.6 Flash | `gemini-3.6-flash` | `predefined-gemini-3.6-flash` |
| Gemini 3.1 | `gemini-3.1` | `predefined-gemini-3.1-pro-preview` |
| Grok 4.6 | `ondemand-grok-4.6` | `predefined-xai-grok4.6` |
| Grok 4.5 | `ondemand-grok-4.5` | `predefined-xai-grok4.5` |
| DeepSeek V4 Pro | `deepseek-v4-pro` | `predefined-deepseek-v4-pro` |
| DeepSeek V4 Flash Fast | `deepseek-v4-flash-fast` | `predefined-deepseek-v4-flash` |
| Kimi K3 | `kimi-k3` | `predefined-kimi-k3` |
| Qwen 3.8 Max | `qwen-3.8-max` | `predefined-qwen-3.8-max` |
| GLM 5.2 | `glm-5.2` | `predefined-glm-5.2` |
| MiniMax M3 | `minimax-m3` | `predefined-minimax-m3` |
| Muse Spark 1.2 | `muse-spark-1.2` | `predefined-muse_spark_1.2` |

"The list of predefined models may be updated over time. Please refer to the playground (`https://app.on-demand.io/playground`) for the most up to date list." Examples elsewhere in the docs still use the older ids `predefined-openai-gpt4o` (Submit Query spec example, guides) and `predefined-openai-gpt4.1` (Projects spec examples) — these are not in the current table. BYOI / BYOM endpoint ids are read from `https://app.on-demand.io/byoi-management` and `https://app.on-demand.io/byom-management/endpoints`. A REST endpoint that enumerates endpoints/models: **NOT FOUND IN LIVE DOCS**.

**Reasoning vs fulfillment.** The docs distinguish the RAG stage (agents are retrieved/executed — `statusType: agents_retrieved / executing / execution_completed`) from the **fulfillment** stage (the `endpointId` model produces the answer — `fulfilling / fulfillment_completed`, `fulfillmentPrompt`, `fulfillmentOnly`) `(src: https://docs.on-demand.io/docs/query-and-responses-modes.md, retrieved 2026-09-17T05:56:31Z)`, `(src: https://docs.on-demand.io/docs/fulfillment-models.md, retrieved 2026-09-17T05:56:31Z)`.

**Reasoning mode values.** Only examples are published, no enumerated list: `low`, `high` ("e.g., `low`, `high`", stream mode only) `(src: https://docs.on-demand.io/docs/chat-api.md, retrieved 2026-09-17T05:56:31Z)`; `"reasoningMode": "grok-4-fast"` and `"reasoningMode": "low"` in stream samples `(src: https://docs.on-demand.io/docs/query-and-responses-modes.md, retrieved 2026-09-17T05:56:31Z)`; `reasoningMode` (free string) plus `model` on the workflow `advancedVoiceMode` node `(src: https://docs.on-demand.io/reference/post_workflow.md, retrieved 2026-09-17T05:56:33Z)`. A REST endpoint that lists reasoning modes: **NOT FOUND IN LIVE DOCS**.

---

## 13. Naming reconciliation table

| Concept | API term | UI term | Definition | Where it appears (endpoint/field) | Source URL |
|---|---|---|---|---|---|
| Tool/agent selection | `pluginIds` (all OpenAPI schemas); `agentIds` (guide code samples); `plugins` (Media API, workflow nodes) | **Agents** ("What are Agents?", "My Agents", "Agents Marketplace"); formerly "Plugins" | Specialized extensions (Knowledge, REST API, IoT, Terminal, Connectors) invoked in the RAG stage before fulfillment | `POST /chat/v1/sessions` body; `POST …/query` body; `plugins` on `POST /media/v1/public/file`; `nodes[].llm.plugins[{id}]`; stream `retrievedAgents[].agentId` | https://docs.on-demand.io/reference/submitquery.md · https://docs.on-demand.io/docs/query-and-responses-modes.md · https://docs.on-demand.io/docs/what-are-plugins.md · https://docs.on-demand.io/docs/terminal-agent.md |
| Agent Tools | "Chat & Agent Tools API" (in-app reference section); plugin objects with `identifier` (`rest_api`, `internet`, …) | Agents / Agent Tools | The chat operations that let a query use agents; the agent records themselves | `GET /plugin/v1/list`; `app.on-demand.io/api-reference#/chat-&-agent-tools-api/*` | https://docs.on-demand.io/docs/chat-api.md · https://docs.on-demand.io/docs/plugin-api.md |
| Agent Flows / Workflows | "Agents Flow Builder API" — `workflow`, `execution`, `approvalgate` resources under `/automation/api` | **Agents Flow Builder** / "Workflow Builder" / "Create Workflow" (dashboard `app.on-demand.io/agents`) | DAG of trigger → nodes (`llm`, `inputText`, `advancedVoiceMode`, `approvalGate`) → delivery channels | `POST /workflow/`, `POST /workflow/{id}/execute`, `GET /execution/{executionID}` | https://docs.on-demand.io/docs/agents-flow-builder.md · https://docs.on-demand.io/reference/post_workflow.md |
| Skills | — (no API) | **Skills** (Dashboard → Skills; marketplace) | A `SKILL.md` playbook (+ optional scripts/references/assets) that agents follow | UI only | https://docs.on-demand.io/docs/agent-skills.md |
| Endpoints / models | `endpointId` (`predefined-…`, BYOI, BYOM); workflow `llm.model` | **Models** page, "Fulfillment Models", BYOI/BYOM Management, Playground | The LLM endpoint that fulfils the query | `POST …/query.endpointId`; `POST /public/projects.endpointId`; `nodes[].llm.model` | https://docs.on-demand.io/docs/fulfillment-models.md |
| Reasoning mode | `reasoningMode` | (not surfaced under a UI name in the fetched docs) | Controls reasoning detail in stream mode; examples `low`, `high`, `grok-4-fast` | `POST …/query` body (guide only, not in OpenAPI); `nodes[].advancedVoiceMode.reasoningMode` | https://docs.on-demand.io/docs/chat-api.md · https://docs.on-demand.io/reference/post_workflow.md |
| Fulfillment prompt | `modelConfigs.fulfillmentPrompt`; workflow `llm.fulfillmentPrompt`; project `systemPrompt` | "Fulfillment Prompt" (LLM node), "system prompt" (Projects) | Instructions guiding the model's fulfilment; supports `{context}` / `{question}` placeholders | `POST …/query.modelConfigs`; `POST /workflow/ nodes[].llm`; `POST /public/projects` | https://docs.on-demand.io/docs/fulfillment-prompts.md · https://docs.on-demand.io/reference/post_workflow.md · https://docs.on-demand.io/reference/post_public-projects.md |
| Response mode | `responseMode` (`sync`, `stream`, `webhook`; media: `sync`, `webhook`) | "Response Modes" | How the answer is delivered | `POST …/query`; `POST /media/v1/public/file` | https://docs.on-demand.io/docs/query-and-responses-modes.md |
| Chat session | `sessionId` (`data.id`) | Chat / conversation | Continuous conversation container | `/chat/v1/sessions*` | https://docs.on-demand.io/docs/what-are-chat-sessions.md |
| External user | `externalUserId` | — | Your system's end-user id (also a filter) | session/message/media bodies and query params | https://docs.on-demand.io/reference/createchatsession.md |
| Project | `projectId`, `name`, `endpointId`, `systemPrompt` | **Projects** | A container of sessions with default model + system prompt | `/chat/v1/public/projects*`, `GET /chat/v1/public/sessions?projectId=` | https://docs.on-demand.io/docs/projects.md |
| Live session | `live-settings` (`enabled`, `mode: proactive\|onevents`, `destinations`) | "Live" mode | Proactive / event-triggered assistant messages with email/Slack delivery | `PUT /chat/v1/sessions/{sessionId}/live-settings` | https://docs.on-demand.io/reference/updatelivesessionsettings.md |
| Advanced voice mode | `advancedVoiceMode` node; `delivery.channel: phone`; `GET /execution/{id}/transcript` | "Advanced Voice Mode Node", "Phone Call" delivery | Outbound phone-call voice conversation run by a workflow | `/automation/api/workflow*`, `/execution/{executionID}/transcript` | https://docs.on-demand.io/docs/workflow-nodes.md |

---

## 14. Native realtime voice

**Answer: N.** OnDemand does **not** expose a native, low-latency, full-duplex realtime voice API for developers (speech in → streaming transcription → agent/tool execution → streaming audio out in one session). Evidence checked:

- The only documented streaming transport is SSE for text answers of `POST /chat/v1/sessions/{sessionId}/query` (`responseMode: "stream"`); 0 occurrences of WebSocket/`wss://`/WebRTC in all 85 documentation pages and 40 OpenAPI specs `(src: https://docs.on-demand.io/docs/query-and-responses-modes.md, retrieved 2026-09-17T05:56:31Z)`; categories index `(src: https://gateway.on-demand.io/config/v1/public/docs/categories, retrieved 2026-09-17T05:57:04Z)`; page index `(src: https://docs.on-demand.io/llms.txt, retrieved 2026-09-17T05:56:10Z)`.
- STT accepts only a hosted `audioUrl` and returns a complete `text`; TTS returns a hosted `audioUrl`; neither documents streaming or partial results `(src: https://docs.on-demand.io/reference/convertaudiototext.md, retrieved 2026-09-17T05:56:32Z)`, `(src: https://docs.on-demand.io/reference/converttexttoaudio.md, retrieved 2026-09-17T05:56:32Z)`, `(src: https://docs.on-demand.io/docs/cloud-services-api.md, retrieved 2026-09-17T05:56:31Z)`.
- The closest documented voice capability is workflow-only: the **Advanced Voice Mode node** "initiates a real-time, interactive voice conversation via an outbound phone call" (one per workflow, cannot be combined with LLM nodes, recipients set in a Phone Call delivery node), with transcripts readable afterwards via `GET /automation/api/execution/{executionID}/transcript` (authors `user`, `voice-server`, `ond`). It is a phone-call product, not a developer-facing audio stream API `(src: https://docs.on-demand.io/docs/workflow-nodes.md, retrieved 2026-09-17T05:56:31Z)`, `(src: https://docs.on-demand.io/reference/get_execution-executionid-transcript.md, retrieved 2026-09-17T05:56:33Z)`, `(src: https://docs.on-demand.io/docs/workflow-api.md, retrieved 2026-09-17T05:56:31Z)`.
- "Live session settings" (`proactive` / `onevents`) is a messaging feature with email/Slack destinations, not voice `(src: https://docs.on-demand.io/reference/updatelivesessionsettings.md, retrieved 2026-09-17T05:56:34Z)`.

**Supported path:** chain the documented services — `POST …/services/v1/public/service/execute/speech_to_text` (`audioUrl` → `data.text`) → `POST /chat/v1/sessions/{sessionId}/query` with `responseMode: "stream"` (SSE deltas; tool execution visible as `statusLog` events) → `POST …/execute/text_to_speech` (`input` → `data.audioUrl`), fetching the returned audio URL for playback.

---

## 15. Previously-seen field status

| Field | Status | Detail | Source URL | Retrieved (UTC) |
|---|---|---|---|---|
| `apikey` | **CONFIRMED** | Header name `apikey` in every security scheme and example (one stray "Authorization/Bearer" sentence in the guide has no matching example). | https://docs.on-demand.io/reference/how-to-do-authentication.md · https://docs.on-demand.io/reference/submitquery.md · https://docs.on-demand.io/docs/authentication.md | 2026-09-17T05:56:32Z / 05:56:34Z / 05:56:30Z |
| `externalUserId` | **CONFIRMED** | Required on `POST /chat/v1/sessions` (OpenAPI `required`), optional on media, filter param on sessions/messages/media list. | https://docs.on-demand.io/reference/createchatsession.md · https://docs.on-demand.io/reference/getchatsessions.md | 2026-09-17T05:56:34Z |
| `pluginIds` | **CONFIRMED in OpenAPI — CHANGED in guide samples (dual-named)** | Schemas and response objects use `pluginIds` (max 20); guide samples updated 2026-08 send the same array as **`agentIds`**. No schema documents `agentIds`. | https://docs.on-demand.io/reference/submitquery.md · https://docs.on-demand.io/docs/query-and-responses-modes.md · https://docs.on-demand.io/docs/terminal-agent.md | 2026-09-17T05:56:34Z / 05:56:31Z / 05:56:31Z |
| `endpointId` | **CONFIRMED (values CHANGED)** | Field unchanged and required; the predefined id list is now the 18 ids in §12 (e.g. `predefined-claude-sonnet-5`); examples still cite `predefined-openai-gpt4o`, which is absent from the current table. | https://docs.on-demand.io/reference/submitquery.md · https://docs.on-demand.io/docs/fulfillment-models.md | 2026-09-17T05:56:34Z / 05:56:31Z |
| `responseMode` | **CONFIRMED** | enum `sync` \| `stream` \| `webhook` (required in OpenAPI; guide says default `sync`). Media API: `sync` \| `webhook`. | https://docs.on-demand.io/reference/submitquery.md · https://docs.on-demand.io/reference/createmediaurl.md | 2026-09-17T05:56:34Z / 05:56:32Z |
| `reasoningMode` | **CONFIRMED in guides only (not in OpenAPI; values unenumerated)** | Present in the Chat API guide table and stream samples (`low`, `high`, `grok-4-fast`); absent from the Submit Query schema; present as a free string on the workflow `advancedVoiceMode` node. | https://docs.on-demand.io/docs/chat-api.md · https://docs.on-demand.io/docs/query-and-responses-modes.md · https://docs.on-demand.io/reference/post_workflow.md | 2026-09-17T05:56:31Z / 05:56:31Z / 05:56:33Z |
| `fulfillmentPrompt` | **CONFIRMED** | `modelConfigs.fulfillmentPrompt` on Submit Query; `nodes[].llm.fulfillmentPrompt` on workflows. | https://docs.on-demand.io/reference/submitquery.md · https://docs.on-demand.io/docs/fulfillment-prompts.md · https://docs.on-demand.io/reference/post_workflow.md | 2026-09-17T05:56:34Z / 05:56:31Z / 05:56:33Z |

No field was found to be **RETIRED**.

> **Production-run note (2026-09-17T08:13Z):** the Gate 1 production contract run could not exercise any of the shapes above — no God's Eye deployment was reachable (`finalProductionUrl` `https://ondemand-eand-spatial-opal.vercel.app` is a different application whose `/api/ondemand/*` answers Vercel `404 NOT_FOUND`; key pull and CLI deploy are blocked in the execution environment). **No amendment was made to this table on that basis.** See `docs/audit/deployment-verification.md` §4 and `docs/audit/gates.md`.

---

## 16. Discrepancies vs the step-1 Perplexity findings

The step-1 Perplexity searches (four queries, run by the orchestration layer) returned **no OnDemand API contract at all** — every source was either a YouTube overview ("OnDemand FULL Platform Overview", "The All-New OnDemand Platform: Full Overview", AICodeKing "This FULLY FREE AI Agent Platform can Generate Apps for FREE! (+ Free Claude 3.5 Sonnet)", TheAIGRID "How To Use OndemandAI"), the Skywork.ai article "OnDemand AI: A Deep Dive into the Agent-Powered Platform", the Geeky Gadgets article "How to Simplify AI Development with OnDemand AI's Platform", or an unrelated **Open OnDemand** HPC-portal page (discourse.openondemand.org, docs.abci.ai).

**(a) Claims the live docs confirm**
- "RAG platform / PaaS" (Skywork): confirmed — queries run a RAG stage over agents (`pluginIds`, `fulfillmentOnly`, Knowledge Agents) before fulfilment `(src: https://docs.on-demand.io/reference/submitquery.md, retrieved 2026-09-17T05:56:34Z)`, `(src: https://docs.on-demand.io/docs/knowledge-plugin.md, retrieved 2026-09-17T05:56:31Z)`.
- "No-code workflow builder" (Skywork, videos): confirmed — the visual Agents Flow Builder with trigger/LLM/agent/delivery nodes `(src: https://docs.on-demand.io/docs/creating-a-workflow.md, retrieved 2026-09-17T05:56:31Z)`.
- "Pre-built AI agents you can customize / an agent marketplace" (Geeky Gadgets, videos): confirmed — Agents Marketplace, My Agents, Connectors, Skills marketplace `(src: https://docs.on-demand.io/docs/what-are-plugins.md, retrieved 2026-09-17T05:56:30Z)`, `(src: https://docs.on-demand.io/docs/agent-skills.md, retrieved 2026-09-17T05:56:31Z)`.
- "Integrate LLMs, plugins, and create agents/apps" (video titles): confirmed — 18 predefined model endpoints plus BYOI/BYOM, agents, and the Terminal Agent that "builds and deploys a web app… live preview URL" `(src: https://docs.on-demand.io/docs/fulfillment-models.md, retrieved 2026-09-17T05:56:31Z)`, `(src: https://docs.on-demand.io/docs/terminal-agent.md, retrieved 2026-09-17T05:56:31Z)`.

**(b) Claims the live docs contradict**
- "FULLY FREE" (AICodeKing title): contradicted — the docs describe a free tier with limited model access, free-plan rate limits (5 media uploads/min, 100 RAG calls/min, 40 GB GPU, 10 vCPU) and a paid plan page `(src: https://docs.on-demand.io/docs/fulfillment-models.md, retrieved 2026-09-17T05:56:31Z)`, `(src: https://docs.on-demand.io/docs/rate-limiting.md, retrieved 2026-09-17T05:56:30Z)`.
- "Free Claude 3.5 Sonnet" (AICodeKing title): contradicted/outdated — the current predefined list carries Claude Opus 5 / Sonnet 5 / Fable 5; no 3.5-generation id is listed `(src: https://docs.on-demand.io/docs/fulfillment-models.md, retrieved 2026-09-17T05:56:31Z)`.
- Skywork's framing of OnDemand as primarily a chatbot/RAG product understates the documented surface: Media analysis, Services (STT/TTS/translation), Projects, MQTT/IoT agents, workflows with phone-call voice mode and approval gates, and the Terminal Agent are all documented APIs/features.

**(c) Not verifiable from the live docs**
- The "$150 credits" referral offer, the specific UI walkthrough claims inside the videos, Product-Hunt/positioning statements, and any pricing figures (only a pricing page link exists, no numbers in the docs).
- Skywork's competitive comparisons and internal-architecture statements (vector database internals, etc.) — the docs mention "an advanced vector database" only at marketing level `(src: https://docs.on-demand.io/docs/getting-started.md, retrieved 2026-09-17T05:56:30Z)`.

**(d) False match to ignore**
- **Open OnDemand** (openondemand.org / discourse.openondemand.org / docs.abci.ai "Using Open OnDemand") is the Ohio Supercomputer Center's open-source HPC web portal (VNC desktops, Slurm clusters, Jupyter on ABCI). It has no relationship to on-demand.io, its APIs, or anything in this document.

---

### Appendix — fields the previous integration should stop assuming

- There is no documented **delete session**, no **session TTL**, no **`contextMetadata` on sessions**, no **`maxTokens`**, no **structured-output** option, no **file attachment on the query body**, no **REST key management**, no **skills API**, no **streaming workflow logs**, no **workflow export/"Get Code"**, and no **WebSocket/realtime voice** endpoint in the live docs (see the NOT FOUND markers above with the URLs checked).
- Two documented host inconsistencies to be aware of: the MQTT specs point at `https://gateway-dev.on-demand.io`, and several guide code samples use `https://gateway-dev.on-demand.io` / `https://api-dev.on-demand.io` while the documented base URL is `https://api.on-demand.io/`.
