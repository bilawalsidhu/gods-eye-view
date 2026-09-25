// src/data/atcAudio.js
// The ATC feature's audio, and the first thing in the app to hold the shared
// audio claim (`src/data/audioOwnership.js`).
//
// It plays ONE stream: a URL the viewer pasted themselves
// (`atcStreamPreference.js`). No stream URL ships with the app.
//
// The claim is the point. Radio's single-source guarantee was the incidental
// consequence of one layer owning one element; ATC is a second element in a
// different layer, so without the claim the two simply talk over each other.
// Holding it means:
//
//   - starting ATC stops whatever was playing, because two soundtracks at once
//     is worse than either;
//   - something else starting stops ATC, via `onRevoked`, without ATC having
//     to watch for it;
//   - changing station RENEWS rather than re-claims, so ATC does not revoke
//     itself mid-start.
//
// The element is injected rather than constructed so the whole state machine
// is testable without a DOM. In the app the default factory is used.

import { claimAudio, releaseAudio } from './audioOwnership.js';

export const ATC_AUDIO_OWNER = 'atc';

/** States the controller reports. `error` carries a reason. */
export const ATC_AUDIO_STATE = Object.freeze({
  IDLE: 'idle',
  LOADING: 'loading',
  PLAYING: 'playing',
  ERROR: 'error',
});

/**
 * Create the ATC audio controller.
 * @param {{createAudio?: () => HTMLAudioElement}} [options] - `createAudio`
 *   builds the media element; injected so the state machine can be tested
 *   without a DOM.
 * @returns {{play: (url: string) => Promise<boolean>, stop: () => void,
 *   getState: () => {state: string, url: string|null, error: string|null},
 *   subscribe: (listener: Function) => () => void, destroy: () => void}}
 *   The controller.
 */
export function createAtcAudio(options = {}) {
  const {
    createAudio = () => (typeof Audio === 'undefined' ? null : new Audio()),
  } = options;

  let audio = null;
  let lease = null;
  let state = ATC_AUDIO_STATE.IDLE;
  let url = null;
  let error = null;
  /** Bumped on every start and stop; a late promise from a superseded attempt
   * compares against it instead of mutating state that has moved on. */
  let generation = 0;
  const listeners = new Set();

  const snapshot = () => ({ state, url, error });

  function emit() {
    const value = snapshot();
    for (const listener of listeners) {
      try {
        listener(value);
      } catch {
        // A broken subscriber is not a reason to stop telling the others.
      }
    }
  }

  function set(next, nextError = null) {
    state = next;
    error = nextError;
    emit();
  }

  /** Silence the element without touching the claim. */
  function silence() {
    if (!audio) return;
    try {
      audio.pause();
    } catch {
      /* already stopped */
    }
    try {
      audio.removeAttribute('src');
      audio.load();
    } catch {
      /* detached or unsupported element */
    }
  }

  /**
   * Stop because something else took the audio. The claim is already gone, so
   * releasing here would free the NEW owner's lease, not ours.
   */
  function onRevoked() {
    generation += 1;
    lease = null;
    silence();
    url = null;
    set(ATC_AUDIO_STATE.IDLE);
  }

  return {
    /**
     * Start playing a stream URL. Validation belongs to the caller
     * (`validateStreamUrl`); this refuses an empty one and nothing else.
     * @param {string} nextUrl - An already-validated https stream URL.
     * @returns {Promise<boolean>} Whether playback started.
     */
    async play(nextUrl) {
      const target = String(nextUrl ?? '').trim();
      if (!target) {
        set(ATC_AUDIO_STATE.ERROR, 'No stream URL.');
        return false;
      }
      if (!audio) audio = createAudio();
      if (!audio) {
        set(ATC_AUDIO_STATE.ERROR, 'Audio is not available in this browser.');
        return false;
      }
      // Renew rather than re-claim: this controller may already hold the
      // audio, and a plain claim would fire its own onRevoked and stop the
      // playback it is starting.
      lease = claimAudio(ATC_AUDIO_OWNER, { onRevoked, renew: lease });
      const mine = ++generation;
      url = target;
      set(ATC_AUDIO_STATE.LOADING);
      try {
        audio.src = target;
        const started = audio.play();
        if (started?.then) await started;
        // Between the await and here, another producer may have taken the
        // audio, or a newer play() may have superseded this one.
        if (mine !== generation) return false;
        set(ATC_AUDIO_STATE.PLAYING);
        return true;
      } catch (cause) {
        if (mine !== generation) return false;
        silence();
        set(
          ATC_AUDIO_STATE.ERROR,
          cause?.name === 'NotAllowedError'
            ? 'The browser blocked playback until you interact with the page.'
            : 'That stream would not play.',
        );
        return false;
      }
    },

    /** Stop and give the audio back, so the next producer is not preempting. */
    stop() {
      generation += 1;
      silence();
      releaseAudio(lease);
      lease = null;
      url = null;
      set(ATC_AUDIO_STATE.IDLE);
    },

    /** @returns {{state: string, url: string|null, error: string|null}} Current state. */
    getState: snapshot,

    /**
     * @param {(value: {state: string, url: string|null, error: string|null}) => void} listener
     * @returns {() => void} Unsubscribe.
     */
    subscribe(listener) {
      if (typeof listener !== 'function') return () => {};
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    /** Tear down: stop, release, drop the element and every subscriber. */
    destroy() {
      this.stop();
      audio = null;
      listeners.clear();
    },
  };
}
