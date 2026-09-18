/**
 * server/ondemand/workflow-definition.js — builds the `GodsEye Advanced
 * Spatial Workflow` (version 1) create-body for the OnDemand Agents Flow
 * Builder, using ONLY the request vocabulary documented in
 * docs/ONDEMAND_API_CURRENT.md §7.1/§7.2 (OpenAPI `CreateWorkflowRequest`
 * of `POST https://api.on-demand.io/automation/api/workflow/`):
 *
 *   name, trigger{type, webhook{}, position, measured, nextNodeKeys},
 *   nodes[]{key, type, kind, dependencies[{nodeKey}], nextNodeKeys,
 *           llm{fulfillmentPrompt, prompt, model, plugins[]}, position,
 *           measured},
 *   delivery[], enableMemory
 *
 * Nothing else is emitted. In particular NO reasoning-effort field exists
 * on a documented `llm` node (§7.2 `LLMMeta` = fulfillmentPrompt, prompt,
 * model, plugins), so a tier's `reasoningMode` cannot be sent per node —
 * effort is expressed only through the tier's `endpointId` (`model`) and
 * the brevity instructions in the prompts; see docs/ondemand-workflows/
 * README.md "Node mapping".
 *
 * Node chain (linear, in this order — blueprint rules 22–23, 46–48):
 *   [Input = the trigger payload] → session_context (llm, source) →
 *   spatial_context_builder → intent_classifier → capability_resolver →
 *   planner → verification → spatial_action_planner → synthesis →
 *   structured_response (llm, sink)
 *
 * The Input stage is the trigger itself. A dedicated `inputText` node (the
 * only documented non-LLM input type) was attempted first and REJECTED
 * live: `POST /workflow/` → HTTP 400 `{"message":"input: text config
 * missing","errorCode":"invalid_request"}` at 2026-09-18T07:15:04Z — the
 * required text config is not part of the documented Node schema (§7.2),
 * so it was not invented. The webhook payload reaches the source node
 * through the `{trigger}` prompt placeholder (prompt TEXT, not an API
 * field; live-observed in this account's existing webhook workflows via
 * the documented GET /workflow/{id} on 2026-09-18T07:16Z — see README).
 *
 * Every node is a documented `llm` node with an explicit system prompt
 * (`fulfillmentPrompt`) and a strict JSON-output instruction (`prompt`).
 * Each node carries the accumulated pipeline state forward in its JSON
 * output so the next node only needs its direct dependency (`{nodeKey}`
 * placeholders, same live-observed convention).
 *
 * This module is pure: no I/O, no env, no network. The CLI
 * scripts/ondemand-workflow.mjs and the unit test
 * server/ondemand/workflow-definition.test.mjs are its only consumers.
 */

export const WORKFLOW_NAME = 'GodsEye Advanced Spatial Workflow';
export const WORKFLOW_VERSION = 1;

/** Ordered node keys of the chain (the first is the source node fed by
 * the trigger payload; see the header comment for why there is no
 * separate `inputText` node). */
export const NODE_KEYS = Object.freeze([
  'session_context',
  'spatial_context_builder',
  'intent_classifier',
  'capability_resolver',
  'planner',
  'verification',
  'spatial_action_planner',
  'synthesis',
  'structured_response',
]);

/** The exact, complete key set of a StructuredResponse (blueprint §13). */
export const STRUCTURED_RESPONSE_KEYS = Object.freeze([
  'message',
  'entities',
  'actions',
  'evidence',
  'sources',
  'suggestedNextActions',
  'runMeta',
]);

/** The §13 spatial-context fields accepted by the Spatial Context Builder. */
export const SPATIAL_CONTEXT_FIELDS = Object.freeze([
  'camera',
  'viewport',
  'center',
  'altitude',
  'zoom',
  'viewScale',
  'mapStack',
  'visibleBounds',
  'activeLayers',
  'selectedEntity',
  'trackedEntity',
  'visibleEntities',
  'timeline',
  'investigation',
  'userAction',
]);

