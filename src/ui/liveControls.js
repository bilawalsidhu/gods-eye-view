import {
  LIVE_STREAMS,
  liveStreamsFor,
  youtubeWatchUrl,
} from '../data/liveStreams.js';
import { createYouTubeLivePlayer } from '../data/youtubeLivePlayer.js';
import { useLiveStore } from './stores/live.js';
import { applicationPinia } from './vueRuntime.js';

/** The element the LIVE section in Context keeps for the player. */
export const LIVE_PLAYER_HOST_ID = 'live-player-host';

/**
 * The element the Cockpit briefing's LIVE page keeps for the player; the one
 * used while the Cockpit is on, since the right rail is hidden there.
 */
export const COCKPIT_LIVE_PLAYER_HOST_ID = 'cockpit-live-player-host';

/**
 * A layer's selected subject can be judged again as it settles (a satellite
 * is docked to the station once both orbits have been compared): the keys
 * are read again this often while something is selected.
 */
export const LIVE_SUBJECT_REFRESH_MS = 2000;

/**
 * Own the live video: which object is selected (the tracking layers'
 * `gev:awareness-subject-selected`), which streams the list attaches to it,
 * and the one player. The views (the LIVE section in Context and the Cockpit
 * briefing's LIVE page) render what this publishes, and the player is built
 * only when the viewer presses Play in one of them (`playLive`): YouTube sees
 * the viewer's IP address, so selecting a station by click, a link, a scene
 * or voice never loads it. The player is built into the view that is shown,
 * the section's outside the Cockpit and the page's inside it, and goes when
 * that view is hidden (the section collapsed, Context closed, the Cockpit
 * page left: `hideLive`), when the Cockpit is entered or left, and when the
 * selection moves to an object without that stream or clears.
 */
export class LiveControls {
  /**
   * @param {{store?: object, actions: {getLayer: (layerId: string) => object|null,
   *   scheduleLayout?: () => void}, documentRef?: Document, globalRef?: object,
   *   createPlayer?: typeof createYouTubeLivePlayer,
   *   streams?: readonly object[], refreshMs?: number}} options
   */
  constructor({
    store = useLiveStore(applicationPinia()),
    actions,
    documentRef = globalThis.document,
    globalRef = globalThis,
    createPlayer = createYouTubeLivePlayer,
    streams = LIVE_STREAMS,
    refreshMs = LIVE_SUBJECT_REFRESH_MS,
  }) {
    this.store = store;
    this.actions = actions;
    this.documentRef = documentRef;
    this.globalRef = globalRef;
    this.createPlayer = createPlayer;
    this.streams = streams;
    this.refreshMs = refreshMs;
    this.destroyed = false;
    /** The selected object: its layer, id and label; null for none. */
    this.subject = null;
    /** The streams on offer for it, and the chosen one's id. */
    this.offered = [];
    this.currentId = null;
    /** The player, the element and stream it was built for, and its state. */
    this.player = null;
    this.playerHost = null;
    this.playerStreamId = null;
    this.playback = { state: 'idle', reason: null };
    /** Whether the Cockpit is on, which decides the host the player goes in. */
    this.cockpitActive =
      documentRef?.body?.classList?.contains?.('cockpit-mode') === true;
    this.timer = null;
    /** The view last published, as text: the 2 s refresh resends nothing new. */
    this.publishedKey = undefined;
    /** The stop held back for one tick after a clear (see `_onCleared`). */
    this.clearGrace = null;
    this.listeners = new AbortController();
    const { signal } = this.listeners;
    const target = globalRef.addEventListener ? globalRef : null;
    target?.addEventListener(
      'gev:awareness-subject-selected',
      (event) => this._onSelected(event.detail),
      { signal },
    );
    target?.addEventListener(
      'gev:awareness-subject-cleared',
      (event) => this._onCleared(event.detail),
      { signal },
    );
    target?.addEventListener(
      'gev:cockpit-mode-changed',
      (event) => this._onCockpitMode(event.detail?.active === true),
      { signal },
    );
    this.owner = store.connect({
      cycleLive: (direction) => this.cycle(direction),
      playLive: () => this.play(),
      stopLive: () => this.stop(),
      retryLive: () => this.play({ restart: true }),
      hideLive: (where) => this.hide(where),
    });
    store.publish(null);
  }

