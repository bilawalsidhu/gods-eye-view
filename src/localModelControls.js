import {
  formatModelBytes,
  selectedLocalModels,
} from './voice/localModelCache.js';
import {
  cancelLocalDownload,
  deleteLocalDownload,
  localDownloadState,
  refreshLocalDownload,
  startLocalDownload,
  subscribeLocalDownloads,
} from './voice/localDownloads.js';
import { t } from './i18n/index.js';

export function createLocalModelControls(documentRef) {
  const root = documentRef.createElement('div');
  root.className = 'local-models';
  let cards = [];
  const paint = () => {
    for (const { model, card, progress, status, download, remove } of cards) {
      const state = localDownloadState(model);
      const busy = state.status === 'downloading';
      const ready = state.status === 'ready';
      const failed = state.status === 'error';
      const checking = state.status === 'checking';
      card.dataset.state = state.status;
      progress.hidden = !busy;
      progress.max = state.total;
      progress.value = state.loaded;
      download.textContent = busy
        ? t('CANCEL')
        : ready
          ? t('DOWNLOADED ✓')
          : failed
            ? t('RETRY DOWNLOAD')
            : t('DOWNLOAD');
      download.disabled = ready || checking;
      remove.hidden = busy || (!ready && !state.loaded);
      status.textContent = busy
        ? `${Math.min(100, Math.floor((state.loaded / state.total) * 100))}% · ${formatModelBytes(state.loaded)} / ${formatModelBytes(state.total)}`
        : (state.error && t(state.error)) ||
          (ready
            ? t('Saved in this browser')
            : checking
              ? t('Checking browser cache…')
              : state.loaded
                ? t('{size} · partially downloaded', {
                    size: formatModelBytes(state.total),
                  })
                : formatModelBytes(state.total));
    }
  };
  const unsubscribe = subscribeLocalDownloads(paint);
  return {
    root,
    destroy: unsubscribe,
    select(config) {
      cards = [];
      root.textContent = '';
      for (const model of selectedLocalModels(config)) {
        const card = documentRef.createElement('div');
        card.className = 'local-model';
        card.dataset.localModel = model.id;
        const title = documentRef.createElement('strong');
        title.textContent = model.title;
        const kind = documentRef.createElement('span');
        kind.className = 'local-model-kind';
        kind.textContent = {
          chat: t('AI MODEL'),
          recognition: t('SPEECH RECOGNITION'),
          speech: t('VOICE'),
        }[model.kind];
        const status = documentRef.createElement('span');
        status.className = 'local-model-status';
        status.setAttribute('role', 'status');
        const progress = documentRef.createElement('progress');
        progress.setAttribute(
          'aria-label',
          t('{model} download progress', { model: model.title }),
        );
        const actions = documentRef.createElement('div');
        actions.className = 'local-model-actions';
        const download = documentRef.createElement('button');
        download.type = 'button';
        download.className = 'local-model-download';
        download.setAttribute(
          'aria-label',
          t('Download {model}', { model: model.title }),
        );
        download.addEventListener('click', () => {
          if (localDownloadState(model).status === 'downloading')
            cancelLocalDownload(model);
          else void startLocalDownload(model);
        });
        const remove = documentRef.createElement('button');
        remove.type = 'button';
        remove.className = 'key-setup-remove';
        remove.textContent = t('REMOVE FROM CACHE');
        remove.setAttribute(
          'aria-label',
          t('Remove {model} from browser cache', { model: model.title }),
        );
        remove.addEventListener('click', () => void deleteLocalDownload(model));
        actions.append(download, remove);
        card.append(kind, title, status, progress, actions);
        root.append(card);
        cards.push({ model, card, status, progress, download, remove });
        void refreshLocalDownload(model);
      }
      paint();
    },
  };
}
