import http from 'node:http';
import { defineConfig } from 'vite';
import { standaloneConfig } from './server/standalone/vite.config.js';
// Preserve existing test and tooling imports while provider modules are split.
export * from './server/providers/local.js';

// PROTOTYPE ONLY: passes /proto-rec/* to the local flight recording.
const protoRecording = {
  name: 'proto-recording',
  configureServer(server) {
    server.middlewares.use('/proto-rec', (req, res) => {
      const pass = http.request(
        { host: '127.0.0.1', port: 5199, path: req.url, method: 'GET' },
        (answer) => {
          res.writeHead(answer.statusCode, answer.headers);
          answer.pipe(res);
        },
      );
      pass.on('error', () => {
        res.statusCode = 502;
        res.end('{}');
      });
      pass.end();
    });
  },
};

export default defineConfig(async (env) => {
  const config = await standaloneConfig(env);
  config.plugins = [protoRecording, ...(config.plugins ?? [])];
  return config;
});
