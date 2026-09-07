export interface AdapterContext {
  readonly correlationId: string;
  readonly signal?: AbortSignal | undefined;
}

export interface AzureMapsSearchResult {
  readonly results: readonly unknown[];
  readonly summary?: unknown;
}

export interface AzureMapsSearchOptions {
  readonly limit?: number | undefined;
  readonly language?: string | undefined;
  readonly countrySet?: string | undefined;
  readonly latitude?: number | undefined;
  readonly longitude?: number | undefined;
}

export interface AzureMapsCoordinate {
  readonly latitude: number;
  readonly longitude: number;
}

export interface AzureMapsRouteRequest {
  readonly coordinates: readonly AzureMapsCoordinate[];
  readonly travelMode?: string | undefined;
  readonly traffic?: boolean | undefined;
  readonly routeType?: string | undefined;
  readonly language?: string | undefined;
}

export interface BinaryPayload {
  readonly body: Buffer;
  readonly contentType: string;
  readonly cacheControl?: string | undefined;
}

export interface AzureMaps {
  searchAddress(query: string, options: AzureMapsSearchOptions, context: AdapterContext): Promise<AzureMapsSearchResult>;
  reverseGeocode(coordinate: AzureMapsCoordinate, language: string | undefined, context: AdapterContext): Promise<unknown>;
  route(request: AzureMapsRouteRequest, context: AdapterContext): Promise<unknown>;
  trafficStatus(): Readonly<{ configured: boolean; available: boolean; reason: null }>;
  tile(tilesetId: string, zoom: number, x: number, y: number, context: AdapterContext): Promise<BinaryPayload>;
  attribution(tilesetIds: readonly string[], bounds: string, zoom: number, context: AdapterContext): Promise<readonly string[]>;
}

export interface ChatMessage {
  readonly role: 'system' | 'user' | 'assistant';
  readonly content: string;
}

export interface FoundryCompletionRequest {
  readonly messages: readonly ChatMessage[];
  readonly maxTokens?: number | undefined;
  readonly temperature?: number | undefined;
}

export interface FoundryCompletion {
  readonly id?: string | undefined;
  readonly choices: readonly unknown[];
  readonly usage?: unknown | undefined;
}

export interface Foundry {
  complete(request: FoundryCompletionRequest, context: AdapterContext): Promise<FoundryCompletion>;
  createRealtimeClientSecret(request: RealtimeClientSecretRequest, context: AdapterContext): Promise<RealtimeClientSecret>;
  createHudSummary(request: HudSummaryRequest, context: AdapterContext): Promise<string>;
}

export interface RealtimeClientSecretRequest {
  readonly voice?: string | undefined;
  readonly instructions?: string | undefined;
  readonly modalities?: readonly string[] | undefined;
}

export interface RealtimeClientSecret {
  readonly value: string;
  readonly expiresAt: number;
  readonly endpoint: string;
  readonly deployment: string;
  readonly model: string;
}

export interface HudSummaryRequest {
  readonly prompt: string;
  readonly context?: unknown;
  readonly maxCharacters?: number | undefined;
}

export interface AisSnapshot {
  readonly rows: readonly unknown[];
  readonly source: string;
  readonly provenance: string;
  readonly status: string;
  readonly error: string | null;
  readonly refreshing: boolean;
  readonly newestPositionAt: string | null;
  readonly lastMessageAt: number | null;
  readonly silentForMs: number | null;
  readonly reconnectAttempt: number;
  readonly nextAttemptAt: number | null;
  readonly staleAfterMs: number;
  readonly watchdog: string;
}

export interface Ais {
  start(): void;
  stop(): void;
  snapshot(maxRows: number): AisSnapshot;
  track(mmsi: string): readonly unknown[];
}

export interface ServiceAdapters {
  readonly maps?: AzureMaps | undefined;
  readonly foundry?: Foundry | undefined;
  readonly ais?: Ais | undefined;
}
