import {
  buildPlaceNarrativeParts,
  buildRegionBriefPayload,
  estimateBoundsAreaKm2,
  formatRegionTitle,
  metaChipsFromRegion,
  normalizeHeadlineTitles,
  VISION_PENDING_NARRATIVE,
} from './entityBriefContext.js';
import { captureMarqueeWhenReady, landmarksNearBounds } from './intelAreaContext.js';
import { createIntelBriefMarquee, collectRecordsInBounds, isReliableMarqueeBounds } from './intelBriefMarquee.js';
import { fetchRegionalBrief } from './regionalBrief.js';
import { isGeminiBriefUnconfigured } from '../geminiBriefResponse.js';

const BRIEF_URL = '/api/gemini/entity-brief';
const MAX_STACK_CARDS = 6;

let _viewer = null;
let _dataManager = null;
let _marquee = null;
let _stack = null;
let _cardSeq = 0;
/** @type {Map<string, { id: string, el: HTMLElement, streamController: AbortController|null, releaseHighlight: (() => void)|null }>} */
const _cards = new Map();

function ensureStack() {
  if (_stack) return Boolean(_stack);
  _stack = document.getElementById('intel-brief-stack');
  return Boolean(_stack);
}

function layoutStack() {
  if (!_stack) return;
  const cards = [..._stack.querySelectorAll('.intel-brief-card')];
  cards.forEach((card, index) => {
    const isFront = index === cards.length - 1;
    card.classList.toggle('is-front', isFront);
    card.classList.toggle('is-peek', !isFront);
    card.style.removeProperty('--stack-depth');
    card.style.removeProperty('bottom');
    card.style.removeProperty('top');
    card.style.removeProperty('z-index');
  });
}

function escapeHtml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function renderBriefContent(bodyEl, context) {
  if (!bodyEl) return;
  delete bodyEl.dataset.streaming;
  delete bodyEl.dataset.visionPrimary;
  const { narrative } = buildPlaceNarrativeParts(context);

  const html = `<p class="intel-brief-lede intel-brief-narrative">${escapeHtml(narrative)}</p>`
    + '<div class="intel-brief-stream-ai"></div>';
  bodyEl.innerHTML = `<div class="intel-brief-copy">${html}</div>`;
  if (context?.visionPending) {
    bodyEl.dataset.visionPrimary = '1';
  }
  requestAnimationFrame(layoutStack);
}

function renderNarrative(bodyEl, text) {
  if (!bodyEl) return;
  delete bodyEl.dataset.streaming;
  bodyEl.innerHTML = `<div class="intel-brief-copy"><p class="intel-brief-lede">${escapeHtml(text)}</p></div>`;
  requestAnimationFrame(layoutStack);
}

function createCardElement() {
  const id = `intel-brief-${++_cardSeq}`;
  const card = document.createElement('article');
  card.className = 'intel-brief-card is-active';
  card.dataset.cardId = id;
  card.setAttribute('aria-live', 'polite');
  card.innerHTML = `
    <div class="intel-brief-glow"></div>
    <div class="intel-brief-inner">
      <header class="intel-brief-header">
        <div class="intel-brief-heading">
          <span class="intel-brief-badge">INTEL</span>
          <h3 class="intel-brief-title">—</h3>
        </div>
        <button class="intel-brief-close" type="button" aria-label="Close intelligence brief" title="Close">×</button>
      </header>
      <div class="intel-brief-meta"></div>
      <div class="intel-brief-stream"></div>
      <footer class="intel-brief-status">Reading sector…</footer>
    </div>
  `;

  card.querySelector('.intel-brief-close')?.addEventListener('click', (event) => {
    event.stopPropagation();
    dismissCard(id);
  });

  card.addEventListener('click', () => {
    if (!card.classList.contains('is-peek') || !_stack) return;
    _stack.appendChild(card);
    layoutStack();
  });

  return {
    id,
    el: card,
    titleEl: card.querySelector('.intel-brief-title'),
    metaEl: card.querySelector('.intel-brief-meta'),
    bodyEl: card.querySelector('.intel-brief-stream'),
    statusEl: card.querySelector('.intel-brief-status'),
    streamController: null,
    releaseHighlight: null,
  };
}

