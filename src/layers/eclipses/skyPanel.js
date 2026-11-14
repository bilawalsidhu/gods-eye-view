/**
 * The sky view: a picture of the Sun and the Moon crossing it, as seen from
 * one spot on the ground, with a caption, in a corner of the globe. The layer
 * says what to show (see skyViewAt); this module only paints it.
 */

const SIZE = 176;
/** The Sun's radius as a share of the picture's side. */
const SUN_SHARE = 30 / SIZE;
const DAY = [58, 128, 214];
const NIGHT = [6, 9, 22];
/** Where the stars sit, as shares of the picture, with their brightness. */
const STARS = [
  [0.12, 0.2, 0.9],
  [0.3, 0.62, 0.6],
  [0.42, 0.14, 0.8],
  [0.58, 0.36, 0.5],
  [0.7, 0.78, 0.7],
  [0.82, 0.24, 1],
  [0.9, 0.56, 0.6],
  [0.2, 0.86, 0.5],
  [0.5, 0.9, 0.7],
  [0.06, 0.52, 0.6],
  [0.94, 0.9, 0.5],
  [0.66, 0.08, 0.6],
  [0.36, 0.34, 0.4],
  [0.78, 0.46, 0.4],
  [0.16, 0.7, 0.4],
  [0.88, 0.1, 0.5],
];

const mix = (a, b, t) =>
  a.map((value, i) => Math.round(value + (b[i] - value) * t));
const rgb = (color, alpha = 1) =>
  `rgba(${color[0]}, ${color[1]}, ${color[2]}, ${alpha})`;

/**
 * How dark the sky looks with `covered` of the Sun hidden: the eye barely
 * notices until most of it is gone, then the light falls away fast.
 */
export function skyDarkness(view) {
  if (view.phase === 'total') return 1;
  return 0.82 * view.covered ** 6;
}

function paintStars(context, width, height, strength) {
  if (strength <= 0) return;
  const dot = Math.max(1.2, Math.min(width, height) / 260);
  for (const [x, y, brightness] of STARS) {
    context.fillStyle = `rgba(255, 255, 255, ${0.8 * brightness * strength})`;
    context.fillRect(x * width, y * height, dot, dot);
  }
}

/**
 * Paint one sky view onto a 2D context, `width` by `height` pixels, with the
 * Sun at its centre. The picture's scale goes by the shorter side.
 */
