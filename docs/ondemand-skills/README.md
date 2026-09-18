# GodsEye Skills (nine `SKILL.md` bodies for the OnDemand dashboard)

Companion to the live workflow **`GodsEye Advanced Spatial Workflow` v1** (id
`6aace534859f7b0abb53d99a`, created through the documented Agents Flow Builder API
on 2026-09-18 — `docs/ondemand-workflows/README.md`) and to the
**GodsEye Spatial Intelligence Agent** whose registration pack is
`docs/audit/dashboard-registration-pack.md`. Each file below is a complete,
ready-to-paste `SKILL.md`; together they teach an OnDemand agent the same
procedure the workflow's nine nodes execute.

| #   | Slug                                 | Name                              | One-line purpose                                                                                                        | Primary workflow node(s)                     | App modules                                                                                                    | File                                          |
| --- | ------------------------------------ | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| 1   | `godseye-spatial-context-reader`     | GodsEye Spatial Context Reader    | Parse/validate the 15 §13 spatial-context fields and derive view radius, entity counts, emergency squawks, vessels under way | `session_context`, `spatial_context_builder` | `src/ui/context*.js`, `src/app/stateChannel.js`, `src/layers/*/evidence.js`                                     | `godseye-spatial-context-reader.md`           |
| 2   | `godseye-intent-classifier`          | GodsEye Intent Classifier         | Classify the query (9 intents), confidence, tier ASK/INVESTIGATE/DEEP, focus, needsExternalData — low effort            | `intent_classifier`                          | `api/ondemand/chat.js`, `tierDefaults()` / `TIER_DEFAULTS` in `server/ondemand/config.js`                       | `godseye-intent-classifier.md`                |
| 3   | `godseye-capability-resolver`        | GodsEye Capability Resolver       | Select capabilities only from the supplied catalogue and build their params (earthquake_search circle/bbox rules)        | `capability_resolver`                        | `src/registry/capabilities.json`, `docs/ondemand-workflows/tools/earthquake_search.json`, `server/serverless/earthquakes-route.js` | `godseye-capability-resolver.md`  |
| 4   | `godseye-map-action-planner`         | GodsEye Map Action Planner        | Emit ≤ 6 schema-valid MapActions restricted to the 28 names and their parameter keys; suggested next actions             | `spatial_action_planner`                     | `src/voice/actionSchemas.js` (`GEV_ACTION_SCHEMAS`), `src/voice/commands.js`, `src/voice/session.js`             | `godseye-map-action-planner.md`               |
| 5   | `godseye-seismic-analyst`            | GodsEye Seismic Analyst           | Plan/interpret `earthquake_search` (USGS, observed coverage): magnitude bands, depth, distance, recency, tsunami flag     | `capability_resolver`, `planner`             | `server/sources/usgs-earthquakes.js`, `server/serverless/earthquakes-route.js`, `src/layers/earthquakes/`       | `godseye-seismic-analyst.md`                  |
| 6   | `godseye-aviation-analyst`           | GodsEye Aviation Analyst          | ADS-B anomaly heuristics: 7500/7600/7700, ground-speed, low-altitude, heading/approach checks with literal evidence      | `planner`, `verification`                    | `src/layers/flights/`, `src/layers/military/`, `src/layers/aircraft/classification.js`, `server/providers/aircraft/` | `godseye-aviation-analyst.md`            |
| 7   | `godseye-maritime-analyst`           | GodsEye Maritime Analyst          | AIS anomaly heuristics: navStatus vs speed, vessels under way near an approach / restricted water, AIS gaps, ship type   | `planner`, `verification`                    | `src/layers/vessels/`, `src/data/aisLiveVessels.js`, `server/providers/vessels/`                                | `godseye-maritime-analyst.md`                 |
| 8   | `godseye-evidence-verifier`          | GodsEye Evidence Verifier         | Adversarial re-check: verified / unverified / rejected, severity downgrade, one evidence row per literal value           | `verification`                               | `docs/audit/media-grounding-verification.md`, `src/layers/flights/evidence.js`, `src/layers/vessels/evidence.js` | `godseye-evidence-verifier.md`               |
| 9   | `godseye-structured-response-writer` | GodsEye Structured Response Writer | Analyst message + the 7-key StructuredResponse (message, entities, actions, evidence, sources, suggestedNextActions, runMeta) | `synthesis`, `structured_response`       | `api/ondemand/chat.js`, `api/ondemand/workflow.js`, `validateStructuredResponse()` in `server/ondemand/workflow-definition.js` | `godseye-structured-response-writer.md` |