function renderMetaChips(metaEl, chips) {
  if (!metaEl) return;
  metaEl.replaceChildren();
  for (const label of chips || []) {
    const span = document.createElement('span');
    span.className = 'intel-brief-chip';
    span.textContent = label;
    metaEl.appendChild(span);
  }
}

function setCardStatus(card, text) {
  if (card?.statusEl) card.statusEl.textContent = text;
}

function renderMarkdownLite(targetEl, text) {
  if (!targetEl) return;
  const escaped = String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  const html = escaped
    .replace(/^## (.+)$/gm, '<h4 class="intel-brief-h">$1</h4>')
    .replace(/^- (.+)$/gm, '<li>$1</li>')
    .replace(/(<li>.*<\/li>\n?)+/g, (block) => `<ul class="intel-brief-list">${block}</ul>`)
    .replace(/\n{2,}/g, '</p><p class="intel-brief-lede">')
    .replace(/\n/g, '<br>');
  targetEl.innerHTML = `<p class="intel-brief-lede">${html}</p>`;
}

function ensureStreamSlot(bodyEl) {
  let slot = bodyEl.querySelector('.intel-brief-stream-ai');
  if (!slot) {
    slot = document.createElement('div');
    slot.className = 'intel-brief-stream-ai';
    bodyEl.querySelector('.intel-brief-copy')?.appendChild(slot);
  }
  if (!slot.querySelector('.intel-brief-h')) {
    const heading = document.createElement('h4');
    heading.className = 'intel-brief-h';
    heading.textContent = 'Analysis';
    slot.appendChild(heading);
  }
  let shell = slot.querySelector('.intel-brief-copy--stream');
  if (!shell) {
    shell = document.createElement('div');
    shell.className = 'intel-brief-copy intel-brief-copy--stream';
    slot.appendChild(shell);
  }
  return shell;
}

function appendStreamText(bodyEl, text) {
  if (!bodyEl || !text) return;
  bodyEl.dataset.streaming = '1';

  if (bodyEl.dataset.visionPrimary === '1') {
    const lede = bodyEl.querySelector('.intel-brief-narrative') || bodyEl.querySelector('.intel-brief-lede');
    if (lede) {
      if (lede.textContent === VISION_PENDING_NARRATIVE) lede.textContent = '';
      lede.textContent += text;
      bodyEl.scrollTop = bodyEl.scrollHeight;
      return;
    }
  }

  const target = ensureStreamSlot(bodyEl);
  target.textContent += text;
  bodyEl.scrollTop = bodyEl.scrollHeight;
}

function finalizeStreamText(bodyEl, text) {
  if (!bodyEl) return;
  if (bodyEl.dataset.visionPrimary === '1') {
    const lede = bodyEl.querySelector('.intel-brief-narrative') || bodyEl.querySelector('.intel-brief-lede');
    if (lede) {
      lede.textContent = text;
      delete bodyEl.dataset.streaming;
      delete bodyEl.dataset.visionPrimary;
      return;
    }
  }
  renderMarkdownLite(ensureStreamSlot(bodyEl), text);
  delete bodyEl.dataset.streaming;
}

function updateCard(card, { title, chips, status, context, body }) {
  if (!card) return;
  if (title && card.titleEl) card.titleEl.textContent = title;
  if (chips) renderMetaChips(card.metaEl, chips);
  if (context) renderBriefContent(card.bodyEl, context);
  else if (body) renderNarrative(card.bodyEl, body);
  if (status) setCardStatus(card, status);
  requestAnimationFrame(layoutStack);
}

function dismissCard(id) {
  const card = _cards.get(id);
  if (!card) return;
  card.streamController?.abort();
  card.releaseHighlight?.();
  card.el.remove();
  _cards.delete(id);
  layoutStack();
}

function trimStack() {
  while (_cards.size > MAX_STACK_CARDS) {
    const oldest = _cards.keys().next().value;
    if (oldest === undefined) break;
    dismissCard(oldest);
  }
}

function clearStack() {
  for (const id of [..._cards.keys()]) dismissCard(id);
}

async function streamBrief(card, payload, context) {
  if (!card || !payload) return;

  card.streamController?.abort();
  card.streamController = new AbortController();
  const { signal } = card.streamController;

  setCardStatus(card, 'Connecting for analysis…');

  try {
    const response = await fetch(BRIEF_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal,
    });

    if (!_cards.has(card.id)) return;

    const contentType = String(response.headers.get('content-type') || '');
    if (contentType.includes('application/json')) {
      const data = await response.json().catch(() => null);
      if (isGeminiBriefUnconfigured(response.status, data)) {
        renderBriefContent(card.bodyEl, { ...context, visionPending: false });
        setCardStatus(card, 'On-device brief');
        return;
      }
      throw new Error(data?.error || `HTTP ${response.status}`);
    }

    if (!response.ok || !response.body) {
      throw new Error(`HTTP ${response.status}`);
    }

    setCardStatus(card, 'Streaming analysis…');
    delete card.bodyEl.dataset.streaming;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let full = '';

    while (true) {
      if (!_cards.has(card.id) || signal.aborted) break;
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      full += chunk;
      appendStreamText(card.bodyEl, chunk);
    }

    if (!_cards.has(card.id)) return;
    if (!full.trim()) {
      throw new Error('Gemini returned an empty brief');
    }
    finalizeStreamText(card.bodyEl, full);
    setCardStatus(card, 'Powered by Gemini');
  } catch (error) {
    if (error?.name === 'AbortError' || !_cards.has(card.id)) return;
    console.warn('[IntelBrief] stream failed:', error);
    const fallbackContext = { ...context, visionPending: false };
    renderBriefContent(card.bodyEl, fallbackContext);
    setCardStatus(card, context?.viewportCapture?.dataBase64 ? 'Vision unavailable — showing live data' : 'On-device brief');
  } finally {
    if (card.streamController?.signal === signal) card.streamController = null;
  }
}

