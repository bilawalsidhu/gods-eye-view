import { driveBcSeverityStyle } from './severity.js';

const EDGE = 8;
const GAP = 14;
const FALLBACK_WIDTH = 304;
const FALLBACK_HEIGHT = 220;

function trustedEventUrl(value) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'api.open511.gov.bc.ca'
      ? url.href
      : null;
  } catch {
    return null;
  }
}

function addField(document, parent, label) {
  const row = document.createElement('div');
  row.className = 'drivebc-event-field';
  const name = document.createElement('span');
  name.className = 'drivebc-event-field-label';
  name.textContent = label;
  const value = document.createElement('span');
  value.className = 'drivebc-event-field-value';
  row.append(name, value);
  parent.appendChild(row);
  return value;
}

/** A small, safely text-rendered map popup for one selected DriveBC event. */
export function createDriveBcEventPopup({ container } = {}) {
  const document = container?.ownerDocument;
  if (!container || typeof document?.createElement !== 'function')
    throw new TypeError('DriveBC event details require a DOM container');

  const root = document.createElement('section');
  root.className = 'drivebc-event-popup';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', 'DriveBC road event details');
  root.setAttribute('aria-live', 'polite');
  root.hidden = true;

  const header = document.createElement('header');
  header.className = 'drivebc-event-popup-header';
  const title = document.createElement('h2');
  title.className = 'drivebc-event-popup-title';
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'drivebc-event-popup-close';
  close.setAttribute('aria-label', 'Close DriveBC event details');
  close.textContent = '×';
  header.append(title, close);

  const severity = document.createElement('div');
  severity.className = 'drivebc-event-severity';
  const swatch = document.createElement('span');
  swatch.className = 'drivebc-event-severity-swatch';
  swatch.setAttribute('aria-hidden', 'true');
  const severityText = document.createElement('span');
  severity.append(swatch, severityText);

  const fields = document.createElement('div');
  fields.className = 'drivebc-event-fields';
  const type = addField(document, fields, 'TYPE');
  const updated = addField(document, fields, 'UPDATED');

  const description = document.createElement('p');
  description.className = 'drivebc-event-description';
  const link = document.createElement('a');
  link.className = 'drivebc-event-link';
  link.textContent = 'Open DriveBC event details ↗';
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.hidden = true;

  root.append(header, severity, fields, description, link);
  container.appendChild(root);

  let listening = false;
  const onKeyDown = (event) => {
    if (event.key === 'Escape' && !root.hidden) {
      event.preventDefault();
      hide();
    }
  };
  const removeKeyListener = () => {
    if (!listening) return;
    document.removeEventListener('keydown', onKeyDown);
    listening = false;
  };
  function hide() {
    root.hidden = true;
    removeKeyListener();
  }
  close.addEventListener('click', hide);

  return {
    show(event, position) {
      if (
        !event ||
        !position ||
        !Number.isFinite(position.x) ||
        !Number.isFinite(position.y)
      )
        return false;
      const style = driveBcSeverityStyle(event.severity);
      title.textContent = event.headline || event.eventType || 'BC road event';
      severityText.textContent = event.severity
        ? `${String(event.severity).toUpperCase()} · ${style.colorName}`
        : `UNSPECIFIED · ${style.colorName}`;
      swatch.style.background = style.color;
      root.dataset.severity = style.key.toLowerCase();
      type.textContent = event.eventType || 'Unspecified';
      updated.textContent = event.updated || 'Update time unavailable';
      description.textContent =
        event.description || 'No additional event description.';
      const url = trustedEventUrl(event.url);
      if (url) {
        link.href = url;
        link.hidden = false;
      } else {
        link.removeAttribute('href');
        link.hidden = true;
      }
      root.dataset.eventId = String(event.id || '');
      root.hidden = false;
      if (!listening) {
        document.addEventListener('keydown', onKeyDown);
        listening = true;
      }

      const bounds = container.getBoundingClientRect();
      const width = root.offsetWidth || FALLBACK_WIDTH;
      const height = root.offsetHeight || FALLBACK_HEIGHT;
      const maxLeft = Math.max(EDGE, bounds.width - width - EDGE);
      const maxTop = Math.max(EDGE, bounds.height - height - EDGE);
      root.style.left = `${Math.min(Math.max(EDGE, position.x + GAP), maxLeft)}px`;
      root.style.top = `${Math.min(Math.max(EDGE, position.y + GAP), maxTop)}px`;
      return true;
    },
    hide,
    destroy() {
      hide();
      close.removeEventListener('click', hide);
      root.remove();
    },
    element: root,
  };
}
