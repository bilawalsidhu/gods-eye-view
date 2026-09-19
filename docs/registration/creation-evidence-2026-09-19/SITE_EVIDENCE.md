# SITE_EVIDENCE — docs.on-demand.io / api.on-demand.io creation-surface crawl

Crawl date: 2026-09-19 (UTC). Records: 63 URLs (cap 70). Read-only, unauthenticated, UA = Chrome/128 desktop, timeout 20 s, ≤1 retry per URL. Pass 1 ran at 2 req/s and was rate-limited (HTTP 429, ReadMe 'Hello there, human!' page containing `challenge-platform`) twice; the crawl paused 15 s and resumed at 1 request / 2 s. `llms-full.txt` and `sitemap.xml` do not exist (404), so pages were discovered from `llms.txt` (which states 'Append .md to any documentation page URL to get its markdown version') and the home-page navigation.

## URLs fetched

| # | URL | HTTP status | content-type | bytes | UTC timestamp | blocked |
|---|-----|-------------|--------------|-------|---------------|---------|
| 1 | https://docs.on-demand.io/ | 200 | text/html | 203646 | 2026-09-19T11:32:17Z | false |
| 2 | https://docs.on-demand.io/llms.txt | 200 | text/plain | 9493 | 2026-09-19T11:32:18Z | false |
| 3 | https://docs.on-demand.io/llms-full.txt | 404 | text/html | 116089 | 2026-09-19T11:32:18Z | false |
| 4 | https://docs.on-demand.io/sitemap.xml | 404 | text/html | 0 | 2026-09-19T11:32:19Z | false |
| 5 | https://docs.on-demand.io/robots.txt | 200 | text/plain | 25 | 2026-09-19T11:32:19Z | false |
| 6 | https://docs.on-demand.io/api-reference | 404 | text/html | 116089 | 2026-09-19T11:32:20Z | false |
| 7 | https://docs.on-demand.io/api-reference/introduction | 404 | text/html | 116154 | 2026-09-19T11:32:20Z | false |
| 8 | https://api.on-demand.io/ | 404 | text/plain | 36 | 2026-09-19T11:32:21Z | false |
| 9 | https://api.on-demand.io/docs | 404 | text/plain | 36 | 2026-09-19T11:32:21Z | false |
| 10 | https://api.on-demand.io/openapi.json | 404 | application/json | 36 | 2026-09-19T11:32:22Z | false |
| 11 | https://api.on-demand.io/swagger | 404 | text/plain | 36 | 2026-09-19T11:32:22Z | false |
| 12 | https://gateway.on-demand.io/ | 404 | text/plain | 36 | 2026-09-19T11:32:23Z | false |
| 13 | https://gateway.on-demand.io/config/v1/public/docs/categories | 401 | text/plain | 62 | 2026-09-19T11:32:23Z | false |
| 14 | https://app.on-demand.io/ | 200 | text/html | 8866 | 2026-09-19T11:32:24Z | false |
| 15 | https://docs.on-demand.io/docs/agent-skills.md | 200 | text/markdown | 13394 | 2026-09-19T11:32:24Z | false |
| 16 | https://docs.on-demand.io/docs/agent-skills.md.md | 404 | text/html | 116815 | 2026-09-19T11:32:25Z | false |
| 17 | https://docs.on-demand.io/docs/workflow-api.md (first attempt 2026-09-19T11:32:25Z: HTTP 429, blocked=true; shown = single retry) | 200 | text/markdown | 12033 | 2026-09-19T11:34:36Z | false |
| 18 | https://docs.on-demand.io/docs/workflow-api | 200 | text/html | 224310 | 2026-09-19T11:32:26Z | false |
| 19 | https://docs.on-demand.io/docs/workflow-nodes.md | 200 | text/markdown | 7072 | 2026-09-19T11:32:27Z | false |
| 20 | https://docs.on-demand.io/docs/workflow-api.md.md | 404 | text/html | 116815 | 2026-09-19T11:32:27Z | false |
| 21 | https://docs.on-demand.io/docs/workflow-nodes.md.md | 404 | text/html | 116825 | 2026-09-19T11:32:28Z | false |
| 22 | https://docs.on-demand.io/docs/creating-a-workflow.md | 200 | text/markdown | 5256 | 2026-09-19T11:32:28Z | false |
| 23 | https://docs.on-demand.io/reference/get_workflow.md.md | 404 | text/html | 116857 | 2026-09-19T11:32:29Z | false |
| 24 | https://docs.on-demand.io/reference/get_workflow.md | 200 | text/markdown | 11778 | 2026-09-19T11:32:29Z | false |
| 25 | https://docs.on-demand.io/reference/post_workflow.md.md | 404 | text/html | 116862 | 2026-09-19T11:32:30Z | false |
| 26 | https://docs.on-demand.io/reference/post_workflow.md | 200 | text/markdown | 11222 | 2026-09-19T11:32:30Z | false |
| 27 | https://docs.on-demand.io/docs/creating-a-workflow.md.md | 404 | text/html | 116850 | 2026-09-19T11:32:31Z | false |
| 28 | https://docs.on-demand.io/reference/get_workflow-id.md.md | 429 | text/html | 21810 | 2026-09-19T11:32:31Z | true |
| 29 | https://docs.on-demand.io/docs/plugin-api.md | 200 | text/markdown | 5837 | 2026-09-19T11:34:22Z | false |
| 30 | https://docs.on-demand.io/docs/what-are-plugins.md | 200 | text/markdown | 5652 | 2026-09-19T11:34:24Z | false |
| 31 | https://docs.on-demand.io/docs/plugins.md | 200 | text/markdown | 4347 | 2026-09-19T11:34:26Z | false |
| 32 | https://docs.on-demand.io/docs/rest-based-plugins.md | 200 | text/markdown | 8993 | 2026-09-19T11:34:28Z | false |
| 33 | https://docs.on-demand.io/docs/rest-api-plugin-examples.md | 200 | text/markdown | 17607 | 2026-09-19T11:34:30Z | false |
| 34 | https://docs.on-demand.io/docs/open-api-schema.md | 200 | text/markdown | 16875 | 2026-09-19T11:34:32Z | false |
| 35 | https://docs.on-demand.io/docs/agents-flow-builder.md | 200 | text/markdown | 962 | 2026-09-19T11:34:34Z | false |
| 36 | https://docs.on-demand.io/reference/post_workflow-id-execute.md | 200 | text/markdown | 1814 | 2026-09-19T11:34:38Z | false |
| 37 | https://docs.on-demand.io/reference/post_workflow-id-activate.md | 200 | text/markdown | 1318 | 2026-09-19T11:34:40Z | false |
| 38 | https://docs.on-demand.io/reference/post_workflow-id-deactivate.md | 200 | text/markdown | 1326 | 2026-09-19T11:34:42Z | false |
| 39 | https://docs.on-demand.io/reference/patch_workflow-id.md | 200 | text/markdown | 11028 | 2026-09-19T11:34:44Z | false |
| 40 | https://docs.on-demand.io/reference/get_workflow-id.md | 200 | text/markdown | 11429 | 2026-09-19T11:34:46Z | false |
| 41 | https://docs.on-demand.io/reference/delete_workflow-id.md | 200 | text/markdown | 1382 | 2026-09-19T11:34:48Z | false |
| 42 | https://docs.on-demand.io/reference/patch_workflow-id-name.md | 200 | text/markdown | 1833 | 2026-09-19T11:34:50Z | false |
| 43 | https://docs.on-demand.io/reference/post_workflow-upload-config.md | 200 | text/markdown | 1629 | 2026-09-19T11:34:52Z | false |
| 44 | https://docs.on-demand.io/reference/get_execution-executionid-logs.md | 200 | text/markdown | 3805 | 2026-09-19T11:34:54Z | false |
| 45 | https://docs.on-demand.io/docs/execution-api.md | 200 | text/markdown | 8888 | 2026-09-19T11:34:56Z | false |
| 46 | https://docs.on-demand.io/docs/rules-to-publish-a-rest-api-plugin.md | 200 | text/markdown | 2618 | 2026-09-19T11:34:58Z | false |
| 47 | https://docs.on-demand.io/docs/knowledge-plugin.md | 200 | text/markdown | 13678 | 2026-09-19T11:35:00Z | false |
| 48 | https://docs.on-demand.io/docs/terminal-agent.md | 200 | text/markdown | 23976 | 2026-09-19T11:35:02Z | false |
| 49 | https://docs.on-demand.io/docs/what-are-connectors.md | 200 | text/markdown | 3112 | 2026-09-19T11:35:04Z | false |
| 50 | https://docs.on-demand.io/docs/chat-api.md | 200 | text/markdown | 16084 | 2026-09-19T11:35:06Z | false |
| 51 | https://docs.on-demand.io/docs/getting-started.md | 200 | text/markdown | 7476 | 2026-09-19T11:35:08Z | false |
| 52 | https://docs.on-demand.io/docs/authentication.md | 200 | text/markdown | 4795 | 2026-09-19T11:35:10Z | false |
| 53 | https://docs.on-demand.io/reference/intro-to-ondemand-api.md | 200 | text/markdown | 2957 | 2026-09-19T11:35:12Z | false |
| 54 | https://docs.on-demand.io/reference/how-to-do-authentication.md | 200 | text/markdown | 1872 | 2026-09-19T11:35:14Z | false |
| 55 | https://docs.on-demand.io/docs/chat-wokflow.md | 200 | text/markdown | 3587 | 2026-09-19T11:35:16Z | false |
| 56 | https://docs.on-demand.io/docs/mqttiot-plugins.md | 200 | text/markdown | 11722 | 2026-09-19T11:35:18Z | false |
| 57 | https://docs.on-demand.io/reference/createchatsession.md | 200 | text/markdown | 6326 | 2026-09-19T11:35:20Z | false |
| 58 | https://docs.on-demand.io/reference/submitquery.md | 200 | text/markdown | 10816 | 2026-09-19T11:35:22Z | false |
| 59 | https://docs.on-demand.io/docs/general-faqs.md | 200 | text/markdown | 1261 | 2026-09-19T11:35:24Z | false |
| 60 | https://docs.on-demand.io/docs/what-is-playground.md | 200 | text/markdown | 7514 | 2026-09-19T11:35:26Z | false |
| 61 | https://docs.on-demand.io/reference/get_execution-executionid.md | 200 | text/markdown | 4215 | 2026-09-19T11:35:28Z | false |
| 62 | https://docs.on-demand.io/docs/mcp.md | 404 | text/html | 116755 | 2026-09-19T11:35:30Z | false |
| 63 | https://docs.on-demand.io/docs/mcp-server.md | 404 | text/html | 116790 | 2026-09-19T11:35:32Z | false |

