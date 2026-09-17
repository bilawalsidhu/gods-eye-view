const CARD_CSS = `
.gev-wind-reading {
  position: absolute; right: 16px; bottom: 112px; z-index: 220;
  box-sizing: border-box; width: min(280px, calc(100% - 24px));
  max-height: calc(100% - 140px); overflow-y: auto; scrollbar-width: thin; scrollbar-color: #58717d transparent;
  padding: 16px; border: 1px solid rgba(105, 216, 231, .45);
  border-radius: 12px; background: rgba(7, 22, 31, .96);
  color: #e8f4f7; box-shadow: 0 8px 28px rgba(0, 0, 0, .3);
  font: 13px/1.45 system-ui, sans-serif; pointer-events: auto;
}
.gev-wind-reading[hidden] { display: none; }
.gev-wind-reading * { box-sizing: border-box; }
.gev-wind-reading__header { display: flex; align-items: center; gap: 12px; }
.gev-wind-reading__title { margin: 0; flex: 1; font: 600 16px/1.3 system-ui, sans-serif; }
.gev-wind-reading__close {
  min-width: 36px; min-height: 36px; border: 1px solid #58717d;
  border-radius: 6px; background: transparent; color: #e8f4f7;
  font: 22px/1 system-ui, sans-serif; cursor: pointer;
}
.gev-wind-reading__close:hover { background: #193a47; }
.gev-wind-reading__close:focus-visible { outline: 2px solid #75e9ff; outline-offset: 3px; }
.gev-wind-reading__context { margin: 3px 0 0; color: #a7bec8; font-size: 11px; }
.gev-wind-reading__coordinates { margin: 4px 0 14px; font-variant-numeric: tabular-nums; }
.gev-wind-reading__wind { margin: 0; font-size: 25px; line-height: 1.2; font-weight: 650; }
.gev-wind-reading[data-scalar="true"] .gev-wind-reading__wind { margin-top: 10px; font-size: 15px; font-weight: 400; }
.gev-wind-reading[data-scalar="true"] .gev-wind-reading__scalar { display: flex; flex-direction: column; margin: 0; }
.gev-wind-reading[data-scalar="true"] .gev-wind-reading__scalar-value { font-size: 25px; line-height: 1.2; font-weight: 650; }
.gev-wind-reading[data-scalar="true"] .gev-wind-reading__scalar-label { font-size: 12px; margin-bottom: 4px; }
.gev-wind-reading__scalar { margin: 10px 0 0; font-size: 15px; }
.gev-wind-reading__scalar-label { color: #a7bec8; margin-right: 8px; }
.gev-wind-reading__metadata { margin-top: 14px; padding-top: 10px; border-top: 1px solid #29424d; }
.gev-wind-reading__metadata p { margin: 3px 0; overflow-wrap: anywhere; }
.gev-wind-reading__status { color: #9ce4ee; font-weight: 600; }
.gev-wind-reading__explanation { margin: 10px 0 0; color: #a7bec8; font-size: 12px; }
@media (max-width: 480px) {
  .gev-wind-reading { right: 12px; bottom: calc(2vh + 8rem); padding: 12px; max-height: min(30svh, calc(100% - 140px)); }
}
`;

/** Owned, on-demand reading surface. Values and freshness come from the caller. */
export function createWindPresentation({ container, onClose = () => {} } = {}) {
  const document = container?.ownerDocument;
  if (!document?.createElement || !container?.appendChild) {
    throw new TypeError('Wind presentation requires a DOM container');
  }
  let destroyed = false;
  let returnFocus = null;
  const make = (tag, suffix, text) => {
    const element = document.createElement(tag);
    element.className = `gev-wind-reading${suffix ? `__${suffix}` : ''}`;
    if (text !== undefined) element.textContent = text;
    return element;
  };
  const style = document.createElement('style');
  style.textContent = CARD_CSS;
  const card = make('section', '');
  card.hidden = true;
  card.setAttribute('aria-label', 'Weather here');
  const header = make('div', 'header');
  const title = make('h2', 'title', 'Weather here');
  const close = make('button', 'close', '×');
  close.type = 'button';
  close.setAttribute('aria-label', 'Close weather reading');
  header.appendChild(title);
  header.appendChild(close);
  const context = make('p', 'context', 'Map center at inspection');
  const coordinates = make('p', 'coordinates');
  const wind = make('p', 'wind');
  const scalar = make('p', 'scalar');
  const scalarLabel = make('span', 'scalar-label');
  const scalarValue = make('span', 'scalar-value');
  scalar.appendChild(scalarLabel);
  scalar.appendChild(scalarValue);
  const metadata = make('div', 'metadata');
  const model = make('p', 'model');
  const validTime = make('p', 'valid-time');
  const status = make('p', 'status');
  status.setAttribute('role', 'status');
  metadata.appendChild(model);
  metadata.appendChild(validTime);
  metadata.appendChild(status);
  const explanation = make('p', 'explanation');
  for (const node of [
    header,
    context,
    coordinates,
    scalar,
    wind,
    metadata,
    explanation,
  ]) {
    card.appendChild(node);
  }
  // Model/field changes hide silently: they must not move the user's focus.
  const hide = () => {
    card.hidden = true;
    returnFocus = null;
  };
  const dismiss = () => {
    if (destroyed) return;
    const target = returnFocus;
    hide();
    onClose();
    if (target?.isConnected) target.focus?.({ preventScroll: true });
  };
  const keydown = (event) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    dismiss();
  };
  close.addEventListener('click', dismiss);
  card.addEventListener('keydown', keydown);
  container.appendChild(style);
  container.appendChild(card);
  const text = (element, value) => {
    element.textContent = value == null ? '' : String(value);
    element.hidden = !element.textContent;
  };
  return {
    show(reading = {}) {
      if (destroyed) return;
      text(coordinates, reading.coordinates);
      text(wind, reading.wind);
      text(scalarLabel, reading.scalarLabel);
      text(scalarValue, reading.scalarValue);
      scalar.hidden = scalarValue.hidden;
      card.setAttribute('data-scalar', String(!scalarValue.hidden));
      text(model, reading.model);
      text(validTime, reading.validTime ? `Valid ${reading.validTime}` : '');
      text(status, reading.status);
      text(explanation, reading.explanation);
      if (!card.contains(document.activeElement))
        returnFocus = document.activeElement;
      card.hidden = false;
      close.focus({ preventScroll: true });
    },
    hide,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      returnFocus = null;
      close.removeEventListener('click', dismiss);
      card.removeEventListener('keydown', keydown);
      card.remove();
      style.remove();
    },
  };
}
