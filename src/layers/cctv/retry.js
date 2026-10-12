/** Replace only this viewer's camera runtime, after its lease is released. */
export function createCameraRetry({
  getActive,
  isEnabled,
  ownsRecord,
  destroy,
  create,
  notify,
  now = Date.now,
  timeoutMs = 32000,
}) {
  let epoch = 0;
  let pending = null;
  const cancel = () => {
    epoch++;
    if (pending) {
      clearTimeout(pending.retry?.timer);
      if (pending.retry?.status === 'loading')
        pending.retry.status = 'cancelled';
    }
    pending = null;
  };
  const settle = (record, status, message) => {
    record.connection = { status, message };
    if (record.retry?.status === 'loading') {
      clearTimeout(record.retry.timer);
      record.retry.status = status;
      record.retry.message = message;
      if (pending === record) pending = null;
    }
    notify();
  };
  const retry = async () => {
    const record = getActive();
    if (
      !isEnabled() ||
      !record ||
      record.retry?.status === 'loading' ||
      now() < (record.retry?.nextAllowedAt || 0)
    )
      return false;
    cancel();
    const attempt = ++epoch;
    pending = record;
    record.retry = {
      attempt,
      status: 'loading',
      message: 'Reconnecting…',
      nextAllowedAt: now() + 5000,
    };
    record.connection = { status: 'loading', message: 'Reconnecting…' };
    // The render loop must not lazily recreate a decoder while DELETE is pending.
    record.releaseBlocked = true;
    const runtime = record.projection;
    record.releasePrevious ||= runtime?.playback?.release;
    const disposal = destroy(runtime);
    record.projection = null;
    notify();
    const released = await (disposal || record.releasePrevious?.() || true);
    if (released) {
      record.releasePrevious = null;
      record.releaseBlocked = false;
    } else if (record.retry?.attempt === attempt) {
      record.connection = {
        status: 'error',
        message:
          'Could not release the old connection. Press Refresh to retry.',
      };
      record.retry.message = record.connection.message;
      record.retry.status = 'error';
      clearTimeout(record.retry.timer);
      if (pending === record) pending = null;
      notify();
    }
    if (
      attempt !== epoch ||
      !isEnabled() ||
      getActive() !== record ||
      !ownsRecord(record)
    )
      return false;
    if (!released) {
      return false;
    }
    create(record);
    record.retry.timer = setTimeout(() => {
      if (
        attempt !== epoch ||
        getActive() !== record ||
        record.retry.status !== 'loading'
      )
        return;
      record.releaseBlocked = true;
      record.releasePrevious = record.projection?.playback?.release || null;
      destroy(record.projection);
      record.projection = null;
      settle(record, 'error', 'Camera unavailable. Press Refresh to retry.');
    }, timeoutMs);
    notify();
    return true;
  };
  return { retry, cancel, settle };
}