Notes on the table:
- `blocked=true` rows are ReadMe rate-limit responses (HTTP 429, body contains `challenge-platform`), recorded as BLOCKED per the detection rule; they were not Cloudflare bot challenges and the host answered 200 again after slowing down.
- The 11 `.md.md` rows are a pass-1 URL-construction bug (llms.txt links already end in `.md`); they are counted against the URL cap and reported as-is.
- `https://gateway.on-demand.io/config/v1/public/docs/categories` was fetched WITHOUT any apikey header and returned HTTP 401 `{"errorCode":"unauthenticated","message":"No API key header"}`.
- `https://api.on-demand.io/`, `/docs`, `/openapi.json`, `/swagger` all return HTTP 404 `{"error_msg":"404 Route Not Found"}` — no self-served API documentation exists on that host.
- `https://app.on-demand.io/` returns HTTP 200 (8,866 bytes, title 'OnDemand'), a JavaScript SPA shell with no crawlable documentation content.

## Findings by surface

### 1. Plugins / tools (My Plugins → now 'My Agents', OpenAPI-schema creation, 'Agent Tools')

**Summary:** Public docs describe plugin/agent creation ONLY as a dashboard flow ('Navigate to My Agents … click on Create Agents', paste/import an OpenAPI schema). The sole documented plugin REST endpoint is read-only: `GET /plugin/v1/list`. No create/update/delete plugin endpoint, no 'Agent Tools' page and no MCP tool for plugin creation appears anywhere in the crawled docs. The Terminal Agent page says it 'can … even create new plugins for the platform' via chat, which is a product feature, not a documented API.

