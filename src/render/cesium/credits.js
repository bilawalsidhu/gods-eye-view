/**
 * @module render/cesium/credits
 * @description The Cesium renderer's credits port over a Cesium credit
 * display: every credit Cesium owes (its logo, static credits and each
 * frame's imagery, terrain and tile credits) and every credit Core adds, as
 * the contract's plain data (`src/render/contract/credits.d.ts`).
 *
 * Until Core renders the credit DOM, a credit Core adds is shown through
 * Cesium's own display, so attribution stays on screen: `inline` credits on
 * the credit line, the rest in its expandable list. Its markup is built
 * here from the plain data, every value escaped.
 *
 * `change` fires when a Core credit is added or removed, and after a drawn
 * frame whose Cesium credits differ from the last one's.
 *
 * Cesium keeps one static credit per markup and placement: a Core credit
 * and another caller's of the same markup share one entry in the display,
 * which goes when the one added first is removed.
 */
import * as Cesium from 'cesium';
import {
  LINK_SCHEMES,
  LOGO_SCHEMES,
  creditFromMarkup,
  safeUrl,
} from '../creditMarkup.js';
import { listenerList } from './common.js';
import { creditDisplayContents } from './internals.js';

const CREDIT_KEYS = new Set(['text', 'href', 'logoUrl', 'inline']);
/** Readings kept per Cesium credit id; past this many, the cache restarts. */
const READINGS_KEPT = 512;

const escape = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (char) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[char],
  );

/**
 * A credit's markup for Cesium's display: the logo, then the text, linked
 * when it has a web link. A link or logo of any other scheme is left out.
 * @param {import('../contract/credits').Credit} credit
 * @returns {string}
 */
export function creditMarkup(credit) {
  const logo = credit.logoUrl && safeUrl(credit.logoUrl, LOGO_SCHEMES);
  const body = [
    logo &&
      `<img src="${escape(logo)}" alt="" style="max-height:1.5em;vertical-align:middle">`,
    credit.text && escape(credit.text),
  ]
    .filter(Boolean)
    .join(' ');
  const href = credit.href && safeUrl(credit.href, LINK_SCHEMES);
  return href
    ? `<a href="${escape(href)}" target="_blank" rel="noopener">${body}</a>`
    : `<span>${body}</span>`;
}

/** The credit as given, its known fields only, in their given order. */
function copyCredit(credit) {
  if (typeof credit?.text !== 'string')
    throw new TypeError('A credit needs its text');
  const copy = {};
  for (const [key, value] of Object.entries(credit))
    if (CREDIT_KEYS.has(key) && value !== undefined) copy[key] = value;
  return copy;
}

/**
 * @param {{display: object|undefined, scene: object,
 *   report: (error: unknown) => void, requestRender: () => void}} options
 *   `display`: the widget's Cesium CreditDisplay; without one, only Core's
 *   credits are listed. `requestRender` draws the display once a Core
 *   credit comes or goes.
 * @returns {{port: import('../contract/credits').CreditsPort,
 *   dispose: () => void}}
 */
