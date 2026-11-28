import {
  ENRICH_DISPATCH_GAP_MS,
  ENRICH_MAX_INFLIGHT,
  ENRICH_RETRY_COOLDOWN_MS,
} from './policy.js';

/**
 * Whether a source failure is permanent: an unsupported lookup, or an HTTP
 * 4xx other than 401/403 (an authorization refusal that may clear), 408
 * (timeout) and 429 (rate limited). Anything else, including an error without a
 * status, is temporary.
 * @param {*} error The rejection, as `LiveSourceError` / `httpError` carry it.
 * @returns {boolean}
 */
function enrichFailureIsFinal(error) {
  if (error?.code === 'unsupported') return true;
  const status = Number(error?.status);
  return (
    Number.isInteger(status) &&
    status >= 400 &&
    status < 500 &&
    status !== 401 &&
    status !== 403 &&
    status !== 408 &&
    status !== 429
  );
}

/**
 * Each key is asked at most once per session, except that a temporary failure
 * can be retried after the cool-down. Answers (found or not) and permanent
 * refusals are final. Dispatch up to four requests in flight, 200 ms apart,
 * with priority jobs at the front.
 */
export function createEnrichmentQueue({
  source,
  signal,
  now = () => Date.now(),
}) {
  const seen = new Set();
  const retryAfter = new Map();
  const queue = [];
  let active = 0;
  let lastDispatchAt = -Infinity;
  let dripTimer = null;
  let epoch = 0;

  function held(key) {
    if (seen.has(key)) return true;
    const until = retryAfter.get(key);
    if (until === undefined) return false;
    if (now() < until) return true;
    retryAfter.delete(key);
    return false;
  }

  function enqueue(key, query, onData, priority = false, read = null) {
    if (signal().aborted || held(key)) return;
    seen.add(key);
    const job = { key, query, onData, read };
    if (priority) queue.unshift(job);
    else queue.push(job);
    drain();
  }

  function drain() {
    if (signal().aborted) return;
    while (active < ENRICH_MAX_INFLIGHT && queue.length) {
      const wait = ENRICH_DISPATCH_GAP_MS - (now() - lastDispatchAt);
      if (wait > 0) {
        if (!dripTimer) {
          dripTimer = setTimeout(() => {
            dripTimer = null;
            drain();
          }, wait);
        }
        return;
      }
      lastDispatchAt = now();
      const job = queue.shift();
      active += 1;
      const jobSignal = signal();
      const jobEpoch = epoch;
      const stale = () => jobSignal.aborted || jobEpoch !== epoch;
      Promise.resolve()
        .then(() => {
          jobSignal.throwIfAborted();
          return source()?.getEnrichment?.(job.query, { signal: jobSignal });
        })
        .then(
          (answer) => {
            const data = job.read ? job.read(answer) : answer;
            if (!stale() && data?.found) job.onData(data);
          },
          (error) => {
            if (stale() || enrichFailureIsFinal(error)) return;
            seen.delete(job.key);
            retryAfter.set(job.key, now() + ENRICH_RETRY_COOLDOWN_MS);
          },
        )
        .catch(() => {
          /* enrichment never surfaces errors */
        })
        .finally(() => {
          if (stale()) return;
          active -= 1;
          drain();
        });
    }
  }

  function reset() {
    epoch += 1;
    queue.length = 0;
    seen.clear();
    retryAfter.clear();
    active = 0;
    lastDispatchAt = -Infinity;
    clearTimeout(dripTimer);
    dripTimer = null;
  }

  return {
    enqueue,
    held,
    drain,
    reset,
    get active() {
      return active;
    },
    seen,
    retryAfter,
  };
}
