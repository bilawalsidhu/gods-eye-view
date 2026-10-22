import { ROUTE_COLORS } from './rendering.js';
import { PICKUP_COLORS } from './pickup.js';
import { TELEMETRY_COLORS } from './telemetry.js';
import { FLEET_COLORS } from './fleet.js';
import { HD_MAP_LABELS } from './hdMap.js';
import { formatDistance, formatDuration } from '../../data/safespot.js';
import { t } from '../../i18n/index.js';

/**
 * @module layers/safespot/controls
 * @description UI row controls, action chips, status telemetry info, and legend
 * builder for SafeSpotSG Evaluation Lab inside God's Eye View layer panel.
 */

export function buildSafeSpotRowControls({
  params,
  corridorData = null,
  pickupData = null,
  telemetryTick = null,
  fleetStats = null,
  isScorecardOpen = false,
  isStreaming = false,
  hasActiveAlert = false,
  enabled = false,
  actions = {},
}) {
  const isNovena = params.corridorId === 'novena-to-mbs';
  const corridorLabel = isNovena ? 'Novena ➔ MBS' : 'Toa Payoh ➔ Raffles';

  const divInfo = corridorData?.divergence || corridorData?.comparison;
  const maxSep = divInfo?.maxSeparationMeters || 0;
  const isDiv = divInfo?.isDivergent || divInfo?.divergenceDetected;

  const corridorPart = corridorData
    ? `${corridorData.pairName || corridorLabel} · ${
        isDiv ? `Divergence: ${formatDistance(maxSep)} max` : 'Convergence: <35m'
      }`
    : corridorLabel;

  const sc = corridorData?.scorecard;
  const modelLabel = String(params.model || 'calibrated').toUpperCase();
  const scorecardPart = sc
    ? ` · [${modelLabel}: ETA ${formatDuration(sc.etaSeconds)} (Ref ${formatDuration(sc.referenceSeconds)}) | MAE: ${Number(sc.absoluteErrorPct ?? 0).toFixed(1)}% | Latency: ${sc.queryLatencyMs}ms | Div: ${formatDistance(sc.divergenceMeters)}]`
    : ` · [Model: ${modelLabel}]`;

  const covPct = fleetStats?.coveragePct ?? 0;
  const covEdges = fleetStats?.coveredEdges ?? 0;
  const totalEdges = fleetStats?.totalDrivableEdges ?? 229433;
  const activeCars = fleetStats?.activeCars ?? 36;
  const activeBuses = fleetStats?.activeBuses ?? 14;
  const fleetPart = params.showFleetSimulation
    ? ` · 🚗 Fleet: ${activeCars} Cars + ${activeBuses} Buses | SG Network Covered: ${Number(covPct).toFixed(2)}% (${covEdges.toLocaleString()}/${totalEdges.toLocaleString()} edges)`
    : '';

  const pickupCandidates = pickupData?.candidates || [];
  const topCandidate = pickupCandidates[0];
  const pickupPart = topCandidate
    ? ` · Pickup: #${topCandidate.rank || 1} ${topCandidate.name || 'Stand'} (${
        topCandidate.shelteredPercentage ?? 0
      }% roof, ${topCandidate.seniorWalkSeconds || 0}s walk)`
    : '';

  const floors = telemetryTick?.floorsAbove ?? 3;
  const wsPart = isStreaming
    ? ` · fēnix 6: Connected (L${floors + 1}, ±3m)`
    : ' · Garmin Bridge: Standby';

  const alertPart = hasActiveAlert ? ' · ⚠️ [CRITICAL FALL ALERT ACTIVE]' : '';
  const infoText = corridorPart + scorecardPart + fleetPart + pickupPart + wsPart + alertPart;

  const hdMapLabel = HD_MAP_LABELS[params.hdMapMode] || 'HD MAP: RETINA @2X';

  const chips = [
    // 1. Corridor selector toggle
    {
      id: 'safespot-corridor-select',
      label: t(corridorLabel),
      title: t('Click to toggle between primary benchmark corridors with divergence'),
      disabled: !enabled,
      onClick: actions.toggleCorridor,
    },
    // 2. Model Arena Selectors
    {
      id: 'safespot-model-baseline',
      label: t('BASELINE'),
      title: t('Select Baseline Heuristic Routing Model (Phase 2)'),
      active: params.model === 'baseline',
      disabled: !enabled,
      onClick: () => actions.setModel?.('baseline'),
    },
    {
      id: 'safespot-model-calibrated',
      label: t('CALIBRATED'),
      title: t('Select Calibrated Parametric Optimizer Model'),
      active: (params.model || 'calibrated') === 'calibrated',
      disabled: !enabled,
      onClick: () => actions.setModel?.('calibrated'),
    },
    {
      id: 'safespot-model-speedband',
      label: t('SPEEDBAND'),
      title: t('Select LTA SpeedBand Hybrid Empirical Bayes Model'),
      active: params.model === 'speedband',
      disabled: !enabled,
      onClick: () => actions.setModel?.('speedband'),
    },
    // 3. Scorecard & Training Summary Modal
    {
      id: 'safespot-scorecard-modal',
      label: t('📊 SCORECARD'),
      title: t('Open 3D Model Arena Training Summary, 95% Bootstrap CIs & Island Coverage'),
      active: Boolean(isScorecardOpen),
      disabled: !enabled,
      onClick: actions.toggleScorecardModal,
    },
    // 4. Autonomous Test Fleet (Cars & Buses) Toggle
    {
      id: 'safespot-toggle-fleet',
      label: params.showFleetSimulation
        ? t('🚗 FLEET: {pct}% SG', { pct: Number(covPct).toFixed(1) })
        : t('🚗 FLEET: OFF'),
      title: t('Toggle autonomous test Cars (CAR-xxxx) and Buses (BUS-xxxx) covering all Singapore roads'),
      active: Boolean(params.showFleetSimulation),
      disabled: !enabled,
      onClick: actions.toggleFleet,
    },
    // 5. Fleet simulation speed (coverage is earned by driving; no instant sweep)
    {
      id: 'safespot-fleet-sweep',
      label: covPct >= 100 ? t('✅ 100% SG COVERED') : t('⚡ SIM SPEED ({multiplier}X)', { multiplier: params.fleetSpeedMultiplier || 10 }),
      title: t('Cycle fleet simulation speed (1x → 10x → 50x → 200x). Every carriageway is counted only once a vehicle has driven it; at 100% click to restart'),
      active: covPct >= 100,
      disabled: !enabled,
      onClick: actions.triggerFleetSweep,
    },
    // 6. High-DPI Street & Label Map Enhancer
    {
      id: 'safespot-hd-map',
      label: t(hdMapLabel),
      title: t('Cycle High-DPI @2x Retina Street Labels / SLA OneMap SG / Dark @2x for razor-sharp street text'),
      active: params.hdMapMode !== 'base',
      disabled: !enabled,
      onClick: actions.cycleHdMap,
    },
    // 7. Heatmap toggle
    {
      id: 'safespot-toggle-heatmap',
      label: params.showHeatmap ? t('HEATMAP: ON') : t('HEATMAP: OFF'),
      title: t('Toggle per-edge residual speed and delay heatmap styling'),
      active: params.showHeatmap,
      disabled: !enabled,
      onClick: actions.toggleHeatmap,
    },
    // 8. Divergence toggle
    {
      id: 'safespot-toggle-divergence',
      label: params.showDivergence ? t('DIVERGENCE: ON') : t('DIVERGENCE: OFF'),
      title: t('Toggle >35m spatial separation markers and alerts'),
      active: params.showDivergence,
      disabled: !enabled,
      onClick: actions.toggleDivergence,
    },
    // 9. Reference route toggle
    {
      id: 'safespot-toggle-ref',
      label: params.showGoogleReference ? t('REF ROUTE: ON') : t('REF ROUTE: OFF'),
      title: t('Toggle Google / reference route polyline drape'),
      active: params.showGoogleReference,
      disabled: !enabled,
      onClick: actions.toggleRef,
    },
    // 10. Rain Weather adaptation toggle
    {
      id: 'safespot-toggle-rain',
      label: params.isRaining ? t('RAIN: ON (Linkways)') : t('RAIN: OFF (Dry)'),
      title: t('Toggle rain weather impedance to prefer covered linkways'),
      active: Boolean(params.isRaining),
      disabled: !enabled,
      onClick: actions.toggleRain,
    },
    // 11. Senior Pickup Simulation trigger
    {
      id: 'safespot-trigger-pickup',
      label: t('SIMULATE PICKUP'),
      title: t('Run 1-to-many Dijkstra pickup ranking and senior walk calculation'),
      disabled: !enabled,
      onClick: actions.triggerPickup,
    },
    // 12. Watch telemetry stream toggle
    {
      id: 'safespot-toggle-telemetry',
      label: isStreaming ? t('WATCH STREAM: ON') : t('WATCH STREAM: OFF'),
      title: t('Toggle real-time Garmin fēnix 6 Pro Solar telemetry stream'),
      active: isStreaming,
      disabled: !enabled,
      onClick: actions.toggleTelemetry,
    },
    // 13. Emergency fall alert trigger
    {
      id: 'safespot-trigger-alert',
      label: hasActiveAlert ? t('CLEAR FALL ALERT') : t('SIMULATE FALL ALERT'),
      title: t('Simulate emergency senior fall alert broadcast from wearable'),
      active: hasActiveAlert,
      disabled: !enabled,
      onClick: actions.triggerFallAlert,
    },
    // 14. Focus camera on active route or pickup area
    {
      id: 'safespot-focus-route',
      label: t('FOCUS ROUTE'),
      title: t('Fly 3D camera to frame the active route corridor'),
      disabled: !enabled || (!corridorData && !pickupData),
      onClick: actions.focusRoute,
    },
  ];

  const legend = [
    {
      label: t('Residual <5 km/h (Good Fit)'),
      color: ROUTE_COLORS.SPEED_FREE,
      blurb: t('Edge speed residual error < 5 km/h vs ground truth reference'),
    },
    {
      label: t('Residual 5–15 km/h (Moderate)'),
      color: ROUTE_COLORS.SPEED_MODERATE,
      blurb: t('Edge speed residual error 5–15 km/h vs ground truth reference'),
    },
    {
      label: t('Residual >15 km/h (High Bias)'),
      color: ROUTE_COLORS.SPEED_DELAY,
      blurb: t('Edge speed residual error > 15 km/h vs ground truth reference'),
    },
    {
      label: t('Autonomous Test Car (CAR-xxxx)'),
      color: FLEET_COLORS.CAR_MARKER,
      blurb: t('Test car traversing 1-way & 2-way carriageways on active SafeSpot algorithm'),
    },
    {
      label: t('Autonomous Test Bus (BUS-xxxx)'),
      color: FLEET_COLORS.BUS_MARKER,
      blurb: t('Test bus traversing arterial/collector bus corridors (60 km/h cap)'),
    },
    {
      label: t('Covered 1-Way Carriageway Track'),
      color: FLEET_COLORS.TRACK_ONEWAY,
      blurb: t('Unidirectional carriageway / dual-carriageway expressway verified by test fleet'),
    },
    {
      label: t('Google Reference Route'),
      color: ROUTE_COLORS.REFERENCE,
      blurb: t('Baseline reference route (Google Routes TRAFFIC_AWARE or OSRM)'),
    },
    {
      label: t('Spatial Divergence (>35m)'),
      color: ROUTE_COLORS.DIVERGENCE_SPAN,
      blurb: t('Routes separate by >35m (e.g. CTE expressway vs surface arterials)'),
    },
    {
      label: t('Senior Walk (Covered Linkway)'),
      color: PICKUP_COLORS.WALK_SHELTERED,
      blurb: t('Senior-paced walking route adapted for rain via sheltered linkways'),
    },
    {
      label: t('Driver Approach Route'),
      color: PICKUP_COLORS.DRIVE_APPROACH,
      blurb: t('1-to-many Dijkstra road approach route to pickup point'),
    },
    {
      label: t('Watch GNSS Envelope'),
      color: TELEMETRY_COLORS.WATCH_GNSS,
      blurb: t('Garmin fēnix 6 Pro Solar GNSS position uncertainty envelope (±12m)'),
    },
    {
      label: t('Barometer 3D Floor Stalk'),
      color: TELEMETRY_COLORS.STALK_COLOR,
      blurb: t('Barometer-derived vertical 3D elevation stalk above ground (2.8m per floor)'),
    },
  ];

  return {
    chips,
    info: infoText,
    legend,
  };
}