## Creation surface: dashboard only

`docs/ONDEMAND_API_CURRENT.md` §9: _"Create / attach / invoke via REST API:
**NOT FOUND IN LIVE DOCS**"_ — source `https://docs.on-demand.io/docs/agent-skills.md`
(retrieved 2026-09-17T05:56:31Z; re-read 2026-09-18T07:20:32Z, unchanged: a Skill
is "created in Dashboard → Skills → Create Skill"). No skill id could therefore
be obtained by API on 2026-09-18, and none was invented; the nine `skillId`
slots in `src/registry/capabilities.json` (`ondemand.skills[]`) are `null` until
the dashboard returns them.

### Dashboard procedure (per skill)

1. Dashboard → **Skills** → **Create Skill**.
2. **Skill Name** = the slug in the table (lowercase with dashes; names are unique
   platform-wide — if taken, append `-godseye`). **Description** = the sentence in
   the file's "Dashboard fields" line. **Category** = as given (`engineering` /
   `research`). **Icon** optional. **Sample Prompts** = the three bullets in the
   file (two are required).
3. Paste the file's body (from `## When to use this skill` through `## Never`;
   the whole file also works) into the `SKILL.md` editor — or zip a folder with
   `SKILL.md` and upload it. Limits: whole zip 50 MB, any single file 25 MB,
   `SKILL.md` 2 MB. Use **Validate** first when uploading a zip.
4. Save; the automatic safety scan runs (moments); the skill starts **private**.
5. Test in the **Playground** with the sample prompts; sharpen "When to use this
   skill" if the agent does not pick it up.
6. "Add the skill to an agent or a Playground session" — attach all nine to the
   GodsEye Spatial Intelligence Agent (registration pack §5-B).

### Where the returned ids go

| Returned id            | Paste into                                                                                     |
| ---------------------- | ---------------------------------------------------------------------------------------------- |
| each skill's id        | `src/registry/capabilities.json` → `ondemand.skills[slug = <slug>].skillId`                     |
| agent `pluginId`       | `src/registry/capabilities.json` → `ondemand.agent.pluginId` **and** env `ONDEMAND_SPATIAL_AGENT_ID` |
| workflow id            | already `6aace534859f7b0abb53d99a` (`FLOW_DEFAULTS.spatialFlowId`, `ondemand.workflow.id`)      |

Full click-by-click steps, the agent prompt, the `earthquake_search` tool JSON /
OpenAPI document and the complete id paste table:
`docs/audit/dashboard-registration-pack.md`.

## Conventions shared by all nine files

- Same section order: Dashboard fields · When to use · When NOT to use · Trigger
  conditions · Instructions · Expected input · Expected output · Never · App
  module mapping · Version.
- Field names are the ones the app and the workflow actually use
  (`visibleEntities[].squawk`, `navStatus`, `viewRadiusKm`, …); nothing is
  invented — where the app has no fact (runway geometry, prior snapshots) the
  skill says so and labels the judgement `inferred`.
- No secrets, no provider credentials, no instructions that override the
  agent's own rules (the platform's safety scan rejects those).
- Version line: `godseye-skills v1 — 2026-09-18 — pairs with workflow "GodsEye
  Advanced Spatial Workflow" v1 (id 6aace534859f7b0abb53d99a)`.
