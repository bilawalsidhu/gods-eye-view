const SCHEDULED = new Set([
  'go',
  'go for launch',
  'hold',
  'launch on hold',
  'tbd',
  'to be determined',
  'tbc',
  'to be confirmed',
  'scrubbed',
  'launch scrubbed',
  'launch was scrubbed',
]);
const COMPLETED = new Set([
  'success',
  'launch successful',
  'failure',
  'launch failure',
  'partial failure',
  'launch partial failure',
  'in flight',
  'launch in flight',
  'payload deployed',
]);

export function missionIsUpcoming(entry, now) {
  if (!Number.isFinite(entry.launchAt)) return false;
  const status = String(entry.status ?? '')
    .trim()
    .toLowerCase();
  return (
    SCHEDULED.has(status) || (entry.launchAt >= now && !COMPLETED.has(status))
  );
}

/**
 * Space Missions roster entries in time order, as Inspect lists them: those
 * still scheduled first, including delayed launches whose advertised time
 * passed. Within that group, precise dates sort first and then coarse ones.
 * Past launches are newest first, followed by any without a time.
 * @param {{launchAt: ?number, status?: string, launchPrecision?: string}[]} entries Roster entries.
 * @param {number} now The time in ms.
 * @param {number} [limit] How many to return; all of them by default.
 * @returns {{entry: object, upcoming: boolean}[]}
 */
export function missionsByTime(entries, now, limit = Infinity) {
  const upcoming = [];
  const past = [];
  const undated = [];
  for (const entry of entries || []) {
    if (!Number.isFinite(entry.launchAt)) undated.push(entry);
    else if (missionIsUpcoming(entry, now)) upcoming.push(entry);
    else past.push(entry);
  }
  upcoming.sort(
    (a, b) =>
      Number(Boolean(a.launchPrecision)) - Number(Boolean(b.launchPrecision)) ||
      a.launchAt - b.launchAt,
  );
  past.sort((a, b) => b.launchAt - a.launchAt);
  return [
    ...upcoming.map((entry) => ({ entry, upcoming: true })),
    ...[...past, ...undated].map((entry) => ({ entry, upcoming: false })),
  ].slice(0, limit);
}
