/** Camera discovery uses degrees and supports view rectangles crossing the date line. */
export function discoverCctvCameras(
  cameras,
  { view, scope = 'view', query = '' } = {},
) {
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const inView = (camera) => {
    if (!view) return false;
    const { west, east, south, north } = view;
    return (
      camera.lat >= south &&
      camera.lat <= north &&
      (west <= east
        ? camera.lon >= west && camera.lon <= east
        : camera.lon >= west || camera.lon <= east)
    );
  };
  const distance = (camera) => {
    if (
      !view?.center ||
      !Number.isFinite(camera.lat) ||
      !Number.isFinite(camera.lon)
    )
      return Infinity;
    const rad = Math.PI / 180;
    const a =
      Math.sin(((camera.lat - view.center.lat) * rad) / 2) ** 2 +
      Math.cos(camera.lat * rad) *
        Math.cos(view.center.lat * rad) *
        Math.sin(((camera.lon - view.center.lon) * rad) / 2) ** 2;
    return 12742 * Math.asin(Math.sqrt(Math.min(1, a)));
  };
  const local = cameras.filter(inView);
  const results = (scope === 'all' ? cameras : local)
    .filter((camera) => {
      const text = [
        camera.city,
        camera.name,
        camera.provider,
        camera.sourceLabel,
        camera.id,
      ]
        .join(' ')
        .toLocaleLowerCase();
      return words.every((word) => text.includes(word));
    })
    .map((camera) => ({ ...camera, distanceKm: distance(camera) }))
    .sort(
      (a, b) =>
        a.distanceKm - b.distanceKm ||
        `${a.city} ${a.name}`.localeCompare(`${b.city} ${b.name}`) ||
        a.id.localeCompare(b.id),
    );
  return {
    cameras: results,
    localIds: new Set(local.map((camera) => camera.id)),
  };
}
