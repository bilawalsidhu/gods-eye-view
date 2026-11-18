import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const DIR = fileURLToPath(
  new URL('../../src/render/conformance/goldens/visual/', import.meta.url),
);
const NAME = /^[a-z0-9-]+\.(png|json)$/;
const MAX_BYTES = 8 * 1024 * 1024;

/**
 * Dev server only: lets `/dev/conformance/` save the visual references it
 * records into `src/render/conformance/goldens/visual/`. Takes a PUT of one
 * PNG or the manifest, named in the path; nothing else is written.
 */
export function conformanceReferencesPlugin() {
  return {
    name: 'conformance-references',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__conformance/references/', (req, res) => {
        const name = decodeURIComponent((req.url ?? '').replace(/^\//, ''));
        // Only the page on this machine: a loopback peer, sent from the
        // dev server's own origin.
        const peer = req.socket.remoteAddress ?? '';
        const loopback = /^(127\.|::1$|::ffff:127\.)/.test(peer);
        let sameOrigin = false;
        try {
          sameOrigin = new URL(req.headers.origin).host === req.headers.host;
        } catch {
          // No Origin, or not a URL.
        }
        if (!loopback || !sameOrigin) {
          res.writeHead(403).end();
          return;
        }
        if (req.method !== 'PUT' || !NAME.test(name)) {
          res.writeHead(400).end();
          return;
        }
        const chunks = [];
        let size = 0;
        req.on('data', (chunk) => {
          size += chunk.length;
          if (size > MAX_BYTES) req.destroy();
          else chunks.push(chunk);
        });
        req.on('end', async () => {
          try {
            await mkdir(DIR, { recursive: true });
            await writeFile(DIR + name, Buffer.concat(chunks));
            res.writeHead(204).end();
          } catch (error) {
            res.writeHead(500).end(String(error?.message ?? error));
          }
        });
      });
    },
  };
}
