/**
 * The satellite propagation worker. Eleven lines of shell around `handleRequest`.
 *
 * SGP4 for a thousand-plus objects runs here rather than on the main thread because the
 * main thread has to hold 60fps while drawing them. Measured on this laptop: 3.5 ms per
 * tick for 1,000 objects and 14 ms for 10,000, which is a frame budget the renderer would
 * otherwise be paying.
 *
 * All the behaviour is in `orbit.ts` so it can be tested in the node runner. Nothing is
 * decided in this file.
 */

import { SatelliteEngine, handleRequest, transferables } from './orbit';
import type { EngineRequest } from './orbit';

/**
 * The bit of the worker global this file uses.
 *
 * `lib.dom` types `self` as a `Window`, whose `postMessage` demands a target origin, so the
 * real shape is named here rather than adding `lib.webworker` to a tsconfig that also has to
 * describe the main thread.
 */
interface WorkerScope {
  addEventListener(type: 'message', listener: (event: MessageEvent<EngineRequest>) => void): void;
  postMessage(message: unknown, transfer: Transferable[]): void;
}

const scope = self as unknown as WorkerScope;
const engine = new SatelliteEngine();

scope.addEventListener('message', (event) => {
  const reply = handleRequest(engine, event.data);
  scope.postMessage(reply, transferables(reply));
});