  /**
   * A new selection. A player that is on keeps playing when the new subject
   * offers the same stream (another entry of the same station: a module, a
   * docked vehicle, the Cockpit stepping between views on it); otherwise it
   * goes.
   */
  _onSelected(detail) {
    if (this.destroyed || !detail?.layerId || detail.id == null) return;
    this._cancelClearGrace();
    this.subject = {
      layerId: detail.layerId,
      id: detail.id,
      label: String(detail.label ?? detail.id),
    };
    if (this.player) {
      const offered = liveStreamsFor(this._subjectKeys(), this.streams);
      if (offered.some((stream) => stream.id === this.playerStreamId))
        this.currentId = this.playerStreamId;
      else this.stop();
    }
    this._refresh();
    this._arm();
  }

  /**
   * The selection cleared. With a player on, the stop waits one tick: the
   * Cockpit stepping between views on a station clears the selection and
   * selects the next entry at once, and a player for the same stream should
   * not be torn down and rebuilt between the two.
   */
  _onCleared(detail) {
    if (this.destroyed || !this.subject) return;
    if (detail?.layerId && detail.layerId !== this.subject.layerId) return;
    this.subject = null;
    this._disarm();
    if (this.player && this.globalRef.setTimeout) {
      this._cancelClearGrace();
      this.clearGrace = this.globalRef.setTimeout(() => {
        this.clearGrace = null;
        if (this.destroyed || this.subject) return;
        this.stop();
        this._refresh();
      }, 0);
      return;
    }
    this.stop();
    this._refresh();
  }

  _cancelClearGrace() {
    if (this.clearGrace !== null)
      this.globalRef.clearTimeout?.(this.clearGrace);
    this.clearGrace = null;
  }

  /**
   * The Cockpit went on or off: the view the player was in is hidden now,
   * so the player goes. The view now shown offers Play again.
   */
  _onCockpitMode(active) {
    if (this.destroyed || active === this.cockpitActive) return;
    this.cockpitActive = active;
    this.stop();
  }

  /**
   * A view was hidden (`section`: the LIVE section collapsed or Context
   * closed; `cockpit`: the briefing left its LIVE page or went): the player
   * goes if it was in that view's screen, so nothing plays unseen.
   * @param {'section'|'cockpit'} where
   * @returns {boolean} True when a player was removed.
   */
  hide(where) {
    const id =
      where === 'cockpit' ? COCKPIT_LIVE_PLAYER_HOST_ID : LIVE_PLAYER_HOST_ID;
    if (!this.player || this.playerHost?.id !== id) return false;
    return this.stop();
  }

  /** The element the player belongs in now: the Cockpit page's, or the section's. */
  _host() {
    const id = this.cockpitActive
      ? COCKPIT_LIVE_PLAYER_HOST_ID
      : LIVE_PLAYER_HOST_ID;
    return this.documentRef?.getElementById?.(id) ?? null;
  }

  /** Read the selected subject's keys again on a timer, while one is selected. */
  _arm() {
    this._disarm();
    if (!this.subject || !(this.refreshMs > 0)) return;
    this.timer = this.globalRef.setInterval(
      () => this._refresh(),
      this.refreshMs,
    );
    this.timer?.unref?.();
  }

  _disarm() {
    if (this.timer !== null) this.globalRef.clearInterval(this.timer);
    this.timer = null;
  }

  /** The keys the selected subject is known by, from its layer. */
  _subjectKeys() {
    if (!this.subject) return [];
    const { layerId, id } = this.subject;
    const keys = [`${layerId}:${id}`];
    let layer = null;
    try {
      layer = this.actions.getLayer?.(layerId) ?? null;
    } catch {
      layer = null;
    }
    try {
      for (const key of layer?.getLiveSubjectKeys?.() ?? [])
        if (typeof key === 'string') keys.push(key);
    } catch {
      // A layer that cannot say keeps its plain key.
    }
    return keys;
  }

