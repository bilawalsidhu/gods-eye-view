const STORAGE_KEY = 'gev-replay-alerts';

/** Whether the viewer switched alerts on earlier (kept in this browser only). */
export function alertsEnabled() {
  try {
    return globalThis.localStorage?.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function remember(on) {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, on ? '1' : '0');
  } catch {
    // The choice then lasts until the page closes.
  }
}

/**
 * Switches alerts on or off. Turning them on must run inside a click, because
 * browsers only ask for notification permission, and only start sound, after
 * a gesture. Resolves to the permission state, so the caller can say when
 * notifications are blocked and alerts will only show in the panel.
 * @param {boolean} on
 * @returns {Promise<'granted'|'denied'|'default'|'unsupported'>}
 */
export async function setAlerts(on) {
  remember(on);
  if (!on) return 'default';
  const api = globalThis.Notification;
  if (!api) return 'unsupported';
  if (api.permission !== 'default') return api.permission;
  try {
    return await api.requestPermission();
  } catch {
    return 'default';
  }
}

let audio = null;

/** Two short tones; an emergency is higher and longer so it cannot be missed. */
export function beep(urgent = false) {
  try {
    const Context = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!Context) return;
    audio ??= new Context();
    if (audio.state === 'suspended') audio.resume?.();
    const start = audio.currentTime;
    const tones = urgent ? [988, 1319, 988] : [660, 880];
    tones.forEach((frequency, i) => {
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      osc.frequency.value = frequency;
      const at = start + i * 0.18;
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.15, at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.16);
      osc.connect(gain).connect(audio.destination);
      osc.start(at);
      osc.stop(at + 0.17);
    });
  } catch {
    // Sound is a convenience; the panel line still shows.
  }
}

/** Sounds the alert and, when the browser allows it, raises a notification. */
export function announce({ title, body, urgent = false, tag }) {
  beep(urgent);
  try {
    const api = globalThis.Notification;
    if (api?.permission === 'granted')
      new api(title, { body, tag, requireInteraction: urgent });
  } catch {
    // Some browsers only allow notifications from a service worker.
  }
}
