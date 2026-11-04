/** Connect portable vessel reconciliation to scene and selection operations. */

export function createVesselSnapshotRenderer({
  state,
  records,
  rendering,
  tracking,
  selection,
  cards,
}) {
  function reconcileVessels(viewer, rows, { complete = true } = {}) {
    rendering.ensureCollections(viewer);
    const occluder = rendering.makeOccluder();
    records.reconcile(
      rows,
      {
        complete,
        selectedRecord: state.selectedRecord,
        cap: rendering.renderRowLimit(),
      },
      {
        add(record) {
          rendering.prepareRecordVisual(record);
          rendering.addRecordPrimitives(record, occluder);
        },
        updated(record) {
          const selected = record === state.selectedRecord;
          rendering.prepareRecordVisual(record);
          rendering.syncRecordIcon(record);
          if (record.mmsi === state.trailMmsi)
            tracking.appendSelectedVesselTrailFix(record);
          if (selected) {
            cards.updateSelectedVesselHud(record);
            selection.registerSelectedContext(record);
          }
        },
        remove(record, evicted) {
          if (evicted) selection.clearVesselInspection({ evicted: true });
          rendering.removeRecordPrimitives(record);
        },
        removed(mmsi) {
          if (state.trailMmsi === mmsi) tracking.clearSelectedVesselTrail();
        },
        staleSelected(record) {
          cards.updateSelectedVesselHud(record);
        },
      },
    );
    state.lastVisibilityUpdate = 0;
    rendering.updateVisibility(true);
  }
  return { reconcileVessels };
}
