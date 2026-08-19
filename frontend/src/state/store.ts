/**
 * Live aircraft state and the current selection.
 *
 * A plain module, no framework. Everything that renders subscribes to it, and nothing
 * else holds a second copy of the data: the globe reads from here, the card reads from
 * here, and the two cannot disagree.
 */

import type { Batch } from '../net/ws';
import type { Aircraft, FeedHealth, LayerName } from '../types/entities';

export interface TrackedAircraft {
  aircraft: Aircraft;
  /** Which feed reported it, so a removal from the other feed cannot delete it. */
  layer: LayerName;
  /**
   * Local clock reading when this fix reached the browser.
   *
   * The card's age counter is measured from here plus the fix age the feed reported,
   * rather than from the server timestamp, so a browser clock that is minutes out does
   * not make every aircraft look stale.
   */
  receivedAtMs: number;
}

type BatchListener = (batch: Batch) => void;
type SelectionListener = (selected: TrackedAircraft | null) => void;

/**
 * Exported so tests can construct a fresh one.
 *
 * Nothing that ships may build a second store: the whole point of the module is that the
 * globe and the card read the same records and cannot disagree. Use `store` below.
 */
export class Store {
  private readonly tracked = new Map<string, TrackedAircraft>();
  private readonly batchListeners = new Set<BatchListener>();
  private readonly selectionListeners = new Set<SelectionListener>();
  private selectedId: string | null = null;
  private latestFeeds: readonly FeedHealth[] = [];

  get size(): number {
    return this.tracked.size;
  }

  get feeds(): readonly FeedHealth[] {
    return this.latestFeeds;
  }

  get(icao24: string): TrackedAircraft | undefined {
    return this.tracked.get(icao24);
  }

  get selected(): TrackedAircraft | null {
    return this.selectedId === null ? null : (this.tracked.get(this.selectedId) ?? null);
  }

  onChange(listener: BatchListener): void {
    this.batchListeners.add(listener);
  }

  onSelectionChange(listener: SelectionListener): void {
    this.selectionListeners.add(listener);
  }

  /**
   * Apply a REST snapshot as if it had arrived on the socket.
   *
   * Used for the first paint so the globe is populated before the socket has said
   * anything. The socket's own snapshot then overwrites it, keyed on the same identity.
   */
  applySnapshot(layer: LayerName, records: Aircraft[], nowMs: number = Date.now()): void {
    this.applyBatch(
      {
        snapshots: new Map([[layer, records]]),
        upserts: new Map(),
        removals: new Map(),
        feeds: null,
      },
      nowMs,
    );
  }

  /** Fold one frame of socket traffic into state, then tell everyone once. */
  applyBatch(batch: Batch, nowMs: number = Date.now()): void {
    for (const [layer, entities] of batch.snapshots) {
      for (const [id, held] of this.tracked) {
        if (held.layer === layer) {
          this.tracked.delete(id);
        }
      }
      for (const entity of entities) {
        this.tracked.set(entity.icao24, { aircraft: entity, layer, receivedAtMs: nowMs });
      }
    }
    for (const [id, entry] of batch.upserts) {
      this.tracked.set(id, {
        aircraft: entry.aircraft,
        layer: entry.layer,
        receivedAtMs: nowMs,
      });
    }
    for (const [id, layer] of batch.removals) {
      if (this.tracked.get(id)?.layer === layer) {
        this.tracked.delete(id);
      }
    }
    if (batch.feeds !== null) {
      this.latestFeeds = batch.feeds;
    }

    for (const listener of this.batchListeners) {
      listener(batch);
    }
    // The card shows a live record, so a new fix for the selected aircraft is a selection
    // change as far as its readers are concerned. A selected aircraft that has dropped off
    // the feed deselects: keeping a card open over a position we no longer have would be
    // exactly the frozen-but-looks-live display this app is meant to avoid.
    if (
      this.selectedId !== null &&
      (!this.tracked.has(this.selectedId) || this.touches(batch, this.selectedId))
    ) {
      this.announceSelection();
    }
  }

  /**
   * Select one aircraft, or `null` to deselect. Selecting something we do not hold is
   * ignored rather than treated as a deselection: a click that missed should not close the
   * card the user is reading.
   */
  select(icao24: string | null): void {
    if (icao24 !== null && !this.tracked.has(icao24)) {
      return;
    }
    if (this.selectedId === icao24) {
      return;
    }
    this.selectedId = icao24;
    this.announceSelection();
  }

  private announceSelection(): void {
    const selected = this.selected;
    if (selected === null) {
      this.selectedId = null;
    }
    for (const listener of this.selectionListeners) {
      listener(selected);
    }
  }

  private touches(batch: Batch, id: string): boolean {
    if (batch.upserts.has(id) || batch.removals.has(id)) {
      return true;
    }
    for (const entities of batch.snapshots.values()) {
      if (entities.some((entity) => entity.icao24 === id)) {
        return true;
      }
    }
    return false;
  }
}

/** The one instance the app uses. Constructed here so nothing has to pass it around. */
export const store = new Store();
