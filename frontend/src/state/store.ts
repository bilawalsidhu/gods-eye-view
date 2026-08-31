/**
 * Live mover state and the current selection.
 *
 * A plain module, no framework. Everything that renders subscribes to it, and nothing
 * else holds a second copy of the data: the globe reads from here, the cards read from
 * here, and the two cannot disagree.
 *
 * Aircraft and vessels are held in separate maps keyed on their own identities, an ICAO
 * 24-bit address and an MMSI, because they are different things with different cards.
 * Satellites are not held here at all: a satellite record is an orbital element set with
 * no position, and the propagation worker owns the element cache.
 */

import { emptyBatch } from '../net/ws';
import type { Batch, Changes } from '../net/ws';
import type { Aircraft, FeedHealth, LayerName, Vessel } from '../types/entities';

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

/** One vessel as held for display, with when its fix reached the browser. */
export interface TrackedVessel {
  vessel: Vessel;
  /**
   * Local clock reading when this record arrived.
   *
   * The age counter runs from here plus the report age the feed gave us, so a browser
   * clock that is minutes out does not make every ship look stale.
   */
  receivedAtMs: number;
}

/**
 * What is currently selected, and therefore which card is open.
 *
 * Discriminated rather than a bare id, because one click has to route to one card and an
 * MMSI and an ICAO address are both just strings.
 */
export type Selection =
  | { kind: 'aircraft'; id: string; aircraft: TrackedAircraft }
  | { kind: 'vessel'; id: string; vessel: TrackedVessel };

type BatchListener = (batch: Batch) => void;
type SelectionListener = (selected: Selection | null) => void;

/**
 * Exported so tests can construct a fresh one.
 *
 * Nothing that ships may build a second store: the whole point of the module is that the
 * globe and the card read the same records and cannot disagree. Use `store` below.
 */
export class Store {
  private readonly tracked = new Map<string, TrackedAircraft>();
  private readonly vessels = new Map<string, TrackedVessel>();
  private readonly batchListeners = new Set<BatchListener>();
  private readonly selectionListeners = new Set<SelectionListener>();
  private selectedId: string | null = null;
  private latestFeeds: readonly FeedHealth[] = [];

  get size(): number {
    return this.tracked.size;
  }

  get vesselCount(): number {
    return this.vessels.size;
  }

  get feeds(): readonly FeedHealth[] {
    return this.latestFeeds;
  }

  get(icao24: string): TrackedAircraft | undefined {
    return this.tracked.get(icao24);
  }

  vessel(mmsi: string): TrackedVessel | undefined {
    return this.vessels.get(mmsi);
  }

  get selected(): Selection | null {
    if (this.selectedId === null) {
      return null;
    }
    const aircraft = this.tracked.get(this.selectedId);
    if (aircraft !== undefined) {
      return { kind: 'aircraft', id: this.selectedId, aircraft };
    }
    const vessel = this.vessels.get(this.selectedId);
    return vessel === undefined ? null : { kind: 'vessel', id: this.selectedId, vessel };
  }

  /**
   * Feed health from the REST endpoint, for the first paint.
   *
   * It goes through the store rather than straight to the panels because the store is the
   * one place this state lives. Painted directly, the first `feed_status`-less batch (the
   * REST snapshot itself) repainted the rail off an empty `feeds` and every count on it
   * vanished until the socket happened to send health.
   */
  setFeeds(feeds: readonly FeedHealth[]): void {
    this.latestFeeds = feeds;
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
    const batch = emptyBatch();
    batch.aircraft.snapshots.set(layer, records);
    this.applyBatch(batch, nowMs);
  }

  /** The same for a REST vessel snapshot, which is one layer and one store server side. */
  applyVesselSnapshot(records: Vessel[], nowMs: number = Date.now()): void {
    const batch = emptyBatch();
    batch.vessels.snapshots.set('vessels', records);
    this.applyBatch(batch, nowMs);
  }

  /** Fold one frame of socket traffic into state, then tell everyone once. */
  applyBatch(batch: Batch, nowMs: number = Date.now()): void {
    for (const [layer, entities] of batch.aircraft.snapshots) {
      for (const [id, held] of this.tracked) {
        if (held.layer === layer) {
          this.tracked.delete(id);
        }
      }
      for (const entity of entities) {
        this.tracked.set(entity.icao24, { aircraft: entity, layer, receivedAtMs: nowMs });
      }
    }
    for (const [id, entry] of batch.aircraft.upserts) {
      this.tracked.set(id, {
        aircraft: entry.entity,
        layer: entry.layer,
        receivedAtMs: nowMs,
      });
    }
    for (const [id, layer] of batch.aircraft.removals) {
      if (this.tracked.get(id)?.layer === layer) {
        this.tracked.delete(id);
      }
    }
    // Vessels are one layer and one server-side store, merged from every provider before
    // they reach us, so there is no per-record layer to discriminate on the way a stale
    // military removal has to be discriminated above.
    for (const entities of batch.vessels.snapshots.values()) {
      this.vessels.clear();
      for (const entity of entities) {
        this.vessels.set(entity.mmsi, { vessel: entity, receivedAtMs: nowMs });
      }
    }
    for (const [mmsi, entry] of batch.vessels.upserts) {
      this.vessels.set(mmsi, { vessel: entry.entity, receivedAtMs: nowMs });
    }
    for (const mmsi of batch.vessels.removals.keys()) {
      this.vessels.delete(mmsi);
    }
    if (batch.feeds !== null) {
      this.latestFeeds = batch.feeds;
    }

    for (const listener of this.batchListeners) {
      listener(batch);
    }
    // A card shows a live record, so a new fix for the selected aircraft or vessel is a
    // selection change as far as its readers are concerned. A selection that has dropped off
    // its feed deselects: keeping a card open over a position we no longer have would be
    // exactly the frozen-but-looks-live display this app is meant to avoid.
    if (
      this.selectedId !== null &&
      (this.selected === null || this.touches(batch, this.selectedId))
    ) {
      this.announceSelection();
    }
  }

  /**
   * Select one aircraft or vessel by the id its primitive carries, or `null` to deselect.
   *
   * Selecting something we do not hold is ignored rather than treated as a deselection: a
   * click that missed should not close the card the user is reading.
   */
  select(id: string | null): void {
    if (id !== null && !this.tracked.has(id) && !this.vessels.has(id)) {
      return;
    }
    if (this.selectedId === id) {
      return;
    }
    this.selectedId = id;
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
    return (
      touchesChanges(batch.aircraft, id, (record) => record.icao24) ||
      touchesChanges(batch.vessels, id, (record) => record.mmsi)
    );
  }
}

function touchesChanges<T>(changes: Changes<T>, id: string, key: (record: T) => string): boolean {
  if (changes.upserts.has(id) || changes.removals.has(id)) {
    return true;
  }
  for (const entities of changes.snapshots.values()) {
    if (entities.some((entity) => key(entity) === id)) {
      return true;
    }
  }
  return false;
}

/** The one instance the app uses. Constructed here so nothing has to pass it around. */
export const store = new Store();
