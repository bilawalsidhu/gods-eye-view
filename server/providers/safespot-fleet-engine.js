import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, '..', '..');

const SAFESPOT_DIR =
  process.env.SAFESPOT_DIR ||
  (existsSync('c:/Users/SIT EUC/Documents/Builds/SafeSpotSG')
    ? 'c:/Users/SIT EUC/Documents/Builds/SafeSpotSG'
    : join(REPO_ROOT, '..', 'SafeSpotSG'));

const GRAPH_PATH = join(SAFESPOT_DIR, 'data', 'graph', 'singapore-road-graph.json');
const CALIBRATED_PARAMS_PATH = join(__dirname, 'safespot-calibrated-params.json');
const rad = (d) => (d * Math.PI) / 180;

function bearingDegrees(lat1, lon1, lat2, lon2) {
  const dLon = rad(lon2 - lon1);
  const y = Math.sin(dLon) * Math.cos(rad(lat2));
  const x =
    Math.cos(rad(lat1)) * Math.sin(rad(lat2)) -
    Math.sin(rad(lat1)) * Math.cos(rad(lat2)) * Math.cos(dLon);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

const CALIBRATED_CLASS_SPEEDS = Object.freeze({
  motorway: 68,
  motorway_link: 55,
  trunk: 46,
  trunk_link: 35,
  primary: 26,
  primary_link: 24,
  secondary: 24,
  secondary_link: 22,
  tertiary: 24,
  tertiary_link: 20,
  unclassified: 22,
  residential: 20,
  living_street: 15,
});

const BASELINE_TURN_DELAYS = Object.freeze({
  straight: 2.0,
  left: 5.0,
  right: 18.0,
  uturn: 28.0,
  signal: 9.0,
});

function loadCalibratedTurnDelays() {
  try {
    const raw = JSON.parse(readFileSync(CALIBRATED_PARAMS_PATH, 'utf8'));
    const d = raw?.models?.calibrated?.params?.turnDelays ?? raw?.turnDelays ?? null;
    return Object.freeze({
      straight: d?.delayStraightSec ?? 1.8,
      left: d?.delayLeftSec ?? 3.8,
      right: d?.delayRightSec ?? 12.0,
      uturn: d?.delayUturnSec ?? 20.0,
      signal: d?.delaySignalSec ?? 5.0,
    });
  } catch {
    return Object.freeze({ straight: 1.8, left: 3.8, right: 12.0, uturn: 20.0, signal: 5.0 });
  }
}

// 14 Strategic Singapore Fleet Depots for island-wide simultaneous dispersion
export const FLEET_DEPOTS = [
  { name: 'Toa Payoh Central', lat: 1.3327, lng: 103.8479 },
  { name: 'Novena / Newton', lat: 1.3204, lng: 103.8438 },
  { name: 'Raffles Place / Marina Bay', lat: 1.284, lng: 103.8514 },
  { name: 'Orchard / Dhoby Ghaut', lat: 1.3008, lng: 103.839 },
  { name: 'Jurong East Regional Hub', lat: 1.3331, lng: 103.7423 },
  { name: 'Jurong West / Boon Lay', lat: 1.3404, lng: 103.709 },
  { name: 'Woodlands Regional Centre', lat: 1.437, lng: 103.7865 },
  { name: 'Yishun / Khatib', lat: 1.4294, lng: 103.8352 },
  { name: 'Ang Mo Kio / Bishan', lat: 1.3698, lng: 103.8485 },
  { name: 'Sengkang / Punggol', lat: 1.398, lng: 103.897 },
  { name: 'Serangoon / Hougang', lat: 1.355, lng: 103.876 },
  { name: 'Tampines / Pasir Ris', lat: 1.3534, lng: 103.9401 },
  { name: 'Bedok / Changi', lat: 1.3243, lng: 103.9298 },
  { name: 'Clementi / Queenstown / HarbourFront', lat: 1.295, lng: 103.785 },
];

const BUS_SERVICES = [
  'SBS 145', 'SBS 190', 'SBS 36', 'SBS 174', 'SBS 51',
  'SMRT 960', 'SMRT 858', 'SBS 133', 'SBS 7', 'SBS 14',
  'SBS 166', 'SMRT 106', 'SBS 43', 'SMRT 972',
];

export const TOTAL_CARS = 36;
export const TOTAL_BUSES = 14;

/** Planned edges kept ahead of every vehicle, and the slice sent to clients. */
const LOOKAHEAD_EDGES = 120;
const MIN_EXTENSION_HOPS = 60;
const MAX_WAYPOINTS_PER_VEHICLE = 120;
/** Edge-state search limits: per search, and summed across all vehicles per step. */
const MAX_SETTLED_PER_SEARCH = 150000;
const SEARCH_BUDGET_PER_STEP = 300000;
/** A stalled browser tab must not advance the clock by hours in one call. */
const MAX_WALL_DT_MS = 15000;
/** A vehicle with nothing reachable patrols this long (sim seconds) before looking again. */
const RETRY_TARGETS_AFTER_SIM_SEC = 600;
/** Simulated seconds a relocated (redeployed) vehicle waits before it starts driving. */
const RELOCATION_DWELL_SEC = 90;
const DEFAULT_SPEED_MULTIPLIER = 10;
const MAX_SPEED_MULTIPLIER = 250;

/** Binary min-heap over (edgeId, priority) pairs in typed arrays. */
class EdgeHeap {
  constructor(initialCapacity = 65536) {
    this.edgeIds = new Int32Array(initialCapacity);
    this.priorities = new Float64Array(initialCapacity);
    this.size = 0;
  }
  clear() {
    this.size = 0;
  }
  push(edgeId, priority) {
    let i = this.size++;
    if (i >= this.edgeIds.length) {
      const newCap = this.edgeIds.length * 2;
      const ne = new Int32Array(newCap);
      ne.set(this.edgeIds);
      this.edgeIds = ne;
      const np = new Float64Array(newCap);
      np.set(this.priorities);
      this.priorities = np;
    }
    const { edgeIds, priorities } = this;
    edgeIds[i] = edgeId;
    priorities[i] = priority;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (priorities[i] >= priorities[p]) break;
      const te = edgeIds[p];
      const tp = priorities[p];
      edgeIds[p] = edgeIds[i];
      priorities[p] = priorities[i];
      edgeIds[i] = te;
      priorities[i] = tp;
      i = p;
    }
  }
  pop() {
    if (this.size === 0) return -1;
    const { edgeIds, priorities } = this;
    const res = edgeIds[0];
    this.size--;
    if (this.size > 0) {
      edgeIds[0] = edgeIds[this.size];
      priorities[0] = priorities[this.size];
      let i = 0;
      for (;;) {
        const l = (i << 1) + 1;
        const r = l + 1;
        let m = i;
        if (l < this.size && priorities[l] < priorities[m]) m = l;
        if (r < this.size && priorities[r] < priorities[m]) m = r;
        if (m === i) break;
        const te = edgeIds[m];
        const tp = priorities[m];
        edgeIds[m] = edgeIds[i];
        priorities[m] = priorities[i];
        edgeIds[i] = te;
        priorities[i] = tp;
        i = m;
      }
    }
    return res;
  }
}

