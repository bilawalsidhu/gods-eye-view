function referencesOf(alert) {
  return String(alert?.references || '')
    .split(/\s+/)
    .filter(Boolean)
    .map((r) => r.split(',')[1] || r);
}
function time(a) {
  const n = Date.parse(a?.sent || '');
  return Number.isFinite(n) ? n : -Infinity;
}
export function createCapState({ now = () => Date.now() } = {}) {
  const records = new Map();
  const cancelled = new Set();
  return {
    ingest(alerts = []) {
      for (const alert of alerts) {
        const refs = referencesOf(alert);
        if (alert?.msgType === 'Cancel') {
          const targets = refs.length ? refs : [alert.identifier];
          for (const id of targets) {
            if (id) {
              records.delete(id);
              cancelled.add(id);
            }
          }
          continue;
        }
        if (!alert?.identifier) continue;
        const target =
          alert.msgType === 'Update'
            ? refs[0] || alert.identifier
            : alert.identifier;
        const old = records.get(target);
        if (cancelled.has(target) || (old && time(alert) <= time(old)))
          continue;
        if (alert.msgType === 'Update' && !old) continue;
        records.set(target, { ...alert, identifier: target });
      }
      return this.snapshot();
    },
    snapshot() {
      const cutoff = now();
      for (const [id, alert] of records) {
        if (
          alert.info?.some((i) => i.expires && Date.parse(i.expires) <= cutoff)
        )
          records.delete(id);
      }
      return [...records.values()].sort((a, b) => time(b) - time(a));
    },
  };
}