  /** Work out the streams on offer and publish. */
  _refresh() {
    if (this.destroyed) return;
    const offered = liveStreamsFor(this._subjectKeys(), this.streams);
    const changed =
      offered.length !== this.offered.length ||
      offered.some((stream, index) => stream.id !== this.offered[index]?.id);
    this.offered = offered;
    if (!offered.some((stream) => stream.id === this.currentId)) {
      // The chosen stream went with the selection: nothing plays on.
      if (this.player) this.stop();
      this.currentId = offered[0]?.id ?? null;
    }
    this._publish();
    if (changed) this.actions.scheduleLayout?.();
  }

  /** Publish `view` unless it is the one published last. */
  _send(view) {
    const key = JSON.stringify(view);
    if (key === this.publishedKey) return;
    this.publishedKey = key;
    this.store.publish(view);
  }

  _publish() {
    if (this.destroyed) return;
    if (!this.subject || !this.offered.length) {
      this._send(null);
      return;
    }
    const index = Math.max(
      0,
      this.offered.findIndex((stream) => stream.id === this.currentId),
    );
    const current = this.offered[index];
    this._send({
      label: this.subject.label,
      streams: this.offered.map((stream) => ({
        id: stream.id,
        title: stream.title,
        owner: stream.owner,
      })),
      index,
      count: this.offered.length,
      current: {
        id: current.id,
        title: current.title,
        owner: current.owner,
        ownerUrl: current.ownerUrl,
        note: current.note,
        watchUrl: youtubeWatchUrl(current.videoId),
      },
      state: this.playback.state,
      reason: this.playback.reason,
    });
  }

  /**
   * Step to the next (+1) or previous (-1) stream on offer, wrapping. A
   * playing stream hands over to the new one.
   * @returns {boolean} True when the stream changed.
   */
  cycle(direction = 1) {
    if (this.offered.length < 2) return false;
    const index = this.offered.findIndex((s) => s.id === this.currentId);
    const next =
      (Math.max(index, 0) + (direction < 0 ? -1 : 1) + this.offered.length) %
      this.offered.length;
    this.currentId = this.offered[next].id;
    const wasPlaying = this.player !== null;
    this.stop();
    if (wasPlaying) this.play();
    else this._publish();
    return true;
  }

  /**
   * Start the chosen stream in the host now shown: the one call that loads
   * the player, made only by the viewer's Play (or Try again). A player
   * already loading or playing that stream in that host is left alone;
   * `restart` (Try again) builds a fresh one regardless.
   * @returns {boolean} True when a player is loading or playing afterwards.
   */
  play({ restart = false } = {}) {
    if (this.destroyed) return false;
    const stream = this.offered.find((s) => s.id === this.currentId);
    const host = this._host();
    if (!stream || !host) return false;
    const running =
      this.playback.state === 'loading' || this.playback.state === 'playing';
    if (
      !restart &&
      this.player &&
      running &&
      this.playerHost === host &&
      this.playerStreamId === stream.id
    )
      return true;
    this.stop();
    this.playback = { state: 'loading', reason: null };
    this.playerHost = host;
    this.playerStreamId = stream.id;
    this.player = this.createPlayer({
      host,
      videoId: stream.videoId,
      documentRef: this.documentRef,
      globalRef: this.globalRef,
      onChange: ({ state, reason }) => {
        if (this.destroyed) return;
        this.playback = { state, reason };
        this._publish();
      },
    });
    this._publish();
    return true;
  }

  /** Remove the player; the screen goes dark. */
  stop() {
    const had = this.player !== null;
    this.player?.destroy();
    this.player = null;
    this.playerHost = null;
    this.playerStreamId = null;
    if (had || this.playback.state !== 'idle') {
      this.playback = { state: 'idle', reason: null };
      this._publish();
    }
    return had;
  }

  destroy() {
    if (this.destroyed) return;
    this._cancelClearGrace();
    this.stop();
    this.destroyed = true;
    this._disarm();
    this.listeners.abort();
    this.store.detach(this.owner);
    this.store.publish(null);
  }
}
