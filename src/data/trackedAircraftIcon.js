/**
 * @module data/trackedAircraftIcon
 * @description The tracked aircraft's billboard, for the flights and military
 * layers: one icon in an icon set of the renderer's draw port, re-posed,
 * re-rotated and recoloured each drawn frame (its `preRender`) from the
 * layer's own per-frame display cache, the same value the follow camera
 * frames. It is drawn over depth, screen-rotated along the course, and
 * sized by eye distance. It is only ever written in `preRender`, so the
 * display cache is never sampled between frames; a frame whose icon would
 * draw exactly as the last writes nothing, so a parked contact asks for no
 * frames.
 *
 * The set is made on the first `show` and kept for the layer's lifetime;
 * `hide` empties it and stops the frame work, `dispose` lets it go. Its
 * pick names the set and the contact's id, as the fleet icons' do.
 * `visible` hides the icon while it stays shown (Cockpit flies the
 * aircraft from its own seat).
 */
import { findDraw, findFrame } from '../render/rendererOf.js';

/** Uniquifier for the sets' ids. */
let instances = 0;

const sameColor = (a, b) =>
  a === b ||
  (Array.isArray(a) &&
    Array.isArray(b) &&
    a.length === b.length &&
    a.every((value, i) => value === b[i]));

/** `trackedIconColor`'s answers, by base colour then alpha. */
const tintsAtAlpha = new Map();

/**
 * The tracked icon's colour: the contact's own colour (the one its fleet
 * icon draws in), at `alpha`. Tracking never recolours a contact; only the
 * alpha changes (faded while stale, clear while its model draws it). One
 * frozen array per colour and alpha, so a frame allocates nothing.
 * @param {ArrayLike<number>} color The contact's RGBA colour, 0..1.
 * @param {number} alpha
 * @returns {readonly number[]}
 */
export function trackedIconColor(color, alpha) {
  if (color[3] === alpha && Object.isFrozen(color)) return color;
  let byAlpha = tintsAtAlpha.get(color);
  if (!byAlpha) {
    byAlpha = new Map();
    tintsAtAlpha.set(color, byAlpha);
  }
  let tint = byAlpha.get(alpha);
  if (!tint) {
    tint = Object.freeze([color[0], color[1], color[2], alpha]);
    byAlpha.set(alpha, tint);
  }
  return tint;
}

/**
 * Whether `setId` names another layer's tracked icon set: a layer must not
 * take a pick of that icon for one of its own contacts.
 * @param {string} setId A picked draw set's id.
 * @param {string} setPrefix The asking layer's prefix, e.g. `military`.
 * @returns {boolean}
 */
export function isOtherTrackedIconSet(setId, setPrefix) {
  return (
    typeof setId === 'string' &&
    setId.includes('-tracked-icon:') &&
    !setId.startsWith(`${setPrefix}-tracked-icon:`)
  );
}

/**
 * @param {object} options
 * @param {() => object|null} options.viewer The layer's viewer, read when
 *   the set is made.
 * @param {string} options.setPrefix The set id's prefix, e.g. `flights`.
 */
