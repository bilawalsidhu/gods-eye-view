import { defineStore } from 'pinia';
import { markRaw } from 'vue';

/**
 * What the Stories view shows. The controller (src/stories/controller.js)
 * owns the globe, the players and the URL; it connects here and the view's
 * controls reach it through `controller`.
 */
export const useStoriesStore = defineStore('stories', {
  state: () => ({
    /** 'closed' | 'explore' | 'story' */
    mode: 'closed',
    storyId: null,
    /** Explore */
    query: '',
    chips: [],
    sort: 'new',
    filters: { region: [], length: [] },
    picked: null,
    pins: [],
    feedSnap: 'split',
    /** Story */
    /** Story card images by story id (none yet: cards show a placeholder). */
    thumbs: {},
    playback: {
      wallMs: 0,
      worldMs: null,
      durationMs: 0,
      playing: false,
      exploring: false,
      chapterIndex: 0,
    },
    /** The big Play button over a story that opened paused. */
    bigPlay: false,
    camera: { lat: 0, lon: 0, altKm: 0 },
    muted: true,
    expanded: false,
    /** Context panel shown over the map while expanded (desktop). */
    ctxOpen: false,
    /** Phone context sheet: 'peek' | 'half' | 'full' */
    sheet: 'peek',
    /** Width the person dragged the context panel to; 0 is the default. */
    contextWidth: 0,
    /** Hints and toasts */
    hint: '',
    toast: '',
    hostedToast: null,
    popSeen: false,
    hintSeen: false,
    sheetHintSeen: false,
    controller: null,
    /** False where Stories is not offered (GEV embedded inline in a host page). */
    available: true,
    /** Every story Explore lists, as the controller publishes them. */
    stories: [],
  }),
  getters: {
    byId: (state) => (id) => state.stories.find((s) => s.id === id) ?? null,
  },
  actions: {
    connect(controller, stories = []) {
      this.controller = markRaw(controller);
      this.stories = markRaw(stories);
    },
    flashHint(text, ms = 1600) {
      this.hint = text;
      clearTimeout(hintTimer);
      hintTimer = setTimeout(() => {
        if (this.hint === text) this.hint = '';
      }, ms);
    },
    flashToast(text, ms = 2200) {
      this.toast = text;
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => {
        if (this.toast === text) this.toast = '';
      }, ms);
    },
  },
});

let hintTimer = 0;
let toastTimer = 0;
