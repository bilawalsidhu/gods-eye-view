/**
 * Private action accounting prototype. Keys describe invocations, never input
 * provenance, successful effects, provider admission or physical settlement.
 * The supplied runAction continues to own execution and currentness.
 */
export function createPanelActionObserver({
  runAction,
  onObservation,
  signal,
}) {
  if (typeof runAction !== 'function')
    throw new TypeError('runAction is required');
  const pending = new Map();
  let disposed = false;
  const publish = (type, record, details = {}) => {
    try {
      onObservation?.(
        Object.freeze({
          type,
          key: record.key,
          name: record.name,
          pendingCount: pending.size,
          ...details,
        }),
      );
    } catch {
      // A presentation observer cannot change execution or its result.
    }
  };
  const release = (record) => {
    if (!pending.delete(record.key)) return false;
    try {
      record.signal?.removeEventListener('abort', record.abort);
    } catch {
      /* Observer cleanup only. */
    }
    return true;
  };
  const retireOne = (record, reason) => {
    if (release(record)) publish('ownership-retired', record, { reason });
  };
  const retire = (reason = 'owner-retired') => {
    for (const record of [...pending.values()])
      retireOne(record, typeof reason === 'string' ? reason : 'owner-retired');
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    try {
      signal?.removeEventListener('abort', dispose);
    } catch {
      /* Observer cleanup only. */
    }
    retire('mount-retired');
  };
  signal?.addEventListener('abort', dispose, { once: true });
  if (signal?.aborted) dispose();

  function observedAction(...args) {
    if (disposed) return Reflect.apply(runAction, this, args);
    const record = {
      key: Object.freeze({}),
      name: typeof args[0] === 'string' ? args[0] : undefined,
    };
    const originalOptions = args[2];
    let forwarded = args;
    // Main supplies ordinary data options. Leave exotic/accessor options intact
    // rather than evaluating getters or pretending all custom factories fit.
    try {
      const prototype =
        originalOptions == null ? null : Object.getPrototypeOf(originalOptions);
      const descriptors =
        originalOptions == null
          ? {}
          : Object.getOwnPropertyDescriptors(originalOptions);
      const callerSignal = descriptors.signal?.value;
      if (callerSignal instanceof AbortSignal) record.signal = callerSignal;
      const dataOnly = Object.values(descriptors).every((d) => 'value' in d);
      const originalProgress = descriptors.progress?.value;
      if (
        originalOptions !== undefined &&
        originalOptions !== null &&
        (prototype === Object.prototype || prototype === null) &&
        dataOnly &&
        (originalProgress == null || typeof originalProgress === 'function')
      ) {
        const progressDescriptor = descriptors.progress;
        delete descriptors.progress;
        const options = Object.create(prototype, descriptors);
        Object.defineProperty(options, 'progress', {
          configurable: true,
          enumerable: progressDescriptor?.enumerable ?? true,
          writable: true,
          value: function (...updates) {
            const receiver = this === options ? originalOptions : this;
            const returned =
              originalProgress == null
                ? undefined
                : Reflect.apply(originalProgress, receiver, updates);
            if (pending.has(record.key)) {
              // No raw mutable result/options/update object escapes to observers.
              try {
                const step = Object.getOwnPropertyDescriptor(
                  updates[0] ?? {},
                  'step',
                )?.value;
                const label = Object.getOwnPropertyDescriptor(
                  updates[0] ?? {},
                  'label',
                )?.value;
                if (typeof step === 'string')
                  publish('progress', record, {
                    step,
                    ...(typeof label === 'string' ? { label } : {}),
                  });
              } catch {
                /* Private metadata inspection cannot change progress. */
              }
            }
            return returned;
          },
        });
        forwarded = [...args];
        forwarded[2] = options;
      }
    } catch {
      // Unsupported option introspection is not an execution failure.
    }
    if (!record.signal?.aborted) {
      pending.set(record.key, record);
      record.abort = () => retireOne(record, 'caller-aborted');
      try {
        record.signal?.addEventListener('abort', record.abort, { once: true });
      } catch {
        retireOne(record, 'unobserved-signal');
      }
      if (pending.has(record.key)) publish('attempt-started', record);
    }
    const settle = (outcome) => {
      if (release(record)) publish('attempt-settled', record, { outcome });
    };
    let result;
    try {
      result = Reflect.apply(runAction, this, forwarded);
    } catch (error) {
      settle('synchronous-throw');
      throw error;
    }
    // The actual common session returns a same-realm native Promise. Do not
    // assimilate arbitrary thenables, read their .then getter or invent their
    // settlement; custom return values still reach the caller unchanged.
    try {
      if (result instanceof Promise) {
        Promise.prototype.then.call(
          result,
          () => settle('fulfilled'),
          () => settle('rejected'),
        );
      } else if (
        result === null ||
        !['object', 'function'].includes(typeof result)
      ) {
        settle('synchronous-return');
      } else retireOne(record, 'unobserved-return-kind');
    } catch {
      retireOne(record, 'unobserved-return-kind');
    }
    return result;
  }
  return {
    runAction: observedAction,
    retire,
    dispose,
    get pendingCount() {
      return pending.size;
    },
  };
}
