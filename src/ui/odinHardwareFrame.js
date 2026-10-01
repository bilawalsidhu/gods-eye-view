const RAIL_SELECTOR = '.odin-frame-connector';

function syncOdinHardwareFrame() {
  const frame = document.getElementById('odin-hardware-frame');
  if (!frame) return;

  const ringSize = Number.parseFloat(
    getComputedStyle(frame, '::after').width,
  );
  const width = frame.clientWidth;
  const height = frame.clientHeight;
  if (!Number.isFinite(ringSize) || !width || !height) return;

  const centerX = width / 2;
  const centerY = height / 2;
  // Stop just inside the ring's outer metal lip. The ring is painted above
  // these strips, so its lip hides this small overlap without letting metal
  // appear through the circular opening.
  const radius = ringSize / 2 + 5;

  for (const rail of frame.querySelectorAll(RAIL_SELECTOR)) {
    const box = rail.getBoundingClientRect();
    const railTop = box.top;
    const railBottom = box.bottom;
    const endpointAt = (y) => {
      const dy = y - centerY;
      const halfChord = Math.sqrt(Math.max(0, radius * radius - dy * dy));
      return {
        left: Math.max(0, centerX - halfChord),
        right: Math.max(0, width - centerX - halfChord),
      };
    };
    const top = endpointAt(railTop);
    const bottom = endpointAt(railBottom);

    rail.style.setProperty('--left-top', `${top.left}px`);
    rail.style.setProperty('--left-bottom', `${bottom.left}px`);
    rail.style.setProperty('--right-top', `${top.right}px`);
    rail.style.setProperty('--right-bottom', `${bottom.right}px`);
  }
}

if (typeof document !== 'undefined') {
  const scheduleSync = () => requestAnimationFrame(syncOdinHardwareFrame);
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', scheduleSync, { once: true });
  } else {
    scheduleSync();
  }

  window.addEventListener('resize', scheduleSync, { passive: true });
  if (typeof ResizeObserver !== 'undefined') {
    const observer = new ResizeObserver(scheduleSync);
    observer.observe(document.documentElement);
  }
  if (typeof MutationObserver !== 'undefined') {
    const observer = new MutationObserver(scheduleSync);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-ui-brand'],
    });
  }
}
