import {
  BAND_FILTERS,
  RECEIVER_TYPES,
  buildSpectrumUrl,
  buildTuneUrl,
  cleanReceiverText,
  defaultModeForHz,
  formatFrequencyHz,
  normalizeReceiverMode,
  rankWebReceivers,
  receiverCoversHz,
  receiverCoversRangeHz,
  receiverMatchesFilter,
} from '../../sources/webReceivers.js';
import { HIGHLIGHT_LIMIT } from './policy.js';

function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function createQueries({ state: layerState, parts }) {
  function visibleReceivers() {
    return layerState._receivers.filter((receiver) =>
      receiverMatchesFilter(receiver, layerState._filter),
    );
  }

  function getReceiver(id) {
    return id ? layerState._byId.get(String(id).toLowerCase()) || null : null;
  }

  /** Select a receiver by id; optionally fly the camera to it. */
  function selectReceiver(id, { flyTo = false } = {}) {
    const receiver = getReceiver(id);
    if (!receiver) {
      layerState._selectedId = null;
      parts.rendering.updateSelectionEntity();
      parts.presentation.emitState();
      return null;
    }
    layerState._selectedId = receiver.id;
    parts.rendering.updateSelectionEntity();
    if (flyTo) parts.rendering.flyTo(receiver);
    parts.presentation.emitState();
    return receiver;
  }

  /** Highlight a set of receivers (search results) on the globe. */
  function highlight(ids) {
    layerState._highlightIds = new Set(
      (ids || [])
        .map((id) => String(id).toLowerCase())
        .filter((id) => layerState._byId.has(id))
        .slice(0, HIGHLIGHT_LIMIT),
    );
    parts.rendering.restyleMarkers();
    parts.presentation.emitState();
  }

  /** Change the panel filter. */
  function setFilter(next = {}) {
    const type = RECEIVER_TYPES.includes(next.type)
      ? next.type
      : next.type === 'all'
        ? 'all'
        : layerState._filter.type;
    const band = BAND_FILTERS.some((entry) => entry.id === next.band)
      ? next.band
      : layerState._filter.band;
    layerState._filter = Object.freeze({ type, band });
    parts.rendering.restyleMarkers();
    parts.presentation.emitState();
  }

  /**
   * Find receivers for a request. Returns ranked rows with distance and
   * coverage; also highlights them on the globe.
   */
  function find(request = {}) {
    const rows = rankWebReceivers(layerState._receivers, request);
    layerState._lastSearch = Object.freeze({
      at: new Date().toISOString(),
      lat: finiteNumber(request.lat),
      lon: finiteNumber(request.lon),
      hz: finiteNumber(request.hz),
      rangeHz: Array.isArray(request.rangeHz)
        ? [Number(request.rangeHz[0]), Number(request.rangeHz[1])]
        : null,
      label: cleanReceiverText(request.label, 120),
      resultIds: rows.map((row) => row.receiver.id),
    });
    highlight(rows.map((row) => row.receiver.id));
    return rows;
  }

  /** Look up one receiver by id, or by a name/site/host substring. */
  function resolveReceiver(query) {
    const text = cleanReceiverText(query, 160).toLowerCase();
    if (!text) return null;
    if (layerState._byId.has(text)) return layerState._byId.get(text);
    const words = text.split(/\s+/).filter(Boolean);
    const scored = layerState._receivers
      .map((receiver) => {
        const haystack =
          `${receiver.name} ${receiver.site} ${receiver.url}`.toLowerCase();
        const hits = words.filter((word) => haystack.includes(word)).length;
        return { receiver, hits };
      })
      .filter((entry) => entry.hits === words.length);
    scored.sort(
      (a, b) =>
        (a.receiver.online === false) - (b.receiver.online === false) ||
        a.receiver.name.length - b.receiver.name.length,
    );
    return scored[0]?.receiver || null;
  }

  /**
   * Tune a receiver: records the request, selects the receiver and returns the
   * URL the UI (or a new tab) should load. Never contacts the receiver itself.
   */
  function tune({ receiverId, hz, mode = null } = {}) {
    const receiver = getReceiver(receiverId);
    const frequency = finiteNumber(hz);
    if (!receiver) return { ok: false, error: 'Receiver not found' };
    if (frequency === null || frequency <= 0)
      return { ok: false, error: 'Frequency is required' };
    const canonical =
      normalizeReceiverMode(mode) || defaultModeForHz(frequency);
    const url = buildTuneUrl(receiver, { hz: frequency, mode: canonical });
    if (!url)
      return { ok: false, error: 'This receiver cannot be tuned by URL' };
    const covers = receiverCoversHz(receiver, frequency);
    const frequencyLabel = formatFrequencyHz(frequency);
    layerState._lastTune = Object.freeze({
      kind: 'tune',
      receiverId: receiver.id,
      receiverName: receiver.name,
      type: receiver.type,
      hz: frequency,
      mode: canonical,
      url,
      covers,
      at: new Date().toISOString(),
      frequencyLabel,
    });
    layerState._selectedId = receiver.id;
    parts.rendering.updateSelectionEntity();
    parts.presentation.emitState();
    return {
      ok: true,
      receiver,
      url,
      hz: frequency,
      mode: canonical,
      covers,
      frequencyLabel,
    };
  }

  /**
   * Spectrum-only view of a range on a receiver: records it like a tune
   * (kind 'spectrum'), selects the receiver and returns the URL for the dock.
   * `muted` is only true for KiwiSDR pages; the note explains the rest.
   */
  function showSpectrum({ receiverId, lowHz, highHz } = {}) {
    const receiver = getReceiver(receiverId);
    const low = finiteNumber(lowHz);
    const high = finiteNumber(highHz);
    if (!receiver) return { ok: false, error: 'Receiver not found' };
    if (low === null || high === null || high <= low)
      return { ok: false, error: 'A frequency range (low < high) is required' };
    const view = buildSpectrumUrl(receiver, { lowHz: low, highHz: high });
    if (!view)
      return {
        ok: false,
        error: 'This receiver cannot show a spectrum from a URL',
      };
    const covers = receiverCoversRangeHz(receiver, low, high);
    layerState._lastTune = Object.freeze({
      kind: 'spectrum',
      receiverId: receiver.id,
      receiverName: receiver.name,
      type: receiver.type,
      hz: view.centerHz,
      lowHz: low,
      highHz: high,
      mode: 'spectrum',
      url: view.url,
      muted: view.muted,
      zoom: view.zoom,
      covers,
      note: view.note,
      at: new Date().toISOString(),
      frequencyLabel: view.rangeLabel,
    });
    layerState._selectedId = receiver.id;
    parts.rendering.updateSelectionEntity();
    parts.presentation.emitState();
    return {
      ok: true,
      receiver,
      url: view.url,
      lowHz: low,
      highHz: high,
      rangeLabel: view.rangeLabel,
      muted: view.muted,
      zoom: view.zoom,
      shownSpanHz: view.shownSpanHz,
      covers,
      note: view.note,
    };
  }

  return {
    visibleReceivers,
    getReceiver,
    selectReceiver,
    highlight,
    setFilter,
    find,
    resolveReceiver,
    tune,
    showSpectrum,
  };
}
