// The Space Missions display: what the launches layer draws, on any globe
// engine, through the engine contract only: engine.movers (the launch-site,
// recovery and payload dots, the hover reticle), engine.lines (trajectories,
// recovery and re-entry paths, the transfer, the orbits in the tactical
// pattern), engine.ground (the pad zones), the selection dispatcher on engine.input
// (clicks), engine.picker (the hover cursor), engine.projector and the frame
// events. The layer keeps its own records and moves the camera itself
// (engine.camera); the engine draws.
//
// The writes of a frame are committed once, at the end of the frame listener
// that made them (display.on), or in a microtask for writes outside a frame.
// Every handle draws only while the display is visible (the layer's own
// switch) and its own `show` is set.

import * as geo from '../../../geo/index.js';
import { isPointerFree } from '../../../data/inputOwnership.js';
import { selectionDispatcherFor } from '../../../data/selectionDispatcher.js';
import { resolvePickId } from '../../../data/pickRegistry.js';
import { createMoverBank, writeFields } from '../../shared/render/moverBank.js';
import { rgbaFromCss } from '../../shared/color.js';
import { LAUNCH_PAD_ZONE_RADIUS_M, LAUNCH_PAD_ZONE_STYLE } from '../policy.js';

const LAYER_ID = 'rocket-launches';
const HOVER_PICK_INTERVAL_MS = 120;
const PICK_DEPTH = 12;
const RETICLE_SIZE_PX = 24;
const RETICLE_CELL = 'reticle';
const rgbaOf = (color) =>
  Array.isArray(color)
    ? [...color]
    : [color?.red ?? 1, color?.green ?? 1, color?.blue ?? 1, color?.alpha ?? 1];

/**
 * Bound hover picking independently of precise click selection. A move inside
 * the throttle window is not dropped: its position is kept and one trailing
 * check runs when the window ends, so a pointer that stops is still resolved.
 * The cursor is the engine canvas's; camera motion and a hidden document
 * clear it.
 */
export function createLaunchHover({
  engine,
  enabled,
  isLaunchPick,
  now = () => performance.now(),
  documentRef = globalThis.document,
  pointerFree = isPointerFree,
  setTimer = globalThis.setTimeout,
  clearTimer = globalThis.clearTimeout,
}) {
  const style = () => engine.host.canvas?.style;
  let moving = false;
  let lastPick = -Infinity;
  let ownsCursor = false;
  let pendingPosition = null;
  let trailingTimer = null;
  const clearCursor = () => {
    const canvasStyle = style();
    if (ownsCursor && canvasStyle?.cursor === 'pointer')
      canvasStyle.cursor = '';
    ownsCursor = false;
  };
  const cancelTrailing = () => {
    if (trailingTimer !== null) clearTimer(trailingTimer);
    trailingTimer = null;
    pendingPosition = null;
  };
  const reset = () => {
    cancelTrailing();
    clearCursor();
    lastPick = -Infinity;
  };
  const start = () => {
    moving = true;
    reset();
  };
  const end = () => {
    moving = false;
    reset();
  };
  const visibility = () => {
    if (documentRef?.hidden || documentRef?.visibilityState === 'hidden')
      reset();
  };
  const eligible = () =>
    enabled() &&
    !moving &&
    !documentRef?.hidden &&
    documentRef?.visibilityState !== 'hidden' &&
    pointerFree();
  const pick = (position, at) => {
    lastPick = at;
    const found = engine.picker
      .drillPick(position, PICK_DEPTH)
      .some((picked) => isLaunchPick(resolvePickId(picked)));
    const canvasStyle = style();
    if (found && canvasStyle) {
      canvasStyle.cursor = 'pointer';
      ownsCursor = true;
    } else clearCursor();
  };
  const trailing = () => {
    trailingTimer = null;
    const position = pendingPosition;
    pendingPosition = null;
    if (!position) return;
    // Eligibility may have changed while the check waited.
    if (!eligible()) {
      reset();
      return;
    }
    pick(position, now());
  };
  const removeStart = engine.camera.moveStart.addEventListener(start);
  const removeEnd = engine.camera.moveEnd.addEventListener(end);
  documentRef?.addEventListener?.('visibilitychange', visibility);
  return {
    move(movement) {
      if (!eligible()) {
        reset();
        return;
      }
      const at = now();
      const wait = HOVER_PICK_INTERVAL_MS - (at - lastPick);
      if (wait > 0) {
        // The engine may reuse the movement object: keep a copy.
        pendingPosition = geo.cartesian2.clone(
          movement.endPosition,
          pendingPosition ?? undefined,
        );
        if (trailingTimer === null) trailingTimer = setTimer(trailing, wait);
        return;
      }
      cancelTrailing();
      pick(movement.endPosition, at);
    },
    reset,
    destroy() {
      reset();
      removeStart();
      removeEnd();
      documentRef?.removeEventListener?.('visibilitychange', visibility);
    },
  };
}

/**
 * @param {import('../../../globe/contract.js').GlobeEngine} engine
 * @param {{ layerId?: string }} [options] Names the mover sets and lines.
 */
