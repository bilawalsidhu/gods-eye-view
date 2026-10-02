/**
 * Splits a byte stream in two with bounded buffering. Either branch pulls
 * from the source, but a branch waits while the other holds more than
 * `highWaterMark` unread bytes, so a slow consumer bounds memory instead of
 * the stream buffering the whole file.
 *
 * A consumer that stops reading before the end (a model loader that has
 * what it needs) calls `releasePrimary()`; the secondary then reads the
 * rest alone. Cancelling a branch lets the other continue; cancelling both
 * cancels the source. A source error errors both branches, so a partial
 * copy is never completed. `releaseSecondary()` drops a secondary whose
 * consumer failed, and `drain()` reads what is left of the source once
 * neither branch will.
 *
 * @returns {{primary: ReadableStream, secondary: ReadableStream,
 *   releasePrimary: () => void, releaseSecondary: () => void,
 *   drain: () => Promise<void>}}
 */
export function teeWithBackpressure(
  source,
  { highWaterMark = 32 * 1024 * 1024 } = {},
) {
  const reader = source.getReader();
  const branches = { primary: null, secondary: null };
  const open = { primary: true, secondary: true };
  let reading = null;
  let ended = false;
  let waiters = [];
  const wake = () => {
    const pending = waiters;
    waiters = [];
    for (const resolve of pending) resolve();
  };
  const settle = (name, error) => {
    if (!open[name]) return;
    open[name] = false;
    try {
      if (error) branches[name].error(error);
      else branches[name].close();
    } catch {
      /* already settled */
    }
  };
  const pump = () => {
    reading ||= reader.read().then(
      ({ done, value }) => {
        reading = null;
        if (done) {
          ended = true;
          settle('primary');
          settle('secondary');
        } else {
          for (const name of ['primary', 'secondary'])
            if (open[name]) branches[name].enqueue(value);
        }
        wake();
      },
      (error) => {
        reading = null;
        ended = true;
        settle('primary', error);
        settle('secondary', error);
        wake();
      },
    );
    return reading;
  };
  const branch = (name, other) =>
    new ReadableStream(
      {
        start(controller) {
          branches[name] = controller;
        },
        async pull() {
          while (open[other] && branches[other].desiredSize <= 0 && open[name])
            await new Promise((resolve) => waiters.push(resolve));
          if (open[name]) await pump();
        },
        cancel(reason) {
          open[name] = false;
          wake();
          if (!open[other]) return reader.cancel(reason);
          return undefined;
        },
      },
      new ByteLengthQueuingStrategy({ highWaterMark }),
    );
  const primary = branch('primary', 'secondary');
  const secondary = branch('secondary', 'primary');
  return {
    primary,
    secondary,
    releasePrimary() {
      open.primary = false;
      wake();
    },
    releaseSecondary() {
      open.secondary = false;
      wake();
    },
    async drain() {
      while (!ended) await pump();
    },
  };
}
