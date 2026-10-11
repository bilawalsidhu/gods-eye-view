import { normalizeVesselType, vesselTypeCss } from './vesselLabels.js';

/** Only reported AIS types determine the shape; names never imply a type. */
export function vesselIconFamily(type) {
  const text = normalizeVesselType(type);
  if (/tanker/i.test(text)) return 'tanker';
  if (/passenger|ferry|cruise/i.test(text)) return 'passenger';
  if (/cargo|container|bulk|carrier/i.test(text)) return 'cargo';
  if (/fishing/i.test(text)) return 'fishing';
  if (/sailing/i.test(text)) return 'sailing';
  if (/pleasure|yacht/i.test(text)) return 'pleasure';
  if (/military|law enforce/i.test(text)) return 'military';
  if (
    /tug|tow|pilot|supply|service|sar|tender|dredg|dive|pollution|medical/i.test(
      text,
    )
  )
    return 'service';
  return 'unknown';
}

const ZOOM_SIZES = [
  [2_000, 44],
  [10_000, 40],
  [100_000, 32],
  [1_000_000, 24],
  [5_000_000, 18],
  [20_000_000, 14],
];

/** Moving contacts follow COG; stationary contacts retain reported heading. */
export function vesselMotionCourse(record) {
  const valid = (angle) => Number.isFinite(angle) && angle >= 0 && angle < 360;
  const course = valid(record?.course) ? record.course : null;
  const heading = valid(record?.heading) ? record.heading : null;
  if (Number.isFinite(record?.speed) && record.speed >= 0.5 && course !== null)
    return course;
  return heading ?? course;
}

/** Bounded screen size with continuous interpolation across camera heights. */
export function vesselIconScale(type, cameraHeightM = 100_000) {
  const rawHeight = Number(cameraHeightM);
  const height = Number.isFinite(rawHeight) ? Math.max(1, rawHeight) : 100_000;
  let pixels = ZOOM_SIZES[0][1];
  for (let i = 1; i < ZOOM_SIZES.length; i++) {
    const [nearHeight, nearSize] = ZOOM_SIZES[i - 1];
    const [farHeight, farSize] = ZOOM_SIZES[i];
    pixels = farSize;
    if (height <= farHeight) {
      const t = Math.max(
        0,
        Math.min(
          1,
          Math.log(height / nearHeight) / Math.log(farHeight / nearHeight),
        ),
      );
      pixels = nearSize + (farSize - nearSize) * t;
      break;
    }
  }
  const familyScale = vesselIconFamily(type) === 'tanker' ? 44 / 36 : 1;
  return (pixels * familyScale) / 64;
}

// Original zenith-view pictograms, informed by real ship plans and commercial
// top-view references. Broad masses and negative spaces survive map-sized use.
const HULLS = {
  cargo: 'M32 3 Q40 8 44 17 L45 52 L44 61 H20 L19 52 L20 17 Q24 8 32 3 Z',
  tanker:
    'M32 3 C40 3 43 9 43 16 V47 H45 V51 H43 V59 Q32 63 21 59 V51 H19 V47 H21 V16 C21 9 24 3 32 3 Z',
  passenger:
    'M32 3 C41 6 46 14 46 24 V53 L43 61 H21 L18 53 V24 C18 14 23 6 32 3 Z',
  fishing: 'M32 9 Q43 17 43 27 V56 H21 V27 Q21 17 32 9 Z',
  sailing: 'M32 4 C39 18 40 34 38 47 L35 59 H29 L26 47 C24 34 25 18 32 4 Z',
  pleasure: 'M32 3 C41 16 44 35 42 48 L40 59 H24 L22 48 C20 35 23 16 32 3 Z',
  service:
    'M32 12 C44 12 48 23 48 33 V43 C48 54 42 59 32 59 C22 59 16 54 16 43 V33 C16 23 20 12 32 12 Z',
  military: 'M32 3 L38 13 L41 31 V47 L39 61 H25 L23 47 V31 L26 13 Z',
  unknown: 'M32 6 Q42 17 42 28 V54 Q42 60 32 60 Q22 60 22 54 V28 Q22 17 32 6 Z',
};

