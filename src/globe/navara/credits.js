// Static credits on Navara's attribution UI (view.attribution, the
// AttributionPlugin). Navara matches entries by content and drops duplicates,
// so one HTML string is shown once and counted here, staying until its last
// holder removes it. Map credits and on-screen static credits share the
// application's credit strip; the full list stays behind Navara's button.

function createCreditStrip(view, counts) {
  const parent = view.canvas?.parentElement;
  const document = parent?.ownerDocument;
  const attribution = view.attribution;
  if (!document || !attribution) return { update() {}, destroy() {} };
  // Navara 0.2.1 exposes neither a credit snapshot nor a change event. Keep
  // its sanitizer and visible-tile tracking, refreshing the list while closed.
  for (const name of [
    'populateList',
    'requestRender',
    'displayedItems',
    'currentZoomLevel',
  ]) {
    if (typeof attribution[name] !== 'function')
      throw new Error(`Navara attribution API changed: ${name}`);
  }
  const { dock, listEl, logosEl } = attribution;
  if (!dock || !listEl || !logosEl)
    throw new Error('Navara attribution DOM is not ready');
  const dockParent = dock.parentElement;
  const logosParent = logosEl.parentElement;
  const strip = document.createElement('div');
  // Reuse Cesium's credit layout, including dock/mobile/recording clearance
  // and the panel obstacle measurements. The renderer owns its lifetime.
  strip.id = 'cesium-credits';
  strip.className = 'navara-credit-strip';
  const logos = document.createElement('span');
  logos.className = 'cesium-credit-logoContainer';
  const text = document.createElement('span');
  text.className = 'cesium-credit-textContainer';
  logos.appendChild(logosEl);
  strip.append(logos, text, dock);
  parent.appendChild(strip);

  function update() {
    const entries = new Set();
    attribution.displayedItems().forEach((item, index) => {
      const holders = counts.get(item.attributionHtml);
      if (holders && !holders.onScreen) return;
      const row = listEl.children[index];
      if (!item.logo) {
        const name = row.querySelector('.navara-attr-name').lastElementChild;
        entries.add(name.innerHTML);
      }
      for (const credit of row.querySelectorAll('.navara-attr-related > li'))
        entries.add(credit.innerHTML);
    });
    const html = [...entries]
      .map((entry) => `<span class="cesium-credit-wrapper">${entry}</span>`)
      .join('<span class="cesium-credit-delimiter"> • </span>');
    if (text.innerHTML !== html) text.innerHTML = html;
  }

  const { populateList, requestRender } = attribution;
  attribution.populateList = function () {
    populateList.call(this);
    update();
  };
  attribution.requestRender = () => attribution.populateList();
  const updateZoom = () => {
    if (!attribution.hasZoomBands) return;
    const zoom = attribution.currentZoomLevel();
    if (zoom === attribution.lastZoomLevel) return;
    attribution.lastZoomLevel = zoom;
    attribution.requestRender();
  };
  view.on('preRender', updateZoom);
  attribution.populateList();
  return {
    update,
    destroy() {
      view.off('preRender', updateZoom);
      attribution.populateList = populateList;
      attribution.requestRender = requestRender;
      dockParent.appendChild(dock);
      logosParent.appendChild(logosEl);
      strip.remove();
    },
  };
}

/**
 * @param {{ attribution?: { add: Function, remove: Function } }} view
 * @returns {{ credits: object, destroy: () => void }}
 */
export function createNavaraCredits(view) {
  const counts = new Map();
  const strip = createCreditStrip(view, counts);
  let destroyed = false;
  const release = (html, onScreen) => {
    const count = counts.get(html);
    if (!count) return;
    count.total--;
    if (onScreen) count.onScreen--;
    if (count.total === 0) {
      counts.delete(html);
      view.attribution?.remove([{ attributionHtml: html }]);
    }
    strip.update();
  };
  const credits = {
    addStatic(html, { onScreen = false } = {}) {
      if (destroyed) return () => {};
      const text = String(html);
      const count = counts.get(text) ?? { total: 0, onScreen: 0 };
      count.total++;
      if (onScreen) count.onScreen++;
      counts.set(text, count);
      if (count.total === 1) view.attribution?.add([{ attributionHtml: text }]);
      strip.update();
      let removed = false;
      return () => {
        if (removed) return;
        removed = true;
        release(text, onScreen);
      };
    },
  };
  return {
    credits,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      for (const html of [...counts.keys()]) {
        counts.delete(html);
        view.attribution?.remove([{ attributionHtml: html }]);
      }
      strip.destroy();
    },
  };
}
