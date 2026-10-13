export const LAYER_ID = 'local-telemetry';
export const LAYER_NAME = 'Industrial Telemetry';
export const LAYER_SOURCE = 'IIoT · MQTT / SCADA';
export const ENTITY_PREFIX = `${LAYER_ID}:`;

export const TELEMETRY_OVERLAY_SOURCE_ID = 'industrial-telemetry';
export const TELEMETRY_OVERLAY_COHORT_LIMIT = 24;
export const TELEMETRY_OVERLAY_COLLISION_CAPACITY = 16;

/** Cyber HUD colors for industrial machine states */
export const TELEMETRY_STATUS_COLORS = Object.freeze({
  nominal: '#00ff88', // Cyber Green (Running / Healthy)
  idle: '#00d2ff', // Electric Cyan (Standby / Idle)
  warning: '#ff9500', // Amber (Degraded / Service Needed)
  fault: '#ff3b30', // Alert Red (Alarm / Trip / E-Stop)
  offline: '#8e8e93', // Muted Gray
});

export const TELEMETRY_TYPE_ICONS = Object.freeze({
  agv: '🚜',
  robot: '🤖',
  drone: '🛸',
  pump: '⚙',
  sensor: '📡',
  vehicle: '🚛',
  default: '⟐',
});

export const TELEMETRY_TYPE_LABELS = Object.freeze({
  agv: 'Automated Guided Vehicle',
  robot: 'Autonomous Mobile Robot',
  drone: 'Autonomous Inspection UAV',
  pump: 'Fluid Pump / Actuator',
  sensor: 'SCADA Telemetry Sensor',
  vehicle: 'Automated Yard Vehicle',
  default: 'Industrial Asset',
});
