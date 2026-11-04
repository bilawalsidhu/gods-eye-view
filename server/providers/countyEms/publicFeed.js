import { readResponseBytesCapped } from '../common/http.js';

/** Read a fixed public source with a deadline, body cap and no redirects. */
export async function readPublicText(fetchImpl, url, cap = 1024000) {
  const signal = AbortSignal.timeout(10000);
  const response = await fetchImpl(url, { signal, redirect: 'error' });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error('County source unavailable');
  }
  return new TextDecoder().decode(
    await readResponseBytesCapped(response, cap, signal),
  );
}

/** Shared on-demand source reads retain only a bounded last-good snapshot. */
export function createCachedCountyFeed({
  load,
  now = Date.now,
  ttl = 120000,
  staleAfter = 720000,
  unavailable,
}) {
  let cached,
    pending,
    failed = false,
    lastAttempt = -Infinity;
  const result = () => {
    if (!cached) throw new Error(unavailable);
    return {
      ...cached,
      stale:
        failed ||
        now() - cached.observedAt > staleAfter ||
        cached.observedAt > now() + 60000,
    };
  };
  return async () => {
    if (pending) return pending;
    if (now() - lastAttempt < ttl) return result();
    lastAttempt = now();
    pending = (async () => {
      try {
        cached = { ...(await load()), fetchedAt: now() };
        failed = false;
      } catch {
        failed = true;
      }
      return result();
    })();
    try {
      return await pending;
    } finally {
      pending = null;
    }
  };
}

/** These sources publish assigned units, not time-stamped unit movements. */
export function createAssignmentDetails({ getSnapshot }) {
  return async (id) => {
    const snapshot = await getSnapshot();
    const row = snapshot.rows.find((row) => row.id === id);
    if (!row)
      throw Object.assign(new Error('Incident is no longer listed'), {
        statusCode: 404,
      });
    return {
      id,
      incidentNumber: row.incidentNumber || null,
      observedAt: snapshot.fetchedAt,
      fetchedAt: snapshot.fetchedAt,
      timestampBasis: 'retrieved',
      sourceObservedAt: snapshot.observedAt,
      assignmentOnly: true,
      stale: !!snapshot.stale,
      sourceUrl: row.detailUrl,
      units: (row.assignedUnits || []).map((unit) => ({
        unit,
        status: 'Assigned',
        entered: '',
        enteredAt: null,
      })),
    };
  };
}

/** Decode upstream text into data only, without forwarding executable markup. */
export function publicText(html) {
  return String(html)
    .replace(/<[^>]*>/g, ' ')
    .replace(
      /&(?:amp|lt|gt|quot|apos|nbsp);|&#(?:x[\da-f]+|\d+);/gi,
      (entity) => {
        if (entity.startsWith('&#')) {
          const hex = entity[2].toLowerCase() === 'x',
            code = parseInt(entity.slice(hex ? 3 : 2, -1), hex ? 16 : 10);
          return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
        }
        return {
          '&amp;': '&',
          '&lt;': '<',
          '&gt;': '>',
          '&quot;': '"',
          '&apos;': "'",
          '&nbsp;': ' ',
        }[entity.toLowerCase()];
      },
    )
    .replace(/\s+/g, ' ')
    .trim();
}
