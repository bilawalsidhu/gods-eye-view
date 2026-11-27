import { t, translateKnown } from '../i18n/index.js';

export function streetPhotoAttribution({ creator, via, license } = {}) {
  const attribution = [];
  if (creator) attribution.push(t('Image by {creator}', { creator }));
  else if (via) attribution.push(t('via {source}', { source: via }));
  if (license) attribution.push(license);
  return attribution;
}

/** The credit fields that belong to one saved picture, independent of the layer's photo history. */
export function savedPhotoCredit(module, id, record) {
  if (record === undefined) record = module?.photo?.(id);
  const providerId = record?.providerId || String(id ?? '').split(':', 1)[0];
  const source = providerId && module?.providerCredit?.(providerId);
  if (!source && !record) return null;
  return {
    source,
    provider: record?.provider,
    creator: record?.creator,
    via: record?.via,
    license: record?.license,
  };
}

export function streetPhotoCredit(module, id, saved) {
  const record = saved || savedPhotoCredit(module, id);
  if (!record) return '';
  const provider = record.source || translateKnown(record.provider || '');
  return [provider, ...streetPhotoAttribution(record)]
    .filter(Boolean)
    .join(' · ');
}
