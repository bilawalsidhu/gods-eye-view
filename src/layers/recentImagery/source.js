import { searchHls } from './catalog.js';
import { gibsTemplate, nonCrossingBoxes, wvsSnapshotUrl } from './model.js';

/**
 * Deadline for one half's response headers, so a day whose other half
 * answered is not held at "checking".
 */
const DEFAULT_HALF_DEADLINE_MS = 15_000;

/**
 * Worldview Snapshots rejects a BBOX with west > east, so a dateline box is
 * probed as its two non-crossing halves, wider first. A plain box is its
 * one normalized half. A day has data when either half does.
 */
function requestBoxes(box) {
  return nonCrossingBoxes(box).sort(
    (a, b) => b.east - b.west - (a.east - a.west),
  );
}

/** A response's Data-Present answer in lower case, or '' when it failed or has none. */
export const dataPresent = (response) =>
  response?.ok
    ? String(response.headers?.get?.('Data-Present') ?? '').toLowerCase()
    : '';

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
 * Non-enumerable per-half evidence for the box's non-crossing halves:
 * presentBoxes lists the halves Worldview confirmed present, emptyBoxes
 * the halves it confirmed empty. What drapes is decided by drapedParts in rendering.js.
 */
function withHalves(response, { presentBoxes, emptyBoxes }) {
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
 * getThumbnail also sets presentBoxes and emptyBoxes (see withHalves),
 * also on the error it throws when another half was confirmed empty.
 * Without per-half evidence the renderer drapes every side of an HLS
 * dateline box and no side of a VIIRS one.
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
      const halvesWhere = (value) =>
        halves.filter((_, i) => answers[i] === value);
      // A missing answer is an error unless another half proved data. The
      // error keeps a half confirmed empty (see withHalves).
      const failure = results.find((result) => result.status === 'rejected');
      if (failure && !answers.includes('true')) {
        const emptyBoxes = halvesWhere('false');
        if (Object.isExtensible(failure.reason))
          withHalves(
            failure.reason,
            emptyBoxes.length
              ? { presentBoxes: [], emptyBoxes }
              : { presentBoxes: null, emptyBoxes: null },
          );
        throw failure.reason;
      }
      // Show the first half with data (the wider wins a tie), else the first
      // not confirmed empty, so an unreadable answer is never called empty.
      // Every half answered here unless one proved data.
      let shown = answers.indexOf('true');
      if (shown < 0) shown = answers.findIndex((answer) => answer !== 'false');
      if (shown < 0) shown = 0;
      return withHalves(results[shown].value, {
        presentBoxes: halvesWhere('true'),
        emptyBoxes: halvesWhere('false'),
      });
    },
    getTileTemplate: (product, day) => tileTemplate(product, day),
  };
}
