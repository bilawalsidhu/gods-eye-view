// Worker-thread entry for the wind provider, started by ./decoder.js. Node
// loads this file from disk, so it may only import files that ship beside it.
import { parentPort } from 'node:worker_threads';
import { serveWindDecodes } from './decode.js';

serveWindDecodes(parentPort);
