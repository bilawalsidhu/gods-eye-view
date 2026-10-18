import { msg } from '../i18n/marker.js';
import {
  cachedModelBytes,
  checkLocalGpu,
  downloadModel,
  modelBytes,
  removeCachedModel,
} from './localModelCache.js';

const states = new Map();
const listeners = new Set();
export const hasLocalDownloads = () =>
  [...states.values()].some((state) => state.controller);
const notify = () => {
  for (const listener of listeners) listener();
};
export const localDownloadState = (model) =>
  states.get(model.id) || {
    status: 'checking',
    loaded: 0,
    total: modelBytes(model),
  };
export function subscribeLocalDownloads(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export async function refreshLocalDownload(model) {
  if (states.get(model.id)?.controller) return;
  try {
    const loaded = await cachedModelBytes(model);
    // A user may have started downloading while Cache Storage was being read.
    if (states.get(model.id)?.controller) return;
    states.set(model.id, {
      status: loaded === modelBytes(model) ? 'ready' : 'idle',
      loaded,
      total: modelBytes(model),
    });
  } catch (error) {
    states.set(model.id, {
      status: 'error',
      error: error.message,
      loaded: 0,
      total: modelBytes(model),
    });
  }
  notify();
}

export async function startLocalDownload(model) {
  if (states.get(model.id)?.controller) return;
  const controller = new AbortController();
  const state = {
    ...localDownloadState(model),
    status: 'downloading',
    error: '',
    controller,
  };
  states.set(model.id, state);
  notify();
  // Best effort: browsers can decline persistence; the cache still works.
  void globalThis.navigator?.storage?.persist?.().catch(() => {});
  try {
    if (model.kind === 'chat') await checkLocalGpu();
    let lastPaint = 0;
    await downloadModel(model, {
      signal: controller.signal,
      onProgress(progress) {
        Object.assign(state, progress);
        if (performance.now() - lastPaint > 100) {
          lastPaint = performance.now();
          notify();
        }
      },
    });
    state.status = 'ready';
  } catch (error) {
    // Report committed bytes, not bytes from the request that just failed.
    state.loaded = await cachedModelBytes(model).catch(() => state.loaded);
    state.status = controller.signal.aborted ? 'idle' : 'error';
    state.error = controller.signal.aborted
      ? msg(
          'Download cancelled. Saved parts are kept; download again to resume.',
        )
      : error.message;
  } finally {
    delete state.controller;
    notify();
  }
}

export function cancelLocalDownload(model) {
  states.get(model.id)?.controller?.abort();
}
export async function deleteLocalDownload(model) {
  if (states.get(model.id)?.controller) return;
  try {
    await removeCachedModel(model);
    await refreshLocalDownload(model);
  } catch (error) {
    states.set(model.id, {
      ...localDownloadState(model),
      status: 'error',
      error: error.message,
    });
    notify();
  }
}
