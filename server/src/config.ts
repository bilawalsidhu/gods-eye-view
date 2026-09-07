import { resolve } from 'node:path';

export type Environment = 'development' | 'test' | 'production';

export interface RuntimeConfig {
  readonly environment: Environment;
  readonly serviceName: string;
  readonly host: string;
  readonly port: number;
  readonly logLevel: 'debug' | 'info' | 'warn' | 'error';
  readonly staticRoot: string;
  readonly requestBodyLimitBytes: number;
  readonly responseLimitBytes: number;
  readonly upstreamTimeoutMs: number;
  readonly shutdownGraceMs: number;
  readonly managedIdentityClientId?: string | undefined;
  readonly azureMapsEndpoint: string;
  readonly azureMapsClientId?: string | undefined;
  readonly foundryEndpoint?: string | undefined;
  readonly foundryRealtimeDeployment?: string | undefined;
  readonly foundryHudDeployment?: string | undefined;
  readonly aisStreamUrl: string;
  readonly aisStreamApiKey?: string | undefined;
  readonly aisStreamBoundingBoxes: readonly unknown[];
  readonly aisStreamMessageTypes: readonly string[];
  readonly aisStreamStaleMs: number;
  readonly aisStreamRecycleMs: number;
  readonly aisStreamCacheMax: number;
  readonly compatibilityModulePath?: string | undefined;
}

type Env = Readonly<Record<string, string | undefined>>;

function optional(env: Env, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

function integer(env: Env, name: string, fallback: number, min: number, max: number): number {
  const raw = optional(env, name);
  if (!raw) return fallback;

  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function oneOf<T extends string>(env: Env, name: string, values: readonly T[], fallback: T): T {
  const value = optional(env, name) ?? fallback;
  if (!values.includes(value as T)) {
    throw new Error(`${name} must be one of: ${values.join(', ')}`);
  }
  return value as T;
}

function url(env: Env, name: string, fallback?: string): string | undefined {
  const value = optional(env, name) ?? fallback;
  if (!value) return undefined;

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be an absolute URL`);
  }
  const isWebSocket = parsed.protocol === 'wss:';
  if (parsed.protocol !== 'https:' && !isWebSocket && parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1') {
    throw new Error(`${name} must use HTTPS or WSS`);
  }
  return parsed.toString().replace(/\/$/, '');
}

function jsonArray(env: Env, name: string, fallback: readonly unknown[]): readonly unknown[] {
  const raw = optional(env, name);
  if (!raw) return fallback;
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) throw new Error();
    return value;
  } catch {
    throw new Error(`${name} must be a JSON array`);
  }
}

export function loadConfig(env: Env = process.env): RuntimeConfig {
  const environment = oneOf(env, 'NODE_ENV', ['development', 'test', 'production'] as const, 'development');
  const foundryEndpoint = url(env, 'FOUNDRY_ENDPOINT');
  const foundryRealtimeDeployment = optional(env, 'FOUNDRY_REALTIME_DEPLOYMENT');
  const foundryHudDeployment = optional(env, 'FOUNDRY_HUD_DEPLOYMENT');
  if (
    Boolean(foundryEndpoint) !== Boolean(foundryRealtimeDeployment)
    || Boolean(foundryEndpoint) !== Boolean(foundryHudDeployment)
  ) {
    throw new Error(
      'FOUNDRY_ENDPOINT, FOUNDRY_REALTIME_DEPLOYMENT, and FOUNDRY_HUD_DEPLOYMENT must be configured together',
    );
  }

  return Object.freeze({
    environment,
    serviceName: optional(env, 'OTEL_SERVICE_NAME') ?? 'satview-bff',
    host: optional(env, 'HOST') ?? '0.0.0.0',
    port: optional(env, 'BFF_PORT')
      ? integer(env, 'BFF_PORT', 3000, 1, 65_535)
      : integer(env, 'PORT', 3000, 1, 65_535),
    logLevel: oneOf(env, 'LOG_LEVEL', ['debug', 'info', 'warn', 'error'] as const, 'info'),
    staticRoot: resolve(optional(env, 'STATIC_ROOT') ?? 'dist'),
    requestBodyLimitBytes: integer(env, 'REQUEST_BODY_LIMIT_BYTES', 1_048_576, 1_024, 10_485_760),
    responseLimitBytes: integer(env, 'RESPONSE_LIMIT_BYTES', 10_485_760, 1_024, 52_428_800),
    upstreamTimeoutMs: integer(env, 'UPSTREAM_TIMEOUT_MS', 10_000, 100, 60_000),
    shutdownGraceMs: integer(env, 'SHUTDOWN_GRACE_MS', 10_000, 1_000, 60_000),
    managedIdentityClientId: optional(env, 'AZURE_CLIENT_ID'),
    azureMapsEndpoint: url(env, 'AZURE_MAPS_ENDPOINT', 'https://atlas.microsoft.com')!,
    azureMapsClientId: optional(env, 'AZURE_MAPS_CLIENT_ID'),
    foundryEndpoint,
    foundryRealtimeDeployment,
    foundryHudDeployment,
    aisStreamUrl: url(env, 'AISSTREAM_URL', 'wss://stream.aisstream.io/v0/stream')!,
    aisStreamApiKey: optional(env, 'AISSTREAM_API_KEY'),
    aisStreamBoundingBoxes: jsonArray(env, 'AISSTREAM_BOUNDING_BOXES', [[[-90, -180], [90, 180]]]),
    aisStreamMessageTypes: jsonArray(env, 'AISSTREAM_MESSAGE_TYPES', [
      'PositionReport',
      'StandardClassBPositionReport',
      'ExtendedClassBPositionReport',
      'ShipStaticData',
      'StaticDataReport',
    ]).map(String),
    aisStreamStaleMs: integer(env, 'AISSTREAM_SILENCE_TIMEOUT_MS', 120_000, 1_000, 3_600_000),
    aisStreamRecycleMs: integer(env, 'AISSTREAM_RECYCLE_MS', 300_000, 5_000, 7_200_000),
    aisStreamCacheMax: integer(env, 'AISSTREAM_CACHE_MAX', 50_000, 100, 100_000),
    compatibilityModulePath: optional(env, 'COMPATIBILITY_MODULE_PATH'),
  });
}