const rect = (x, y, w, h, fill, radius = 0) =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${radius}" fill="${fill}"/>`;
const line = (d, color, width = 1) =>
  `<path d="${d}" fill="none" stroke="${color}" stroke-width="${width}"/>`;
const path = (d, fill) => `<path d="${d}" fill="${fill}"/>`;

function deckPlan(family, ink, color) {
  switch (family) {
    case 'tanker':
      // Clear liquid-cargo deck, central pipe trunk and compact aft house.
      return (
        line('M30 14 V43 M34 14 V43 M26 32 H38', ink, 2) +
        rect(24, 48, 16, 9, ink, 1) +
        rect(29, 59, 6, 2, ink)
      );
    case 'cargo':
      // Large grouped rectangular holds/loads, rather than tiny container ribs.
      return (
        [18, 28, 38]
          .map((y) => rect(23, y, 8, 8, ink) + rect(33, y, 8, 8, ink))
          .join('') + rect(23, 50, 18, 7, ink, 0.5)
      );
    case 'passenger':
      // Long continuous upper deck, stepped balconies and two funnel openings.
      return (
        path(
          'M32 12 Q41 18 41 26 V51 L38 56 H26 L23 51 V26 Q23 18 32 12 Z',
          ink,
        ) +
        rect(26, 24, 12, 22, color, 4) +
        rect(29, 28, 6, 5, ink, 1) +
        rect(29, 37, 6, 5, ink, 1) +
        line('M18 29 H22 M42 29 H46 M18 39 H22 M42 39 H46', ink, 3)
      );
    case 'fishing':
      // Working stern and broad trawling booms form the recognizable outline.
      return (
        line('M24 33 L11 21 V39 M40 33 L53 21 V39', color, 3.5) +
        rect(24, 23, 16, 10, ink, 1) +
        rect(25, 40, 14, 12, ink, 0.5)
      );
    case 'sailing':
      return (
        path('M30 10 L10 39 H30 Z M34 19 L52 39 H34 Z', color) +
        line('M32 9 V42', ink, 2) +
        rect(29, 45, 6, 11, ink, 2)
      );
    case 'pleasure':
      return (
        path('M32 17 Q39 25 39 33 L36 38 H28 L25 33 Q25 25 32 17 Z', ink) +
        rect(27, 44, 10, 11, ink, 1) +
        line('M24 59 H40', ink, 2)
      );
    case 'service':
      // Stubby hull, thick wrap-around fender and forward wheelhouse.
      return (
        line('M19 30 V44 Q19 56 32 56 Q45 56 45 44 V30', ink, 3) +
        rect(23, 24, 18, 12, ink, 3) +
        '<circle cx="32" cy="46" r="4" fill="' +
        ink +
        '"/>'
      );
    case 'military':
      return (
        path('M28 16 H36 L38 20 L35 24 H29 L26 20 Z', ink) +
        line('M32 9 V20', ink, 2.5) +
        path('M32 27 L38 32 V43 H26 V32 Z', ink) +
        rect(27, 48, 10, 10, ink, 1)
      );
    default:
      return '';
  }
}

/** North-pointing silhouettes retain the existing screen-projected heading. */
export function vesselIconSvg(type, selected = false) {
  const family = vesselIconFamily(type);
  const color = vesselTypeCss(type);
  const ink = '#071922';
  const hull = HULLS[family];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64" data-family="${family}">
    <g stroke-linejoin="round" stroke-linecap="round">
      <path d="${hull}" fill="${color}" stroke="${ink}" stroke-width="3"/>
      <path d="${hull}" fill="${color}" stroke="${selected ? '#ffffff' : '#e9f4f8'}" stroke-opacity="${selected ? 1 : 0.55}" stroke-width="${selected ? 2 : 0.8}"/>
      ${deckPlan(family, ink, color)}
    </g>
  </svg>`;
}