export function createTrackedAircraftIcon({ viewer, setPrefix }) {
  let set = null;
  let offFrame = null;
  /** What is shown: the id and the per-frame readers. */
  let shown = null;
  /** The item last written, to skip a frame that changes nothing. */
  let written = null;
  /** Whether the shown icon draws (false while Cockpit hides it). */
  let visible = true;

  /** Ask for a frame, whose `preRender` draws the icon. */
  function requestFrame(reason) {
    const host = viewer();
    if (host) findFrame(host)?.requestRender(`${setPrefix}: ${reason}`);
  }

  function ensureSet() {
    if (set) return set;
    const host = viewer();
    const port = host ? findDraw(host) : null;
    if (!port) return null;
    set = port.icons({ id: `${setPrefix}-tracked-icon:${++instances}` });
    return set;
  }

  /** Write the icon as it is drawn this frame, when that changed. */
  function draw() {
    if (!shown || !set) return;
    const pos = shown.position();
    const item = {
      id: shown.id,
      pos: pos ? { x: pos.x, y: pos.y, z: pos.z } : { x: 0, y: 0, z: 0 },
      show: Boolean(pos) && visible,
      image: shown.image,
      ...(shown.imageLod ? { imageLod: shown.imageLod } : {}),
      size: [shown.sprite.width, shown.sprite.height],
      scale: shown.sprite.scale,
      scaleByDistance: shown.sprite.scaleByDistance,
      color: shown.color(),
      rotationMode: 'screen',
      rotation: pos ? shown.rotation() : 0,
      disableDepthTest: Number.POSITIVE_INFINITY,
    };
    if (
      written &&
      written.id === item.id &&
      written.show === item.show &&
      written.pos.x === item.pos.x &&
      written.pos.y === item.pos.y &&
      written.pos.z === item.pos.z &&
      written.image === item.image &&
      written.imageLod?.near === item.imageLod?.near &&
      written.imageLod?.switchPx === item.imageLod?.switchPx &&
      written.size[0] === item.size[0] &&
      written.size[1] === item.size[1] &&
      written.scale === item.scale &&
      written.rotation === item.rotation &&
      sameColor(written.color, item.color)
    )
      return;
    written = item;
    set.upsert([item]);
  }

  return {
    /**
     * Show the tracked contact `id`'s icon, drawn before each frame from the
     * next one on.
     * @param {object} target
     * @param {string} target.id The contact's id.
     * @param {string} target.image
     * @param {{near: string, switchPx: number}} [target.imageLod] The
     *   sharper image it switches to once drawn larger than `switchPx`.
     * @param {{width: number, height: number, scale: number,
     *   scaleByDistance: object}} target.sprite Read each frame.
     * @param {() => object|null} target.position ECEF this frame; none hides it.
     * @param {() => number} target.rotation Screen radians, counter-clockwise.
     * @param {() => object} target.color The tint this frame.
     */
    show(target) {
      this.hide();
      if (!ensureSet()) return;
      shown = { ...target };
      const host = viewer();
      offFrame = (host && findFrame(host)?.on('preRender', draw)) ?? null;
      requestFrame('tracked icon');
    },

    /** Draw it from a new image (the class or conversion changed) next frame. */
    setImage(image, imageLod) {
      if (!shown) return;
      shown.image = image;
      shown.imageLod = imageLod;
      requestFrame('tracked icon image');
    },

    /** Whether the shown icon draws. */
    get visible() {
      return visible;
    },

    /** Hide or show the icon without letting the contact go. */
    setVisible(value) {
      if (visible === Boolean(value)) return;
      visible = Boolean(value);
      requestFrame('tracked icon visibility');
    },

    /** The set's id while it is made, for picks and height samples. */
    get setId() {
      return set?.id ?? null;
    },

    /** Stop showing the icon. */
    hide() {
      offFrame?.();
      offFrame = null;
      shown = null;
      written = null;
      visible = true;
      if (set?.size()) set.clear();
    },

    /** Let the set go (layer teardown). */
    dispose() {
      this.hide();
      set?.dispose();
      set = null;
    },
  };
}

/**
 * The tracked contact as its readers see it (the tracked card, Cockpit,
 * share links): a plain holder that the layer keeps its entity record on.
 * Cockpit reads `position` for whether there is a contact to fly and sets
 * `show` to hide the icon while it flies it; the record's `drawn` says
 * whether the layer still tracks it.
 * @param {string} id e.g. `flights:a1b2c3`.
 * @param {ReturnType<typeof createTrackedAircraftIcon>} icon
 * @param {() => object|null} position The contact's display position.
 */
export function trackedContactHolder(id, icon, position) {
  return {
    id,
    position: { getValue: () => position() ?? undefined },
    get show() {
      return icon.visible;
    },
    set show(value) {
      icon.setVisible(value);
    },
  };
}