| kind | verbatim quote | source URL |
|------|----------------|------------|
| dashboard | To create a REST-based agent, you will need to: 1. Navigate to [My Agents](https://app.on-demand.io/rag-agents/my-agents) section and click on Create Agents. 2. Define your API's structure using the OpenAPI schema. | https://docs.on-demand.io/docs/rest-based-plugins.md |
| dashboard | <Image alt="Create Rest API Plugin" align="center" border={true} _(note: screenshot alt text still uses the old 'Plugin' naming; the page itself now says 'Agents')_ | https://docs.on-demand.io/docs/rest-based-plugins.md |
| dashboard | * **Import from URL:** If your API schema is available online, you can directly import it by providing the URL. * **Example Schema:** Start with an example schema and modify it to fit your API specifications. | https://docs.on-demand.io/docs/rest-based-plugins.md |
| dashboard | You can create the Knowledge Agent directly through the provided link above, or you can access it from the UI under the category **My Agents**. Click on Create Agent to see the screen as shown below: | https://docs.on-demand.io/docs/knowledge-plugin.md |
| api | ### Get Agents: To fetch the list of plugins based on plugin IDs. Endpoint URL: `/plugin/v1/list` Method: `GET` _(note: the ONLY plugin/agent REST endpoint documented is a read-only list; no create/update/delete endpoint appears anywhere in the crawled docs)_ | https://docs.on-demand.io/docs/plugin-api.md |
| api | curl -X GET 'https://api.on-demand.io/plugin/v1/list?pluginIds=plugin-1716806012,plugin-1717869021' \ -H 'apikey: <replace_api_key>' | https://docs.on-demand.io/docs/plugin-api.md |
| unclear | The OnDemand platform empowers users to create their own agents and leverage agents created by others. | https://docs.on-demand.io/docs/plugin-api.md |
| dashboard | In addition to accessing pre-built agents, the marketplace also supports the creation and sharing of user-generated agents. This feature empowers developers to build custom agents tailored to unique use cases and share them with the broader community. | https://docs.on-demand.io/docs/what-are-plugins.md |
| api | **Agents (Plugins):** Optional specialized tools (Knowledge, REST API, etc.) referenced by `pluginIds` that can be invoked during the RAG stage to gather context before fulfillment. _(note: attaching existing plugins to a chat session via API (not creation))_ | https://docs.on-demand.io/docs/chat-api.md |
| api | "pluginIds": { "type": "array", "description": "A list of plugin IDs to be used in the chat session. _(note: attach-only)_ | https://docs.on-demand.io/reference/createchatsession.md |
| unclear | and even create new plugins for the platform — all inside a single chat. _(note: Terminal Agent product feature (chat-driven), not a documented REST endpoint or MCP tool)_ | https://docs.on-demand.io/docs/terminal-agent.md |
| unclear | \| `api-connector-builder` \| Write a custom Python connector to a REST API that isn't in the marketplace \| | https://docs.on-demand.io/docs/terminal-agent.md |
| unclear | \| `api-schema-generator` \| Produce a validated OpenAPI specification for a real external API \| | https://docs.on-demand.io/docs/terminal-agent.md |
| unclear | Connectors are a specialized form of agents introduced to make authentication and user verification simpler and more convenient. | https://docs.on-demand.io/docs/what-are-connectors.md |
| unclear | For compliance and security, connectors can only be created by On Demand. Users cannot create their own connectors. | https://docs.on-demand.io/docs/what-are-connectors.md |

### 2. Agents (REST API Agent / My Agents creation)

**Summary:** On docs.on-demand.io the word 'Agents' now denotes what the API and URL slugs still call plugins (llms.txt maps 'Agents API' → /docs/plugin-api.md and 'What are Agents ?' → /docs/what-are-plugins.md). Creation of Knowledge / REST API / IoT agents is documented exclusively through the dashboard (My Agents → Create Agent). Existing agents are referenced by ID via API (`pluginIds` on chat sessions, `plugins: [{id}]` inside workflow node bodies).

| kind | verbatim quote | source URL |
|------|----------------|------------|
| unclear | - [Agents API](https://docs.on-demand.io/docs/plugin-api.md) _(note: naming: the docs' 'Agents' == the API's 'plugins' (URL slugs still say plugin))_ | https://docs.on-demand.io/llms.txt |
| unclear | - [What are Agents ?](https://docs.on-demand.io/docs/what-are-plugins.md) | https://docs.on-demand.io/llms.txt |
| unclear | - [Rest API Agent Examples](https://docs.on-demand.io/docs/rest-api-plugin-examples.md): This document provides a step-by-step guide for creating a REST API agent using the examples. | https://docs.on-demand.io/llms.txt |
| dashboard | To create a REST-based agent, you will need to: 1. Navigate to [My Agents](https://app.on-demand.io/rag-agents/my-agents) section and click on Create Agents. | https://docs.on-demand.io/docs/rest-based-plugins.md |
| dashboard | 3. Configure your agent with the necessary parameters and settings. 4. Test and validate your agent to ensure it operates correctly within our platform | https://docs.on-demand.io/docs/rest-based-plugins.md |
| dashboard | The [Agents Marketplace](https://app.on-demand.io/rag-agents/marketplace) is a centralized platform where users can explore, discover, and utilize a variety of agents to extend the functionalities of AI models. | https://docs.on-demand.io/docs/what-are-plugins.md |
| api | Endpoint URL: `/plugin/v1/list` Method: `GET` _(note: list only — no 'create agent' endpoint documented)_ | https://docs.on-demand.io/docs/plugin-api.md |
| dashboard | * **Agents Integration:** Select specific Agents (Knowledge, REST API, etc.) whose context or execution results should be made available to this LLM node during its execution. | https://docs.on-demand.io/docs/workflow-nodes.md |
| dashboard | * **Agent:** Represents the execution of a specific Knowledge, REST API, or IoT Agent. | https://docs.on-demand.io/docs/creating-a-workflow.md |
| dashboard | * **Agents:** Add Agent nodes and configure them to use any Agents you have subscribed to or created. | https://docs.on-demand.io/docs/creating-a-workflow.md |
| api | "plugins": [ { "id": "plugin-1713924030" } ] _(note: attaching an existing agent/plugin to a workflow node inside the Create Workflow request body)_ | https://docs.on-demand.io/docs/workflow-api.md |
| dashboard | **Add agents/custom agents**- Allows users to add agents to the conversation window after subscribing to them from the agent marketplace. | https://docs.on-demand.io/docs/what-is-playground.md |

### 3. Skills (create / list / attach to agent)

**Summary:** A single guide page exists (/docs/agent-skills.md). Creation, ZIP upload, validation, publishing, subscribing and attaching a skill to an agent are all described as dashboard actions ('In your dashboard, open Skills and click Create Skill', 'Zip the folder and drop it in', 'Click Subscribe', 'Add the skill to an agent or a Playground session'). No /reference/ (API) page for skills is listed in llms.txt and no skill endpoint appears in any fetched page.

| kind | verbatim quote | source URL |
|------|----------------|------------|
| unclear | - [Agent Skills](https://docs.on-demand.io/docs/agent-skills.md) _(note: the only Skills page in the index; no /reference/ (API) page for skills is listed)_ | https://docs.on-demand.io/llms.txt |
| dashboard | **1. You write it.** A Skill is a Markdown file called `SKILL.md` — plain writing, no code required. If your skill needs helper files (scripts, templates, reference documents), you add them to a folder and upload the whole thing as a `.zip`. | https://docs.on-demand.io/docs/agent-skills.md |
| dashboard | ### Step 1 — Set up the Skill In your dashboard, open **Skills** and click **Create Skill**. | https://docs.on-demand.io/docs/agent-skills.md |
| dashboard | **Uploading.** Zip the folder and drop it in. Use **Validate** first if you'd like to see the file list we detected before committing — it checks your structure without changing your skill. | https://docs.on-demand.io/docs/agent-skills.md |
| dashboard | **3. Your agents use it.** Once approved, the skill is available to your agents. Publish it and any company on the platform can add it to their own library. | https://docs.on-demand.io/docs/agent-skills.md |
| dashboard | Click **Subscribe**. The skill is added to your company's library and becomes available to your agents. | https://docs.on-demand.io/docs/agent-skills.md |
| dashboard | Add the skill to an agent or a Playground session and your agent follows its instructions from that point on. _(note: attach-to-agent is described as a UI action; no endpoint given)_ | https://docs.on-demand.io/docs/agent-skills.md |
| dashboard | ### Step 4— Test it Add your skill in the Playground and try your sample prompts. | https://docs.on-demand.io/docs/agent-skills.md |
| dashboard | **Can I edit a published skill?**<br />Yes. Your changes go through the safety check again, then reach everyone who subscribed. | https://docs.on-demand.io/docs/agent-skills.md |
| unclear | \| Custom skills per message \| 10 \| | https://docs.on-demand.io/docs/terminal-agent.md |

### 4. Agents Flow Builder workflows (create/update, activate/deactivate, execute, logs, attach plugins to nodes)

**Summary:** Fully documented REST API under base `https://api.on-demand.io/automation/api` with `apikey` header auth: POST /workflow/ (create), GET /workflow/ (list), GET|PATCH|DELETE /workflow/{id}, PATCH /workflow/{id}/name, POST /workflow/{id}/activate, POST /workflow/{id}/deactivate, POST /workflow/{id}/execute, POST /workflow/upload/config, plus execution endpoints (GET /execution/{executionID}/logs — a JSON array, no streaming transport documented). Plugins/agents are attached to nodes via a `plugins: [{id}]` array in LLMMeta and AdvancedVoiceModeMeta node schemas. The dashboard flow (Create Workflow button, activation toggle) is documented in parallel.

| kind | verbatim quote | source URL |
|------|----------------|------------|
| dashboard | 1. Navigate to the [main Agents/Workflow section](https://app.on-demand.io/agents) in your OnDemand dashboard 2. Click the **"Create Workflow"** button, typically located in the top-right corner of the page. | https://docs.on-demand.io/docs/creating-a-workflow.md |
| dashboard | Once you are satisfied with your workflow's design and test results, you need to **activate** it before it can be triggered automatically (via schedule or API). | https://docs.on-demand.io/docs/creating-a-workflow.md |
| api | Your workflow is now live and will run based on its configured trigger (e.g., at the specified CRON interval or when called by the [Workflow Execution API](https://app.on-demand.io/api-reference#/agents-flow-builder-api/post_workflow-id-execute)). | https://docs.on-demand.io/docs/creating-a-workflow.md |
| api | **List of workflow endpoints** 1. [Create workflow](https://docs.on-demand.io/reference/post_workflow) 2. [List workflows](https://docs.on-demand.io/reference/get_workflow) 3. [Get workflow by ID](https://docs.on-demand.io/reference/get_workflow-id) | https://docs.on-demand.io/docs/workflow-api.md |
| api | 7. [Activate workflow](https://docs.on-demand.io/reference/post_workflow-id-activate) 8. [Deactivate workflow](https://docs.on-demand.io/reference/post_workflow-id-deactivate) 9. [Execute workflow](https://docs.on-demand.io/reference/post_workflow-id-execute) | https://docs.on-demand.io/docs/workflow-api.md |
| api | curl --location 'https://api.on-demand.io/automation/api/workflow' \ --header 'apikey: token-here' \ --data '{ "name":"Marketing reach out - voice", | https://docs.on-demand.io/docs/workflow-api.md |
| api | curl --location 'https://api.on-demand.io/automation/api/workflow?limit=50' \ --header 'apikey: token-here' | https://docs.on-demand.io/docs/workflow-api.md |
| api | "plugins": [ { "id": "plugin-1713924030" } ] _(note: plugins attached to an advancedVoiceMode node in the Create Workflow body)_ | https://docs.on-demand.io/docs/workflow-api.md |
| api | "servers": [ { "url": "https://api.on-demand.io/automation/api" } ], "paths": { "/workflow/": { "post": { "summary": "Create a new workflow", | https://docs.on-demand.io/reference/post_workflow.md |
| api | "plugins": { "type": "array", "items": { "$ref": "#/components/schemas/Plugin" } } _(note: appears in the LLMMeta and AdvancedVoiceModeMeta node schemas → plugins/agents are attached to nodes via the API body)_ | https://docs.on-demand.io/reference/post_workflow.md |
| api | "/workflow/{id}": { "patch": { "summary": "Update workflow", | https://docs.on-demand.io/reference/patch_workflow-id.md |
| api | "/workflow/{id}": { "delete": { "summary": "Delete workflow", | https://docs.on-demand.io/reference/delete_workflow-id.md |
| api | "/workflow/{id}/name": { "patch": { "summary": "Update workflow name", | https://docs.on-demand.io/reference/patch_workflow-id-name.md |
| api | "/workflow/{id}/activate": { "post": { "summary": "Activate workflow", | https://docs.on-demand.io/reference/post_workflow-id-activate.md |
| api | "/workflow/{id}/deactivate": { "post": { "summary": "Deactivate workflow", | https://docs.on-demand.io/reference/post_workflow-id-deactivate.md |
| api | "/workflow/{id}/execute": { "post": { "summary": "Execute workflow", | https://docs.on-demand.io/reference/post_workflow-id-execute.md |
| api | "200": { "description": "Workflow execution started", "content": { "application/json": { "schema": { "type": "object", "properties": { "executionID": { "type": "string" } | https://docs.on-demand.io/reference/post_workflow-id-execute.md |
| api | "/workflow/upload/config": { "post": { "summary": "Upload workflow configuration", | https://docs.on-demand.io/reference/post_workflow-upload-config.md |
| api | "securitySchemes": { "ApiKeyAuth": { "type": "apiKey", "in": "header", "name": "apikey" } } | https://docs.on-demand.io/reference/post_workflow-id-execute.md |
| api | List of workflow execution endpoints. 1. [List executions](https://docs.on-demand.io/reference/get_execution-list) 2. [Get execution logs](https://docs.on-demand.io/reference/get_execution-executionid-logs) | https://docs.on-demand.io/docs/execution-api.md |
| api | "/execution/{executionID}/logs": { "get": { "summary": "Get execution logs", _(note: logs are a plain GET returning a JSON array of ExecutionLog objects; no SSE/streaming transport is documented)_ | https://docs.on-demand.io/reference/get_execution-executionid-logs.md |
| api | * **API Trigger:** * Allows you to start a workflow execution programmatically by making an HTTP POST request to a unique endpoint generated for your workflow. | https://docs.on-demand.io/docs/workflow-nodes.md |
| dashboard | * **Agents Integration:** Select specific Agents (Knowledge, REST API, etc.) whose context or execution results should be made available to this LLM node during its execution. | https://docs.on-demand.io/docs/workflow-nodes.md |

### 5. OnDemand MCP server

**Summary:** No OnDemand MCP server is documented: no page, URL, transport or tools list mentions it; llms.txt contains no 'mcp'/'Model Context' entry; speculative /docs/mcp.md and /docs/mcp-server.md return 404. The only 'mcp' strings on the site are ReadMe hosting-platform config flags (`"mcp":{"state":"disabled",…}` — ReadMe's own docs-MCP feature, disabled) and an internal Terminal Agent skill name `mcp-graphs`.

| kind | verbatim quote | source URL |
|------|----------------|------------|
| unclear | "mcp":{"state":"disabled","custom_tools":[],"disabled_routes":[],"disabled_tools":[] _(note: ReadMe (the docs-hosting platform) project config embedded in the page — ReadMe's own docs-MCP feature is DISABLED for this site; this is not an OnDemand product MCP server)_ | https://docs.on-demand.io/ |
| unclear | "mcp_server_card":true _(note: ReadMe platform feature flag, not OnDemand documentation)_ | https://docs.on-demand.io/ |
| unclear | \| `mcp-graphs` \| Render live, interactive charts and diagrams (flowcharts, node-link graphs) \| _(note: an internal Terminal Agent skill name; no MCP server URL, transport or tools list is documented)_ | https://docs.on-demand.io/docs/terminal-agent.md |

## Endpoints seen (paths containing /plugin, /plugins, /agent, /agents, /skill, /skills, /tool, /tools, /workflow, /mcp)

| method | path | documented at |
|--------|------|---------------|
| GET | `/plugin/v1/list` | https://docs.on-demand.io/docs/plugin-api.md |
| POST | `https://api.on-demand.io/automation/api/workflow` | https://docs.on-demand.io/docs/workflow-api.md |
| GET | `https://api.on-demand.io/automation/api/workflow` | https://docs.on-demand.io/docs/workflow-api.md |
| POST | `https://api.on-demand.io/automation/api/workflow/` | https://docs.on-demand.io/reference/post_workflow.md |
| GET | `https://api.on-demand.io/automation/api/workflow/` | https://docs.on-demand.io/reference/get_workflow.md |
| DELETE | `https://api.on-demand.io/automation/api/workflow/66e3f1bb60a439e502658247` | https://docs.on-demand.io/docs/workflow-api.md |
| POST | `https://api.on-demand.io/automation/api/workflow/66e4448d2cac15eadc6d9ffb/activate` | https://docs.on-demand.io/docs/workflow-api.md |
| POST | `https://api.on-demand.io/automation/api/workflow/66e4448d2cac15eadc6d9ffb/deactivate` | https://docs.on-demand.io/docs/workflow-api.md |
| POST | `https://api.on-demand.io/automation/api/workflow/66e4448d2cac15eadc6d9ffb/execute` | https://docs.on-demand.io/docs/workflow-api.md |
| PATCH | `https://api.on-demand.io/automation/api/workflow/6717522672e5ea587e393583/name` | https://docs.on-demand.io/docs/workflow-api.md |
| PATCH | `https://api.on-demand.io/automation/api/workflow/67652617621ed048863aafe8` | https://docs.on-demand.io/docs/workflow-api.md |
| GET | `https://api.on-demand.io/automation/api/workflow/6781182e5cb8b99af5975a6c` | https://docs.on-demand.io/docs/workflow-api.md |
| POST | `https://api.on-demand.io/automation/api/workflow/upload/config` | https://docs.on-demand.io/reference/post_workflow-upload-config.md |
| GET | `https://api.on-demand.io/automation/api/workflow/{id}` | https://docs.on-demand.io/reference/get_workflow-id.md |
| PATCH | `https://api.on-demand.io/automation/api/workflow/{id}` | https://docs.on-demand.io/reference/patch_workflow-id.md |
| DELETE | `https://api.on-demand.io/automation/api/workflow/{id}` | https://docs.on-demand.io/reference/delete_workflow-id.md |
| POST | `https://api.on-demand.io/automation/api/workflow/{id}/activate` | https://docs.on-demand.io/reference/post_workflow-id-activate.md |
| POST | `https://api.on-demand.io/automation/api/workflow/{id}/deactivate` | https://docs.on-demand.io/reference/post_workflow-id-deactivate.md |
| POST | `https://api.on-demand.io/automation/api/workflow/{id}/execute` | https://docs.on-demand.io/reference/post_workflow-id-execute.md |
| PATCH | `https://api.on-demand.io/automation/api/workflow/{id}/name` | https://docs.on-demand.io/reference/patch_workflow-id-name.md |
| GET | `https://api.on-demand.io/plugin/v1/list` | https://docs.on-demand.io/docs/plugin-api.md |

Related execution endpoints on the same Agents Flow Builder API (do not contain the keyword list, included because they cover 'stream logs' / execution status):

| method | path | documented at |
|--------|------|---------------|
| GET | `https://api.on-demand.io/automation/api/execution/{executionID}` | https://docs.on-demand.io/reference/get_execution-executionid.md |
| GET | `https://api.on-demand.io/automation/api/execution/{executionID}/logs` | https://docs.on-demand.io/reference/get_execution-executionid-logs.md |
| POST | `https://api.on-demand.io/chat/v1/sessions` | https://docs.on-demand.io/reference/createchatsession.md |
| POST | `https://api.on-demand.io/chat/v1/sessions/{sessionId}/query` | https://docs.on-demand.io/reference/submitquery.md |

No endpoint containing `/skill`, `/skills`, `/tool`, `/tools`, `/agent`, `/agents` or `/mcp` was found in any fetched page. No MCP server URL was found, so none was connected to.

## Absence / integrity checks

- **llms_txt_mentions_mcp**: false
- **llms_txt_skill_pages**: ["- [Agent Skills](https://docs.on-demand.io/docs/agent-skills.md)"]
- **llms_txt_reference_pages_matching_plugin_agent_skill_tool**: []
- **llms_txt_reference_pages_matching_workflow**: ["- [Get email delivery status for workflow executions.](https://docs.on-demand.io/reference/get_execution-executionid-delivery-track-email.md): Retrieves email delivery status for workflow executions.", "- [Get voice mode transcripts for an execution](https://docs.on-demand.io/reference/get_execution-executionid-transcript.md): Retrieves transcripts for voice mode workflows. Returns unauthorized error if the workflow is not in advanced voice mode.", "- [Create a new workflow](https://docs.on-demand.io/reference/post_workflow.md)", "- [List workflows](https://docs.on-demand.io/reference/get_workflow.md)", "- [Get workflow by ID](https://docs.on-demand.io/reference/get_workflow-id.md)", "- [Update workflow](https://docs.on-demand.io/reference/patch_workflow-id.md)", "- [Delete workflow](https://docs.on-demand.io/reference/delete_workflow-id.md)", "- [Activate workflow](https://docs.on-demand.io/reference/post_workflow-id-activate.md)", "- [Deactivate workflow](https://docs.on-demand.io/reference/post_workflow-id-deactivate.md)", "- [Execute workflow](https://docs.on-demand.io/reference/post_workflow-id-execute.md)", "- [Update workflow name](https://docs.on-demand.io/reference/patch_workflow-id-name.md)", "- [Upload workflow configuration](https://docs.on-demand.io/reference/post_workflow-upload-config.md)"]
- **sitemap_xml**: 404 — no sitemap; discovery used llms.txt and the home-page navigation instead
- **llms_full_txt**: 404 — no aggregate; individual .md pages fetched instead
- **api_on_demand_io_root_docs_openapi_swagger**: all 404 with body {"error_msg":"404 Route Not Found"} — no self-hosted API docs / OpenAPI document at api.on-demand.io
- **gateway_categories_unauthenticated**: 401 {"errorCode":"unauthenticated","message":"No API key header"} (fetched deliberately without any apikey header)
- **docs_mcp_pages**: /docs/mcp.md and /docs/mcp-server.md → 404 (speculative URLs; not listed in llms.txt or nav)
- **rate_limiting_during_crawl**: docs.on-demand.io (ReadMe-hosted) answered 429 'Hello there, human!' (body contains 'challenge-platform') twice in pass 1 at 2 req/s; crawl paused and resumed at 1 req / 2 s — all remaining pages then returned 200
- **pass1_url_bug**: pass 1 appended '.md' to llms.txt links that already ended in '.md' (→ 11 '.md.md' 404s); those requests still count toward the 70-URL cap
- **quotes verified verbatim against fetched bodies (whitespace-normalised)**: 63 of 63
