/**
 * server/ondemand/camera-chat-config.js — server-side defaults for the
 * CAMERA chat profile (ASK ONDEMAND on a live street camera; see
 * docs/ONDEMAND_CAMERA_CHAT_ADDENDUM_2026-09-21.md).
 *
 * Every value here is NON-SECRET configuration read from the environment at
 * module load (same "read once" discipline as config.js) and may be echoed
 * by the health endpoint. The API key never lives here.
 *
 * Env (canonical name → default → evidence):
 *   ONDEMAND_CAMERA_CHAT_ENDPOINT_ID        'predefined-cerebras-qwen-3.8-27b'
 *       text-only turns. LIVE-verified Cerebras endpoint from the quick-fire
 *       contract (docs/ONDEMAND_QUICKFIRE_CHAT_CONTRACT_2026-09-19.md §0/§d);
 *       NOT in the docs' predefined table (docs/fulfillment-models, 18 rows,
 *       updatedAt 2026-08-24) — that is why it is overridable here.
 *   ONDEMAND_CAMERA_CHAT_VISION_ENDPOINT_ID  '' (→ same as the text endpoint)
 *       turns that carry an attached camera frame. The live docs publish NO
 *       per-model vision/multimodal statement (fulfillment-models page,
 *       2026-09-21 read: 0 hits for "vision"/"multimodal"), so no endpoint is
 *       hardcoded as "vision"; image understanding travels the DOCUMENTED path
 *       instead — the frame is uploaded through the Media API with the image
 *       agent and attached to the session (`sessionId`), and its extracted
 *       context is what the fulfillment model reads. Set this when a
 *       multimodal endpoint is confirmed for the account.
 *   ONDEMAND_CAMERA_CHAT_PLUGIN_IDS          'agent-1713924030'
 *       comma-separated `pluginIds` sent on every camera turn so answers can
 *       pull live web context. `agent-1713924030` is the "Internet Agent"
 *       (identifier `internet`) shown in the docs' stream sample
 *       (docs/query-and-responses-modes, statusLog retrievedAgents); the docs
 *       publish no other web-search agent id. Set to '' to disable.
 *   ONDEMAND_CAMERA_CHAT_REASONING_MODE      'low'
 *       stream-only `reasoningMode` (docs/chat-api: "e.g., low, high",
 *       "Relevant only for responseMode: stream"). Must be one of
 *       DOCUMENTED_REASONING_MODES; an invalid value falls back to 'low'.
 *   ONDEMAND_CAMERA_CHAT_IMAGE_PLUGIN_ID     'plugin-1713958591'
 *       the Media API `plugins` entry for png/jpg/jpeg uploads — the image
 *       sample in docs/media-api uses exactly this id.
 *   ONDEMAND_CAMERA_CHAT_HISTORY_LIMIT       '20' (1..50)
 *       page size for the cursor-paginated history reload
 *       (GET /chat/v1/sessions/{sessionId}/messages: limit 1..50, default 10).
 */
import { DOCUMENTED_REASONING_MODES } from './config.js';

export const CAMERA_CHAT_ENV = Object.freeze({
  endpointId: 'ONDEMAND_CAMERA_CHAT_ENDPOINT_ID',
  visionEndpointId: 'ONDEMAND_CAMERA_CHAT_VISION_ENDPOINT_ID',
  pluginIds: 'ONDEMAND_CAMERA_CHAT_PLUGIN_IDS',
  reasoningMode: 'ONDEMAND_CAMERA_CHAT_REASONING_MODE',
  imagePluginId: 'ONDEMAND_CAMERA_CHAT_IMAGE_PLUGIN_ID',
  historyLimit: 'ONDEMAND_CAMERA_CHAT_HISTORY_LIMIT',
});

export const CAMERA_CHAT_DEFAULTS = Object.freeze({
  endpointId: 'predefined-cerebras-qwen-3.8-27b',
  visionEndpointId: '',
  pluginIds: Object.freeze(['agent-1713924030']),
  reasoningMode: 'low',
  imagePluginId: 'plugin-1713958591',
  historyLimit: 20,
});

/** The camera profile name the chat proxy accepts in `profile`. */
export const CAMERA_PROFILE = 'camera';
const MAX_PLUGIN_IDS = 20;
const PLUGIN_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ENDPOINT_ID = /^[A-Za-z0-9][A-Za-z0-9._\/-]{0,127}$/;

function readEnv(name) {
  const raw = process.env[name];
  return typeof raw === 'string' ? raw.trim() : '';
}

/** Parse a comma-separated plugin list; drops blanks and malformed ids. */
export function parsePluginIds(raw) {
  if (typeof raw !== 'string') return [];
  const out = [];
  for (const part of raw.split(',')) {
    const id = part.trim();
    if (id && PLUGIN_ID.test(id) && !out.includes(id)) out.push(id);
    if (out.length >= MAX_PLUGIN_IDS) break;
  }
  return out;
}

