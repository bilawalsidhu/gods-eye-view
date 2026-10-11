/**
 * HUD target sound: a short clip played whenever the selection reticle locks
 * onto a new subject (`gev:hud-target-locked`).
 *
 * The Display panel's HUD "Target sound" row sets `data-hud-lock-sound` on the
 * root element to `none`, `hud-lock` (default) or `sci-fi-click`. The clips are
 * bundled third-party assets (public/sounds/README.md).
 */

/** Dispatched on the window each time the reticle locks onto a new subject. */
export const HUD_TARGET_LOCKED_EVENT = 'gev:hud-target-locked';
export const LOCK_SOUND_VOLUME = 0.45;
export const NO_LOCK_SOUND = 'none';
export const DEFAULT_LOCK_SOUND = 'hud-lock';
/** Selectable clips, keyed by their `data-hud-lock-sound` value. */
export const LOCK_SOUND_FILES = Object.freeze({
  'hud-lock': 'sounds/hud-lock.wav',
  'sci-fi-click': 'sounds/sci-fi-click.wav',
});
export const LOCK_SOUND_IDS = Object.freeze([
  NO_LOCK_SOUND,
  ...Object.keys(LOCK_SOUND_FILES),
]);

/**
 * URL of a bundled clip, under the app's base path.
 * @param {string} [id]
 * @param {string} [baseUrl]
 * @returns {string|null} Null for `none` or an unknown id.
 */
export function lockSoundUrl(
  id = DEFAULT_LOCK_SOUND,
  baseUrl = import.meta.env?.BASE_URL || '/',
) {
  const file = LOCK_SOUND_FILES[id];
  return file ? `${baseUrl.replace(/\/?$/, '/')}${file}` : null;
}

/**
 * The selected target sound; unknown or missing values fall back to the
 * default clip.
 * @param {Document} [doc]
 * @returns {string} One of LOCK_SOUND_IDS.
 */
export function selectedLockSound(doc = globalThis.document) {
  const id = doc?.documentElement?.dataset?.hudLockSound;
  return LOCK_SOUND_IDS.includes(id) ? id : DEFAULT_LOCK_SOUND;
}

/**
 * Play the selected clip on every reticle lock.
 * @param {object} [options]
 * @param {Window} [options.win]
 * @param {Document} [options.doc]
 * @param {(id: string) => string|null} [options.urlFor]
 * @param {number} [options.volume]
 * @param {() => string} [options.getSoundId]
 * @param {(url: string) => HTMLAudioElement|null} [options.createAudio]
 * @returns {() => void} Uninstall.
 */
export function installLockSound({
  win = globalThis.window,
  doc = globalThis.document,
  urlFor = (id) => lockSoundUrl(id),
  volume = LOCK_SOUND_VOLUME,
  getSoundId = () => selectedLockSound(doc),
  createAudio = (src) =>
    typeof globalThis.Audio === 'function' ? new globalThis.Audio(src) : null,
} = {}) {
  if (!win?.addEventListener) return () => {};
  const clips = new Map();
  for (const id of Object.keys(LOCK_SOUND_FILES)) {
    const url = urlFor(id);
    let audio = null;
    try {
      audio = url ? createAudio(url) : null;
    } catch {
      audio = null;
    }
    if (!audio) continue;
    audio.preload = 'auto';
    audio.volume = volume;
    clips.set(id, audio);
  }
  if (!clips.size) return () => {};

  function onLocked() {
    const audio = clips.get(getSoundId());
    if (!audio) return;
    for (const other of clips.values()) if (other !== audio) other.pause?.();
    try {
      audio.pause?.();
      audio.currentTime = 0;
      const played = audio.play?.();
      // Autoplay refusals and missing files are not worth surfacing.
      if (played?.catch) void played.catch(() => {});
    } catch {
      // Ignore playback failures.
    }
  }

  win.addEventListener(HUD_TARGET_LOCKED_EVENT, onLocked);
  return () => {
    win.removeEventListener?.(HUD_TARGET_LOCKED_EVENT, onLocked);
    for (const audio of clips.values()) audio.pause?.();
  };
}
