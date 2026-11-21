/**
 * @module contactTrailRenderer
 * @description The selected transit vehicle's trail, drawn through the
 * renderer's draw port as draped lines: a history body and a moving head.
 *
 * The body is every subdivision of the vehicle's history, each a segment of
 * a draped line in two lanes (a dark 5 px backing under a 3 px line in the
 * mode colour). A segment shows once the vehicle has passed it and fades
 * with its age; both change in place (`segmentShow`, `segmentColors`), so
 * the body is rebuilt only when the history changes. The head is the
 * subdivision the vehicle is on, revealed up to the vehicle
 * (`revealFraction`): it moves only where the vehicle crosses into the
 * next subdivision, and a frame writes how far it is revealed.
 */
import { cssColor } from '../render/color.js';
import { findDraw } from '../render/rendererOf.js';

const ALPHA_STOPS = [
  [0, 0.8],
  [120000, 0.45],
  [600000, 0.2],
  [900000, 0.08],
];
export function trailAlpha(ageMs) {
  const stops = ALPHA_STOPS;
  for (let i = 1; i < stops.length; i++) {
    if (ageMs === stops[i][0]) return stops[i][1];
    if (ageMs < stops[i][0]) {
      const [a, x] = stops[i - 1],
        [b, y] = stops[i];
      return x + ((y - x) * Math.max(0, ageMs - a)) / (b - a);
    }
  }
  return 0.08;
}

/** The backing lane's colour, under the mode colour. */
const BACKING = [0.02, 0.03, 0.05];
/** Alpha of the head, and of a body segment the vehicle has just passed. */
const HEAD_ALPHA = 0.8;
const WHITE = [1, 1, 1, 1];
/** The two lanes, drawn in this order: the backing, then the line. */
const LANES = [
  { name: 'backing', widthPx: 5, dark: true },
  { name: 'line', widthPx: 3, dark: false },
];

/** Uniquifier for each renderer's set ids. */
let trailSeq = 0;

const samePoint = (a, b) => a.x === b.x && a.y === b.y && a.z === b.z;

/**
 * The history as runs of joined segments (each segment starting where the
 * one before it ends), so each lane is a few lines rather than one a
 * segment. `first` is the index of the run's first segment; a segment with
 * no length ends a run.
 */
function runsOf(segments) {
  const runs = [];
  let run = null;
  for (let i = 0; i < segments.length; i++) {
    const [from, to] = segments[i].positions;
    if (!from || !to) run = null;
    else if (run && samePoint(run.positions.at(-1), from))
      run.positions.push(to);
    else runs.push((run = { first: i, positions: [from, to] }));
  }
  return runs;
}

/**
 * The trail renderer of one selection, over `viewer`'s draw port. Never
 * entities; nothing it draws takes part in picks.
 * @param {object} viewer
 */
