/**
 * Split-flap (departure-board) text animation for the status chips.
 *
 * When a chip's label changes — "LOADING LIVE DATA" → "LOAD COMPLETE",
 * "loading frames" → "camera grid ready" — the characters flip over
 * mechanically, left to right, like a Solari board at a ferry terminal.
 *
 * This module plans the cascade; the SplitFlapText view
 * (src/ui/views/panels/SplitFlapText.vue) renders it. FOUR INVARIANTS HOLD
 * THIS TOGETHER — do not "fix" any of them:
 *
 * 1. DOM TEXT IS THE TRUTH, AND ITS NODE NEVER MOVES. The label is a
 *    `.gev-flap-text` span holding one long-lived `Text` node, beside an
 *    `aria-hidden` `.gev-flap-cells` sibling. The ONLY text operation for the
 *    life of the label is a change to that node's data — a single
 *    `characterData` mutation. Nothing is ever reparented, so the label is
 *    never transiently empty and the `aria-live` region never sees a removal /
 *    reinsertion pair it could announce twice. `element.textContent` is the
 *    settled string at every instant, because the cells carry NO text at all:
 *    both glyphs are CSS generated content (`::before` from `data-flap-prev`,
 *    `::after` from `data-flap-next`), which never reaches `textContent`.
 *    QA pins therefore always read the truth; the flaps are purely visual.
 *
 * 2. NO ANIMATION LOOP, AND EXACTLY ONE TIMER PER CHANGE. The motion is CSS
 *    `animation`/`transition` only, triggered once per text change and
 *    staggered via a per-cell `--gev-flap-delay` custom property. A change
 *    schedules exactly ONE `setTimeout` — the settle that strips the cells.
 *    The width ease ends on a `transitionend`/`transitioncancel` listener,
 *    not a second timer. There is zero per-frame JS and zero periodic work;
 *    idle cost is nothing, and nothing here requests a Cesium render — the
 *    chips are DOM, outside the panel-stack observers, so the render governor
 *    is untouched.
 *
 * 3. ONLY WHAT WAS VISIBLE FLAPS AWAY. An interrupted cascade (A→B cut short
 *    by C) derives each column's outgoing glyph from what that column is
 *    actually SHOWING at that instant — which for a column whose stagger has
 *    not elapsed yet is still A, not the pending B. Deriving it from the
 *    pending target would flash a glyph that was never on screen.
 *
 * 4. COLUMNS NEVER RENUMBER MID-CASCADE. For the whole cascade the board keeps
 *    one column per index of the LONGER string, each holding its own width.
 *    A column the new string does not reach flaps its old glyph to a BLANK in
 *    place — exactly how a departure board clears a cell — rather than
 *    collapsing to zero width. Collapsing would stack the absolutely-positioned
 *    outgoing glyphs on top of each other and would let a later glyph slide
 *    into an earlier column, which in turn would make invariant 3 lie. The
 *    container only takes up the slack AFTER every flap has landed, as one
 *    smooth width ease.
 *
 * The motion vocabulary deliberately matches the cockpit odometer roll
 * (`cockpitRollingValue.js`, style.css `.cockpit-roll-token`): ~200 ms per
 * character on `cubic-bezier(0.2, 0.75, 0.25, 1)`, reduced-motion collapsing
 * the duration rather than removing the animation. What this adds over the
 * odometer is the CASCADE — the left-to-right sweep that makes a departure
 * board read as a departure board.
 */

/**
 * One-line kill switch. Flip to `false` and every chip goes back to a plain
 * instant text swap with no other code change.
 */
export const SPLIT_FLAP_ENABLED = true;

/** Time one character spends flipping. */
export const FLAP_CHAR_MS = 190;
/** Nominal gap between consecutive characters starting their flip. */
export const FLAP_STAGGER_MS = 26;
/**
 * Hard ceiling for a whole cascade. Long labels compress their stagger to
 * fit rather than running on — a chip that flaps for a full second reads as
 * a slot machine, not a quiet mechanical settle.
 */
export const FLAP_MAX_TOTAL_MS = 620;
/** Slack after the last character lands before the cells are stripped. */
export const FLAP_SETTLE_SLACK_MS = 60;
/**
 * Fraction of a character's flip at which the outgoing glyph has rotated
 * away and the incoming one takes over as what the eye reads. MUST track the
 * `gev-flap-out`/`gev-flap-in` keyframe crossover in style.css — it is what
 * makes an interrupted cascade pick honest outgoing glyphs.
 */
export const FLAP_TURN_RATIO = 0.5;

/**
 * What a reserved-but-empty column shows. A column the new string does not
 * reach is not removed mid-cascade — it flaps to a blank and holds its place,
 * which is both what a real board does and what keeps column indices stable.
 */
export const FLAP_BLANK = ' ';

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

/**
 * Diff two strings into per-character flap cells with staggered delays.
 *
 * Unchanged characters do not animate — a real split-flap cell that already
 * shows the right glyph simply does not move, which is both authentic and
 * free. The stagger is rebased on the FIRST changed column so a label whose
 * head is stable ("LOAD COMPLETE" keeps "LOAD" from "LOADING LIVE DATA")
 * starts flipping immediately instead of idling through untouched columns.
 *
 * Pure — no DOM, no clock. This is the unit-tested core.
 *
 * @param {string} fromText - Glyphs currently on screen.
 * @param {string} toText - Text to settle on.
 * @param {{charMs?: number, staggerMs?: number, maxTotalMs?: number}} [options]
 * @returns {{
 *   cells: Array<{index: number, from: string, to: string, changed: boolean,
 *                 vacating: boolean, delayMs: number}>,
 *   durationMs: number, staggerMs: number, changedCount: number,
 *   firstChanged: number, lastChanged: number,
 * }}
 */
