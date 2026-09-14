import {
  GLOBAL_RADIO_ALTITUDE_M,
  RADIO_SINGLETON_GLOBAL_LIMIT,
  RADIO_SINGLETON_MID_LIMIT,
  RADIO_SINGLETON_NEAR_LIMIT,
  RADIO_OVERLAY_COHORT_LIMIT,
} from './policy.js';

export function createClustering({
  state: layerState,
  services,
  parts,
  source,
}) {
  /** Return the bounded singleton-label allowance for the current camera scale. */

  function radioSingletonLabelLimit(cameraHeightM) {
    const height = Math.max(0, Number(cameraHeightM) || 0);
    if (height >= GLOBAL_RADIO_ALTITUDE_M) return RADIO_SINGLETON_GLOBAL_LIMIT;
    if (height >= 250_000) return RADIO_SINGLETON_MID_LIMIT;
    return RADIO_SINGLETON_NEAR_LIMIT;
  }

  /** Rank visible singleton stations by camera distance and stable station id. */

  function selectRadioSingletonCandidates(
    candidates,
    limit = RADIO_SINGLETON_NEAR_LIMIT,
  ) {
    const distance = (candidate) => {
      const value = Number(candidate?.distanceM);
      return Number.isFinite(value) ? value : Number.POSITIVE_INFINITY;
    };
    return [...(candidates || [])]
      .sort(
        (a, b) =>
          distance(a) - distance(b) ||
          String(a?.station?.id || a?.id || '').localeCompare(
            String(b?.station?.id || b?.id || ''),
          ),
      )
      .slice(0, Math.max(0, Math.floor(Number(limit) || 0)));
  }

  /** Rank and cap ambient Radio clusters before shared-host entry allocation. */

  function selectRadioClusterCandidates(
    candidates,
    limit = RADIO_OVERLAY_COHORT_LIMIT,
  ) {
    return [...(candidates || [])]
      .sort(
        (a, b) =>
          (Number(b?.stationCount) || 0) - (Number(a?.stationCount) || 0) ||
          String(a?.id || '').localeCompare(String(b?.id || '')),
      )
      .slice(0, Math.max(0, Math.floor(Number(limit) || 0)));
  }

  /**
   * Preserve one-to-one overlay identity for overlapping clusters.
   * Cesium clustering is screen-space, so a small camera move may alter exact
   * membership even when the same geographic cluster remains visible. Every
   * positive overlap participates in greatest-contributor discovery, while
   * inheritance remains mutual-best: a current cluster accepts only one of its
   * greatest contributors and a prior identity transfers only to one of its
   * strongest split children.
   */

  function reconcileRadioClusterCandidates(
    candidates,
    previous = [],
    createId = null,
  ) {
    const current = (Array.isArray(candidates) ? candidates : []).map(
      (candidate, index) => {
        const stationIds = [
          ...new Set((candidate?.stationIds || []).map((id) => String(id))),
        ].sort();
        const membershipId = String(
          candidate?.id || `membership:${stationIds.join('|')}`,
        );
        return {
          ...candidate,
          _reconcileIndex: index,
          _reconcileMembershipId: membershipId,
          _reconcileCanonicalKey: `${membershipId}\u0000${stationIds.join('\u0000')}`,
          stationIds,
        };
      },
    );
    const priorMembershipsByIdentity = new Map();
    for (const candidate of Array.isArray(previous) ? previous : []) {
      const identityId = String(candidate?.identityId || candidate?.id || '');
      if (!identityId) continue;
      if (!priorMembershipsByIdentity.has(identityId)) {
        priorMembershipsByIdentity.set(identityId, new Set());
      }
      const membership = priorMembershipsByIdentity.get(identityId);
      for (const stationId of candidate?.stationIds || [])
        membership.add(String(stationId));
    }
    const prior = [...priorMembershipsByIdentity]
      .map(([identityId, stationIds]) => ({
        identityId,
        stationIds: [...stationIds].sort(),
      }))
      .filter((candidate) => candidate.stationIds.length)
      .sort((a, b) => a.identityId.localeCompare(b.identityId));
    const priorByStation = new Map();
    for (let priorIndex = 0; priorIndex < prior.length; priorIndex += 1) {
      for (const stationId of prior[priorIndex].stationIds) {
        if (!priorByStation.has(stationId)) priorByStation.set(stationId, []);
        priorByStation.get(stationId).push(priorIndex);
      }
    }

    const edges = [];
    const greatestOverlapByCurrent = new Map();
    const greatestOverlapByPrior = new Map();
    for (
      let currentIndex = 0;
      currentIndex < current.length;
      currentIndex += 1
    ) {
      const overlapByPrior = new Map();
      for (const stationId of current[currentIndex].stationIds) {
        for (const priorIndex of priorByStation.get(stationId) || []) {
          overlapByPrior.set(
            priorIndex,
            (overlapByPrior.get(priorIndex) || 0) + 1,
          );
        }
      }
      for (const [priorIndex, overlap] of overlapByPrior) {
        const union =
          current[currentIndex].stationIds.length +
          prior[priorIndex].stationIds.length -
          overlap;
        const smaller = Math.min(
          current[currentIndex].stationIds.length,
          prior[priorIndex].stationIds.length,
        );
        const score = smaller > 0 ? overlap / smaller : 0;
        const similarity = union > 0 ? overlap / union : 0;
        edges.push({ currentIndex, priorIndex, overlap, score, similarity });
        greatestOverlapByCurrent.set(
          currentIndex,
          Math.max(greatestOverlapByCurrent.get(currentIndex) || 0, overlap),
        );
        greatestOverlapByPrior.set(
          priorIndex,
          Math.max(greatestOverlapByPrior.get(priorIndex) || 0, overlap),
        );
      }
    }
    const eligibleEdges = edges.filter(
      (edge) =>
        edge.overlap === greatestOverlapByCurrent.get(edge.currentIndex) &&
        edge.overlap === greatestOverlapByPrior.get(edge.priorIndex),
    );
    eligibleEdges.sort(
      (a, b) =>
        // Identity follows the contributor representing the largest share of the
        // new cluster. Overlap-coefficient-first incorrectly lets a fully retained
        // two-station minority beat a larger partial contributor during a merge.
        b.overlap - a.overlap ||
        b.score - a.score ||
        b.similarity - a.similarity ||
        current[a.currentIndex]._reconcileCanonicalKey.localeCompare(
          current[b.currentIndex]._reconcileCanonicalKey,
        ) ||
        prior[a.priorIndex].identityId.localeCompare(
          prior[b.priorIndex].identityId,
        ),
    );

    const inheritedByCurrent = new Map();
    const usedPriorIdentities = new Set();
    for (const edge of eligibleEdges) {
      const identityId = prior[edge.priorIndex].identityId;
      if (
        inheritedByCurrent.has(edge.currentIndex) ||
        usedPriorIdentities.has(identityId)
      )
        continue;
      inheritedByCurrent.set(
        edge.currentIndex,
        prior[edge.priorIndex].identityId,
      );
      usedPriorIdentities.add(identityId);
    }

    const generatedByCurrent = new Map();
    if (typeof createId === 'function') {
      const freshIndices = current
        .map((candidate, index) => ({ candidate, index }))
        .filter(({ index }) => !inheritedByCurrent.has(index))
        .sort((a, b) =>
          a.candidate._reconcileCanonicalKey.localeCompare(
            b.candidate._reconcileCanonicalKey,
          ),
        );
      for (const { candidate, index } of freshIndices) {
        generatedByCurrent.set(index, String(createId(candidate, index) || ''));
      }
    }

    return current.map((candidate, index) => {
      const membershipId = candidate._reconcileMembershipId;
      const inherited = inheritedByCurrent.get(index);
      const generated = generatedByCurrent.get(index) || '';
      const identityId = inherited || generated || membershipId;
      const {
        _reconcileIndex,
        _reconcileMembershipId,
        _reconcileCanonicalKey,
        ...rest
      } = candidate;
      return { ...rest, membershipId, identityId, id: identityId };
    });
  }

  function resetRadioClusterOverlayIdentities() {
    layerState._clusterOverlayIdentities = [];
  }

  function emptyRadioOverlayDiagnostics() {
    return {
      entryCount: 0,
      selectedCount: 0,
      singletonTexts: [],
      singletonIds: [],
      clusterTexts: [],
      clusterIds: [],
      clusterMemberships: [],
    };
  }

  /** Retain refresh identities only while every represented station still exists. */

  function retainRadioClusterIdentitiesForStations(previous, stations) {
    const stationIds = new Set(
      (stations || [])
        .map((station) => String(station?.id || ''))
        .filter(Boolean),
    );
    return (previous || []).filter(
      (candidate) =>
        Array.isArray(candidate?.stationIds) &&
        candidate.stationIds.length > 0 &&
        candidate.stationIds.every((stationId) =>
          stationIds.has(String(stationId)),
        ),
    );
  }
  return {
    radioSingletonLabelLimit,
    selectRadioSingletonCandidates,
    selectRadioClusterCandidates,
    reconcileRadioClusterCandidates,
    resetRadioClusterOverlayIdentities,
    emptyRadioOverlayDiagnostics,
    retainRadioClusterIdentitiesForStations,
  };
}
