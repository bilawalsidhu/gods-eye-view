/**
 * A transit vehicle's identity, which is two fields rather than one.
 *
 * Every other mover in this app has a global identifier to key on: an aircraft its ICAO 24-bit
 * address, a vessel its MMSI, a satellite its NORAD catalogue number. A GTFS-realtime entity id
 * is unique only inside the feed that published it, so two agencies can each run a vehicle "1"
 * and keying on the id alone lets one operator's bus overwrite another's.
 *
 * **Here rather than in the layer, because it is a domain fact and not a rendering one.** It
 * lived in `globe/layers/transit.ts`, which pulls Cesium in with it, and `net/ws.ts` needs the
 * same string to key a removal off the socket. Importing the layer from the socket client would
 * have made transport depend on a renderer, and a socket client that cannot be reasoned about
 * without a WebGL context is one nobody can test in isolation. Layers may depend on transport;
 * transport must not depend on a layer. Both now depend on this instead.
 *
 * **The separator is a tab and that is load-bearing.** Written with a colon it collapses two
 * distinct vehicles into one key: `feed_id` "a" with `entity_id` "b:c" and `feed_id` "a:b" with
 * `entity_id` "c" both render as `a:b:c`. A feed id or an entity id can plausibly contain a
 * colon; neither can contain a tab. Getting it wrong is silent rather than loud, because a
 * removal off the socket would simply never match a slot on the globe, every removal would miss,
 * and the layer would accumulate vehicles for the life of the tab with nothing erroring.
 */

import type { TransitVehicle } from '../types/entities';

/**
 * Feed and entity joined, which is what identifies one vehicle.
 *
 * Takes the two fields rather than a whole record, so a removal that arrives as a bare pair of
 * strings can be keyed without inventing the rest of a vehicle to hold them.
 */
export function transitKey(vehicle: Pick<TransitVehicle, 'feed_id' | 'entity_id'>): string {
  return `${vehicle.feed_id}\t${vehicle.entity_id}`;
}
