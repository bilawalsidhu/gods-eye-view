import { install as installIncidents } from './incidents.js';
import { install as installRadio } from './radio.js';
import { install as installVisionBatch } from './visionBatch.js';
import { install as installSpeaker } from './speaker.js';
import { install as installPeers } from './peers.js';

/** Feature routes mounted under /api/voice/* by the ollama provider. */
export const FEATURE_ROUTES = Object.freeze([
  installIncidents,
  installRadio,
  installVisionBatch,
  installSpeaker,
  installPeers,
]);

export function installFeatureRoutes(middlewares, server) {
  for (const install of FEATURE_ROUTES) install(middlewares, server);
}
