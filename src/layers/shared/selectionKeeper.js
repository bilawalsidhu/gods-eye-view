import { isPointerFree } from '../../data/inputOwnership.js';

/** Selection state shared by record-backed marker layers. */
export function createSelectionKeeper({
  state,
  getSelectedEntityContext,
  selectRecord,
  clearSelection,
  pickId = ({ picked }) => (typeof picked?.id === 'string' ? picked.id : null),
  reselectContext = false,
}) {
  return {
    onClick(event) {
      if (!isPointerFree()) return;
      if (!state.enabled) return;
      const id = pickId(event);
      if (
        id &&
        state.recordById.has(id) &&
        (id !== state.selectedId ||
          (reselectContext && getSelectedEntityContext()?.id !== id))
      )
        selectRecord(id);
      else if (state.selectedId) clearSelection();
    },
    reconcile({ claimSelection = false, layerId, records } = {}) {
      const selected = getSelectedEntityContext();
      if (
        !claimSelection &&
        (selected?.id !== state.selectedId ||
          (layerId !== undefined && selected?.layerId !== layerId) ||
          (records &&
            !records.some((record) => record.id === state.selectedId)))
      ) {
        state.selectedId = null;
        return false;
      }
      return true;
    },
  };
}

/** Write the single selected marker; the caller owns the commit timing. */
export function writeSelectedMarker(set, fields) {
  set.setCount(fields ? 1 : 0);
  if (fields) set.set(0, fields);
}
