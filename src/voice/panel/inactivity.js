/** Local inactivity only. Unknown activity never authorizes expiry. */
export function createVoiceInactivity({
  readActivity,
  readPending,
  minutes = 5,
  onExpire,
  signal,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  now = Date.now,
}) {
  if (!Number.isInteger(minutes) || minutes < 0 || minutes > 60) minutes = 5;
  let disposed = false,
    timer = null,
    deadline = null,
    eligible = false,
    epoch = 0;
  function cancel() {
    epoch++;
    if (timer !== null) clearTimer(timer);
    timer = deadline = null;
  }
  function quiet() {
    const a = readActivity();
    return (
      a.known &&
      a.connected &&
      !a.held &&
      !a.inputBusy &&
      !a.outputBusy &&
      !a.generationBusy &&
      !readPending()
    );
  }
  function arm() {
    cancel();
    if (!minutes || disposed) return;
    const id = epoch;
    deadline = now() + minutes * 60000;
    timer = setTimer(() => {
      if (disposed || id !== epoch) return;
      timer = deadline = null;
      eligible = quiet();
      if (eligible) onExpire?.();
    }, minutes * 60000);
  }
  function update({ activity = false } = {}) {
    if (disposed) return;
    const next = quiet();
    if (!next) cancel();
    else if (!eligible || activity) arm();
    eligible = next;
  }
  function setMinutes(value) {
    if (!Number.isInteger(value) || value < 0 || value > 60) return false;
    if (disposed) return false;
    minutes = value;
    eligible = false;
    update();
    return true;
  }
  function destroy() {
    if (disposed) return;
    disposed = true;
    cancel();
    signal?.removeEventListener('abort', destroy);
  }
  signal?.addEventListener('abort', destroy, { once: true });
  if (signal?.aborted) destroy();
  update();
  return {
    update,
    setMinutes,
    snapshot: () => ({ minutes, deadline, eligible, disposed }),
    destroy,
  };
}
