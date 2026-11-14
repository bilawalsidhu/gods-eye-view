/**
 * @module cockpitProgress
 * @description Lay out a subject's progress line (cockpitSubjectProviders.js)
 * at a width in pixels: where each tick, label and the marker go.
 *
 * Ticks sit at fractions of the line, 0 at the left. Ticks closer than
 * `minTickPx` merge, so a long run still reads as a line: a labelled tick
 * keeps its place and takes in the bare ticks beside it, and bare ticks merge
 * with each other at their mean place. A merged tick takes the strongest tone
 * of those it holds. Labels never overlap: where two would, the one of lower
 * priority is left out (on a tie, the later one).
 *
 * Pure: no DOM.
 */

/** Bare ticks closer than this merge (px). */
export const COCKPIT_PROGRESS_MIN_TICK_PX = 6;
/** Room kept between two labels (px). */
export const COCKPIT_PROGRESS_LABEL_GAP_PX = 8;

/** Tones from weakest to strongest, for a merged tick. */
const TONE_RANK = Object.freeze([
  'muted',
  'normal',
  'live',
  'estimate',
  'warning',
  'alert',
]);
const stronger = (a, b) =>
  TONE_RANK.indexOf(b) > TONE_RANK.indexOf(a) ? b : a;

/** A label's width estimate (px): its longer line in small capitals. */
export function estimateProgressLabelPx(label) {
  const longest = Math.max(
    String(label?.text ?? '').length,
    String(label?.detail ?? '').length,
  );
  return longest * 6.4 + 8;
}

/**
 * The progress line at `widthPx`, or null when there is nothing to draw.
 * @param {{ticks: Array<{at: number, tone: string, label: object|null}>,
 *   marker: {at: number, dwell: boolean}|null, tag: string}|null} progress
 *   As cockpitSubjectHudView gives it: ticks sorted by `at`.
 * @param {number} widthPx
 * @param {{minTickPx?: number, gapPx?: number,
 *   measure?: (label: object) => number}} [options]
 * @returns {{ticks: Array<{x: number, tone: string, count: number,
 *   labelled: boolean}>, labels: Array<{x: number, left: number,
 *   width: number, align: string, text: string, detail: string,
 *   tone: string}>, marker: {x: number, dwell: boolean}|null,
 *   travelledX: number, tag: string}|null}
 */
export function cockpitProgressLayout(
  progress,
  widthPx,
  {
    minTickPx = COCKPIT_PROGRESS_MIN_TICK_PX,
    gapPx = COCKPIT_PROGRESS_LABEL_GAP_PX,
    measure = estimateProgressLabelPx,
  } = {},
) {
  const ticks = progress?.ticks;
  if (!Array.isArray(ticks) || ticks.length < 2) return null;
  if (!Number.isFinite(widthPx) || widthPx <= 0) return null;
  const placed = ticks.map((tick, order) => ({
    x: tick.at * widthPx,
    tone: tick.tone,
    label: tick.label,
    order,
  }));
  const labelled = placed.filter((tick) => tick.label);
  // Bare ticks beside a labelled one go into it.
  const kept = labelled.map((tick) => ({
    x: tick.x,
    tone: tick.tone,
    count: 1,
    labelled: true,
    label: tick.label,
    order: tick.order,
  }));
  const bare = [];
  for (const tick of placed) {
    if (tick.label) continue;
    const host = kept.find((entry) => Math.abs(entry.x - tick.x) < minTickPx);
    if (host) {
      host.tone = stronger(host.tone, tick.tone);
      host.count += 1;
    } else bare.push(tick);
  }
  // Bare ticks in a chain closer than minTickPx merge at their mean place.
  let cluster = null;
  const flush = () => {
    if (!cluster) return;
    kept.push({
      x: cluster.sum / cluster.count,
      tone: cluster.tone,
      count: cluster.count,
      labelled: false,
      label: null,
      order: cluster.order,
    });
    cluster = null;
  };
  for (const tick of bare) {
    if (cluster && tick.x - cluster.last < minTickPx) {
      cluster.sum += tick.x;
      cluster.count += 1;
      cluster.last = tick.x;
      cluster.tone = stronger(cluster.tone, tick.tone);
    } else {
      flush();
      cluster = {
        sum: tick.x,
        count: 1,
        last: tick.x,
        tone: tick.tone,
        order: tick.order,
      };
    }
  }
  flush();
  kept.sort((a, b) => a.x - b.x || a.order - b.order);

  // Labels by priority; one that would overlap a placed label is left out.
  const boxes = [];
  const candidates = kept
    .filter((tick) => tick.labelled)
    .sort((a, b) => b.label.priority - a.label.priority || a.order - b.order);
  for (const tick of candidates) {
    const width = Math.min(widthPx, Math.max(0, measure(tick.label)));
    let left =
      tick.label.align === 'start'
        ? tick.x
        : tick.label.align === 'end'
          ? tick.x - width
          : tick.x - width / 2;
    left = Math.min(Math.max(0, left), widthPx - width);
    const right = left + width;
    if (
      boxes.some((box) => left < box.right + gapPx && right > box.left - gapPx)
    )
      continue;
    boxes.push({
      x: tick.x,
      left,
      right,
      width,
      align: tick.label.align,
      text: tick.label.text,
      detail: tick.label.detail,
      tone: tick.tone,
      order: tick.order,
    });
  }
  boxes.sort((a, b) => a.left - b.left);
  const marker = progress.marker
    ? { x: progress.marker.at * widthPx, dwell: progress.marker.dwell }
    : null;
  return {
    ticks: kept.map(({ x, tone, count, labelled: isLabelled }) => ({
      x,
      tone,
      count,
      labelled: isLabelled,
    })),
    labels: boxes.map(({ x, left, width, align, text, detail, tone }) => ({
      x,
      left,
      width,
      align,
      text,
      detail,
      tone,
    })),
    marker,
    travelledX: marker ? marker.x : 0,
    tag: progress.tag || '',
  };
}
