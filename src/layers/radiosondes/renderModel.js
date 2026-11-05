import { MAX_SONDES_RENDERED } from './policy.js';
import { isSondeAloft } from './records.js';

/**
 * Owns population membership and geometry/style signatures without Cesium.
 * Metadata always advances; only a changed visual input writes to the adapter.
 */
export function createSondeRenderModel({
  cap = MAX_SONDES_RENDERED,
  create,
  update,
  remove,
}) {
  const marks = new Map();
  const signatures = new Map();

  function sync(records, selected, revision = '') {
    const ranked = [...records.values()].sort(
      (a, b) =>
        (b.frame.serial === selected) - (a.frame.serial === selected) ||
        isSondeAloft(b.phase) - isSondeAloft(a.phase) ||
        b.frame.timeMs - a.frame.timeMs ||
        a.frame.serial.localeCompare(b.frame.serial),
    );
    const shown = ranked.slice(0, cap);
    const ids = new Set(shown.map((record) => record.frame.serial));
    let creates = 0,
      updates = 0,
      removes = 0;

    for (const [serial, mark] of marks) {
      if (ids.has(serial)) continue;
      remove(mark);
      marks.delete(serial);
      signatures.delete(serial);
      removes++;
    }

    for (const record of shown) {
      const { frame, phase } = record;
      const serial = frame.serial;
      const isSelected = serial === selected;
      let mark = marks.get(serial);
      if (!mark) {
        mark = create(record, isSelected);
        marks.set(serial, mark);
        creates++;
      }
      mark.frame = frame;
      mark.phase = phase;
      mark.selected = isSelected;
      const previous = signatures.get(serial);
      if (
        previous &&
        previous.lat === frame.lat &&
        previous.lon === frame.lon &&
        previous.altM === frame.altM &&
        previous.phase === phase &&
        previous.selected === isSelected &&
        previous.revision === revision
      )
        continue;

      update(mark, record, isSelected);
      signatures.set(serial, {
        lat: frame.lat,
        lon: frame.lon,
        altM: frame.altM,
        phase,
        selected: isSelected,
        revision,
      });
      updates++;
    }

    return {
      rendered: marks.size,
      total: records.size,
      creates,
      updates,
      removes,
      changed: creates + updates + removes > 0,
    };
  }

  function clear() {
    for (const mark of marks.values()) remove(mark);
    marks.clear();
    signatures.clear();
  }

  return { marks, sync, clear };
}
