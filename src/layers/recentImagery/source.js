import { searchHls } from './catalog.js';
import { gibsTemplate, nonCrossingBoxes, wvsSnapshotUrl } from './model.js';

/**
 * A half's answer is only worth so much waiting: past this deadline the half
 * is cancelled with its own `TimeoutError` so a day whose wider side answered
 * at once is never stranded at "checking" behind a narrow side that never
 * sends headers.
 */
const DEFAULT_HALF_DEADLINE_MS = 15_000;

/**
 * Worldview Snapshots rejects a BBOX with west > east, so a dateline box is
 * probed as its two non-crossing halves, wider first. Granules do not cross
 * +/-180, so a day has data when either half does.
 */
function requestBoxes(box) {
  if (!(box?.west > box?.east)) return [box];
  const halves = nonCrossingBoxes(box);
  if (!halves.length) return [box];
  return [...halves].sort((a, b) => b.east - b.west - (a.east - a.west));
}

const isPresent = (response) => dataPresent(response) === 'true';

const dataPresent = (response) =>
  response?.ok
    ? String(response.headers?.get?.('Data-Present') ?? '').toLowerCase()
    : '';

/**
 * One answer for a crossing box across only the halves that actually
 * answered: the first half that has data (the wider side wins a tie, so the
 * thumbnail shows it); both confirmed empty is empty; any other mix (a
 * failed or unreadable half) is returned as that half's response so the day
 * is never called empty on partial evidence.
 */
function combineHalves(responses) {
  const present = responses.find(isPresent);
  if (present) return present;
  const unproven = responses.find((r) => dataPresent(r) !== 'false');
  return unproven ?? responses[0];
}

/**
 * One half's snapshot fetch, raced against its own deadline so a half that
 * never answers — including a transport that ignores its AbortSignal — is
 * bounded and the day settles instead of hanging. The controller is private:
 * only a half that has not settled is ever aborted, so a settled response's
 * body stays readable afterwards, while the caller's signal still stops
 * every pending half at once. No half is settled early on the other's
 * answer: both headers are heard, so two present halves both survive.
 */
function probeHalf(
  url,
  { fetchImpl, signal, deadlineMs, setTimeoutImpl, clearTimeoutImpl },
) {
  const controller = new AbortController();
  let settle = null;
  let timer = null;
  let transportSettled = false;
  const finishTimeout = () => {
    if (timer !== null) {
      clearTimeoutImpl(timer);
      timer = null;
    }
  };
  const stop = (why) => {
    const reason =
      why ??
      signal?.reason ??
      new DOMException('Thumbnail half stopped', 'AbortError');
    controller.abort(reason);
    finishTimeout();
    // The transport's own rejection is the answer when it honours abort;
    // for one that does not, the race itself carries the stop to the probe.
    if (!transportSettled) settle?.reject(reason);
  };
  if (signal?.aborted) stop();
  else
    signal?.addEventListener('abort', () => stop(signal.reason), {
      once: true,
    });
  const response = new Promise((resolve, reject) => {
    settle = { resolve, reject };
    if (controller.signal.aborted) {
      reject(controller.signal.reason);
      return;
    }
    if (deadlineMs > 0)
      timer = setTimeoutImpl(
        () =>
          stop(new DOMException('Thumbnail half timed out', 'TimeoutError')),
        deadlineMs,
      );
    let promise;
    try {
      promise = Promise.resolve(fetchImpl(url, { signal: controller.signal }));
    } catch (error) {
      finishTimeout();
      reject(error);
      return;
    }
    promise.then(
      (value) => {
        transportSettled = true;
        finishTimeout();
        resolve(value);
      },
      (error) => {
        transportSettled = true;
        finishTimeout();
        reject(error);
      },
    );
  });
  // The deadline dies with the fetch's own settle; the caller-abort wiring
  // deliberately outlives it, so a stop that arrives while the response body
  // is still being read still cancels the half, right up until the caller's
  // signal (and this listener with it) is collected.
  return { stop, response };
}

/**
 * The answer to one request: the response, enriched (non-enumerably, so the
 * transport's own shape is untouched) with the non-crossing halves the probe
 * did not confirm empty. An empty evidence list is a confirmed-empty day;
 * no field means the caller did not probe per half.
 */
function withPresentBoxes(response, presentBoxes) {
  if (!response) return response;
  try {
    Object.defineProperty(response, 'presentBoxes', {
      value: presentBoxes,
      enumerable: false,
      configurable: true,
    });
    return response;
  } catch {
    // Preserve native Response getters and methods on non-extensible objects.
    return new Proxy(Object.create(Object.getPrototypeOf(response)), {
      get(_target, property) {
        if (property === 'presentBoxes') return presentBoxes;
        const value = Reflect.get(response, property, response);
        return typeof value === 'function' ? value.bind(response) : value;
      },
    });
  }
}

/**
 * NASA-compatible imagery acquisition; transport and URL builders are replaceable.
 * Thumbnail responses must expose Data-Present: true for image admission, or
 * false for confirmed empty coverage, including injected getThumbnail sources.
 */
export function createRecentImagerySource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  search = searchHls,
  thumbnailUrl = wvsSnapshotUrl,
  tileTemplate = gibsTemplate,
  credit = 'NASA GIBS',
  halfDeadlineMs = DEFAULT_HALF_DEADLINE_MS,
  setTimeoutImpl = (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeoutImpl = (id) => globalThis.clearTimeout(id),
} = {}) {
  return {
    credit,
    searchHls: (query) => search({ ...query, fetchImpl }),
    async getThumbnail(candidate, box, { size = 256, signal } = {}) {
      signal?.throwIfAborted();
      const halves = requestBoxes(box);
      const probes = halves.map((half) => ({
        half,
        ...probeHalf(
          thumbnailUrl({
            product: candidate.product,
            day: candidate.day,
            box: half,
            width: size,
            height: size,
          }),
          {
            fetchImpl,
            signal,
            deadlineMs: halves.length > 1 ? halfDeadlineMs : 0,
            setTimeoutImpl,
            clearTimeoutImpl,
          },
        ),
      }));
      // Bounded header race: every half is raced against its own deadline,
      // so a half that never answers — even a transport that ignores its
      // AbortSignal — is bounded. Both headers are heard; no half is settled
      // early on the other's answer, so two present halves both survive.
      const results = await Promise.allSettled(
        probes.map((probe) => probe.response),
      );
      signal?.throwIfAborted();
      const fulfilled = [];
      results.forEach((result, i) => {
        if (result.status === 'fulfilled')
          fulfilled.push({ value: result.value, half: probes[i].half });
      });
      const responses = fulfilled.map((entry) => entry.value);
      // Retain every half except one that answered confirmed empty. A failed
      // probe is not evidence of absence, even when its sibling proves a day.
      const proven = fulfilled.filter((entry) => isPresent(entry.value));
      if (proven.length)
        return withPresentBoxes(
          combineHalves(responses),
          probes
            .filter(
              (probe, i) =>
                results[i].status === 'rejected' ||
                dataPresent(results[i].value) !== 'false',
            )
            .map((entry) => nonCrossingBoxes(entry.half)[0]),
        );
      // A rejected half is an error, never an empty day, unless another half
      // proved data on its own.
      if (results.length > responses.length) {
        const failure = results.find((result) => result.status === 'rejected');
        if (failure.reason?.name === 'TimeoutError')
          throw new DOMException('Thumbnail request timed out', 'TimeoutError');
        throw new Error('Thumbnail request failed');
      }
      return withPresentBoxes(combineHalves(responses), []);
    },
    getTileTemplate: (product, day) => tileTemplate(product, day),
  };
}