export function paintSky(context, view, width = SIZE, height = width) {
  const size = Math.min(width, height);
  const cx = width / 2;
  const cy = height / 2;
  const sun = SUN_SHARE * size;
  context.clearRect(0, 0, width, height);
  if (view.night) {
    // The Sun is down: nothing of the eclipse shows from here.
    context.fillStyle = rgb(NIGHT);
    context.fillRect(0, 0, width, height);
    paintStars(context, width, height, 0.9);
    return;
  }
  const dark = skyDarkness(view);
  const sky = mix(DAY, NIGHT, dark);

  // The sky, lighter toward the horizon; in totality the horizon glows all
  // the way round, like a sunset in every direction.
  const backdrop = context.createLinearGradient(0, 0, 0, height);
  backdrop.addColorStop(0, rgb(mix(sky, [8, 20, 70], 0.42)));
  backdrop.addColorStop(0.55, rgb(sky));
  backdrop.addColorStop(
    1,
    rgb(mix(mix(sky, [226, 238, 250], 0.55), [255, 150, 70], dark * 0.75)),
  );
  context.fillStyle = backdrop;
  context.fillRect(0, 0, width, height);
  // The brighter stars and planets come out as the light goes.
  paintStars(context, width, height, (dark - 0.55) / 0.45);

  if (view.phase === 'total') {
    // The corona: a soft halo with a few longer streamers.
    const halo = context.createRadialGradient(
      cx,
      cy,
      sun * 0.95,
      cx,
      cy,
      sun * 2.7,
    );
    halo.addColorStop(0, 'rgba(255, 255, 255, 0.95)');
    halo.addColorStop(0.18, 'rgba(235, 242, 255, 0.5)');
    halo.addColorStop(0.5, 'rgba(200, 220, 255, 0.16)');
    halo.addColorStop(1, 'rgba(200, 220, 255, 0)');
    context.fillStyle = halo;
    context.fillRect(0, 0, width, height);
    context.save();
    context.translate(cx, cy);
    context.globalCompositeOperation = 'lighter';
    for (const [angle, reach] of [
      [0.35, 3.1],
      [1.5, 2.3],
      [2.7, 2.9],
      [3.6, 3.3],
      [4.6, 2.4],
      [5.6, 2.8],
    ]) {
      context.save();
      context.rotate(angle);
      const streamer = context.createLinearGradient(0, 0, sun * reach, 0);
      streamer.addColorStop(0.3, 'rgba(255, 255, 255, 0.28)');
      streamer.addColorStop(1, 'rgba(255, 255, 255, 0)');
      context.fillStyle = streamer;
      context.beginPath();
      context.ellipse(
        sun * reach * 0.5,
        0,
        sun * reach * 0.5,
        sun * 0.34,
        0,
        0,
        7,
      );
      context.fill();
      context.restore();
    }
    context.restore();
  } else {
    // The Sun by day: the sky whitens toward it, and the disc itself is
    // white-hot with a warm, slightly dimmer limb.
    const light = 1 - view.covered;
    const aureole = context.createRadialGradient(cx, cy, sun, cx, cy, size);
    aureole.addColorStop(0, `rgba(255, 252, 240, ${0.5 * light + 0.08})`);
    aureole.addColorStop(0.18, `rgba(240, 246, 255, ${0.26 * light + 0.04})`);
    aureole.addColorStop(0.5, `rgba(225, 238, 255, ${0.1 * light})`);
    aureole.addColorStop(1, 'rgba(225, 238, 255, 0)');
    context.fillStyle = aureole;
    context.fillRect(0, 0, width, height);
    const disc = context.createRadialGradient(cx, cy, 0, cx, cy, sun);
    disc.addColorStop(0, '#ffffff');
    disc.addColorStop(0.62, '#fffdf2');
    disc.addColorStop(0.9, '#fff3c4');
    disc.addColorStop(1, '#ffd98a');
    context.fillStyle = disc;
    context.beginPath();
    context.arc(cx, cy, sun, 0, 7);
    context.fill();
  }

  if (view.phase !== 'none') {
    // The Moon's near side is unlit: it shows only as the sky's own colour
    // cut out of the Sun, or black against the corona.
    const x = cx + view.moonX * sun;
    const y = cy - view.moonY * sun;
    context.save();
    if (view.phase !== 'total') {
      // By day the Moon is lost in the glare: only its bite out of the Sun
      // shows, as bright sky.
      context.beginPath();
      context.arc(cx, cy, sun + 0.5, 0, 7);
      context.clip();
    }
    context.fillStyle =
      view.phase === 'total'
        ? '#05060c'
        : rgb(mix(sky, [255, 252, 240], 0.3 + 0.3 * (1 - view.covered)));
    context.beginPath();
    context.arc(x, y, view.moonRadius * sun, 0, 7);
    context.fill();
    context.restore();

    // The diamond ring: the last bead of sunlight just outside totality.
    const gap = view.distance - (view.moonRadius - 1);
    if (view.moonRadius >= 1 && gap > 0 && gap < 0.05 && view.distance > 0) {
      const bx = cx - (view.moonX / view.distance) * sun;
      const by = cy + (view.moonY / view.distance) * sun;
      const bead = context.createRadialGradient(bx, by, 0, bx, by, sun * 0.9);
      bead.addColorStop(0, 'rgba(255, 255, 255, 1)');
      bead.addColorStop(0.25, 'rgba(255, 250, 230, 0.55)');
      bead.addColorStop(1, 'rgba(255, 250, 230, 0)');
      context.fillStyle = bead;
      context.fillRect(0, 0, width, height);
    }
  }
  if (view.phase !== 'total') {
    // The glare: light scattered in the eye and the air spills over the
    // Sun's limb, and over the Moon's edge where it bites the Sun.
    const light = 1 - view.covered;
    context.save();
    context.globalCompositeOperation = 'lighter';
    const bloom = context.createRadialGradient(
      cx,
      cy,
      sun * 0.6,
      cx,
      cy,
      sun * 2.1,
    );
    bloom.addColorStop(0, `rgba(255, 250, 232, ${0.34 * light})`);
    bloom.addColorStop(0.42, `rgba(255, 244, 214, ${0.2 * light})`);
    bloom.addColorStop(1, 'rgba(255, 244, 214, 0)');
    context.fillStyle = bloom;
    context.fillRect(0, 0, width, height);
    // Faint rays, as the eye or a lens draws them round a bright light.
    context.translate(cx, cy);
    for (let ray = 0; ray < 6; ray += 1) {
      context.rotate(Math.PI / 6 + (ray % 2) * 0.21);
      const beam = context.createLinearGradient(-sun * 3.4, 0, sun * 3.4, 0);
      beam.addColorStop(0, 'rgba(255, 250, 235, 0)');
      beam.addColorStop(0.5, `rgba(255, 250, 235, ${0.11 * light})`);
      beam.addColorStop(1, 'rgba(255, 250, 235, 0)');
      context.fillStyle = beam;
      context.beginPath();
      context.ellipse(0, 0, sun * 3.4, sun * 0.07, 0, 0, 7);
      context.fill();
    }
    context.restore();
  }
}

