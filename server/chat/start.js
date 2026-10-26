import { readFile } from 'node:fs/promises';
import { createServer } from 'node:https';
import { pathToFileURL } from 'node:url';
import { installChatSignaling } from './signaling.js';

function requiredEnv(name, env) {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} must be configured`);
  return value;
}

export async function startChatSignalingServer(env = process.env) {
  const certPath = env.GEV_CHAT_TLS_CERT_FILE?.trim();
  const keyPath = env.GEV_CHAT_TLS_KEY_FILE?.trim();
  if (!certPath || !keyPath) {
    throw new Error(
      'Set GEV_CHAT_TLS_CERT_FILE and GEV_CHAT_TLS_KEY_FILE to enable secure chat',
    );
  }
  const allowedOrigins = requiredEnv('GEV_CHAT_ALLOWED_ORIGINS', env)
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  const [cert, key] = await Promise.all([
    readFile(certPath),
    readFile(keyPath),
  ]);
  const server = createServer({ cert, key });
  const signaling = installChatSignaling(server, { allowedOrigins });
  const host = env.GEV_CHAT_HOST?.trim() || '127.0.0.1';
  const port = Number(env.GEV_CHAT_PORT || 4174);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new RangeError('GEV_CHAT_PORT must be between 1 and 65535');
  }
  await new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });

  const address = server.address();
  console.info(
    `[chat] secure signaling listening on ${host}:${address.port}/chat/signal`,
  );
  return {
    close() {
      signaling.close();
      return new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
    server,
    signaling,
  };
}

async function main() {
  const service = await startChatSignalingServer();
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await service.close();
    process.exitCode = 0;
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(`[chat] ${error.message}`);
    process.exitCode = 1;
  });
}