/** Small ring road used when the SafeSpotSG graph is unavailable (CI, tests). */
function buildFallbackGraph() {
  const nodes = FLEET_DEPOTS.map((d, id) => ({ id, lat: d.lat, lng: d.lng }));
  const edges = [];
  const N = nodes.length;
  for (let i = 0; i < N; i++) {
    const next = (i + 1) % N;
    const next2 = (i + 2) % N;
    edges.push({
      from: i, to: next, length: 850, seconds: 60, maxspeed: 60, wayId: 1000 + i,
      highway: 'primary', name: `${FLEET_DEPOTS[i].name} Arterial`,
    });
    edges.push({
      from: i, to: next2, length: 1200, seconds: 90, maxspeed: 50, wayId: 2000 + i,
      highway: 'secondary', name: `${FLEET_DEPOTS[i].name} Connector`,
    });
    if (i % 2 === 1) {
      // Opposing carriageway for odd arterials so the fallback mixes 1-way and 2-way roads.
      edges.push({
        from: next, to: i, length: 850, seconds: 60, maxspeed: 60, wayId: 1000 + i,
        highway: 'primary', name: `${FLEET_DEPOTS[i].name} Arterial`,
      });
    }
  }
  return { nodes, edges, turnRestrictions: [], trafficSignalNodes: [] };
}

/**
 * Build a Singapore road-network coverage simulation.
 *
 * The engine is the authority for the fleet: it owns a simulated clock, moves
 * every vehicle along a planned, legal, contiguous path, and counts a directed
 * edge as covered only once a vehicle has driven it end to end. Route planning
 * steers onto uncovered edges greedily and, when none is legally reachable from
 * the current junction, runs an edge-state Dijkstra (turn restrictions, one-way
 * carriageways and vehicle-class rules respected) to the nearest uncovered edge.
 *
 * @param {object} [options]
 * @param {string|null} [options.graphPath] Road graph JSON; `null` forces the fallback ring.
 * @param {object} [options.graph] Pre-parsed `{ nodes, edges, turnRestrictions, trafficSignalNodes }`.
 * @param {() => number} [options.now] Wall clock in ms (injectable for tests).
 */