/**
 * The near side's dark seas, as they lie on the disc with north up: x to the
 * right, y down, radius and depth, all in Moon radii.
 */
const SEAS = [
  [-0.3, -0.45, 0.27, 1], // Imbrium
  [0.17, -0.38, 0.17, 1], // Serenitatis
  [0.37, -0.13, 0.19, 1], // Tranquillitatis
  [0.68, -0.27, 0.085, 1], // Crisium
  [0.62, 0.07, 0.12, 0.9], // Fecunditatis
  [0.43, 0.22, 0.075, 0.9], // Nectaris
  [-0.62, -0.22, 0.26, 0.85], // Procellarum
  [-0.55, 0.05, 0.2, 0.8],
  [-0.72, -0.42, 0.12, 0.7],
  [-0.15, 0.33, 0.16, 0.85], // Nubium
  [-0.47, 0.37, 0.085, 0.95], // Humorum
  [-0.32, 0.15, 0.12, 0.8], // Cognitum
  [-0.35, -0.1, 0.1, 0.6], // Insularum
  [0.05, -0.2, 0.06, 0.7], // Vaporum
  [-0.3, -0.76, 0.07, 0.6], // Frigoris
  [-0.1, -0.78, 0.07, 0.6],
  [0.1, -0.77, 0.07, 0.6],
  [0.3, -0.72, 0.07, 0.6],
];
/** Young bright craters: x, y, radius, and how far their rays reach. */
const BRIGHT = [
  [-0.12, 0.68, 0.035, 0.85], // Tycho
  [-0.33, -0.15, 0.035, 0.22], // Copernicus
  [-0.6, -0.13, 0.022, 0.14], // Kepler
  [-0.68, -0.4, 0.022, 0.08], // Aristarchus
  [0.6, -0.27, 0.016, 0.1], // Proclus
];

const smooth = (t) => {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
};
const hash = (x, y) => {
  const value = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return value - Math.floor(value);
};
/** Smooth noise in 0..1, the same for the same point every time. */
function noise(x, y) {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = smooth(x - x0);
  const fy = smooth(y - y0);
  const top = hash(x0, y0) + (hash(x0 + 1, y0) - hash(x0, y0)) * fx;
  const bottom =
    hash(x0, y0 + 1) + (hash(x0 + 1, y0 + 1) - hash(x0, y0 + 1)) * fx;
  return top + (bottom - top) * fy;
}
const rough = (x, y) =>
  noise(x, y) * 0.5 +
  noise(x * 2.1, y * 2.1) * 0.3 +
  noise(x * 4.3, y * 4.3) * 0.2;

/**
 * How bright the full Moon's face is at a point of its disc (x right, y
 * down, in Moon radii): bright highlands, dark seas with ragged shores,
 * a few young craters and Tycho's rays.
 */
export function moonAlbedo(x, y) {
  // Ragged shores: the seas are measured from a slightly shifted point.
  const wx = x + (rough(x * 6 + 11, y * 6) - 0.5) * 0.12;
  const wy = y + (rough(x * 6, y * 6 + 7) - 0.5) * 0.12;
  let land = 1;
  for (const [sx, sy, radius, depth] of SEAS) {
    const gap = Math.hypot(wx - sx, wy - sy) / radius;
    land *= 1 - depth * (1 - smooth((gap - 0.7) / 0.5));
  }
  // Highlands are rougher than the seas' smooth lava.
  const grain = rough(x * 26, y * 26) - 0.5;
  let albedo = 0.5 + 0.36 * land + grain * (0.07 + 0.09 * land);
  for (const [bx, by, radius, reach] of BRIGHT) {
    const dx = x - bx;
    const dy = y - by;
    const gap = Math.hypot(dx, dy);
    albedo += 0.22 * Math.exp(-((gap / radius) ** 2));
    if (gap < reach) {
      // Rays: thin bright streaks fanning out from the crater.
      const streak = Math.max(0, Math.cos(Math.atan2(dy, dx) * 9 + bx * 40));
      albedo +=
        0.1 * streak ** 6 * (1 - gap / reach) * smooth(gap / radius - 1);
    }
  }
  return Math.min(1, Math.max(0.2, albedo));
}

