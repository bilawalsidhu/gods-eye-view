import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { RuntimeConfig } from './config.js';
import { HttpProblem } from './errors.js';

const forbiddenResponseHeaders = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'set-cookie',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

export interface CompatibilityRequest {
  readonly contractId: string;
  readonly method: string;
  readonly url: string;
  readonly query: Readonly<Record<string, unknown>>;
  readonly params: Readonly<Record<string, unknown>>;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly body: unknown;
  readonly correlationId: string;
  readonly remoteAddress: string;
  readonly signal: AbortSignal;
}

export interface CompatibilityResponse {
  readonly status: number;
  readonly headers?: Readonly<Record<string, string>> | undefined;
  readonly body?: unknown;
}

export interface CompatibilityBridge {
  handle(request: CompatibilityRequest): Promise<CompatibilityResponse>;
  close?(): Promise<void> | void;
}

export const COMPATIBILITY_ROUTE_CONTRACTS = Object.freeze([
  { id: 'celestrak', method: 'GET', url: '/api/celestrak/*' },
  { id: 'tomtom-status', method: 'GET', url: '/api/tomtom/status' },
  { id: 'tomtom-flow', method: 'GET', url: '/api/tomtom/flow/*' },
  { id: 'firms', method: 'GET', url: '/api/firms' },
  { id: 'firms-status', method: 'GET', url: '/api/firms/status' },
  { id: 'terrain-heights', method: 'GET', url: '/api/terrain/heights' },
  { id: 'adsbdb', method: 'GET', url: '/api/adsbdb/*' },
  { id: 'overpass', method: 'POST', url: '/api/overpass' },
  { id: 'route', method: 'GET', url: '/api/route' },
  { id: 'opensky', method: 'GET', url: '/api/opensky' },
  { id: 'opensky-track', method: 'GET', url: '/api/opensky-track' },
  { id: 'adsblol-military', method: 'GET', url: '/api/adsblol/mil' },
  { id: 'adsblol-trace', method: 'GET', url: '/api/adsblol/trace' },
  { id: 'cctv', method: 'GET', url: '/api/cctv/*' },
  { id: 'military-installations', method: 'GET', url: '/api/military-installations' },
  { id: 'regional-brief', method: 'GET', url: '/api/regional-brief' },
  { id: 'weather-effects', method: 'GET', url: '/api/weather-effects' },
] as const);

class MissingCompatibilityBridge implements CompatibilityBridge {
  async handle(request: CompatibilityRequest): Promise<CompatibilityResponse> {
    throw new HttpProblem(
      501,
      'Not Implemented',
      `Production compatibility handler "${request.contractId}" is not mounted.`,
    );
  }
}

export async function loadCompatibilityBridge(config: RuntimeConfig): Promise<CompatibilityBridge> {
  if (!config.compatibilityModulePath) {
    if (config.environment === 'production') {
      throw new Error(
        'COMPATIBILITY_MODULE_PATH is required in production so retained Vite API routes are not lost.',
      );
    }
    return new MissingCompatibilityBridge();
  }

  const moduleUrl = pathToFileURL(resolve(config.compatibilityModulePath)).href;
  const loaded = await import(moduleUrl) as {
    createCompatibilityBridge?: (config: RuntimeConfig) => Promise<CompatibilityBridge> | CompatibilityBridge;
  };
  if (typeof loaded.createCompatibilityBridge !== 'function') {
    throw new Error('Compatibility module must export createCompatibilityBridge(config).');
  }
  const bridge = await loaded.createCompatibilityBridge(config);
  if (!bridge || typeof bridge.handle !== 'function') {
    throw new Error('Compatibility module returned an invalid bridge.');
  }
  return bridge;
}

export async function registerCompatibilityRoutes(
  app: FastifyInstance,
  bridge: CompatibilityBridge = new MissingCompatibilityBridge(),
): Promise<void> {
  for (const contract of COMPATIBILITY_ROUTE_CONTRACTS) {
    app.route({
      method: contract.method,
      url: contract.url,
      handler: async (request: FastifyRequest, reply) => {
        const controller = new AbortController();
        request.raw.once('aborted', () => controller.abort());
        const result = await bridge.handle({
          contractId: contract.id,
          method: request.method,
          url: request.url,
          query: request.query as Readonly<Record<string, unknown>>,
          params: request.params as Readonly<Record<string, unknown>>,
          headers: request.headers,
          body: request.body,
          correlationId: request.id,
          remoteAddress: request.ip,
          signal: controller.signal,
        });
        reply.code(result.status);
        for (const [name, value] of Object.entries(result.headers ?? {})) {
          if (!forbiddenResponseHeaders.has(name.toLowerCase())) {
            reply.header(name, value);
          }
        }
        return reply.send(result.body);
      },
    });
  }
}
