import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import fastifyStatic from '@fastify/static';
import helmet from '@fastify/helmet';
import Fastify, { type FastifyInstance } from 'fastify';
import type { ServiceAdapters } from './adapters/index.js';
import type { CompatibilityBridge } from './compatibility.js';
import { registerCompatibilityRoutes } from './compatibility.js';
import type { RuntimeConfig } from './config.js';
import { asProblem, HttpProblem } from './errors.js';
import { ReadinessState } from './readiness.js';
import { registerApiRoutes } from './routes/api.js';

const correlationPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export interface AppOptions {
  readonly config: RuntimeConfig;
  readonly adapters: ServiceAdapters;
  readonly readiness: ReadinessState;
  readonly compatibilityBridge?: CompatibilityBridge | undefined;
}

export async function buildApp(options: AppOptions): Promise<FastifyInstance> {
  const { config, adapters, readiness, compatibilityBridge } = options;
  const app = Fastify({
    bodyLimit: config.requestBodyLimitBytes,
    logger: {
      level: config.logLevel,
      base: { service: config.serviceName },
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'req.headers["x-ms-token-aad-access-token"]',
          'res.headers["set-cookie"]',
        ],
        censor: '[REDACTED]',
      },
    },
    genReqId: (request) => {
      const incoming = request.headers['x-correlation-id'];
      return typeof incoming === 'string' && correlationPattern.test(incoming) ? incoming : randomUUID();
    },
    requestIdHeader: 'x-correlation-id',
  });

  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (_request, body, done) => done(null, body),
  );

  await app.register(helmet, {
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
  });

  app.addHook('onRequest', async (request, reply) => {
    reply.header('x-correlation-id', request.id);
  });

  app.addHook('onClose', async () => {
    adapters.ais?.stop();
  });

  app.addHook('onSend', async (request, reply, payload) => {
    if (!request.raw.url?.startsWith('/api/')) return payload;
    const contentLength = Number(reply.getHeader('content-length'));
    const actualLength = typeof payload === 'string'
      ? Buffer.byteLength(payload)
      : Buffer.isBuffer(payload) ? payload.byteLength : 0;
    if (
      (Number.isFinite(contentLength) && contentLength > config.responseLimitBytes)
      || actualLength > config.responseLimitBytes
    ) {
      throw new HttpProblem(500, 'Response Too Large', 'The response exceeds the configured limit.');
    }
    return payload;
  });

  app.setErrorHandler((error, request, reply) => {
    const normalizedError = error instanceof Error ? error : new Error('Unknown error');
    const problem = asProblem(normalizedError, request.raw.url ?? request.url, request.id);
    if (problem.status >= 500) {
      request.log.error({ err: error, status: problem.status }, 'request failed');
    } else {
      request.log.warn({ err: error, status: problem.status }, 'request rejected');
    }
    void reply
      .code(problem.status)
      .type('application/problem+json')
      .send(problem);
  });

  app.get('/health/live', async () => ({ status: 'ok' }));
  app.get('/health/ready', async (_request, reply) => {
    const state = readiness.snapshot();
    if (!state.ready) reply.code(503);
    return { status: state.ready ? 'ready' : 'not-ready', reason: state.reason };
  });

  await registerApiRoutes(app, adapters);
  await registerCompatibilityRoutes(app, compatibilityBridge);

  const hasStaticFiles = existsSync(join(config.staticRoot, 'index.html'));
  if (hasStaticFiles) {
    await app.register(fastifyStatic, {
      root: config.staticRoot,
      prefix: '/',
      wildcard: false,
      index: false,
      maxAge: config.environment === 'production' ? '1h' : 0,
      immutable: false,
    });
  } else if (config.environment === 'production') {
    throw new Error(`Static build not found at ${config.staticRoot}`);
  }

  app.setNotFoundHandler((request, reply) => {
    if (request.raw.url?.startsWith('/api/')) {
      throw new HttpProblem(404, 'Not Found', 'The requested API route does not exist.');
    }
    if (hasStaticFiles && request.method === 'GET' && request.headers.accept?.includes('text/html')) {
      return reply.type('text/html').sendFile('index.html');
    }
    throw new HttpProblem(404, 'Not Found', 'The requested resource does not exist.');
  });

  await app.ready();
  readiness.markReady();
  return app;
}