/** Which benchmarked tier (server/ondemand/config.js TIER_DEFAULTS) each
 * llm node runs on. `FULFILLMENT` = the deployment's configured
 * fulfillment endpoint (config.fulfillmentEndpointId). DEEP cannot be
 * expressed (it differs from INVESTIGATE only by `reasoningMode: 'high'`,
 * which has no documented llm-node field), so the deepest expressible tier
 * for the reasoning-heavy nodes is INVESTIGATE (the same model). */
export const NODE_TIERS = Object.freeze({
  session_context: 'ASK',
  spatial_context_builder: 'ASK',
  intent_classifier: 'ASK',
  capability_resolver: 'ASK',
  planner: 'INVESTIGATE',
  verification: 'INVESTIGATE',
  spatial_action_planner: 'INVESTIGATE',
  synthesis: 'FULFILLMENT',
  structured_response: 'ASK',
});

const JSON_ONLY =
  'OUTPUT RULES: respond with ONE JSON object and nothing else — no prose, no Markdown fences, no comments. Never invent entities, coordinates, ids or measurements that are not present in your input; when something is missing write null or an empty array. Keep every string short.';

/**
 * Self-test fixture: the Abu Dhabi International Airport (OMAA) viewport
 * spatial context + a one-entry capability catalogue + the verification
 * query. Embedded verbatim in the session_context prompt as the ONLY input
 * used when the trigger supplies no payload (the documented
 * `POST /workflow/{id}/execute` carries no request body, §7.1), and used
 * by scripts/ondemand-workflow.mjs as the expected input of a verification
 * run. `timeline.now` is filled at build time.
 */
export function selftestFixture(nowIso = '2026-09-18T00:00:00.000Z') {
  return {
    query: 'What is unusual around this airport?',
    spatialContext: {
      camera: {
        latitude: 24.4331,
        longitude: 54.6511,
        heightM: 12500,
        headingDeg: 0,
        pitchDeg: -78,
        rollDeg: 0,
      },
      viewport: { widthPx: 1920, heightPx: 1080 },
      center: { latitude: 24.4331, longitude: 54.6511 },
      altitude: 12500,
      zoom: 12.4,
      viewScale: 'airport',
      mapStack: 'photoreal',
      visibleBounds: { north: 24.52, south: 24.35, east: 54.78, west: 54.52 },
      activeLayers: ['flights', 'earthquakes', 'ais-live-vessels'],
      selectedEntity: null,
      trackedEntity: null,
      visibleEntities: [
        {
          layerId: 'flights',
          id: 'icao24:896180',
          callsign: 'ETD11',
          latitude: 24.451,
          longitude: 54.703,
          altitudeM: 1130,
          speedKts: 168,
          headingDeg: 311,
          squawk: '4021',
          onGround: false,
          source: 'adsb',
        },
        {
          layerId: 'flights',
          id: 'icao24:8963f2',
          callsign: 'ETD9',
          latitude: 24.419,
          longitude: 54.632,
          altitudeM: 0,
          speedKts: 12,
          headingDeg: 130,
          squawk: '2000',
          onGround: true,
          source: 'adsb',
        },
        {
          layerId: 'flights',
          id: 'icao24:4b1a0c',
          callsign: 'SWR9DE',
          latitude: 24.489,
          longitude: 54.571,
          altitudeM: 3350,
          speedKts: 240,
          headingDeg: 96,
          squawk: '7700',
          onGround: false,
          source: 'adsb',
        },
        {
          layerId: 'ais-live-vessels',
          id: 'mmsi:470123000',
          name: 'AL DHAFRA 7',
          latitude: 24.512,
          longitude: 54.612,
          speedKts: 0.2,
          courseDeg: 45,
          shipType: 'tug',
          navStatus: 'moored',
          source: 'ais',
        },
        {
          layerId: 'ais-live-vessels',
          id: 'mmsi:636019876',
          name: 'MSC KHALIFA',
          latitude: 24.535,
          longitude: 54.66,
          speedKts: 9.8,
          courseDeg: 275,
          shipType: 'cargo',
          navStatus: 'under way using engine',
          source: 'ais',
        },
      ],
      timeline: { mode: 'live', now: nowIso, playbackRate: 1 },
      investigation: null,
      userAction: 'query',
    },
    capabilityCatalogue: [
      {
        id: 'earthquake.search',
        ondemand_tool: 'earthquake_search',
        route: '/api/sources/earthquakes',
        provider: 'USGS FDSN Event',
        coverage: 'observed',
        description:
          'Search recent/historical earthquakes by time window, magnitude and circle (latitude+longitude+maxradiuskm) or bounding box.',
        params: [
          'starttime',
          'endtime',
          'minmagnitude',
          'maxmagnitude',
          'latitude',
          'longitude',
          'maxradiuskm',
          'minlatitude',
          'maxlatitude',
          'minlongitude',
          'maxlongitude',
          'limit',
          'orderby',
          'mode',
        ],
      },
    ],
  };
}

