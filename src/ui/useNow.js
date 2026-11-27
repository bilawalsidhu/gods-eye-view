import { onMounted, ref, watch } from 'vue';

/** Keep a component's clock current while it is mounted and active. */
export function useNow(intervalMs, active = () => true) {
  const now = ref(Date.now());
  onMounted(() => {
    watch(
      active,
      (running, _, onCleanup) => {
        if (!running) return;
        const refresh = () => {
          now.value = Date.now();
        };
        refresh();
        const timer = setInterval(refresh, intervalMs);
        onCleanup(() => clearInterval(timer));
      },
      { immediate: true },
    );
  });
  return now;
}