export function createLaunchesDisplay(engine, { layerId = LAYER_ID } = {}) {
  let destroyed = false;
  let visible = false;
  let lineSeq = 0;
  let frameNumber = 0;
  const removers = [];
  const pads = new Set();

  // --- commits: once per frame listener, or in a microtask -----------------
  const pending = new Set();
  let inFrame = 0;
  let microtask = false;
  const flush = () => {
    microtask = false;
    for (const bank of pending) bank.commit();
    pending.clear();
  };
  const onCommit = (bank) => {
    pending.add(bank);
    if (inFrame === 0 && !microtask) {
      microtask = true;
      queueMicrotask(flush);
    }
  };
  const frame = (run) => {
    inFrame++;
    try {
      return run();
    } finally {
      inFrame--;
      if (inFrame === 0) flush();
    }
  };

  // What the layer draws, by pick id: the selection dispatcher's owns().
  const pickIds = new Map();
  const ownPick = (id) => pickIds.set(id, (pickIds.get(id) ?? 0) + 1);
  const dropPick = (id) => {
    const count = (pickIds.get(id) ?? 0) - 1;
    if (count > 0) pickIds.set(id, count);
    else pickIds.delete(id);
  };
  const owns = (id) => typeof id === 'string' && pickIds.has(id);

  // --- markers: points by size, the reticle sprite --------------------------
  const banks = new Map();
  const markers = new Set();
  const markerWrite = (marker, set, index) => {
    writeFields(set, index, {
      position: marker.drawnPosition,
      color: marker.rgba,
      show: marker.show,
      ...(marker.cell ? { cell: marker.cell } : {}),
    });
    set.set(index, { pickId: marker.id });
  };
  const bankFor = (key, options) => {
    let bank = banks.get(key);
    if (!bank) {
      const index = banks.size;
      bank = createMoverBank(engine, {
        options: (capacity, generation) => ({
          id: `${layerId}-${index}-${generation}`,
          capacity,
          pickable: true,
          // Cesium's disableDepthTestDistance = Infinity: over the scene.
          depthTest: 'always',
          ...options,
        }),
        write: markerWrite,
        onCommit,
      });
      bank.setVisible(visible);
      banks.set(key, bank);
    }
    return bank;
  };
  const pointBank = (sizePx) =>
    bankFor(`point:${sizePx}`, {
      kind: 'point',
      point: { sizePx, outlinePx: 0 },
    });
  let reticleImage = null;
  const reticleBank = (image) => {
    reticleImage ??= image;
    return bankFor('reticle', {
      kind: 'sprite',
      sprite: {
        sizePx: RETICLE_SIZE_PX,
        atlas: {
          ...(typeof reticleImage === 'string'
            ? { url: reticleImage }
            : { canvas: reticleImage }),
          cells: { [RETICLE_CELL]: [0, 0, 1, 1] },
        },
      },
    });
  };

  // A function position is read each frame while its marker draws.
  const readPosition = (marker) => {
    const position =
      typeof marker.position === 'function'
        ? marker.position()
        : marker.position;
    if (!position) return false;
    if (geo.cartesian3.equals(position, marker.drawnPosition)) return false;
    geo.cartesian3.clone(position, marker.drawnPosition);
    return true;
  };
  const refresh = (marker) => {
    if (!visible || !marker.show || typeof marker.position !== 'function')
      return;
    if (readPosition(marker))
      marker.bank.update(marker, { position: marker.drawnPosition });
  };

  class Marker {
    constructor(bank, { id, position, color, cell }) {
      this.bank = bank;
      this.gevBank = null;
      this.gevIndex = -1;
      this.id = id;
      this.cell = cell;
      this.position = position;
      this.drawnPosition = geo.cartesian3.clone(geo.cartesian3.ZERO);
      this.rgba = rgbaOf(color);
      this._show = true;
      if (typeof position !== 'function') readPosition(this);
      else if (visible) readPosition(this);
      ownPick(id);
      markers.add(this);
      bank.add(this);
    }

    get show() {
      return this._show;
    }

    set show(value) {
      const next = value !== false;
      if (next === this._show) return;
      this._show = next;
      if (next && typeof this.position === 'function' && visible)
        readPosition(this);
      this.bank.update(this, {
        show: next,
        position: this.drawnPosition,
      });
    }

    remove() {
      if (!markers.delete(this)) return;
      dropPick(this.id);
      this.bank.remove(this);
    }
  }

  // --- lines ------------------------------------------------------------------
  const lines = new Set();
  class LineHandle {
    constructor(options) {
      const { id, positions, pickId, modelMatrix } = options;
      this.id = id;
      this.pickId = pickId;
      this.positions = positions;
      this._show = true;
      this.line = engine.lines.createLine({
        id: `${layerId}-line-${++lineSeq}`,
        widthPx: options.widthPx,
        color: rgbaOf(options.color),
        arc: options.arc ?? 'none',
        ...(options.dash ? { dash: options.dash } : {}),
        ...(options.depthFailAlpha
          ? { depthFailAlpha: options.depthFailAlpha }
          : {}),
        ...(modelMatrix ? { modelMatrix: [...modelMatrix] } : {}),
        ...(pickId !== undefined ? { pickId } : {}),
      });
      this.line.setPositions(positions);
      this.line.show(visible);
      if (pickId !== undefined) ownPick(pickId);
      lines.add(this);
    }

    get show() {
      return this._show;
    }

    set show(value) {
      const next = value !== false;
      if (next === this._show) return;
      this._show = next;
      this.line.show(visible && next);
    }

    setModelMatrix(matrix) {
      this.line.setModelMatrix([...matrix]);
    }

    remove() {
      if (!lines.delete(this)) return;
      if (this.pickId !== undefined) dropPick(this.pickId);
      this.line.destroy();
    }
  }

  // --- frames -------------------------------------------------------------------
  removers.push(
    engine.frames.preUpdate.addEventListener(() => {
      frameNumber++;
    }),
  );
  // Before the layer's own listeners: function positions of the drawn markers.
  removers.push(
    engine.frames.preRender.addEventListener(() =>
      frame(() => {
        if (!visible) return;
        for (const marker of markers) refresh(marker);
      }),
    ),
  );

  const occluder = {
    isPointVisible: (position) => engine.projector.horizonVisible(position),
  };

  return {
    engine,
    ownsPick: owns,
    occluder,
    /** The engine frames seen so far (preUpdate). */
    frameNumber: () => frameNumber,
    visible: () => visible && !destroyed,
    /** The layer's switch: nothing draws while it is off. */
    setVisible(next) {
      next = Boolean(next) && !destroyed;
      if (next === visible) return;
      visible = next;
      for (const pad of pads) pad.refresh();
      frame(() => {
        for (const bank of banks.values()) bank.setVisible(visible);
        if (visible) for (const marker of markers) refresh(marker);
        for (const handle of lines) handle.line.show(visible && handle.show);
      });
    },
    /** A frame event listener whose writes commit when it returns. */
    on(name, listener) {
      const remove = engine.frames[name].addEventListener((time) =>
        frame(() => listener(time)),
      );
      removers.push(remove);
      return remove;
    },
    /** A dot of `sizePx` CSS px over the scene; picks return `id`. */
    addPoint: ({ id, position, sizePx, color }) =>
      new Marker(pointBank(sizePx), { id, position, color }),
    /** The hover reticle (`image`: a canvas or url) over the scene. */
    addReticle: ({ id, position, image }) =>
      new Marker(reticleBank(image), {
        id,
        position,
        color: [1, 1, 1, 1],
        cell: RETICLE_CELL,
      }),
    /**
     * A line: { id, positions, widthPx, color, dash?, arc?, pickId?,
     * modelMatrix?, depthFailAlpha? } (engine.lines options).
     */
    addLine: (options) => new LineHandle(options),
    /** The launch pad's radial fill, draped on terrain and tiles. */
    createPad(launch) {
      const set = engine.ground.createSet({
        id: `rocket-pad-zone:${launch.id}`,
        kind: 'disc',
      });
      const { color, ...radial } = LAUNCH_PAD_ZONE_STYLE;
      set.replace([
        {
          center: [launch.lon, launch.lat],
          radiusM: LAUNCH_PAD_ZONE_RADIUS_M,
          fill: rgbaFromCss(color).rgba(),
          radial,
        },
      ]);
      set.commit();
      let shown = true;
      const pad = {
        get show() {
          return shown;
        },
        set show(value) {
          shown = value !== false;
          pad.refresh();
        },
        refresh: () => set.show(visible && shown),
        destroy() {
          if (pads.delete(pad)) set.destroy();
        },
      };
      pads.add(pad);
      pad.refresh();
      return pad;
    },
    project: (position, result) =>
      engine.projector.worldToWindow(position, result),
    /**
     * Clicks through the selection dispatcher: `listener(id)` gets the
     * first of the layer's pick ids under the click, or undefined.
     */
    onClick(listener, { enabled = () => true } = {}) {
      const remove = selectionDispatcherFor(engine).register(LAYER_ID, {
        owns,
        onClick: (ctx) => {
          if (!isPointerFree()) return;
          if (!enabled()) return;
          const id = [ctx.picked, ...ctx.drilled]
            .map((picked) => resolvePickId(picked))
            .find(owns);
          listener(id);
        },
      });
      removers.push(remove);
      return { destroy: remove };
    },
    /** The pointer cursor over the layer's picks (createLaunchHover). */
    onHover({ enabled = () => true } = {}) {
      const hover = createLaunchHover({ engine, enabled, isLaunchPick: owns });
      const removeMove = engine.input.on('move', hover.move);
      const handle = {
        reset: hover.reset,
        destroy() {
          removeMove();
          hover.destroy();
        },
      };
      removers.push(handle.destroy);
      return handle;
    },
    destroy() {
      if (destroyed) return;
      flush();
      destroyed = true;
      visible = false;
      for (const remove of removers.splice(0)) remove?.();
      for (const marker of [...markers]) marker.remove();
      for (const bank of banks.values()) bank.destroy();
      banks.clear();
      pending.clear();
      for (const handle of [...lines]) handle.remove();
      for (const pad of [...pads]) pad.destroy();
      pickIds.clear();
    },
  };
}