/**
 * One-line-per-action digest of the app's MapAction schemas
 * (src/voice/actionSchemas.js GEV_ACTION_SCHEMAS): `name(param:type, …)`,
 * optional parameters suffixed `?`, enums expanded. Embedded in the
 * spatial_action_planner prompt so the emitted actions are restricted to
 * exactly these names and parameter keys.
 */
export function actionDigest(actionSchemas) {
  return actionSchemas.map((schema) => {
    const params = schema.parameters || {};
    const required = new Set(params.required || []);
    const parts = Object.entries(params.properties || {}).map(([key, def]) => {
      let type = def.type || (def.anyOf ? 'anyOf' : 'any');
      if (def.enum) type = `enum[${def.enum.join('|')}]`;
      else if (type === 'array') {
        const item = def.items || {};
        type = `array<${item.type || (item.enum ? 'enum' : 'object')}>`;
      }
      return `${key}${required.has(key) ? '' : '?'}:${type}`;
    });
    return `${schema.name}(${parts.join(', ')})`;
  });
}

function position(index) {
  return { x: -200 + index * 320, y: 200 };
}

function llmNode({ key, index, model, system, task, dependsOn, next }) {
  const node = {
    key,
    type: 'llm',
    kind: next ? (dependsOn ? 'intermediate' : 'source') : 'sink',
    dependencies: dependsOn ? [{ nodeKey: dependsOn }] : [],
    nextNodeKeys: next ? [next] : [],
    llm: {
      fulfillmentPrompt: system,
      prompt: task,
      model,
      plugins: [],
    },
    position: position(index),
    measured: { width: 0, height: 0 },
  };
  return node;
}

/**
 * @param {object} options
 * @param {Array<{name:string, parameters?:object}>} options.actionSchemas
 *   the 28 MapAction schemas (GEV_ACTION_SCHEMAS) — the planner is
 *   restricted to exactly these names.
 * @param {{ASK:{fulfillmentEndpointId:string}, INVESTIGATE:{fulfillmentEndpointId:string}}} options.tiers
 *   TIER_DEFAULTS from server/ondemand/config.js.
 * @param {string} options.fulfillmentEndpointId  config.fulfillmentEndpointId
 *   (the synthesis node's model).
 * @param {string} [options.nowIso]  timeline.now of the embedded fixture.
 * @returns {object} the documented CreateWorkflowRequest body.
 */