/**
 * How the Earth's shadow colours a point of the Moon: the share of sunlight
 * left, as red, green and blue. `gap` is the point's distance from the
 * shadow's axis and `deep` how far the whole Moon is inside the umbra (0 out,
 * 1 wholly in), all in Moon radii. In the penumbra the light fades toward the
 * umbra; inside it only sunlight bent and reddened by the Earth's air is
 * left, darkest at the centre. Beside a sunlit part the eye sees the umbra
 * as nearly black; with the whole Moon inside, it sees the copper.
 */
export function moonShade(gap, umbraRadius, penumbraRadius, deep) {
  const span = Math.max(1e-6, penumbraRadius - umbraRadius);
  // The eye evens out the penumbra: it only looks dim near the umbra.
  const sunlit =
    0.12 + 0.88 * Math.min(1, Math.max(0, (gap - umbraRadius) / span)) ** 0.45;
  const glow = 0.1 + 0.42 * deep;
  const edge = umbraRadius > 0 ? Math.min(1, gap / umbraRadius) : 1;
  const ember = glow * (0.42 + 0.58 * edge ** 2);
  // The umbra's edge is soft: the Earth's air blurs it.
  const inside =
    umbraRadius > 0 ? 1 - smooth((gap - umbraRadius + 0.05) / 0.1) : 0;
  return [
    sunlit * (1 - inside) + ember * inside,
    sunlit * (1 - inside) + ember * (0.3 + 0.16 * edge) * inside,
    sunlit * (1 - inside) + ember * (0.12 + 0.16 * edge ** 3) * inside,
  ];
}

/** The Moon's face, worked out once for each size it is painted at. */
let _face = null;
function moonFace(pixels) {
  if (_face?.pixels === pixels) return _face.albedo;
  const albedo = new Float32Array(pixels * pixels);
  for (let row = 0; row < pixels; row += 1)
    for (let column = 0; column < pixels; column += 1)
      albedo[row * pixels + column] = moonAlbedo(
        ((column + 0.5) / pixels) * 2 - 1,
        ((row + 0.5) / pixels) * 2 - 1,
      );
  _face = { pixels, albedo };
  return albedo;
}

/**
 * Paint a lunar eclipse: the Moon with the Earth's shadow across it, north
 * up, as it looks from anywhere the Moon is in the sky. `view.x` and
 * `view.y` are where the Moon's centre stands from the shadow's axis (east
 * and north), and the two radii are the shadow's, all in Moon radii.
 */
export function paintMoon(context, view, width = SIZE, height = width) {
  const size = Math.min(width, height);
  const cx = width / 2;
  const cy = height / 2;
  const moon = SUN_SHARE * size * 1.35;
  context.clearRect(0, 0, width, height);
  context.fillStyle = rgb(NIGHT);
  context.fillRect(0, 0, width, height);
  paintStars(context, width, height, 0.9);
  // Facing the Moon with north up, east is to the left: the shadow's centre
  // lies opposite the Moon's own offset from it.
  const offset = Math.hypot(view.x, view.y);
  // How far the whole Moon is inside the umbra.
  const deep =
    view.umbraRadius > 0
      ? 1 - smooth((offset - (view.umbraRadius - 1)) / 2)
      : 0;
  // How much of the Moon still shines, for the glow round it.
  const shine = moonShade(
    offset,
    view.umbraRadius,
    view.penumbraRadius,
    deep,
  )[1];
  const glow = context.createRadialGradient(cx, cy, moon, cx, cy, moon * 1.9);
  glow.addColorStop(0, `rgba(200, 214, 240, ${0.2 * shine})`);
  glow.addColorStop(1, 'rgba(200, 214, 240, 0)');
  context.fillStyle = glow;
  context.fillRect(0, 0, width, height);

  // The disc is worked out pixel by pixel, in the canvas's own pixels.
  const scale = context.getTransform?.().a || 1;
  const pixels = Math.max(2, Math.round(moon * 2 * scale));
  const left = Math.round((cx - moon) * scale);
  const top = Math.round((cy - moon) * scale);
  const image = context.getImageData?.(left, top, pixels, pixels);
  if (!image) return;
  const face = moonFace(pixels);
  const data = image.data;
  for (let row = 0; row < pixels; row += 1) {
    const y = ((row + 0.5) / pixels) * 2 - 1;
    for (let column = 0; column < pixels; column += 1) {
      const x = ((column + 0.5) / pixels) * 2 - 1;
      const radius = Math.hypot(x, y);
      // A soft edge one pixel wide.
      const cover = Math.min(1, Math.max(0, (1 - radius) * (pixels / 2) + 0.5));
      if (cover <= 0) continue;
      const shade = moonShade(
        Math.hypot(x - view.x, y - view.y),
        view.umbraRadius,
        view.penumbraRadius,
        deep,
      );
      // The full Moon is almost as bright at its limb as at its centre.
      const lit =
        face[row * pixels + column] *
        (0.9 + 0.1 * Math.sqrt(Math.max(0, 1 - radius * radius)));
      const at = (row * pixels + column) * 4;
      const tone = [250, 246, 236];
      for (let channel = 0; channel < 3; channel += 1) {
        const value = Math.min(255, tone[channel] * lit * shade[channel]);
        data[at + channel] += (value - data[at + channel]) * cover;
      }
      data[at + 3] = 255;
    }
  }
  context.putImageData(image, left, top);
  // Below the horizon it is the same eclipse, only out of sight.
  if (view.below) {
    context.fillStyle = 'rgba(6, 9, 22, 0.6)';
    context.fillRect(0, 0, width, height);
  }
}