export function createCesiumCredits({ display, scene, report, requestRender }) {
  const listeners = listenerList(report);
  /** Core's credits, in the order added: each `{credit, markup}`. */
  const added = [];
  /** Core's credits as Cesium shows them, by markup: `{credit, count}`. */
  const shown = new Map();
  /** Cesium credit id → its text, link and logo. */
  const readings = new Map();

  const reading = (credit) => {
    let read = readings.get(credit.id);
    if (!read) {
      if (readings.size >= READINGS_KEPT) readings.clear();
      read = creditFromMarkup(credit.html);
      readings.set(credit.id, read);
    }
    return { ...read, inline: Boolean(credit.showOnScreen) };
  };

  // The display shows a frame's credits most frequent first, sorting them
  // in place as the frame ends, after postRender: the same stable sort,
  // so the order is the same before and after.
  const byCount = (elements) => [...elements].sort((a, b) => b.count - a.count);

  /** The Cesium credits made for Core's, while shown. */
  const coreCredits = new Set();

  /**
   * Every credit shown now, in display order, each a Cesium credit or
   * (`core`) the Cesium credit made for Core's: the logo, then on the
   * credit line and then in the expanded list, the static credits in the
   * order added and the last frame's own, most frequent first. A second
   * credit of the same markup and placement is left out, as the display
   * leaves it out.
   */
  function shownCredits() {
    const { statics, screen, lightbox, logo } = creditDisplayContents(display);
    const out = [];
    const seen = new Set();
    const take = (credit) => {
      if (!credit) return;
      const key = `${credit.id}:${credit.showOnScreen ? 1 : 0}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push(credit);
    };
    take(logo);
    for (const [inline, elements] of [
      [true, screen],
      [false, lightbox],
    ]) {
      for (const credit of statics)
        // The display shows an ion credit as its logo.
        if (
          Boolean(credit.showOnScreen) === inline &&
          !(logo && credit.isIon?.())
        )
          take(credit);
      for (const element of byCount(elements))
        // A static credit counts Number.MAX_VALUE; those are listed above,
        // and one removed since the frame is not owed any more.
        if (element.count !== Number.MAX_VALUE) take(element.credit);
    }
    return out;
  }

  /** Cesium's own credits only, for the per-frame diff. */
  const engineCredits = () =>
    shownCredits().filter((credit) => !coreCredits.has(credit));

  /**
   * Cesium's credits read as plain data, with Core's listed as Core gave
   * them where the display shows them; any the display does not show (no
   * display, or one it already had) after.
   */
  function list() {
    const out = [];
    const listed = new Set();
    for (const credit of shownCredits()) {
      if (!coreCredits.has(credit)) {
        out.push(reading(credit));
        continue;
      }
      for (const entry of added)
        if (shown.get(entry.key)?.credit === credit) {
          out.push({ ...entry.credit });
          listed.add(entry);
        }
    }
    for (const entry of added)
      if (!listed.has(entry)) out.push({ ...entry.credit });
    return out;
  }
  const changed = () => {
    if (listeners.size > 0) listeners.fire(list());
  };

  // What Cesium owed after the last frame, as credit ids and placements.
  const signature = () =>
    engineCredits()
      .map((credit) => `${credit.id}:${credit.showOnScreen ? 1 : 0}`)
      .join(',');
  let lastSignature = signature();
  const afterFrame = () => {
    const now = signature();
    if (now === lastSignature) return;
    lastSignature = now;
    changed();
  };
  const offFrame = scene.postRender.addEventListener(afterFrame);

  // Cesium shows one static credit per markup and placement, so Core's
  // credits of the same markup and placement share one.
  function show(markup, inline) {
    const key = `${inline ? 'inline' : 'listed'}:${markup}`;
    let entry = shown.get(key);
    if (!entry) {
      entry = { credit: new Cesium.Credit(markup, inline), count: 0 };
      shown.set(key, entry);
      coreCredits.add(entry.credit);
      display?.addStaticCredit(entry.credit);
    }
    entry.count += 1;
    return key;
  }

  function hide(key) {
    const entry = shown.get(key);
    if (!entry) return;
    entry.count -= 1;
    if (entry.count > 0) return;
    shown.delete(key);
    coreCredits.delete(entry.credit);
    display?.removeStaticCredit(entry.credit);
  }

  let disposed = false;
  const port = {
    addStatic(credit) {
      const copy = copyCredit(credit);
      const entry = { credit: copy, key: null };
      added.push(entry);
      if (!disposed) {
        entry.key = show(creditMarkup(copy), Boolean(copy.inline));
        requestRender();
      }
      changed();
      return () => {
        const i = added.indexOf(entry);
        if (i < 0) return;
        added.splice(i, 1);
        if (entry.key !== null && !disposed) {
          hide(entry.key);
          requestRender();
        }
        changed();
      };
    },
    list,
    on(event, cb) {
      if (event !== 'change') return () => {};
      return listeners.on(cb);
    },
  };

  return {
    port,
    dispose() {
      disposed = true;
      offFrame();
      listeners.clear();
      if (!display?.isDestroyed?.())
        for (const { credit } of shown.values())
          display?.removeStaticCredit(credit);
      shown.clear();
      coreCredits.clear();
    },
  };
}