export function createSafeSpotFleetEngine(options = {}) {
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const graphPath = options.graphPath === undefined ? GRAPH_PATH : options.graphPath;

  let raw = options.graph ?? null;
  if (!raw && graphPath && existsSync(graphPath)) {
    raw = JSON.parse(readFileSync(graphPath, 'utf8'));
  }
  const usingFallbackGraph = !raw;
  if (!raw) raw = buildFallbackGraph();

  const { nodes, edges, turnRestrictions, trafficSignalNodes } = raw;
  const N = nodes.length;
  const M = edges.length;

  const nodeLat = new Float64Array(N);
  const nodeLng = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    nodeLat[i] = nodes[i].lat;
    nodeLng[i] = nodes[i].lng;
  }

  const edgeFrom = new Int32Array(M);
  const edgeTo = new Int32Array(M);
  const edgeLength = new Float32Array(M);
  const edgeSeconds = new Float32Array(M);
  const edgeMaxspeed = new Uint8Array(M);
  const edgeWayId = new Int32Array(M);
  const edgeBearings = new Float32Array(M);
  const edgeHighwayStr = new Array(M);
  const edgeNameStr = new Array(M);
  const edgeIsMotorway = new Uint8Array(M);

  const outgoingCounts = new Int32Array(N);
  const inCounts = new Int32Array(N);

  for (let i = 0; i < M; i++) {
    const e = edges[i];
    edgeFrom[i] = e.from;
    edgeTo[i] = e.to;
    edgeLength[i] = e.length || 25;
    edgeSeconds[i] = e.seconds || 3;
    edgeMaxspeed[i] = e.maxspeed || 50;
    edgeWayId[i] = e.wayId || 0;
    edgeHighwayStr[i] = e.highway || 'residential';
    edgeNameStr[i] = e.name || e.highway || 'Singapore Road';
    edgeIsMotorway[i] = edgeHighwayStr[i] === 'motorway' ? 1 : 0;
    edgeBearings[i] = bearingDegrees(nodeLat[e.from], nodeLng[e.from], nodeLat[e.to], nodeLng[e.to]);
    outgoingCounts[e.from]++;
    inCounts[e.to]++;
  }

  const outgoingOffsets = new Int32Array(N + 1);
  const inOffsets = new Int32Array(N + 1);
  let outTot = 0;
  let inTot = 0;
  for (let i = 0; i < N; i++) {
    outgoingOffsets[i] = outTot;
    outTot += outgoingCounts[i];
    inOffsets[i] = inTot;
    inTot += inCounts[i];
  }
  outgoingOffsets[N] = outTot;
  inOffsets[N] = inTot;

  const outgoingEdgeIds = new Int32Array(outTot);
  const inNodes = new Int32Array(inTot);
  const curOut = new Int32Array(outgoingOffsets);
  const curIn = new Int32Array(inOffsets);
  for (let i = 0; i < M; i++) {
    outgoingEdgeIds[curOut[edgeFrom[i]]++] = i;
    inNodes[curIn[edgeTo[i]]++] = edgeFrom[i];
  }

  // Strongly connected main road network component, seeded at the busiest node.
  let seedNode = 0;
  let maxDeg = 0;
  for (let i = 0; i < N; i++) {
    const deg = outgoingCounts[i] + inCounts[i];
    if (deg > maxDeg) {
      maxDeg = deg;
      seedNode = i;
    }
  }

  const fwdVisited = new Uint8Array(N);
  const queue = new Int32Array(N);
  let qHead = 0;
  let qTail = 0;
  fwdVisited[seedNode] = 1;
  queue[qTail++] = seedNode;
  while (qHead < qTail) {
    const u = queue[qHead++];
    for (let j = outgoingOffsets[u]; j < outgoingOffsets[u + 1]; j++) {
      const v = edgeTo[outgoingEdgeIds[j]];
      if (!fwdVisited[v]) {
        fwdVisited[v] = 1;
        queue[qTail++] = v;
      }
    }
  }
  const bwdVisited = new Uint8Array(N);
  qHead = 0;
  qTail = 0;
  bwdVisited[seedNode] = 1;
  queue[qTail++] = seedNode;
  while (qHead < qTail) {
    const u = queue[qHead++];
    for (let j = inOffsets[u]; j < inOffsets[u + 1]; j++) {
      const v = inNodes[j];
      if (!bwdVisited[v]) {
        bwdVisited[v] = 1;
        queue[qTail++] = v;
      }
    }
  }

  const edgeIsMain = new Uint8Array(M);
  const edgeIsOneWay = new Uint8Array(M);
  const mainEdgeList = [];
  let totalOneWayMain = 0;
  let totalTwoWayMain = 0;
  for (let i = 0; i < M; i++) {
    const u = edgeFrom[i];
    const v = edgeTo[i];
    let hasReverse = false;
    for (let j = outgoingOffsets[v]; j < outgoingOffsets[v + 1]; j++) {
      if (edgeTo[outgoingEdgeIds[j]] === u) {
        hasReverse = true;
        break;
      }
    }
    edgeIsOneWay[i] = hasReverse ? 0 : 1;
    if (bwdVisited[u] && fwdVisited[v]) {
      edgeIsMain[i] = 1;
      mainEdgeList.push(i);
      if (edgeIsOneWay[i]) totalOneWayMain++;
      else totalTwoWayMain++;
    }
  }

  const hasTrafficSignal = new Uint8Array(N);
  for (const id of trafficSignalNodes ?? []) {
    if (id >= 0 && id < N) hasTrafficSignal[id] = 1;
  }
  const nodeIsJunction = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    if (outgoingCounts[i] + inCounts[i] > 2) nodeIsJunction[i] = 1;
  }

  const restrictionsByVia = new Array(N);
  let droppedRestrictions = 0;
  for (const r of turnRestrictions ?? []) {
    if (r.viaNode >= 0 && r.viaNode < N) {
      if (typeof r.type === 'string' && r.type.startsWith('only_')) {
        // An `only_*` whose mandated way does not leave the via node would
        // forbid every exit; that is unsatisfiable data, not a road rule.
        let exitExists = false;
        for (let j = outgoingOffsets[r.viaNode]; j < outgoingOffsets[r.viaNode + 1]; j++) {
          if (edgeWayId[outgoingEdgeIds[j]] === r.toWayId) {
            exitExists = true;
            break;
          }
        }
        if (!exitExists) {
          droppedRestrictions++;
          continue;
        }
      }
      let m = restrictionsByVia[r.viaNode];
      if (!m) {
        m = new Map();
        restrictionsByVia[r.viaNode] = m;
      }
      let list = m.get(r.fromWayId);
      if (!list) {
        list = [];
        m.set(r.fromWayId, list);
      }
      list.push(r);
    }
  }

  const CALIBRATED_TURN_DELAYS = loadCalibratedTurnDelays();
  const totalDrivableEdges = mainEdgeList.length;

  // Edge-state reachability under turn restrictions from the network core
  // (the busiest junction). Edges outside this set can only be entered through
  // a forbidden turn, so they are coverable by relocation only; knowing that up
  // front keeps the late game from searching the whole island for them.
  const edgeReachable = new Uint8Array(M);
  let reachableEdges = 0;
  {
    let seedEdge = -1;
    let bestReach = -1;
    const candidates = [];
    for (let j = outgoingOffsets[seedNode]; j < outgoingOffsets[seedNode + 1]; j++) {
      if (edgeIsMain[outgoingEdgeIds[j]]) candidates.push(outgoingEdgeIds[j]);
    }
    const scratch = new Uint8Array(M);
    const edgeQueue = new Int32Array(M);
    for (const start of candidates) {
      scratch.fill(0);
      let head = 0;
      let tail = 0;
      scratch[start] = 1;
      edgeQueue[tail++] = start;
      while (head < tail) {
        const e = edgeQueue[head++];
        const via = edgeTo[e];
        for (let j = outgoingOffsets[via]; j < outgoingOffsets[via + 1]; j++) {
          const nid = outgoingEdgeIds[j];
          if (scratch[nid] || !edgeIsMain[nid] || isTurnForbidden(e, nid)) continue;
          scratch[nid] = 1;
          edgeQueue[tail++] = nid;
        }
      }
      if (tail > bestReach) {
        bestReach = tail;
        seedEdge = start;
        edgeReachable.set(scratch);
      }
    }
    if (seedEdge < 0) edgeReachable.set(edgeIsMain);
    for (let i = 0; i < M; i++) if (edgeReachable[i]) reachableEdges++;
  }

  // ---------------------------------------------------------------------------
  // Coverage state
  // ---------------------------------------------------------------------------
  const edgeCovered = new Uint8Array(M); // 0 = untouched, 1 = car, 2 = bus
  const edgeClaimed = new Uint8Array(M); // planned by a vehicle but not yet driven
  let coveredEdgesCount = 0;
  let coveredOneWayEdges = 0;
  let coveredTwoWayEdges = 0;
  let claimedCount = 0;
  let relocationsTotal = 0;
  let sweepCursor = 0;
  let activeRoutingModel = 'calibrated';
  let speedMultiplier = DEFAULT_SPEED_MULTIPLIER;
  let simSeconds = 0;
  let lastWallMs = now();
  let searchBudget = 0;

  const MAX_VISUAL_SEGMENTS = 1800;
  const recentSegments = [];

  // Spatial grid over main edges (by start node) so a vehicle can find the
  // nearest free edge by distance and aim its search at it.
  const CELL_DEG = 0.01;
  let minLat = Infinity;
  let minLng = Infinity;
  let maxLat = -Infinity;
  let maxLng = -Infinity;
  for (let i = 0; i < N; i++) {
    if (nodeLat[i] < minLat) minLat = nodeLat[i];
    if (nodeLat[i] > maxLat) maxLat = nodeLat[i];
    if (nodeLng[i] < minLng) minLng = nodeLng[i];
    if (nodeLng[i] > maxLng) maxLng = nodeLng[i];
  }
  const gridRows = Math.max(1, Math.floor((maxLat - minLat) / CELL_DEG) + 1);
  const gridCols = Math.max(1, Math.floor((maxLng - minLng) / CELL_DEG) + 1);
  const cellOfNode = (n) =>
    Math.min(gridRows - 1, Math.floor((nodeLat[n] - minLat) / CELL_DEG)) * gridCols +
    Math.min(gridCols - 1, Math.floor((nodeLng[n] - minLng) / CELL_DEG));
  const cellOfEdge = new Int32Array(M);
  const cellCounts = new Int32Array(gridRows * gridCols);
  for (const eid of mainEdgeList) {
    cellOfEdge[eid] = cellOfNode(edgeFrom[eid]);
    cellCounts[cellOfEdge[eid]]++;
  }
  const cellOffsets = new Int32Array(gridRows * gridCols + 1);
  for (let c = 0; c < cellCounts.length; c++) cellOffsets[c + 1] = cellOffsets[c] + cellCounts[c];
  const cellEdgeIds = new Int32Array(mainEdgeList.length);
  {
    const fill = new Int32Array(cellOffsets);
    for (const eid of mainEdgeList) cellEdgeIds[fill[cellOfEdge[eid]]++] = eid;
  }

  // Live counts of "free" edges (main, uncovered, unclaimed) that are legally
  // reachable from the core: overall, for buses (which avoid motorways), and per cell.
  let freeReachable = 0;
  let freeReachableBus = 0;
  const cellFreeReachable = new Int32Array(gridRows * gridCols);
  for (const eid of mainEdgeList) {
    if (!edgeReachable[eid]) continue;
    freeReachable++;
    if (!edgeIsMotorway[eid]) freeReachableBus++;
    cellFreeReachable[cellOfEdge[eid]]++;
  }

  function freeUncoveredRemaining() {
    return totalDrivableEdges - coveredEdgesCount - claimedCount;
  }

  /** `eid` just became free (+1) or stopped being free (-1). */
  function adjustFree(eid, delta) {
    if (!edgeReachable[eid]) return;
    freeReachable += delta;
    if (!edgeIsMotorway[eid]) freeReachableBus += delta;
    cellFreeReachable[cellOfEdge[eid]] += delta;
  }

  /** Nearest free, reachable, class-allowed edge by straight-line distance from the end of `fromEdge`. */
  function nearestFreeReachableBySpace(fromEdge, vehicleType) {
    const origin = edgeTo[fromEdge];
    const oLat = nodeLat[origin];
    const oLng = nodeLng[origin];
    const row0 = Math.floor(cellOfNode(origin) / gridCols);
    const col0 = cellOfNode(origin) % gridCols;
    const maxRadius = Math.max(gridRows, gridCols);
    let best = -1;
    let bestD = Infinity;
    for (let r = 0; r <= maxRadius; r++) {
      for (let dr = -r; dr <= r; dr++) {
        const row = row0 + dr;
        if (row < 0 || row >= gridRows) continue;
        const edgeRow = Math.abs(dr) === r;
        for (let dc = -r; dc <= r; dc += edgeRow ? 1 : 2 * r || 1) {
          const col = col0 + dc;
          if (col < 0 || col >= gridCols) continue;
          const cell = row * gridCols + col;
          if (cellFreeReachable[cell] <= 0) continue;
          for (let k = cellOffsets[cell]; k < cellOffsets[cell + 1]; k++) {
            const eid = cellEdgeIds[k];
            if (!edgeReachable[eid] || !isFreeUncovered(eid, vehicleType)) continue;
            const dLat = nodeLat[edgeFrom[eid]] - oLat;
            const dLng = (nodeLng[edgeFrom[eid]] - oLng) * 0.9997;
            const d = dLat * dLat + dLng * dLng;
            if (d < bestD) {
              bestD = d;
              best = eid;
            }
          }
        }
      }
      // Anything in a farther ring is at least (r * CELL_DEG) away; stop once the
      // best found is closer than that bound.
      if (best >= 0 && bestD <= (r * CELL_DEG) * (r * CELL_DEG)) return best;
    }
    return best;
  }

  function claimEdge(eid) {
    if (edgeIsMain[eid] && edgeCovered[eid] === 0 && edgeClaimed[eid] === 0) {
      edgeClaimed[eid] = 1;
      claimedCount++;
      adjustFree(eid, -1);
    }
  }

  function releaseClaim(eid) {
    if (edgeClaimed[eid]) {
      edgeClaimed[eid] = 0;
      claimedCount--;
      if (edgeCovered[eid] === 0) adjustFree(eid, +1);
    }
  }

  /** Called only when a vehicle has driven `eid` from its start node to its end node. */
  function markEdgeCovered(eid, vehicleType = 'CAR') {
    if (eid < 0 || eid >= M || !edgeIsMain[eid]) return false;
    releaseClaim(eid);
    if (edgeCovered[eid] !== 0) return false;
    adjustFree(eid, -1);
    edgeCovered[eid] = vehicleType === 'BUS' ? 2 : 1;
    coveredEdgesCount++;
    if (edgeIsOneWay[eid]) coveredOneWayEdges++;
    else coveredTwoWayEdges++;

    const u = edgeFrom[eid];
    const v = edgeTo[eid];
    recentSegments.push({
      edgeId: eid,
      oneway: Boolean(edgeIsOneWay[eid]),
      vehicleType,
      highway: edgeHighwayStr[eid],
      name: edgeNameStr[eid],
      coords: [
        [Number(nodeLng[u].toFixed(5)), Number(nodeLat[u].toFixed(5))],
        [Number(nodeLng[v].toFixed(5)), Number(nodeLat[v].toFixed(5))],
      ],
    });
    if (recentSegments.length > MAX_VISUAL_SEGMENTS) recentSegments.shift();
    return true;
  }

  // ---------------------------------------------------------------------------
  // Road rules
  // ---------------------------------------------------------------------------
  function isTurnForbidden(curEdgeId, nextEdgeId) {
    if (curEdgeId < 0) return false;
    const via = edgeTo[curEdgeId];
    const viaMap = restrictionsByVia[via];
    if (!viaMap) return false;
    const curWay = edgeWayId[curEdgeId];
    const resList = viaMap.get(curWay);
    if (!resList) return false;

    const nextWay = edgeWayId[nextEdgeId];
    const isReverse = edgeTo[nextEdgeId] === edgeFrom[curEdgeId];
    const a = ((edgeBearings[nextEdgeId] - edgeBearings[curEdgeId] + 540) % 360) - 180;

    for (let ri = 0; ri < resList.length; ri++) {
      const r = resList[ri];
      if (r.type === 'no_u_turn') {
        if (nextWay === r.toWayId && (isReverse || Math.abs(a) > 135)) return true;
      } else if (r.type.startsWith('no_')) {
        if (
          curWay === r.toWayId &&
          ((r.type === 'no_left_turn' && a < -30) ||
            (r.type === 'no_right_turn' && a > 30) ||
            (r.type === 'no_straight_on' && Math.abs(a) <= 30))
        ) {
          return true;
        } else if (nextWay === r.toWayId && curWay !== r.toWayId) {
          return true;
        }
      } else if (r.type.startsWith('only_')) {
        if (nextWay !== r.toWayId) return true;
      }
    }
    return false;
  }

  /** Buses are kept off expressway mainlines; cars may use every drivable edge. */
  function vehicleMayUse(eid, vehicleType) {
    return vehicleType !== 'BUS' || !edgeIsMotorway[eid];
  }

  function isLegalTransition(curEdge, nextEdge, vehicleType) {
    return (
      edgeIsMain[nextEdge] === 1 &&
      vehicleMayUse(nextEdge, vehicleType) &&
      !isTurnForbidden(curEdge, nextEdge)
    );
  }

  function computeModelEdgeSpeedKmh(eid, model = activeRoutingModel, vehicleType = 'CAR') {
    const hw = edgeHighwayStr[eid] || 'residential';
    const maxSpd = edgeMaxspeed[eid] || 50;
    let speedKmh = maxSpd;

    if (model === 'calibrated' || model === 'speedband') {
      const cap = CALIBRATED_CLASS_SPEEDS[hw] || maxSpd;
      speedKmh = Math.min(maxSpd, cap);
      if (model === 'speedband') {
        const bandMod = 0.88 + ((eid % 17) / 17) * 0.24;
        speedKmh = Math.max(15, Math.min(maxSpd, speedKmh * bandMod));
      }
    } else {
      const baseSec = Math.max(0.5, edgeSeconds[eid]);
      speedKmh = Math.min(68, (edgeLength[eid] / baseSec) * 3.6);
    }

    if (vehicleType === 'BUS') {
      speedKmh = Math.min(60, speedKmh * 0.86);
    }
    return Math.max(12, Math.round(speedKmh * 10) / 10);
  }

  /** Simulated seconds to drive `eid`; the same number the client animates with. */
  function edgeDurationSec(eid, model, vehicleType) {
    const speedKmh = computeModelEdgeSpeedKmh(eid, model, vehicleType);
    const signalWaitSec = hasTrafficSignal[edgeTo[eid]] ? (model === 'baseline' ? 9 : 5) : 0;
    return Math.max(0.4, edgeLength[eid] / (speedKmh / 3.6) + signalWaitSec * 0.25);
  }

  function turnDelaySec(curEdge, nextEdge, model) {
    const d = model === 'baseline' ? BASELINE_TURN_DELAYS : CALIBRATED_TURN_DELAYS;
    if (edgeTo[nextEdge] === edgeFrom[curEdge]) return d.uturn;
    const via = edgeTo[curEdge];
    const sig = hasTrafficSignal[via] ? d.signal : 0;
    if (!nodeIsJunction[via]) return sig;
    const a = ((edgeBearings[nextEdge] - edgeBearings[curEdge] + 540) % 360) - 180;
    if (Math.abs(a) > 135) return Math.max(sig, d.uturn);
    if (a > 30) return Math.max(sig, d.right);
    if (a < -30) return Math.max(sig, d.left);
    return Math.max(sig, d.straight);
  }

  // ---------------------------------------------------------------------------
  // Edge-state shortest-path search (Dijkstra; A* when a target edge is given)
  // ---------------------------------------------------------------------------
  const heap = new EdgeHeap();
  const bestCost = new Float64Array(M);
  const bestEpoch = new Int32Array(M);
  const prevEdge = new Int32Array(M);
  let currentEpoch = 0;
  const LAT_DEG_M = 111320;
  const LNG_DEG_M = 111320 * Math.cos(rad(1.35));
  const INV_MAX_SPEED_MS = 1 / (90 / 3.6);

  /**
   * Find the cheapest legal path from the end of `startEdge` to the first edge
   * accepted by `accept`. Returns the edge sequence after `startEdge`, `null`
   * when nothing acceptable is reachable, or `undefined` when the search budget
   * ran out before an answer was found.
   */
  function searchPath(startEdge, vehicleType, model, accept, targetEdge = -1) {
    currentEpoch++;
    if (currentEpoch === 2147483647) {
      bestEpoch.fill(0);
      currentEpoch = 1;
    }
    const epoch = currentEpoch;
    heap.clear();

    const targetY = targetEdge >= 0 ? nodeLat[edgeFrom[targetEdge]] * LAT_DEG_M : 0;
    const targetX = targetEdge >= 0 ? nodeLng[edgeFrom[targetEdge]] * LNG_DEG_M : 0;
    const heuristic = (eid) => {
      if (targetEdge < 0) return 0;
      const dy = nodeLat[edgeTo[eid]] * LAT_DEG_M - targetY;
      const dx = nodeLng[edgeTo[eid]] * LNG_DEG_M - targetX;
      return Math.sqrt(dx * dx + dy * dy) * INV_MAX_SPEED_MS;
    };

    // Only the per-step budget defers work. Within one search, blowing the
    // per-search cap means the nearest acceptable edge is effectively
    // unreachable (a legal nearest-uncovered search settles a few hundred edges
    // when a target exists), so that case is reported as "no path".
    if (searchBudget <= 0) return undefined;

    bestCost[startEdge] = 0;
    bestEpoch[startEdge] = epoch;
    prevEdge[startEdge] = -1;
    heap.push(startEdge, 0);

    let settled = 0;
    let reached = -1;
    while (heap.size > 0) {
      const cur = heap.pop();
      if (cur < 0) break;
      if (cur !== startEdge && accept(cur)) {
        reached = cur;
        break;
      }
      settled++;
      if (settled > MAX_SETTLED_PER_SEARCH) {
        searchBudget -= settled;
        return null;
      }
      const elapsed = bestCost[cur];
      const via = edgeTo[cur];
      for (let j = outgoingOffsets[via]; j < outgoingOffsets[via + 1]; j++) {
        const nid = outgoingEdgeIds[j];
        if (!isLegalTransition(cur, nid, vehicleType)) continue;
        const cost = elapsed + turnDelaySec(cur, nid, model) + edgeDurationSec(nid, model, vehicleType);
        if (bestEpoch[nid] !== epoch || cost < bestCost[nid]) {
          bestCost[nid] = cost;
          bestEpoch[nid] = epoch;
          prevEdge[nid] = cur;
          heap.push(nid, cost + heuristic(nid));
        }
      }
    }
    searchBudget -= settled;
    if (reached < 0) return null;

    const path = [];
    let curr = reached;
    while (curr >= 0 && curr !== startEdge) {
      path.push(curr);
      curr = prevEdge[curr];
    }
    path.reverse();
    return path;
  }

  // ---------------------------------------------------------------------------
  // Route planning
  // ---------------------------------------------------------------------------
  function findNearestMainEdge(lat, lng) {
    let bestEdge = mainEdgeList[0] || 0;
    let bestDistSq = Infinity;
    const step = Math.max(1, Math.floor(mainEdgeList.length / 4000));
    for (let i = 0; i < mainEdgeList.length; i += step) {
      const eid = mainEdgeList[i];
      const u = edgeFrom[eid];
      const dLat = nodeLat[u] - lat;
      const dLng = nodeLng[u] - lng;
      const dSq = dLat * dLat + dLng * dLng;
      if (dSq < bestDistSq) {
        bestDistSq = dSq;
        bestEdge = eid;
      }
    }
    return bestEdge;
  }

  function isFreeUncovered(eid, vehicleType) {
    return (
      edgeIsMain[eid] === 1 &&
      edgeCovered[eid] === 0 &&
      edgeClaimed[eid] === 0 &&
      vehicleMayUse(eid, vehicleType)
    );
  }

  /** Scan the main edge list from a rotating cursor for an edge nobody has driven or claimed. */
  function findFreeUncoveredByCursor(seedIndex, vehicleType) {
    const len = mainEdgeList.length;
    for (let offset = 0; offset < len; offset++) {
      const idx = (sweepCursor + seedIndex * 997 + offset) % len;
      const eid = mainEdgeList[idx];
      if (isFreeUncovered(eid, vehicleType)) {
        sweepCursor = (idx + 1) % len;
        return eid;
      }
    }
    return -1;
  }

  /** Legal outgoing edge that is uncovered and unclaimed; straight-through before U-turns. */
  function greedyNextEdge(curEdge, vehicleType) {
    const u = edgeTo[curEdge];
    const prevNode = edgeFrom[curEdge];
    let uTurnOption = -1;
    for (let j = outgoingOffsets[u]; j < outgoingOffsets[u + 1]; j++) {
      const cand = outgoingEdgeIds[j];
      if (!isLegalTransition(curEdge, cand, vehicleType)) continue;
      if (edgeCovered[cand] !== 0 || edgeClaimed[cand] !== 0) continue;
      if (edgeTo[cand] === prevNode) {
        if (uTurnOption < 0) uTurnOption = cand;
        continue;
      }
      return cand;
    }
    return uTurnOption;
  }

  /** Any legal outgoing edge, rotating among forward options so patrols do not loop. */
  function anyLegalNextEdge(curEdge, vehicleType, rotation) {
    const u = edgeTo[curEdge];
    const prevNode = edgeFrom[curEdge];
    const forward = [];
    let uTurnOption = -1;
    for (let j = outgoingOffsets[u]; j < outgoingOffsets[u + 1]; j++) {
      const cand = outgoingEdgeIds[j];
      if (!isLegalTransition(curEdge, cand, vehicleType)) continue;
      if (edgeTo[cand] === prevNode) {
        if (uTurnOption < 0) uTurnOption = cand;
        continue;
      }
      forward.push(cand);
    }
    if (forward.length > 0) return forward[rotation % forward.length];
    return uTurnOption;
  }

  /**
   * Plan the next edges after `fromEdge`. Every consecutive pair is a legal
   * transition. Returns `{ edges, outcome }` where outcome is one of
   * `'ok'`, `'budget'` (stop early, retry next step), or `'relocate'` with a
   * `target` when no uncovered edge is legally reachable from here.
   */
  function planExtension(veh, fromEdge, minHops) {
    const vehicleType = veh.vehicleType;
    const model = activeRoutingModel;
    const out = [];
    let cur = fromEdge;
    let rotation = veh.index;
    while (out.length < minHops) {
      const greedy = greedyNextEdge(cur, vehicleType);
      if (greedy >= 0) {
        out.push(greedy);
        claimEdge(greedy);
        cur = greedy;
        continue;
      }

      const nothingLeft = freeUncoveredRemaining() <= 0;
      const inRetryWindow = simSeconds < veh.retryTargetsAtSim;
      if (nothingLeft || inRetryWindow) {
        // Nothing (reachable) left to cover right now: patrol legally over
        // covered roads and look again once the retry window elapses.
        const next = anyLegalNextEdge(cur, vehicleType, rotation++);
        if (next < 0) return { edges: out, outcome: out.length ? 'ok' : 'relocate', target: -1 };
        out.push(next);
        cur = next;
        continue;
      }

      const reachableLeft = vehicleType === 'BUS' ? freeReachableBus : freeReachable;
      if (reachableLeft > 0) {
        // Route legally to a free edge: an A* aimed at the spatially nearest free
        // reachable edge that accepts any free edge it meets on the way. The
        // search only ever returns edges reached through legal transitions.
        const aim = nearestFreeReachableBySpace(cur, vehicleType);
        const path = searchPath(cur, vehicleType, model, (eid) => isFreeUncovered(eid, vehicleType), aim);
        if (path === undefined) return { edges: out, outcome: 'budget' };
        if (path && path.length > 0) {
          for (const eid of path) claimEdge(eid);
          out.push(...path);
          cur = path[path.length - 1];
          continue;
        }
        // Null: this vehicle sits in a pocket or dead end that cannot reach the
        // core. Fall through to a relocation.
      }

      // Whatever remains for this class is only enterable through a forbidden
      // turn (or we are stuck in a dead end): relocate, counted and reported.
      const target = findFreeUncoveredByCursor(veh.index, vehicleType);
      if (target < 0) {
        // Nothing this vehicle class may still cover: patrol and re-check later.
        veh.retryTargetsAtSim = simSeconds + RETRY_TARGETS_AFTER_SIM_SEC;
        continue;
      }
      return { edges: out, outcome: 'relocate', target };
    }
    return { edges: out, outcome: 'ok' };
  }

  // ---------------------------------------------------------------------------
  // Vehicles
  // ---------------------------------------------------------------------------
  const vehicles = [];

  function spawnVehicle(i) {
    const isBus = i >= TOTAL_CARS;
    const type = isBus ? 'BUS' : 'CAR';
    const seqNum = isBus ? i - TOTAL_CARS + 1 : i + 1;
    const depot = FLEET_DEPOTS[i % FLEET_DEPOTS.length];
    let startEdge = findNearestMainEdge(
      depot.lat + ((i % 5) - 2) * 0.004,
      depot.lng + ((i % 7) - 3) * 0.004
    );
    if (!vehicleMayUse(startEdge, type)) {
      const alt = findFreeUncoveredByCursor(i, type);
      if (alt >= 0) startEdge = alt;
    }
    claimEdge(startEdge);
    return {
      id: `${type}-${String(seqNum).padStart(4, '0')}`,
      index: i,
      vehicleType: type,
      serviceLabel: isBus ? BUS_SERVICES[(seqNum - 1) % BUS_SERVICES.length] : `TEST-CAR-${seqNum}`,
      depotName: depot.name,
      route: [startEdge],
      routeIdx: 0,
      edgeProgressSec: 0,
      pendingRelocation: -1,
      relocatedThisStep: false,
      retryTargetsAtSim: 0,
      status: 'covering',
      odometerMeters: 0,
      edgesDriven: 0,
      edgesCovered: 0,
      relocations: 0,
      waitingSec: 0,
      routeVersion: 1,
    };
  }

  /** Keep at least LOOKAHEAD_EDGES planned ahead of the vehicle. Returns false when it ran dry. */
  function ensureRoute(veh) {
    while (veh.route.length - veh.routeIdx < LOOKAHEAD_EDGES) {
      if (veh.route.length === 0) {
        if (veh.pendingRelocation >= 0) {
          relocateVehicle(veh, veh.pendingRelocation);
          continue;
        }
        return false;
      }
      const anchor = veh.route[veh.route.length - 1];
      const planned = planExtension(veh, anchor, MIN_EXTENSION_HOPS);
      if (planned.edges.length > 0) {
        veh.route.push(...planned.edges);
        veh.routeVersion++;
      }
      if (planned.outcome === 'budget') return veh.route.length - veh.routeIdx > 0;
      if (planned.outcome === 'relocate') {
        veh.pendingRelocation = planned.target;
        return veh.route.length - veh.routeIdx > 0;
      }
      if (planned.edges.length === 0) return veh.route.length - veh.routeIdx > 0;
    }
    return true;
  }

  /** Teleport: used only when no legal path to any uncovered edge exists. Counted and reported. */
  function relocateVehicle(veh, targetEdge) {
    veh.pendingRelocation = -1;
    if (targetEdge < 0 || !edgeIsMain[targetEdge]) return;
    veh.route = [targetEdge];
    veh.routeIdx = 0;
    // A redeploy is not free: the vehicle sits at the start of the target edge
    // for the dwell before it moves (negative progress reads as "not started").
    veh.edgeProgressSec = -RELOCATION_DWELL_SEC;
    veh.relocations++;
    veh.relocatedThisStep = true;
    veh.routeVersion++;
    relocationsTotal++;
    claimEdge(targetEdge);
  }

  function advanceVehicle(veh, dtSim) {
    let remaining = dtSim;
    veh.relocatedThisStep = false;
    while (remaining > 0) {
      if (veh.routeIdx >= veh.route.length) {
        // Finished every planned edge: drop the consumed prefix (keeping the anchor) and extend.
        if (veh.route.length > 1) {
          veh.route = [veh.route[veh.route.length - 1]];
          veh.routeIdx = 1;
        }
        if (veh.pendingRelocation >= 0) {
          relocateVehicle(veh, veh.pendingRelocation);
        } else if (!ensureRoute(veh) || veh.routeIdx >= veh.route.length) {
          // Planning may have concluded a relocation is needed; take it now
          // rather than idling until the next step.
          if (veh.pendingRelocation >= 0) continue;
          veh.status = 'waiting';
          veh.waitingSec += remaining;
          return;
        }
        continue;
      }
      const eid = veh.route[veh.routeIdx];
      const dur = edgeDurationSec(eid, activeRoutingModel, veh.vehicleType);
      const need = dur - veh.edgeProgressSec;
      if (remaining >= need) {
        remaining -= need;
        veh.odometerMeters += edgeLength[eid];
        veh.edgesDriven++;
        if (markEdgeCovered(eid, veh.vehicleType)) veh.edgesCovered++;
        veh.routeIdx++;
        veh.edgeProgressSec = 0;
      } else {
        veh.edgeProgressSec += remaining;
        remaining = 0;
      }
    }
    // Trim driven edges so the route array stays small; keep the current edge at index 0.
    if (veh.routeIdx > 0 && veh.routeIdx < veh.route.length) {
      veh.route = veh.route.slice(veh.routeIdx);
      veh.routeIdx = 0;
    }
    ensureRoute(veh);
    veh.status = computeStatus(veh);
  }

  function computeStatus(veh) {
    if (veh.routeIdx >= veh.route.length) return 'waiting';
    if (coveredEdgesCount >= totalDrivableEdges) return 'patrol';
    for (let i = veh.routeIdx; i < veh.route.length; i++) {
      if (edgeCovered[veh.route[i]] === 0) return i === veh.routeIdx ? 'covering' : 'transit';
    }
    return 'patrol';
  }

  function buildWaypoints(veh) {
    const waypoints = [];
    const end = Math.min(veh.route.length, veh.routeIdx + MAX_WAYPOINTS_PER_VEHICLE);
    for (let i = veh.routeIdx; i < end; i++) {
      const eid = veh.route[i];
      const u = edgeFrom[eid];
      const v = edgeTo[eid];
      waypoints.push({
        edgeId: eid,
        fromLat: Number(nodeLat[u].toFixed(5)),
        fromLng: Number(nodeLng[u].toFixed(5)),
        toLat: Number(nodeLat[v].toFixed(5)),
        toLng: Number(nodeLng[v].toFixed(5)),
        bearing: Math.round(edgeBearings[eid]),
        oneway: Boolean(edgeIsOneWay[eid]),
        highway: edgeHighwayStr[eid],
        roadName: edgeNameStr[eid],
        speedKmh: computeModelEdgeSpeedKmh(eid, activeRoutingModel, veh.vehicleType),
        lengthMeters: Math.round(edgeLength[eid]),
        durationSec: Number(edgeDurationSec(eid, activeRoutingModel, veh.vehicleType).toFixed(2)),
        hasSignal: Boolean(hasTrafficSignal[v]),
        covered: edgeCovered[eid] !== 0,
      });
    }
    return waypoints;
  }

  function serializeVehicle(veh) {
    return {
      id: veh.id,
      vehicleType: veh.vehicleType,
      serviceLabel: veh.serviceLabel,
      depotName: veh.depotName,
      model: activeRoutingModel,
      status: veh.status,
      waypoints: buildWaypoints(veh),
      progressSec: Number(veh.edgeProgressSec.toFixed(2)),
      routeVersion: veh.routeVersion,
      relocated: veh.relocatedThisStep,
      relocations: veh.relocations,
      odometerKm: Number((veh.odometerMeters / 1000).toFixed(2)),
      edgesCovered: veh.edgesCovered,
    };
  }

  function initVehicles() {
    vehicles.length = 0;
    searchBudget = SEARCH_BUDGET_PER_STEP;
    for (let i = 0; i < TOTAL_CARS + TOTAL_BUSES; i++) {
      const veh = spawnVehicle(i);
      ensureRoute(veh);
      veh.status = computeStatus(veh);
      vehicles.push(veh);
    }
  }

  initVehicles();

  function clampMultiplier(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return speedMultiplier;
    return Math.max(1, Math.min(MAX_SPEED_MULTIPLIER, n));
  }

  function buildState() {
    let waiting = 0;
    let fleetMeters = 0;
    for (const veh of vehicles) {
      // Status reflects the coverage bitmap after every vehicle has moved this step.
      veh.status = computeStatus(veh);
      if (veh.status === 'waiting') waiting++;
      fleetMeters += veh.odometerMeters;
    }
    const coveragePct =
      totalDrivableEdges > 0
        ? Number(((coveredEdgesCount / totalDrivableEdges) * 100).toFixed(2))
        : 100.0;
    return {
      model: activeRoutingModel,
      speedMultiplier,
      simSeconds: Math.round(simSeconds),
      usingFallbackGraph,
      coverage: {
        coveredEdges: coveredEdgesCount,
        totalDrivableEdges,
        coveragePct,
        isComplete: coveredEdgesCount >= totalDrivableEdges,
        coveredOneWayEdges,
        totalOneWayEdges: totalOneWayMain,
        coveredTwoWayEdges,
        totalTwoWayEdges: totalTwoWayMain,
        claimedEdges: claimedCount,
        reachableEdges,
        activeCars: TOTAL_CARS,
        activeBuses: TOTAL_BUSES,
        totalVehicles: vehicles.length,
        waitingVehicles: waiting,
        relocations: relocationsTotal,
        fleetDistanceKm: Number((fleetMeters / 1000).toFixed(1)),
        simSeconds: Math.round(simSeconds),
        speedMultiplier,
      },
      vehicles: vehicles.map(serializeVehicle),
      coveredSegmentsSample: recentSegments.slice(-900),
    };
  }

  /**
   * Advance the simulation by the wall-clock time since the previous call,
   * scaled by the speed multiplier, and return the fleet state.
   *
   * @param {object} [options]
   * @param {string} [options.model] Routing model for edge speeds and delays.
   * @param {number} [options.speedMultiplier] Simulation speed; applies from this call on.
   * @param {number} [options.nowMs] Wall clock override (tests).
   */
  function stepCoverage({ model = activeRoutingModel, speedMultiplier: nextMultiplier, nowMs } = {}) {
    if (model && model !== activeRoutingModel) activeRoutingModel = model;

    const wallNow = Number.isFinite(nowMs) ? nowMs : now();
    const dtWallMs = Math.max(0, Math.min(MAX_WALL_DT_MS, wallNow - lastWallMs));
    lastWallMs = wallNow;
    const dtSim = (dtWallMs / 1000) * speedMultiplier;
    if (nextMultiplier !== undefined) speedMultiplier = clampMultiplier(nextMultiplier);

    searchBudget = SEARCH_BUDGET_PER_STEP;
    if (dtSim > 0) {
      simSeconds += dtSim;
      for (const veh of vehicles) advanceVehicle(veh, dtSim);
    } else {
      for (const veh of vehicles) {
        veh.relocatedThisStep = false;
        ensureRoute(veh);
        veh.status = computeStatus(veh);
      }
    }
    return buildState();
  }

  function resetCoverage({ model, speedMultiplier: nextMultiplier, nowMs } = {}) {
    edgeCovered.fill(0);
    edgeClaimed.fill(0);
    coveredEdgesCount = 0;
    coveredOneWayEdges = 0;
    coveredTwoWayEdges = 0;
    claimedCount = 0;
    relocationsTotal = 0;
    sweepCursor = 0;
    simSeconds = 0;
    recentSegments.length = 0;
    if (model) activeRoutingModel = model;
    if (nextMultiplier !== undefined) speedMultiplier = clampMultiplier(nextMultiplier);
    lastWallMs = Number.isFinite(nowMs) ? nowMs : now();
    initVehicles();
    return buildState();
  }

  /** Read-only graph accessors for tests and QA scripts. */
  const graph = Object.freeze({
    edgeCount: M,
    nodeCount: N,
    totalDrivableEdges,
    reachableEdges,
    droppedRestrictions,
    edgeFrom: (eid) => edgeFrom[eid],
    edgeTo: (eid) => edgeTo[eid],
    isMain: (eid) => edgeIsMain[eid] === 1,
    isCovered: (eid) => edgeCovered[eid] !== 0,
    isTurnForbidden,
    vehicleMayUse,
  });

  return { stepCoverage, resetCoverage, graph };
}

let _engine = null;

/** Process-wide engine backed by the SafeSpotSG Singapore road graph. */
export function getSafeSpotFleetEngine() {
  if (!_engine) _engine = createSafeSpotFleetEngine();
  return _engine;
}
