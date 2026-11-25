// Worker entry, started by ./decoder.js. Node loads it and its imports from
// disk, outside Vite's config bundle: no Vite aliases or virtual modules, and
// editing this file does not restart the dev server.
import { parentPort } from 'node:worker_threads';
import { serveWindDecodes } from './decode.js';

serveWindDecodes(parentPort);
