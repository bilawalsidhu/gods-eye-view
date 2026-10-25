/**
 * Inline SVG icon set for layer rows, tool buttons and status chips.
 *
 * Sizes follow the surrounding text: every glyph is 1em square and strokes
 * use `currentColor`, so a host span only needs a font-size. Paths are kept
 * deliberately simple; they are static markup, never built from user data.
 */
const svg = (body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

export const ICONS = Object.freeze({
  plane: svg(
    '<path d="M12 2.6c.9 0 1.3.8 1.3 1.7V10l7.2 4.5v1.8l-7.2-2v4l2.2 2.8v1.4L12 21.2l-3.5 1.3v-1.4l2.2-2.8v-4l-7.2 2v-1.8L10.7 10V4.3c0-.9.4-1.7 1.3-1.7z" fill="currentColor" stroke="none"/>',
  ),
  medal: svg(
    '<path d="M8 3h8l-2.6 7.2h-2.8z"/><circle cx="12" cy="14.6" r="4.4"/><path d="M12 12.9l.7 1.5 1.6.2-1.2 1.1.3 1.6-1.4-.8-1.4.8.3-1.6-1.2-1.1 1.6-.2z" fill="currentColor" stroke="none"/>',
  ),
  antenna: svg(
    '<path d="M12 21v-8"/><path d="M12 13l-5 8M12 13l5 8"/><circle cx="12" cy="9" r="1.8"/><path d="M9 6.2a4.5 4.5 0 0 1 6 0M6.6 3.8a8.2 8.2 0 0 1 10.8 0"/>',
  ),
  flame: svg(
    '<path d="M12 2.5c.8 3.2-2.4 4.2-2.4 7.2 0 1 .6 1.8 1.4 2.3-.3-1.5.3-2.8 1.6-3.4-.7 3 3 4.3 3 7.9a5.6 5.6 0 0 1-11.2 0c0-2.9 2-4.2 3.1-6.4.3 1.1 1 1.9 2 2.3C8.6 9.8 9.2 5.6 12 2.5z"/>',
  ),
  satellite: svg(
    '<rect x="9.8" y="9.8" width="4.4" height="4.4" rx="1"/><rect x="2.6" y="9" width="5.2" height="6" rx="0.8"/><rect x="16.2" y="9" width="5.2" height="6" rx="0.8"/><path d="M9.8 12H7.8M16.2 12h-2M12 9.8V6.5M12 14.2v3.3"/><path d="M10.5 4l3 1M13.5 20l-3-1"/>',
  ),
  camera: svg(
    '<rect x="3" y="7.5" width="18" height="12" rx="2"/><circle cx="12" cy="13.5" r="3.4"/><path d="M8.5 7.5L10 5h4l1.5 2.5"/>',
  ),
  video: svg(
    '<rect x="2.8" y="7" width="12.6" height="10" rx="2"/><path d="M15.4 10.6l5.8-3v8.8l-5.8-3"/>',
  ),
  bike: svg(
    '<circle cx="6" cy="16.5" r="3.2"/><circle cx="18" cy="16.5" r="3.2"/><path d="M6 16.5l3.6-7.5H15l3 7.5M9.6 9L8.5 6.4h2.7M13.5 9l1.5 7.5"/>',
  ),
  car: svg(
    '<path d="M4.5 12.5l1.6-4.6A1.8 1.8 0 0 1 7.8 6.5h8.4a1.8 1.8 0 0 1 1.7 1.4l1.6 4.6"/><rect x="3" y="12.5" width="18" height="4.8" rx="1.4"/><path d="M6.5 17.3v2.2M17.5 17.3v2.2"/><circle cx="7.6" cy="14.9" r="0.6" fill="currentColor"/><circle cx="16.4" cy="14.9" r="0.6" fill="currentColor"/>',
  ),
  bus: svg(
    '<rect x="4" y="3.8" width="16" height="13.7" rx="2"/><path d="M4 10h16M7 17.5v2M17 17.5v2"/><circle cx="8" cy="13.8" r="0.7" fill="currentColor"/><circle cx="16" cy="13.8" r="0.7" fill="currentColor"/>',
  ),
  wind: svg(
    '<path d="M3 8h8.5a2.4 2.4 0 1 0-2.4-2.4M3 12.5h14.5a2.4 2.4 0 1 1-2.4 2.4M3 17h7"/>',
  ),
  volcano: svg(
    '<path d="M9.5 4h5l1.8 6 4.2 11H3.5l4.2-11z"/><path d="M8.8 8h6.4"/><path d="M12 4V2.2M9 2.8l.6 1.2M15 2.8l-.6 1.2"/>',
  ),
  compass: svg(
    '<circle cx="12" cy="12" r="8.6"/><path d="M15.6 8.4l-2.3 4.9-4.9 2.3 2.3-4.9z"/>',
  ),
  waves: svg(
    '<path d="M2.5 11.5c2.5 0 2.5 2.3 5 2.3s2.4-2.3 4.9-2.3 2.4 2.3 4.8 2.3 2.4-2.3 4.3-2.3M2.5 17c2.5 0 2.5 2.3 5 2.3s2.4-2.3 4.9-2.3 2.4 2.3 4.8 2.3 2.4-2.3 4.3-2.3"/>',
  ),
  pin: svg(
    '<path d="M19.5 10c0 6.2-7.5 11.5-7.5 11.5S4.5 16.2 4.5 10a7.5 7.5 0 0 1 15 0z"/><circle cx="12" cy="10" r="2.6"/>',
  ),
  rocket: svg(
    '<path d="M12 2.5c2.9 2.2 4 6 4 9.2l2.8 2.8v2.8h-3.4l-3.4 2.2-3.4-2.2H5.2v-2.8L8 11.7c0-3.2 1.1-7 4-9.2z"/><circle cx="12" cy="10" r="1.7"/>',
  ),
});