export function planSplitFlap(fromText, toText, options = {}) {
  const charMs = positiveNumber(options.charMs, FLAP_CHAR_MS);
  const baseStagger = positiveNumber(options.staggerMs, FLAP_STAGGER_MS);
  const maxTotalMs = positiveNumber(options.maxTotalMs, FLAP_MAX_TOTAL_MS);

  // Code-point safe: a chip label may carry a separator like '·'.
  const fromChars = Array.from(String(fromText ?? ''));
  const toChars = Array.from(String(toText ?? ''));
  const width = Math.max(fromChars.length, toChars.length);

  let firstChanged = -1;
  let lastChanged = -1;
  for (let index = 0; index < width; index += 1) {
    if ((fromChars[index] ?? '') !== (toChars[index] ?? '')) {
      if (firstChanged < 0) firstChanged = index;
      lastChanged = index;
    }
  }

  if (firstChanged < 0) {
    return {
      cells: [],
      durationMs: 0,
      staggerMs: 0,
      changedCount: 0,
      firstChanged: -1,
      lastChanged: -1,
    };
  }

  // Compress the stagger so the whole cascade fits the budget.
  const span = lastChanged - firstChanged + 1;
  const room = Math.max(0, maxTotalMs - charMs);
  const staggerMs = span > 1 ? Math.min(baseStagger, room / (span - 1)) : 0;

  const cells = [];
  let changedCount = 0;
  for (let index = 0; index < width; index += 1) {
    const from = fromChars[index] ?? '';
    const to = toChars[index] ?? '';
    const changed = from !== to;
    if (changed) changedCount += 1;
    cells.push({
      index,
      from,
      to,
      changed,
      // The string shrank: this column has an old glyph to flap away and no
      // new one, so it flaps to a blank and holds its place (invariant 4).
      vacating: changed && to === '' && from !== '',
      delayMs: changed ? Math.round((index - firstChanged) * staggerMs) : 0,
    });
  }

  return {
    cells,
    durationMs: Math.round((lastChanged - firstChanged) * staggerMs + charMs),
    staggerMs,
    changedCount,
    firstChanged,
    lastChanged,
  };
}

/**
 * What one column is showing, before or after it turns over.
 *
 * A column with no glyph on the side being asked for is a RESERVED BLANK, not
 * an absence: it is still on the board, holding its width and its index. That
 * is what keeps the returned string positionally true.
 */
function displayedGlyph(cell, turned) {
  if (!cell.changed) return cell.to;
  return (turned ? cell.to : cell.from) || FLAP_BLANK;
}

/**
 * The glyphs a cascade is actually SHOWING at `elapsedMs`.
 *
 * A column that has not reached its stagger delay yet still displays its old
 * glyph; one past the halfway turn displays its new one; unchanged columns
 * never moved. This is what an interrupting change must flap away from, so
 * no column ever shows a glyph that was never visually current.
 *
 * The result is positionally true by construction: it always has exactly one
 * character per column, so index N of the string is always column N of the
 * board. A cleared or not-yet-filled column reads as a blank rather than
 * closing up — otherwise a later glyph would appear to occupy an earlier
 * column and an interrupt would flap the wrong glyph away.
 *
 * Pure — no DOM.
 *
 * @param {{cells: Array<object>}} plan - A plan from `planSplitFlap`.
 * @param {number} elapsedMs - Milliseconds since the cascade started.
 * @param {{charMs?: number, turnRatio?: number}} [options]
 * @returns {string} The currently displayed string, one character per column.
 */
export function visibleGlyphs(plan, elapsedMs, options = {}) {
  const charMs = positiveNumber(options.charMs, FLAP_CHAR_MS);
  const turnRatio = Number.isFinite(Number(options.turnRatio))
    ? Number(options.turnRatio)
    : FLAP_TURN_RATIO;
  const elapsed = Number.isFinite(Number(elapsedMs))
    ? Math.max(0, Number(elapsedMs))
    : 0;
  const turn = charMs * turnRatio;
  let out = '';
  for (const cell of plan?.cells || []) {
    out += displayedGlyph(cell, elapsed >= cell.delayMs + turn);
  }
  return out;
}

/** Whether the viewer asked for reduced motion. */
export function prefersReducedMotion() {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

/**
 * Whether an element is actually on screen right now.
 *
 * `getClientRects()` alone is not enough: clean-UI and recording mode hide the
 * chips with `opacity: 0 !important; visibility: hidden !important` on the
 * chip CONTAINER, and the traffic/CCTV chips sit at `opacity: 0` until they
 * get `.visible`. All of those still report client rects, so a naive check
 * would animate a chip nobody can see. `checkVisibility` walks ancestors for
 * exactly these properties; the fallback walks them by hand.
 */
export function isOnScreen(element) {
  if (!element?.isConnected) return false;
  if (typeof element.checkVisibility === 'function') {
    return element.checkVisibility({
      opacityProperty: true,
      visibilityProperty: true,
      contentVisibilityAuto: true,
    });
  }
  if (typeof element.getClientRects !== 'function') return false;
  if (element.getClientRects().length === 0) return false;
  const view = element.ownerDocument?.defaultView;
  if (typeof view?.getComputedStyle !== 'function') return true;
  for (
    let node = element;
    node && node.nodeType === 1;
    node = node.parentElement
  ) {
    const style = view.getComputedStyle(node);
    if (style.visibility === 'hidden' || style.display === 'none') return false;
    if (Number(style.opacity) === 0) return false;
  }
  return true;
}