export function buildGodsEyeWorkflowDefinition({
  actionSchemas,
  tiers,
  fulfillmentEndpointId,
  nowIso,
}) {
  if (!Array.isArray(actionSchemas) || actionSchemas.length === 0) {
    throw new Error('actionSchemas (GEV_ACTION_SCHEMAS) is required');
  }
  if (
    !tiers?.ASK?.fulfillmentEndpointId ||
    !tiers?.INVESTIGATE?.fulfillmentEndpointId
  ) {
    throw new Error(
      'tiers.ASK / tiers.INVESTIGATE fulfillmentEndpointId are required',
    );
  }
  if (!fulfillmentEndpointId) {
    throw new Error('fulfillmentEndpointId is required');
  }
  const modelFor = (key) => {
    const tier = NODE_TIERS[key];
    if (tier === 'FULFILLMENT') return fulfillmentEndpointId;
    return tiers[tier].fulfillmentEndpointId;
  };
  const actionNames = actionSchemas.map((s) => s.name);
  const digest = actionDigest(actionSchemas).join('\n');
  const fixture = JSON.stringify(selftestFixture(nowIso));
  const keys = STRUCTURED_RESPONSE_KEYS.join(', ');
  const fields = SPATIAL_CONTEXT_FIELDS.join(', ');

  const nodes = [
    llmNode({
      key: 'session_context',
      index: 0,
      model: modelFor('session_context'),
      dependsOn: null,
      next: 'spatial_context_builder',
      system: `You are the Session Context node of the God's Eye spatial intelligence pipeline (workflow "${WORKFLOW_NAME}" v${WORKFLOW_VERSION}). You normalise the raw run input into a session envelope. ${JSON_ONLY}`,
      task: `RAW INPUT (the trigger payload — the JSON object sent under the webhook body's "payload" field):\n{trigger}\n\nIf the raw input above is a JSON object, use it. It may contain: "query" (string), "spatialContext" (object with the fields ${fields}), "capabilityCatalogue" (array), "session" (object: sessionId, externalUserId, locale, tier, priorTurns[]), "investigation" (object or null).\n\nIf the raw input is empty, missing, an unresolved placeholder such as "{trigger}", or not JSON (this happens when the workflow is started through the API execute endpoint, which carries no body), you are in SELFTEST mode: use exactly this fixture as the input and set "mode" to "selftest":\n${fixture}\n\nReturn exactly: {"mode": "live" | "selftest", "session": {"sessionId": string|null, "externalUserId": string|null, "locale": string|null, "tier": "ASK"|"INVESTIGATE"|"DEEP"|null, "priorTurns": []}, "query": string, "rawSpatialContext": object|null, "capabilityCatalogue": array, "investigation": object|null, "receivedAtUtc": string|null}. Copy rawSpatialContext and capabilityCatalogue through unchanged.`,
    }),
    llmNode({
      key: 'spatial_context_builder',
      index: 1,
      model: modelFor('spatial_context_builder'),
      dependsOn: 'session_context',
      next: 'intent_classifier',
      system: `You are the Spatial Context Builder node of the God's Eye pipeline. You validate and normalise the §13 spatial-context object and derive compact geometry facts. ${JSON_ONLY}`,
      task: `SESSION ENVELOPE (output of the previous node):\n{session_context}\n\nBuild "spatialContext" with exactly these keys, in this order: ${fields}. Rules: copy present values; set absent ones to null (arrays to []); "center" must be {latitude, longitude}; "visibleBounds" must be {north, south, east, west}; "activeLayers" must be an array of layer ids; "visibleEntities" must be an array of objects each keeping at least layerId, id, latitude, longitude plus every other field present; "timeline" must keep mode and now; "userAction" must be one of query|select|track|navigate|annotate|unknown.\nAlso compute "derived": {"viewRadiusKm": number|null (half the visibleBounds diagonal, great-circle, rounded to 0.1), "entityCounts": {"<layerId>": count}, "airborne": count of visibleEntities with onGround === false, "onGround": count with onGround === true, "emergencySquawks": [ids whose squawk is 7500, 7600 or 7700], "vesselsUnderWay": count of vessel entities whose speedKts > 1}.\nReturn exactly: {"mode": string, "session": object, "query": string, "spatialContext": object, "derived": object, "capabilityCatalogue": array, "investigation": object|null, "contextWarnings": [strings describing any field that was missing or malformed]}.`,
    }),
    llmNode({
      key: 'intent_classifier',
      index: 2,
      model: modelFor('intent_classifier'),
      dependsOn: 'spatial_context_builder',
      next: 'capability_resolver',
      system: `You are the Intent Classifier node of the God's Eye pipeline. Classify quickly and tersely (low reasoning effort): no analysis, no explanation beyond one sentence. ${JSON_ONLY}`,
      task: `PIPELINE STATE (output of the previous node):\n{spatial_context_builder}\n\nClassify the user query against the spatial context. Return exactly: {"intent": one of "anomaly_scan" | "entity_lookup" | "area_summary" | "navigate" | "layer_control" | "temporal_query" | "compare" | "explain" | "other", "confidence": number 0-1, "tier": "ASK" | "INVESTIGATE" | "DEEP" (ASK = one fact or one navigation step; INVESTIGATE = needs cross-layer reasoning or an external capability; DEEP = multi-step investigation with evidence chains), "focus": {"entityIds": [ids from visibleEntities that the query is about, or []], "layers": [layer ids the query concerns], "timeWindow": {"start": ISO|null, "end": ISO|null}}, "needsExternalData": boolean, "rationale": one short sentence, "state": <the PIPELINE STATE object copied through unchanged>}.`,
    }),
    llmNode({
      key: 'capability_resolver',
      index: 3,
      model: modelFor('capability_resolver'),
      dependsOn: 'intent_classifier',
      next: 'planner',
      system: `You are the Capability Resolver node of the God's Eye pipeline. You choose capabilities ONLY from the capability catalogue carried in the input; you never invent a capability, tool, route or parameter name. ${JSON_ONLY}`,
      task: `CLASSIFIED STATE (output of the previous node):\n{intent_classifier}\n\nRead state.capabilityCatalogue (each entry: id, ondemand_tool, route, provider, coverage, description, params[]). Select every capability whose description serves the intent and the active layers (for an anomaly scan over an airport with the earthquakes layer active, seismic context within a few hundred km over the last 30 days is relevant). For each selected capability build "params" using ONLY names listed in that entry's params[]; derive geographic values from state.spatialContext.center / visibleBounds and time values from state.spatialContext.timeline.now.\nReturn exactly: {"selectedCapabilityIds": [ids], "calls": [{"capabilityId": id, "ondemandTool": string, "route": string, "params": object, "purpose": one short sentence}], "unmetNeeds": [short strings for data the query needs but no catalogued capability provides], "intent": <intent object from the input without its state>, "state": <state copied through unchanged>}.`,
    }),
    llmNode({
      key: 'planner',
      index: 4,
      model: modelFor('planner'),
      dependsOn: 'capability_resolver',
      next: 'verification',
      system: `You are the Planner node of the God's Eye pipeline. You produce an evidence-first analysis plan and the candidate findings that the in-view data already supports. Distinguish OBSERVED facts (present in visibleEntities / derived) from INFERENCES and from UNKNOWNS. ${JSON_ONLY}`,
      task: `RESOLVED STATE (output of the previous node):\n{capability_resolver}\n\nUsing state.spatialContext, state.derived, intent and calls, produce: "steps": ordered list of {"id": "s1"…, "kind": "observe"|"call_capability"|"compare"|"infer"|"present", "description": short, "usesCapabilityId": id|null, "inputs": [entity ids or field names]}; "candidateFindings": [{"id": "f1"…, "claim": one sentence, "kind": "observed"|"inferred", "supportingEntityIds": [ids], "supportingFields": [field paths], "severity": "info"|"notable"|"high"}] — an emergency squawk (7500/7600/7700) on an airborne aircraft, an aircraft moving fast while onGround, a vessel under way inside an airport approach corridor, or a recent M≥4 earthquake within the view radius are all at least "notable"; "assumptions": [short strings]; "unknowns": [short strings, including every capability call whose result is not available inside this workflow run].\nReturn exactly: {"plan": {"steps": [...], "candidateFindings": [...], "assumptions": [...], "unknowns": [...]}, "calls": <copied>, "intent": <copied>, "state": <state copied through unchanged>}.`,
    }),
    llmNode({
      key: 'verification',
      index: 5,
      model: modelFor('verification'),
      dependsOn: 'planner',
      next: 'spatial_action_planner',
      system: `You are the Verification node of the God's Eye pipeline. You are adversarial: re-check every candidate finding against the raw spatialContext fields and reject anything not literally supported by the input. ${JSON_ONLY}`,
      task: `PLANNED STATE (output of the previous node):\n{planner}\n\nFor each plan.candidateFindings entry: locate the supporting entity/field values in state.spatialContext; mark "verified" only if every supporting value exists and the claim follows from it; "unverified" if support is partial; "rejected" if contradicted or unsupported. Downgrade any severity that is not justified. Add "evidence": [{"findingId": id, "entityId": id|null, "field": path, "value": the literal value, "sourceLayer": layerId|null}] with one entry per supporting value actually found.\nReturn exactly: {"findings": [{"id","claim","kind","status": "verified"|"unverified"|"rejected","severity","supportingEntityIds","note": short}], "evidence": [...], "unknowns": <plan.unknowns plus anything new>, "calls": <copied>, "intent": <copied>, "state": <state copied through unchanged>}.`,
    }),
    llmNode({
      key: 'spatial_action_planner',
      index: 6,
      model: modelFor('spatial_action_planner'),
      dependsOn: 'verification',
      next: 'synthesis',
      system: `You are the Spatial Action Planner node of the God's Eye pipeline. You emit the MapAction list the client will execute. You may ONLY use these ${actionNames.length} action names, with ONLY the parameter keys listed for each (a trailing ? marks an optional parameter; enum[...] lists the only legal values):\n${digest}\n\nAny action name or parameter key not in this list is forbidden. ${JSON_ONLY}`,
      task: `VERIFIED STATE (output of the previous node):\n{verification}\n\nPlan at most 6 actions that best present the verified findings to the analyst: e.g. fly_to_location with latitude/longitude/rangeM to frame the area of interest, track_entity for a verified anomalous entity (query = its callsign or name), set_layer_visibility to enable a layer the findings need, annotate_map to mark verified findings (each annotation an object with "type", "latitude", "longitude", "label"), analyst_query for a follow-up data question, frame_overhead to review traffic. Never emit an action for a rejected finding. Every action must be {"name": <one of the ${actionNames.length} names>, "params": {<only legal keys>}, "reason": short, "findingIds": [ids]}.\nReturn exactly: {"actions": [...], "suggestedNextActions": [{"label": short imperative, "action": {"name", "params"} | null}], "findings": <copied>, "evidence": <copied>, "unknowns": <copied>, "calls": <copied>, "intent": <copied>, "state": <state copied through unchanged>}.`,
    }),
    llmNode({
      key: 'synthesis',
      index: 7,
      model: modelFor('synthesis'),
      dependsOn: 'spatial_action_planner',
      next: 'structured_response',
      system: `You are the Synthesis node of the God's Eye pipeline — the fulfillment stage. Write the analyst-facing answer: precise, calm, operational; lead with verified findings, then unverified ones clearly labelled, then what could not be checked. Never present an inference as an observation. ${JSON_ONLY}`,
      task: `ACTION-PLANNED STATE (output of the previous node):\n{spatial_action_planner}\n\nWrite "message": 3–8 sentences of plain text (no Markdown) answering state.query for the current view; name entities by callsign/name and id; quote the literal values (squawk, altitude, speed, distance) that support each verified finding; state explicitly when a capability call (e.g. earthquake search) was planned but its data was not available inside this run. Build "entities": [{"id", "layerId", "label": callsign or name, "role": "finding"|"context", "latitude", "longitude"}] for every entity referenced in the message.\nReturn exactly: {"message": string, "entities": [...], "actions": <copied>, "suggestedNextActions": <copied>, "findings": <copied>, "evidence": <copied>, "unknowns": <copied>, "calls": <copied>, "intent": <copied>, "state": <state copied through unchanged>}.`,
    }),
    llmNode({
      key: 'structured_response',
      index: 8,
      model: modelFor('structured_response'),
      dependsOn: 'synthesis',
      next: null,
      system: `You are the StructuredResponse formatter of the God's Eye pipeline — the workflow's final output. You reshape the synthesis into the client contract. The output object must have EXACTLY these seven keys and no others: ${keys}. ${JSON_ONLY}`,
      task: `SYNTHESISED STATE (output of the previous node):\n{synthesis}\n\nReturn exactly one object with keys ${keys}:\n"message": the synthesis message unchanged;\n"entities": the synthesis entities unchanged;\n"actions": the actions list unchanged (each {"name","params","reason","findingIds"}) — drop any action whose name is not one of: ${actionNames.join(', ')};\n"evidence": the evidence list unchanged;\n"sources": [{"id": string, "kind": "in_view"|"capability", "label": e.g. "ADS-B (flights layer)", "AIS (ais-live-vessels layer)", "USGS FDSN Event (earthquake_search)", "status": "used"|"planned_not_executed"}] — one entry per distinct source layer in the evidence plus one per planned capability call;\n"suggestedNextActions": unchanged;\n"runMeta": {"workflow": "${WORKFLOW_NAME}", "flowVersion": ${WORKFLOW_VERSION}, "mode": state.mode, "intent": intent.intent, "tier": intent.tier, "confidence": intent.confidence, "selectedCapabilityIds": [ids from calls], "unknowns": <unknowns list>, "nodeChain": ${JSON.stringify(NODE_KEYS)}, "generatedAtUtc": state.spatialContext.timeline.now}.\nDo not add, rename or omit any of the seven keys.`,
    }),
  ];

  return {
    name: WORKFLOW_NAME,
    trigger: {
      type: 'webhook',
      webhook: {},
      position: { x: -520, y: 200 },
      measured: { width: 0, height: 0 },
      nextNodeKeys: ['session_context'],
    },
    nodes,
    delivery: [],
    enableMemory: false,
  };
}

