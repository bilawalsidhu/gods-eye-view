import { readShareAlerts, writeShareAlerts } from '../peerFrames.js';

/**
 * Peer federation tool pack: talk to the other God's Eye View globes this
 * instance is federated with (GEV_PEERS; server/providers/ollama/peers.js,
 * docs/FEDERATION.md). Places travel through POST /api/voice/peers; the
 * share-alerts switch is a per-browser preference (peerFrames.js).
 */
export const PEERS_ROUTE = '/api/voice/peers';

export const schemas = [
  {
    name: 'peers_list',
    description:
      'List the other God\'s Eye View globes federated with this one ("which other globes are connected", "is the office globe online") and whether each is connected.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
  },
  {
    name: 'share_place',
    description:
      'Send one of the user\'s saved places to every federated globe ("share home with the other globe", "send the marina to the office"). The place must already exist from remember_place; use list_saved_places if unsure of the name.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        name: {
          type: 'string',
          description: 'Name of a saved place, as spoken.',
        },
      },
      required: ['name'],
    },
  },
  {
    name: 'share_alerts',
    description:
      'Turn sharing of this globe\'s spoken alerts with the federated globes on or off ("stop sharing my alerts", "share alerts again").',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        enabled: { type: 'boolean', description: 'true to share alerts.' },
      },
      required: ['enabled'],
    },
  },
];

export function createHandlers({ memory, fetchJson, storage } = {}) {
  return {
    async peers_list() {
      const data = await fetchJson(PEERS_ROUTE);
      const peers = Array.isArray(data?.peers) ? data.peers : [];
      const connected = peers.filter((peer) => peer.connected);
      return {
        ok: true,
        me: data?.name ?? null,
        count: peers.length,
        connected: connected.length,
        peers: peers.map(({ name, url, connected }) => ({
          name,
          url,
          connected: Boolean(connected),
        })),
        summary: peers.length
          ? peers
              .map(
                (p) => `${p.name} (${p.connected ? 'connected' : 'offline'})`,
              )
              .join(', ')
          : 'No peer globes are configured (GEV_PEERS is empty).',
      };
    },
    async share_place({ name } = {}) {
      const place = memory?.recallPlace?.(name);
      if (!place)
        return {
          ok: false,
          error: `No saved place named "${name}". Save it with remember_place first.`,
        };
      const { name: label, lat, lon, alt, heading, pitch, roll } = place;
      const data = await fetchJson(PEERS_ROUTE, {
        op: 'share_place',
        place: { name: label, lat, lon, alt, heading, pitch, roll },
      });
      const sent = Array.isArray(data?.sent) ? data.sent : [];
      return {
        ok: Boolean(data?.ok),
        name: label,
        sent,
        peers: data?.peers ?? 0,
        summary: sent.length
          ? `Sent "${label}" to ${sent.join(', ')}.`
          : `No peer globe is connected right now; "${label}" was not sent.`,
      };
    },
    async share_alerts({ enabled } = {}) {
      const next = enabled !== false;
      const persisted = writeShareAlerts(next, storage);
      return { ok: true, enabled: readShareAlerts(storage), persisted };
    },
  };
}
