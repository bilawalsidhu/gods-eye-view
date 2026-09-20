import * as watchkeeping from './watchkeeping.js';
import * as prediction from './prediction.js';
import * as incidents from './incidents.js';
import * as radio from './radio.js';
import * as cameraSweep from './cameraSweep.js';
import * as speaker from './speaker.js';
import * as director from './director.js';
import * as peers from './peers.js';

/**
 * Registry of local-only tool packs. Each pack exports `schemas` (tool
 * definitions sent to the model) and `createHandlers(context)` returning
 * `{ [toolName]: async (args) => result }`.
 */
export const LOCAL_TOOL_PACKS = Object.freeze([
  watchkeeping,
  prediction,
  incidents,
  radio,
  cameraSweep,
  speaker,
  director,
  peers,
]);

export function packSchemas() {
  return LOCAL_TOOL_PACKS.flatMap((pack) => pack.schemas || []);
}

/** Per-tool result timeouts (ms) for tools that legitimately run long. */
export function packTimeouts() {
  const out = {};
  for (const pack of LOCAL_TOOL_PACKS) Object.assign(out, pack.timeouts || {});
  return out;
}

export function packHandlers(context) {
  const handlers = {};
  for (const pack of LOCAL_TOOL_PACKS)
    Object.assign(handlers, pack.createHandlers?.(context) || {});
  return handlers;
}
