/** Connect portable vessel reconciliation to scene and selection operations. */

export function createVesselSnapshotRenderer({
  state,
  records,
  rendering,
  tracking,
  selection,
  cards,
  followsClock = () => false,
}) {
  /** `replace`: the rows are the world at another time (see VesselRecords). */
  function reconcileVessels(
    viewer,
    rows,
    { complete = true, replace = false } = {},
  ) {
    rendering.ensureCollections(viewer);
    const occluder = rendering.makeOccluder();
    const follow = followsClock();
    records.reconcile(
      rows,
      {
        complete,
        selectedRecord: state.selectedRecord,
        cap: rendering.renderRowLimit(),
        ...(replace && { replace }),
        ...(follow && { follow }),
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
          if (record.id === state.trailId)
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
        removed(id) {
          if (state.trailId === id) tracking.clearSelectedVesselTrail();
        },
        staleSelected(record) {
          cards.updateSelectedVesselHud(record);
        },
      },
    );
    // The selected vessel at the new time: its trail starts there.
    if (replace && state.selectedRecord && state.trailId)
      tracking.startSelectedVesselTrail(state.selectedRecord);
    state.lastVisibilityUpdate = 0;
    rendering.updateVisibility(true);
  }
  return { reconcileVessels };
}
