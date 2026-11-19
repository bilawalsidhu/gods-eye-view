import { searchHls } from './catalog.js';
import {
  PRODUCTS,
  gibsTemplate,
  nonCrossingBoxes,
  wvsSnapshotUrl,
} from './model.js';

/**
 * Deadline for one half's response headers, so a day whose other half
 * answered is not held at "checking".
 */
const DEFAULT_HALF_DEADLINE_MS = 15_000;

/**
 * Worldview Snapshots rejects a BBOX with west > east, so a dateline box is
 * probed as its two non-crossing halves, wider first. A plain box is its
 * one normalized half. Granules do not cross ±180, so a day has data when
 * either half does.
 */
function requestBoxes(box) {
  const halves = nonCrossingBoxes(box);
  if (!halves.length) return [box];
  return halves.sort((a, b) => b.east - b.west - (a.east - a.west));
}

const isPresent = (response) => dataPresent(response) === 'true';

/**
 * Which halves a product may drape. The VIIRS JPEG has no alpha and would
 * drape an empty side as a black rectangle, so it drapes only a half
 * Worldview confirmed present. An HLS PNG drapes every half not confirmed empty.
 */
const drapesOnlyProven = (candidate) =>
  PRODUCTS[candidate?.product]?.format === 'jpg';

const dataPresent = (response) =>
  response?.ok
    ? String(response.headers?.get?.('Data-Present') ?? '').toLowerCase()
    : '';

/**
 * Of the halves that answered, prefer the first with data (wider wins a
 * tie), then the first not confirmed empty so an unreadable answer is
 * never called empty, then the first response.
 */
function combineHalves(responses) {
  const present = responses.find(isPresent);
  if (present) return present;
  const unproven = responses.find((r) => dataPresent(r) !== 'false');
  return unproven ?? responses[0];
}

/**
 * One half's snapshot fetch, raced against its own deadline so a half that
 * never answers, even over a transport that ignores AbortSignal, still
 * settles. Its deadline cancels only this half. The caller can cancel it
 * at any time, including while its body is being read.
 */
function probeHalf(
  url,
  { fetchImpl, signal, deadlineMs, setTimeoutImpl, clearTimeoutImpl },
) {
  const controller = new AbortController();
  return new Promise((resolve, reject) => {
    let timer = null;
    const finishTimeout = () => {
      if (timer !== null) clearTimeoutImpl(timer);
      timer = null;
    };
    const stop = (reason) => {
      controller.abort(reason);
      finishTimeout();
      // Settle even if the transport ignores abort.
      reject(reason);
    };
    if (signal?.aborted) {
      stop(signal.reason);
      return;
    }
    signal?.addEventListener('abort', () => stop(signal.reason), {
      once: true,
    });
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
        finishTimeout();
        resolve(value);
      },
      (error) => {
        finishTimeout();
        reject(error);
      },
    );
  });
}

/**
 * Non-enumerable evidence for the box's non-crossing halves. presentBoxes
 * lists the halves this product may drape (see drapesOnlyProven).
 * emptyBoxes lists the halves Worldview confirmed empty.
 */
function withHalves(response, { presentBoxes, emptyBoxes }) {
  if (!response) return response;
  Object.defineProperties(response, {
    presentBoxes: { value: presentBoxes, configurable: true },
    emptyBoxes: { value: emptyBoxes, configurable: true },
  });
  return response;
}

/**
 * NASA-compatible imagery acquisition; transport and URL builders are replaceable.
 * Thumbnail responses must expose Data-Present: true for image admission, or
 * false for confirmed empty coverage, including injected getThumbnail sources.
 * getThumbnail also sets presentBoxes and emptyBoxes (see withHalves).
 * Without per-half evidence the renderer drapes every side of a dateline
 * box, so an empty side of a VIIRS JPEG then draws black.
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
      const deadlineMs = halves.length > 1 ? halfDeadlineMs : 0;
      const results = await Promise.allSettled(
        halves.map((half) =>
          probeHalf(
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
              deadlineMs,
              setTimeoutImpl,
              clearTimeoutImpl,
            },
          ),
        ),
      );
      signal?.throwIfAborted();
      // Per half, its Data-Present answer or null when it did not answer.
      const answers = results.map((result) =>
        result.status === 'fulfilled' ? dataPresent(result.value) : null,
      );
      const responses = results
        .filter((result) => result.status === 'fulfilled')
        .map((result) => result.value);
      const halvesWhere = (keep) => halves.filter((_, i) => keep(answers[i]));
      const emptyBoxes = halvesWhere((answer) => answer === 'false');
      if (answers.includes('true'))
        return withHalves(combineHalves(responses), {
          presentBoxes: halvesWhere(
            drapesOnlyProven(candidate)
              ? (answer) => answer === 'true'
              : (answer) => answer !== 'false',
          ),
          emptyBoxes,
        });
      // A missing answer is an error unless another half proved data.
      const failure = results.find((result) => result.status === 'rejected');
      if (failure) {
        if (failure.reason?.name === 'TimeoutError')
          throw new DOMException('Thumbnail request timed out', 'TimeoutError');
        throw new Error('Thumbnail request failed');
      }
      return withHalves(combineHalves(responses), {
        presentBoxes: [],
        emptyBoxes,
      });
    },
    getTileTemplate: (product, day) => tileTemplate(product, day),
  };
}
