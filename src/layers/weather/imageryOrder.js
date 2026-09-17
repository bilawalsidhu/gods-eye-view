const priorities = new WeakMap();

/** Scalar context, infrared, radar, then lightning: independent of enable order. */
export function orderWeatherImagery(collection, layer, priority) {
  priorities.set(layer, priority);
  if (typeof collection.raiseToTop !== 'function') return;
  const weather = [];
  for (let i = 0; i < collection.length; i++) {
    const item = collection.get(i);
    if (priorities.has(item)) weather.push(item);
  }
  weather.sort((a, b) => priorities.get(a) - priorities.get(b));
  for (const item of weather) collection.raiseToTop(item);
}