export function createContactTrailRenderer(viewer) {
  const draw = findDraw(viewer);
  const prefix = `transit-trail:${++trailSeq}`;
  const body = draw?.lines({ id: `${prefix}:body`, pickable: false }) ?? null;
  const headLines =
    draw?.lines({ id: `${prefix}:head`, pickable: false, show: false }) ?? null;
  /** What the head draws now, for diagnostics: its start to the vehicle. */
  const endpoint = { x: 0, y: 0, z: 0 };
  const headPositions = [null, endpoint];
  const head = { positions: [], show: false, width: 3 };
  const backing = { positions: [], show: false, width: 5 };
  let segments = [],
    runs = [],
    revision = -1,
    visible = true,
    style = '#5EF08A',
    styleColor = cssColor(style).slice(0, 3);
  let lastSecond = -1,
    completed = -1,
    active = null,
    revealed = -1,
    restyled = false;
  let rebuilds = 0,
    headRebuilds = 0;

  const tint = (alpha, dark) => [...(dark ? BACKING : styleColor), alpha];

  /** The body's lines: each lane's runs, segments shown up to `done`. */
  function bodyLines(displayT, done) {
    const lines = [];
    for (const lane of LANES)
      for (let r = 0; r < runs.length; r++) {
        const run = runs[r];
        const count = run.positions.length - 1;
        const segmentColors = new Array(count);
        const segmentShow = new Array(count);
        for (let k = 0; k < count; k++) {
          const i = run.first + k;
          const alpha =
            displayT === null
              ? HEAD_ALPHA
              : trailAlpha(displayT - segments[i].toT);
          segmentColors[k] = tint(alpha, lane.dark);
          segmentShow[k] = i <= done;
        }
        lines.push({
          id: `${lane.name}:${r}`,
          positions: run.positions,
          widthPx: lane.widthPx,
          mode: 'draped',
          clampTo: 'both',
          // Every segment has its own colour: the line's own never
          // changes, so a new mode colour is written in place.
          style: { kind: 'solid', color: lane.dark ? [...BACKING, 1] : WHITE },
          segmentColors,
          segmentShow,
        });
      }
    return lines;
  }

  /**
   * The head over `segment`, revealed to `fraction`: one line the backing's
   * width, its edge the backing's colour and its centre the line's width,
   * in one pass. Two lanes stacked would darken the centre where their
   * translucent passes overlap.
   */
  function headItems(segment, fraction) {
    const [backingLane, lineLane] = LANES;
    return [
      {
        id: 'head',
        positions: segment.positions,
        widthPx: backingLane.widthPx,
        mode: 'draped',
        clampTo: 'both',
        style: {
          kind: 'solid',
          color: tint(HEAD_ALPHA, false),
          outline: {
            color: tint(HEAD_ALPHA, true),
            widthPx: backingLane.widthPx - lineLane.widthPx,
          },
        },
        revealFraction: fraction,
      },
    ];
  }

  // Written only when it changes: a renderer may redraw for each write.
  function showHead(show) {
    head.show = backing.show = show;
    if (headLines && headLines.show !== show) headLines.show = show;
  }

  function replaceHistory(next) {
    if (next.revision === revision) return;
    revision = next.revision;
    segments = next.segments;
    completed = -1;
    lastSecond = -1;
    active = null;
    revealed = -1;
    showHead(false);
    headLines?.clear();
    runs = runsOf(segments);
    if (!body) return;
    if (!runs.length) {
      body.clear();
      return;
    }
    body.set(bodyLines(null, -1));
    rebuilds++;
  }

  function setDisplaySample(sample, renderedPosition) {
    if (!sample || !renderedPosition) {
      showHead(false);
      return;
    }
    const second = Math.floor(sample.displayT / 1000);
    let lo = 0,
      hi = segments.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (segments[mid].toT <= sample.displayT) lo = mid + 1;
      else hi = mid;
    }
    const done = lo - 1;
    const candidate = segments[lo];
    const segment =
      candidate &&
      candidate.fromT <= sample.displayT &&
      candidate.fromSeq === sample.fromSeq &&
      candidate.toSeq === sample.toSeq
        ? candidate
        : null;
    // Passed segments show, and every segment fades with its age, once a
    // second; the port writes only the segments that change.
    if (body && runs.length && (done !== completed || second !== lastSecond)) {
      body.upsert(bodyLines(sample.displayT, done));
      completed = done;
      lastSecond = second;
    }
    const show =
      visible &&
      !!segment?.positions[0] &&
      !!segment.positions[1] &&
      sample.fraction < 1;
    showHead(show);
    if (!show) return;
    const fraction = Math.max(
      0,
      Math.min(
        1,
        (sample.displayT - segment.fromT) / (segment.toT - segment.fromT),
      ),
    );
    if (active !== segment || restyled) {
      if (active !== segment) headRebuilds++;
      active = segment;
      restyled = false;
      revealed = fraction;
      // Upserted, not set: a renderer can move a draped line to where it
      // now runs in the same frame, instead of building it anew.
      headLines?.upsert(headItems(segment, fraction));
    } else if (fraction !== revealed) {
      revealed = fraction;
      headLines?.upsert(headItems(segment, fraction));
    }
    headPositions[0] = segment.positions[0];
    endpoint.x = renderedPosition.x;
    endpoint.y = renderedPosition.y;
    endpoint.z = renderedPosition.z;
    head.positions = backing.positions = headPositions;
  }

  return {
    replaceHistory,
    setDisplaySample,
    setStyle(next) {
      if (next === style) return;
      style = next;
      styleColor = cssColor(style)?.slice(0, 3) ?? styleColor;
      // Faded again in the new colour on the next sample, and the head
      // drawn in it.
      lastSecond = -1;
      restyled = true;
    },
    setVisible(next) {
      visible = next;
      if (body && body.show !== next) body.show = next;
      if (!next) showHead(false);
    },
    destroy() {
      body?.dispose();
      headLines?.dispose();
      segments = [];
      runs = [];
      active = null;
    },
    diagnostics() {
      return {
        revision,
        rebuilds,
        segments: segments.length,
        body,
        headLines,
        head,
        backing,
        headStrategy: 'draped lines revealed to the vehicle',
        ground: !!draw,
        headRebuilds,
        entitiesAdded: 0,
      };
    },
  };
}