function computeCameraChatConfig() {
  const endpointRaw = readEnv(CAMERA_CHAT_ENV.endpointId);
  const endpointId = ENDPOINT_ID.test(endpointRaw)
    ? endpointRaw
    : CAMERA_CHAT_DEFAULTS.endpointId;
  const visionRaw = readEnv(CAMERA_CHAT_ENV.visionEndpointId);
  const visionEndpointId = ENDPOINT_ID.test(visionRaw) ? visionRaw : '';
  const pluginsRaw = process.env[CAMERA_CHAT_ENV.pluginIds];
  const pluginIds =
    pluginsRaw === undefined
      ? [...CAMERA_CHAT_DEFAULTS.pluginIds]
      : parsePluginIds(pluginsRaw);
  const modeRaw = readEnv(CAMERA_CHAT_ENV.reasoningMode);
  const reasoningModeInvalid = Boolean(
    modeRaw && !DOCUMENTED_REASONING_MODES.includes(modeRaw),
  );
  const reasoningMode =
    modeRaw && !reasoningModeInvalid
      ? modeRaw
      : CAMERA_CHAT_DEFAULTS.reasoningMode;
  const imageRaw = readEnv(CAMERA_CHAT_ENV.imagePluginId);
  const imagePluginId = PLUGIN_ID.test(imageRaw)
    ? imageRaw
    : CAMERA_CHAT_DEFAULTS.imagePluginId;
  const limitRaw = Number.parseInt(readEnv(CAMERA_CHAT_ENV.historyLimit), 10);
  const historyLimit =
    Number.isInteger(limitRaw) && limitRaw >= 1 && limitRaw <= 50
      ? limitRaw
      : CAMERA_CHAT_DEFAULTS.historyLimit;
  return Object.freeze({
    profile: CAMERA_PROFILE,
    endpointId,
    visionEndpointId: visionEndpointId || endpointId,
    visionEndpointSource: visionEndpointId ? 'env' : 'text-endpoint',
    pluginIds: Object.freeze(pluginIds),
    reasoningMode,
    reasoningModeInvalid,
    imagePluginId,
    historyLimit,
    sources: Object.freeze({
      endpointId: endpointRaw ? CAMERA_CHAT_ENV.endpointId : 'default',
      visionEndpointId: visionEndpointId
        ? CAMERA_CHAT_ENV.visionEndpointId
        : 'default',
      pluginIds:
        pluginsRaw === undefined ? 'default' : CAMERA_CHAT_ENV.pluginIds,
      reasoningMode:
        modeRaw && !reasoningModeInvalid
          ? CAMERA_CHAT_ENV.reasoningMode
          : 'default',
      imagePluginId: imageRaw ? CAMERA_CHAT_ENV.imagePluginId : 'default',
      historyLimit: Number.isInteger(limitRaw)
        ? CAMERA_CHAT_ENV.historyLimit
        : 'default',
    }),
  });
}

let state = computeCameraChatConfig();

/** Live view (getters) so the test reload is visible to importers. */
export function cameraChatConfig() {
  return state;
}

/**
 * Non-secret block the health endpoint publishes so the browser can build
 * its Media API form (image plugin id) and show which defaults apply.
 * Contains ids and mode names only — never a key.
 */
export function cameraChatPublicConfig() {
  return {
    profile: state.profile,
    endpointId: state.endpointId,
    visionEndpointId: state.visionEndpointId,
    visionEndpointSource: state.visionEndpointSource,
    pluginIds: [...state.pluginIds],
    reasoningMode: state.reasoningMode,
    reasoningModeInvalid: state.reasoningModeInvalid,
    imagePluginId: state.imagePluginId,
    historyLimit: state.historyLimit,
    env: { ...CAMERA_CHAT_ENV },
    sources: { ...state.sources },
  };
}

/**
 * Apply the camera-profile defaults to an outgoing query body. Explicit
 * request values always win; defaults fill only what the body omitted.
 * @param {{ endpointId?: string, pluginIds?: string[], reasoningMode?: string, responseMode?: string }} body
 * @param {{ hasAttachment?: boolean }} [options]
 * @returns {{ endpointId: string, pluginIds: string[]|undefined, reasoningMode: string|undefined, applied: string[] }}
 */
export function applyCameraProfile(body, { hasAttachment = false } = {}) {
  const applied = [];
  let { endpointId, pluginIds, reasoningMode } = body;
  if (endpointId === undefined) {
    endpointId = hasAttachment ? state.visionEndpointId : state.endpointId;
    applied.push(hasAttachment ? 'visionEndpointId' : 'endpointId');
  }
  if (pluginIds === undefined && state.pluginIds.length > 0) {
    pluginIds = [...state.pluginIds];
    applied.push('pluginIds');
  }
  if (reasoningMode === undefined && body.responseMode === 'stream') {
    reasoningMode = state.reasoningMode;
    applied.push('reasoningMode');
  }
  return { endpointId, pluginIds, reasoningMode, applied };
}

/** TEST-ONLY: re-read process.env. */
export function __reloadCameraChatConfigForTests() {
  state = computeCameraChatConfig();
}