/**
 * Own the sky view's element inside `container`. `show({view, title, lines,
 * close})` paints it; `hide()` takes it off the page. The cross in its corner
 * calls `onClose`; `close` is what that button is called.
 */
export function createSkyPanel(
  container,
  { document = globalThis.document, onClose = null } = {},
) {
  const root = document.createElement('div');
  root.className = 'eclipse-sky-view';
  root.hidden = true;
  Object.assign(root.style, {
    position: 'absolute',
    right: '16px',
    bottom: '104px',
    width: `${SIZE}px`,
    zIndex: '6',
    pointerEvents: 'none',
    borderRadius: '12px',
    overflow: 'hidden',
    border: '1px solid rgba(126, 200, 255, 0.28)',
    background: 'rgba(7, 12, 20, 0.86)',
    boxShadow: '0 10px 30px rgba(0, 0, 0, 0.45)',
    color: '#d7e6f2',
    font: '11px/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  });
  const canvas = document.createElement('canvas');
  const ratio = Math.min(2, globalThis.devicePixelRatio || 1);
  canvas.width = SIZE * ratio;
  canvas.height = SIZE * ratio;
  Object.assign(canvas.style, {
    display: 'block',
    width: `${SIZE}px`,
    height: `${SIZE}px`,
  });
  const caption = document.createElement('div');
  Object.assign(caption.style, { padding: '7px 10px 9px' });
  const title = document.createElement('div');
  Object.assign(title.style, {
    color: '#8fd3ff',
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
    fontSize: '10px',
  });
  const body = document.createElement('div');
  body.style.whiteSpace = 'pre-line';
  caption.append(title, body);
  // The one part of the view that takes the pointer.
  const closer = document.createElement('button');
  closer.type = 'button';
  closer.className = 'eclipse-sky-view-close';
  closer.textContent = '×';
  Object.assign(closer.style, {
    position: 'absolute',
    top: '6px',
    right: '6px',
    width: '22px',
    height: '22px',
    padding: '0',
    pointerEvents: 'auto',
    cursor: 'pointer',
    borderRadius: '50%',
    border: '1px solid rgba(255, 255, 255, 0.28)',
    background: 'rgba(7, 12, 20, 0.62)',
    color: '#ffffff',
    font: '15px/1 system-ui, sans-serif',
  });
  closer.addEventListener('click', () => onClose?.());
  canvas.setAttribute('role', 'img');
  root.append(canvas, caption, closer);
  container.append(root);
  const context = canvas.getContext('2d');
  let painted = '';

  return {
    /**
     * @param {{view: object, title: string, lines: string[], close?: string}} shown
     */
    show({ view, title: heading, lines, close = '' }) {
      root.hidden = false;
      if (closer.title !== close) {
        closer.title = close;
        closer.setAttribute('aria-label', close);
      }
      const text = lines.join('\n');
      if (title.textContent !== heading) title.textContent = heading;
      if (body.textContent !== text) body.textContent = text;
      canvas.setAttribute('aria-label', `${heading}. ${lines.join('. ')}`);
      // Repaint only when the picture would change by a pixel or so.
      const key = (
        view.lunar
          ? ['moon', view.below, view.x.toFixed(2), view.y.toFixed(2)]
          : [
              view.night ? 'night' : view.phase,
              view.moonRadius.toFixed(3),
              view.moonX.toFixed(2),
              view.moonY.toFixed(2),
            ]
      ).join('|');
      if (key === painted || !context) return;
      painted = key;
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      if (view.lunar) paintMoon(context, view, SIZE);
      else paintSky(context, view, SIZE);
    },
    hide() {
      root.hidden = true;
    },
    isShown: () => !root.hidden,
    destroy() {
      root.remove();
    },
  };
}
