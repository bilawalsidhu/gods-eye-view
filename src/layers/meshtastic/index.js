import * as Cesium from 'cesium';

export { createMeshtasticSource } from './source.js';

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function createMeshtasticLayer({ source } = {}) {
  if (typeof source?.getSnapshot !== 'function') {
    throw new TypeError('Meshtastic requires a snapshot source');
  }

  let viewer = null;
  let dataSource = null;
  let enabled = false;
  let request = null;
  let count = 0;

  return {
    id: 'meshtastic',
    name: 'Meshtastic',
    icon: '📡',
    source: 'Meshtastic MQTT / USB',
    updateInterval: 10000,

    init(nextViewer) {
      viewer = nextViewer;
      dataSource = new Cesium.CustomDataSource('meshtastic');
      dataSource.show = false;
      viewer.dataSources.add(dataSource);
      console.log('[Data:Meshtastic] Initialized');
    },

    enable() {
      enabled = true;
      if (dataSource) dataSource.show = true;
    },

    disable() {
      request?.abort();
      request = null;
      enabled = false;
      if (dataSource) {
        dataSource.show = false;
        dataSource.entities.removeAll();
      }
    },

    async update() {
      if (!enabled || !dataSource) return false;

      request?.abort();
      const current = new AbortController();
      request = current;

      try {
        const nodes = await source.getSnapshot({ signal: current.signal });

        if (current.signal.aborted || !enabled) return false;

        dataSource.entities.removeAll();
        count = 0;

        for (const node of nodes) {
          const lat = Number(node.latitude);
          const lon = Number(node.longitude);

          if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

          const local = node.source === 'local_usb';
          const retained = node.freshness === 'retained';

          const color = local
            ? Cesium.Color.LIME
            : retained
              ? Cesium.Color.GRAY
              : Cesium.Color.CYAN;

          dataSource.entities.add({
            id: `meshtastic:${node.id}`,
            name: node.longName || node.shortName || node.id,
            position: Cesium.Cartesian3.fromDegrees(lon, lat),

            point: {
              pixelSize: local ? 12 : 9,
              color,
              outlineColor: Cesium.Color.BLACK,
              outlineWidth: 2,
              heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
              disableDepthTestDistance: Number.POSITIVE_INFINITY,
            },

            label: {
              text: node.shortName || node.longName || node.id,
              font: '12px monospace',
              fillColor: Cesium.Color.WHITE,
              outlineColor: Cesium.Color.BLACK,
              outlineWidth: 3,
              style: Cesium.LabelStyle.FILL_AND_OUTLINE,
              pixelOffset: new Cesium.Cartesian2(0, -18),
              heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
              disableDepthTestDistance: Number.POSITIVE_INFINITY,
              distanceDisplayCondition: new Cesium.DistanceDisplayCondition(
                0,
                250000,
              ),
            },

            description: `
              <table class="cesium-infoBox-defaultTable">
                <tbody>
                  <tr><th>Name</th><td>${escapeHtml(node.longName || 'Unknown')}</td></tr>
                  <tr><th>Node</th><td>${escapeHtml(node.id)}</td></tr>
                  <tr><th>Source</th><td>${escapeHtml(node.source)}</td></tr>
                  <tr><th>Freshness</th><td>${escapeHtml(node.freshness)}</td></tr>
                  <tr><th>Channel</th><td>${escapeHtml(node.channel || 'Unknown')}</td></tr>
                  <tr><th>Firmware</th><td>${escapeHtml(node.firmwareVersion || 'Unknown')}</td></tr>
                  <tr><th>Precision</th><td>${escapeHtml(node.positionPrecision ?? 'Unknown')}</td></tr>
                  <tr><th>Local nodes</th><td>${escapeHtml(node.localNodeCount ?? 'Unknown')}</td></tr>
                </tbody>
              </table>
            `,
          });

          count++;
        }

        console.log(`[Data:Meshtastic] Updated: ${count} nodes`);
        return true;
      } finally {
        if (request === current) request = null;
      }
    },

    destroy(nextViewer = viewer) {
      request?.abort();

      if (dataSource && nextViewer) {
        nextViewer.dataSources.remove(dataSource, true);
      }

      dataSource = null;
      viewer = null;
    },

    getStats() {
      return { count };
    },
  };
}