function patchBriefEnrichment(card, context) {
  if (!card?.bodyEl || !_cards.has(card.id)) return;
  const visionActive = card.bodyEl.dataset.visionPrimary === '1' || card.bodyEl.dataset.streaming === '1';
  const parts = buildPlaceNarrativeParts(context);
  const copy = card.bodyEl.querySelector('.intel-brief-copy');
  if (!copy) {
    renderBriefContent(card.bodyEl, context);
    return;
  }

  if (!visionActive) {
    const lede = copy.querySelector('.intel-brief-narrative') || copy.querySelector('.intel-brief-lede');
    if (lede) lede.textContent = parts.narrative || parts.openingParagraph;

    copy.querySelectorAll('.intel-brief-prose, .intel-brief-tracks-more, .intel-brief-summary, .intel-brief-ambient')
      .forEach((node) => node.remove());
  }

  if (card.titleEl) {
    card.titleEl.textContent = formatRegionTitle({ place: context.place, bounds: context.bounds });
  }
  renderMetaChips(card.metaEl, metaChipsFromRegion(context));
  requestAnimationFrame(layoutStack);
}

async function enrichRegionalBrief(card, bounds, baseContext) {
  if (!bounds?.center || !_cards.has(card.id)) return;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 8000);

  try {
    const regional = await fetchRegionalBrief(bounds.center.lat, bounds.center.lon, {
      signal: controller.signal,
    });
    if (!_cards.has(card.id)) return;

    const enriched = {
      ...baseContext,
      place: regional?.place || baseContext.place,
      weather: regional?.weather || baseContext.weather,
      headlineTitles: normalizeHeadlineTitles(regional?.articles || []),
      headlines: regional?.articles || baseContext.headlines,
    };
    patchBriefEnrichment(card, enriched);
    if (!card.bodyEl?.dataset?.streaming) {
      setCardStatus(card, enriched.contacts?.length ? 'Sector picture ready' : 'Area scan complete');
    }
  } catch (error) {
    if (error?.name === 'AbortError' || !_cards.has(card.id)) return;
    console.warn('[IntelBrief] regional place lookup failed:', error);
    if (!card.bodyEl?.dataset?.streaming) {
      setCardStatus(card, baseContext.contacts?.length ? 'Sector picture ready' : 'Area scan complete');
    }
  } finally {
    clearTimeout(timeoutId);
  }
}

