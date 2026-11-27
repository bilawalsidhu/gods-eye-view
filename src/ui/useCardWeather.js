import { hasInjectionContext, inject, ref, unref, watch } from 'vue';
import {
  readPointWeather,
  WEATHER_RETRY_MS,
  weatherPoint,
} from './viewWeather.js';

export function useCardWeather(location, store) {
  const weather = ref(null);
  const zone = ref(null);
  const pending = ref(false);
  const shown = hasInjectionContext() ? inject('contextViewShown', true) : true;
  let nextRead = 0;
  watch(
    [() => weatherPoint(location()), () => unref(shown)],
    ([point, visible], [previousPoint], onCleanup) => {
      if (point !== previousPoint) {
        weather.value = zone.value = null;
        pending.value = Boolean(point);
        nextRead = 0;
      }
      if (!point || !visible) return;
      const { lat, lon } = location();
      const controller = new AbortController();
      let reading = false;
      async function read() {
        if (
          reading ||
          Date.now() < nextRead ||
          globalThis.document?.visibilityState === 'hidden'
        )
          return;
        reading = true;
        const result = await readPointWeather(
          (signal) => store.readWeather(lat, lon, { exactPoint: true, signal }),
          point,
          controller.signal,
        );
        if (controller.signal.aborted) return;
        reading = false;
        pending.value = false;
        weather.value = result.reading;
        zone.value = result.zone;
        nextRead =
          Date.now() + (result.reading ? 5 * 60_000 : WEATHER_RETRY_MS);
      }
      const stop = watch(() => store.tick, read, { immediate: true });
      onCleanup(() => {
        controller.abort();
        stop();
      });
    },
    { immediate: true },
  );
  return { weather, zone, pending };
}
