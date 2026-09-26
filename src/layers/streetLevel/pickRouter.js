/**
 * Route picked primitive ids to the provider whose prefix they carry. The
 * registry guarantees prefixes never overlap, so the first match is the only
 * match.
 * @param {() => Iterable<{def: {id: string, pickPrefix: string}, instance: object}>} getProviders
 * @param {{positionId?: string}} [options]  Id of the core-owned position marker.
 */
export function createPickRouter(getProviders, { positionId = null } = {}) {
  function resolve(id) {
    if (typeof id !== 'string' || !id) return null;
    if (positionId && id === positionId)
      return { providerId: null, instance: null, id };
    for (const entry of getProviders())
      if (id.startsWith(entry.def.pickPrefix))
        return { providerId: entry.def.id, instance: entry.instance, id };
    return null;
  }
  return {
    ownsPick: (id) => resolve(id) !== null,
    resolve,
  };
}
