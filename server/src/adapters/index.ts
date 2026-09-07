import type { RuntimeConfig } from '../config.js';
import { AisStreamService } from './ais.js';
import { createAzureCredential } from './azure-credential.js';
import { AzureMapsRestAdapter } from './azure-maps.js';
import type { ServiceAdapters } from './contracts.js';
import { FoundryRestAdapter } from './foundry.js';

export type {
  AzureMapsCoordinate,
  AzureMapsRouteRequest,
  AzureMapsSearchOptions,
  BinaryPayload,
  Ais,
  AisSnapshot,
  AdapterContext,
  AzureMaps,
  AzureMapsSearchResult,
  ChatMessage,
  Foundry,
  FoundryCompletion,
  FoundryCompletionRequest,
  HudSummaryRequest,
  RealtimeClientSecret,
  RealtimeClientSecretRequest,
  ServiceAdapters,
} from './contracts.js';

export function createServiceAdapters(config: RuntimeConfig): ServiceAdapters {
  const credential = createAzureCredential(config.managedIdentityClientId);
  return {
    maps: config.azureMapsClientId ? new AzureMapsRestAdapter(config, credential) : undefined,
    foundry: config.foundryEndpoint ? new FoundryRestAdapter(config, credential) : undefined,
    ais: new AisStreamService(config),
  };
}
