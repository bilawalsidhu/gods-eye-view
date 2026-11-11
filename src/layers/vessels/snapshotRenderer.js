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
        beforeUpdate(record) {
          return rendering.shipIcon(record, record === state.selectedRecord);
        },
        updated(record, prevIcon) {
          const selected = record === state.selectedRecord;
          const visual = rendering.prepareRecordVisual(record);
          if (visual.billboard) {
            visual.billboard.position = visual.position;
            visual.billboard.scale =
              rendering.shipScale(record) * (selected ? 1.2 : 1);
            const nextIcon = rendering.shipIcon(record, selected);
            if (nextIcon !== prevIcon) visual.billboard.image = nextIcon;
          }
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
