import catalog from './local_data/world_desk_events.json' with { type: 'json' };

export const WORLD_DESK_ERA_START = catalog.eraStart;
export const WORLD_DESK_ERA_END = catalog.eraEnd;
export const WORLD_DESK_CATEGORIES = Object.freeze(catalog.categories);
export const WORLD_DESK_DISCLAIMER = catalog.disclaimer;
export const WORLD_DESK_HISTORY = Object.freeze(catalog.events);

const CATEGORY_IDS = new Set(WORLD_DESK_CATEGORIES.map((row) => row.id));

export function formatWorldDeskYear(year) {
  const value = Number(year);
  if (!Number.isFinite(value)) return '';
  if (value < 0) return `${Math.abs(value)} BCE`;
  if (value === 0) return '1 BCE/CE';
  return `${value} CE`;
}

function eventEndYear(event, start) {
  const raw = event?.yearEnd;
  if (raw == null || raw === '') return start;
  const end = Number(raw);
  return Number.isFinite(end) ? end : start;
}

export function eventActiveInYear(event, year) {
  const start = Number(event?.year);
  if (!Number.isFinite(start)) return false;
  const end = eventEndYear(event, start);
  return year >= Math.min(start, end) && year <= Math.max(start, end);
}

export function filterWorldDeskEvents(events, { year, categories } = {}) {
  const rows = Array.isArray(events) ? events : [];
  const allowed = Array.isArray(categories) && categories.length
    ? new Set(categories.filter((id) => CATEGORY_IDS.has(id)))
    : null;
  const y = Number(year);
  return rows.filter((event) => {
    if (allowed && !allowed.has(event.category)) return false;
    if (Number.isFinite(y) && !eventActiveInYear(event, y)) return false;
    return true;
  });
}

export function eventsVisibleOnPlayhead(events, year, windowYears = 40) {
  const y = Number(year);
  const span = Math.max(1, Number(windowYears) || 40);
  return (Array.isArray(events) ? events : []).filter((event) => {
    const start = Number(event.year);
    if (!Number.isFinite(start) || !Number.isFinite(y)) return false;
    const end = eventEndYear(event, start);
    return end >= y - span && start <= y + Math.min(8, span / 5);
  });
}

export { catalog as WORLD_DESK_CATALOG };