/**
 * Validate a StructuredResponse against the 7-key contract and the known
 * MapAction names. Returns { ok, errors[] }.
 */
export function validateStructuredResponse(response, actionNames) {
  const errors = [];
  if (!response || typeof response !== 'object' || Array.isArray(response)) {
    return { ok: false, errors: ['response is not an object'] };
  }
  const keys = Object.keys(response);
  for (const key of STRUCTURED_RESPONSE_KEYS) {
    if (!keys.includes(key)) errors.push(`missing key: ${key}`);
  }
  for (const key of keys) {
    if (!STRUCTURED_RESPONSE_KEYS.includes(key))
      errors.push(`extra key: ${key}`);
  }
  if (typeof response.message !== 'string' || response.message.length === 0) {
    errors.push('message must be a non-empty string');
  }
  for (const listKey of [
    'entities',
    'actions',
    'evidence',
    'sources',
    'suggestedNextActions',
  ]) {
    if (!Array.isArray(response[listKey]))
      errors.push(`${listKey} must be an array`);
  }
  if (!response.runMeta || typeof response.runMeta !== 'object') {
    errors.push('runMeta must be an object');
  }
  const known = new Set(actionNames);
  if (Array.isArray(response.actions)) {
    response.actions.forEach((action, index) => {
      if (!action || typeof action.name !== 'string') {
        errors.push(`actions[${index}] has no name`);
      } else if (!known.has(action.name)) {
        errors.push(
          `actions[${index}].name "${action.name}" is not a known MapAction`,
        );
      }
    });
  }
  return { ok: errors.length === 0, errors };
}
