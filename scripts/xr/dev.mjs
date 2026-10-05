import { readFile } from 'node:fs/promises';
import { createServer } from 'vite';

const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
};
const cert = option('--cert'),
  key = option('--key');
if (Boolean(cert) !== Boolean(key))
  throw new Error('Supply both --cert and --key for HTTPS.');
const https = cert
  ? { cert: await readFile(cert), key: await readFile(key) }
  : undefined;
const port = Number(option('--port') || 4173);
const server = await createServer({
  // The XR launcher can run beside the console's ordinary development server.
  // Independent optimizer caches prevent stale dependency URLs on either port.
  cacheDir: 'node_modules/.vite-xr',
  server: {
    host: '0.0.0.0',
    port,
    strictPort: true,
    ...(https ? { https } : {}),
  },
});
await server.listen();
server.printUrls();
console.log(
  https
    ? 'Headset access: use the LAN HTTPS URL and a certificate trusted by the device.'
    : 'Desktop / local XR preview. Headsets need HTTPS: pass --cert <certificate.pem> --key <key.pem>.',
);
for (const signal of ['SIGINT', 'SIGTERM'])
  process.once(signal, async () => {
    await server.close();
    process.exit(0);
  });