function enabledLayerSummary() {
  return (_dataManager?.getAll?.() || [])
    .filter((layer) => layer.enabled)
    .map((layer) => ({ id: layer.id, name: layer.name, count: layer.stats?.count || 0 }));
}

async function runRegionBrief({ bounds, rect, releaseHighlight }) {
  if (!bounds || !_dataManager || !ensureStack()) return;

  const card = createCardElement();
  card.releaseHighlight = typeof releaseHighlight === 'function' ? releaseHighlight : null;
  _cards.set(card.id, card);
  _stack.appendChild(card.el);
  trimStack();
  layoutStack();

  const areaKm2 = estimateBoundsAreaKm2(bounds);
  const geoReliable = isReliableMarqueeBounds(bounds, areaKm2);
  const landmarks = landmarksNearBounds(bounds, { areaKm2 });
  const contacts = collectRecordsInBounds(_dataManager, bounds, {
    viewer: _viewer,
    screenRect: rect || null,
  });

  updateCard(card, {
    title: formatRegionTitle({ bounds }),
    chips: metaChipsFromRegion({ bounds, areaKm2, contacts }),
    status: 'Capturing your view…',
    context: {
      bounds,
      areaKm2,
      geoReliable,
      contacts,
      place: null,
      weather: null,
      headlineTitles: [],
      headlines: [],
      enabledLayers: enabledLayerSummary(),
      landmarks,
      visionPending: true,
    },
  });

  const viewportCapture = _viewer && rect
    ? await captureMarqueeWhenReady(_viewer, rect)
    : null;

  const baseContext = {
    bounds,
    areaKm2,
    geoReliable,
    contacts,
    place: null,
    weather: null,
    headlineTitles: [],
    headlines: [],
    enabledLayers: enabledLayerSummary(),
    landmarks,
    viewportCapture,
    visionPending: Boolean(viewportCapture?.dataBase64),
  };
  const payload = buildRegionBriefPayload(baseContext);

  updateCard(card, {
    title: formatRegionTitle({ bounds }),
    chips: metaChipsFromRegion(baseContext),
    status: viewportCapture?.dataBase64 ? 'Analyzing what you highlighted…' : 'Live picture ready',
    context: baseContext,
  });

  void streamBrief(card, payload, baseContext);
  void enrichRegionalBrief(card, bounds, baseContext);
}

/**
 * @param {{ viewer?: object, dataManager?: object|null }} [options]
 */
export function initGeminiEntityBrief(options = {}) {
  _viewer = options.viewer || null;
  _dataManager = options.dataManager || null;
  if (!ensureStack()) return null;

  _marquee?.destroy?.();
  _marquee = _viewer
    ? createIntelBriefMarquee({
      viewer: _viewer,
      onComplete: ({ bounds, rect, releaseHighlight }) => runRegionBrief({ bounds, rect, releaseHighlight }),
    })
    : null;

  clearStack();

  return {
    destroy() {
      clearStack();
      _marquee?.destroy?.();
      _marquee = null;
      _viewer = null;
      _dataManager = null;
    },
  };
}

export default initGeminiEntityBrief;
