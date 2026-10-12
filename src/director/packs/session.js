import { PACK_LIMITS, validateDataPack } from './manifest.js';

// Also settle adapters that fail to observe abort; dispose any late resource they return.
function untilAbort(promise, signal, late = () => {}) {
  return new Promise((resolve, reject) => {
    let ended = false;
    const abort = () => {
      if (!ended) {
        ended = true;
        reject(signal.reason);
      }
    };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    Promise.resolve(promise).then(
      (value) => {
        signal.removeEventListener('abort', abort);
        if (ended) late(value);
        else {
          ended = true;
          resolve(value);
        }
      },
      (error) => {
        signal.removeEventListener('abort', abort);
        if (!ended) {
          ended = true;
          reject(error);
        }
      },
    );
  });
}

/** Own bounded pack acquisition and disposable presentations for a single shot. */
export function createDataPackSession({
  sources = {},
  adapters = {},
  timeoutMs = 15000,
} = {}) {
  const sourceMap = new Map(Object.entries(sources));
  const adapterMap = new Map(Object.entries(adapters));
  let active = null,
    disposed = false;
  function clear() {
    const run = active;
    if (!run) return;
    active = null;
    run.controller.abort();
    run.detach();
    clearTimeout(run.timer);
    for (const handle of run.handles.splice(0).reverse()) handle.dispose();
  }
  return {
    clear,
    destroy() {
      disposed = true;
      clear();
    },
    getState() {
      return {
        status: active?.status || 'idle',
        count: active?.handles.length || 0,
      };
    },
    async load(packs, { anchors = [], signal } = {}) {
      clear();
      if (!Array.isArray(packs) || packs.length > PACK_LIMITS.packs)
        throw new Error('Too many data packs');
      const anchorIds = new Set(anchors.map((anchor) => anchor.id));
      packs.forEach((pack, i) =>
        validateDataPack(pack, `packs[${i}]`, anchorIds),
      );
      if (disposed || signal?.aborted) return false;
      if (!packs.length) return true;
      const controller = new AbortController();
      const run = {
        controller,
        handles: [],
        status: 'loading',
        detach: () => signal?.removeEventListener('abort', cancel),
      };
      const cancel = () => {
        if (active === run) clear();
      };
      active = run;
      signal?.addEventListener('abort', cancel, { once: true });
      run.timer = setTimeout(
        () => controller.abort(new Error('Asset load timed out')),
        timeoutMs,
      );
      let total = 0;
      try {
        for (const pack of packs) {
          const source = sourceMap.get(pack.source.adapter),
            adapter = adapterMap.get(pack.format);
          if (!source || !adapter)
            throw new Error('Data pack adapter unavailable');
          const asset = await untilAbort(
            source({
              path: pack.source.path,
              signal: controller.signal,
              maxBytes: pack.byteLength || PACK_LIMITS.bytes,
            }),
            controller.signal,
          );
          controller.signal.throwIfAborted();
          const { bytes } = asset;
          if (
            !(bytes instanceof Uint8Array) ||
            !bytes.length ||
            bytes.length > PACK_LIMITS.bytes ||
            (pack.byteLength && bytes.length !== pack.byteLength)
          )
            throw new Error('Asset byte length invalid');
          total += bytes.length;
          if (total > PACK_LIMITS.totalBytes)
            throw new Error('Shot assets exceed byte limit');
          if (pack.sha256) {
            const digest = await untilAbort(
              crypto.subtle.digest('SHA-256', bytes),
              controller.signal,
            );
            const hex = Array.from(new Uint8Array(digest), (b) =>
              b.toString(16).padStart(2, '0'),
            ).join('');
            if (hex !== pack.sha256)
              throw new Error('Asset integrity mismatch');
          }
          const handle = await untilAbort(
            adapter({ pack, asset, anchors, signal: controller.signal }),
            controller.signal,
            (late) => late?.dispose(),
          );
          if (!handle || typeof handle.dispose !== 'function')
            throw new Error('Data pack adapter requires disposal');
          if (active !== run || controller.signal.aborted) {
            handle.dispose();
            controller.signal.throwIfAborted();
            return false;
          }
          run.handles.push(handle);
        }
        controller.signal.throwIfAborted();
        clearTimeout(run.timer);
        run.status = 'ready';
        return true;
      } catch (error) {
        const superseded = active !== run || signal?.aborted || disposed;
        if (active === run) clear();
        if (superseded) return false;
        // Source errors may include URLs; only stable messages reach the UI.
        throw new Error(
          'Data pack could not load: check its source, format, size or integrity',
        );
      }
    },
  };
}
