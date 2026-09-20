/**
 * Geo Data Plotter — Instant Drag-and-Drop 3D Map Plotting for GeoJSON, KML & CSV
 *
 * Automatically parses, styles with tactical holographics, and zooms Cesium camera
 * to any dropped geospatial dataset while feeding metadata to JARVIS.
 */

export class GeoDataPlotter {
  constructor({
    viewer = null,
    getViewer = () => globalThis.__godsEyeView?.viewer,
    aiController = null,
    documentRef = globalThis.document,
    playCue = () => {},
  } = {}) {
    this._viewer = viewer;
    this._getViewer = getViewer;
    this._aiController = aiController;
    this._doc = documentRef;
    this._playCue = playCue;
    this._activeDataSources = [];
    this._bound = false;
  }

  get viewer() {
    return this._viewer || this._getViewer?.();
  }

  init() {
    if (this._bound || !this._doc?.body) return;
    this._bound = true;

    const onDragOver = (e) => {
      e.preventDefault();
      e.stopPropagation();
      this._doc.body.classList.add('geo-drop-active');
    };

    const onDragLeave = (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.relatedTarget === null) {
        this._doc.body.classList.remove('geo-drop-active');
      }
    };

    const onDrop = async (e) => {
      e.preventDefault();
      e.stopPropagation();
      this._doc.body.classList.remove('geo-drop-active');

      const files = Array.from(e.dataTransfer?.files || []);
      for (const file of files) {
        await this.plotFile(file);
      }
    };

    this._doc.addEventListener('dragover', onDragOver);
    this._doc.addEventListener('dragleave', onDragLeave);
    this._doc.addEventListener('drop', onDrop);

    this._cleanupListeners = () => {
      this._doc.removeEventListener('dragover', onDragOver);
      this._doc.removeEventListener('dragleave', onDragLeave);
      this._doc.removeEventListener('drop', onDrop);
      this._bound = false;
    };
  }

  destroy() {
    this._cleanupListeners?.();
    this.clearAll();
  }

  async plotFile(file) {
    if (!file) return { ok: false, error: 'No file provided' };
    const name = file.name || 'dataset';
    const ext = name.split('.').pop().toLowerCase();

    try {
      const text = await file.text();
      return await this.plotText(text, { name, ext });
    } catch (err) {
      this._notifyJarvis(`⚠️ Failed to read file **${name}**: ${err.message}`);
      return { ok: false, error: err.message };
    }
  }

  async plotText(text, { name = 'Custom Dataset', ext = 'geojson' } = {}) {
    const viewer = this.viewer;
    if (!viewer) return { ok: false, error: 'Cesium viewer not available' };

    this._playCue('data');

    if (ext === 'geojson' || ext === 'json') {
      return this._plotGeoJson(text, name);
    } else if (ext === 'csv') {
      return this._plotCsv(text, name);
    } else if (ext === 'kml') {
      return this._plotKml(text, name);
    } else {
      this._notifyJarvis(
        `⚠️ Unsupported file format \`.${ext}\`. Supported formats: GeoJSON, KML, CSV.`,
      );
      return { ok: false, error: `Unsupported format .${ext}` };
    }
  }

  async _plotGeoJson(jsonString, name) {
    const viewer = this.viewer;
    try {
      const data =
        typeof jsonString === 'string' ? JSON.parse(jsonString) : jsonString;
      const Cesium = globalThis.Cesium || globalThis.window?.Cesium;
      if (!Cesium) return { ok: false, error: 'Cesium not loaded' };

      const dataSource = await Cesium.GeoJsonDataSource.load(data, {
        stroke: Cesium.Color.fromCssColorString('#00d4ff'),
        fill: Cesium.Color.fromCssColorString('rgba(0, 212, 255, 0.25)'),
        strokeWidth: 3,
        markerColor: Cesium.Color.fromCssColorString('#00ffaa'),
        clampToGround: true,
      });

      viewer.dataSources.add(dataSource);
      this._activeDataSources.push(dataSource);
      viewer.zoomTo(dataSource);

      const featureCount = data.features ? data.features.length : 1;
      this._notifyJarvis(
        `🗺️ **DATASET PLOTTED**: Plotted **${name}** (${featureCount} feature${featureCount === 1 ? '' : 's'}) directly onto the 3D globe with tactical holographic styling. Camera framed to dataset boundaries.`,
      );

      return { ok: true, name, featureCount };
    } catch (err) {
      this._notifyJarvis(
        `⚠️ Could not parse GeoJSON in **${name}**: ${err.message}`,
      );
      return { ok: false, error: err.message };
    }
  }

  async _plotCsv(csvString, name) {
    try {
      const lines = csvString.split(/\r?\n/).filter((l) => l.trim().length > 0);
      if (lines.length < 2)
        throw new Error(
          'CSV must contain at least a header row and one data row.',
        );

      const headers = lines[0].split(',').map((h) =>
        h
          .trim()
          .replace(/^["']|["']$/g, '')
          .toLowerCase(),
      );
      const latIdx = headers.findIndex(
        (h) => h === 'lat' || h === 'latitude' || h === 'y',
      );
      const lonIdx = headers.findIndex(
        (h) => h === 'lon' || h === 'lng' || h === 'longitude' || h === 'x',
      );

      if (latIdx === -1 || lonIdx === -1) {
        throw new Error(
          'CSV must contain latitude ("lat" or "latitude") and longitude ("lon", "lng" or "longitude") columns.',
        );
      }

      const features = [];
      for (let i = 1; i < lines.length; i++) {
        const cols = lines[i]
          .split(',')
          .map((c) => c.trim().replace(/^["']|["']$/g, ''));
        const lat = parseFloat(cols[latIdx]);
        const lon = parseFloat(cols[lonIdx]);
        if (!isNaN(lat) && !isNaN(lon)) {
          const properties = {};
          headers.forEach((h, idx) => {
            properties[h] = cols[idx] || '';
          });
          features.push({
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [lon, lat] },
            properties,
          });
        }
      }

      const geoJson = {
        type: 'FeatureCollection',
        features,
      };

      return await this._plotGeoJson(
        geoJson,
        `${name} (CSV parsed: ${features.length} points)`,
      );
    } catch (err) {
      this._notifyJarvis(`⚠️ Failed parsing CSV **${name}**: ${err.message}`);
      return { ok: false, error: err.message };
    }
  }

  async _plotKml(kmlString, name) {
    const viewer = this.viewer;
    try {
      const Cesium = globalThis.Cesium || globalThis.window?.Cesium;
      if (!Cesium) return { ok: false, error: 'Cesium not loaded' };
      const blob = new Blob([kmlString], {
        type: 'application/vnd.google-earth.kml+xml',
      });
      const url = URL.createObjectURL(blob);
      const dataSource = await Cesium.KmlDataSource.load(url, {
        camera: viewer.scene.camera,
        canvas: viewer.scene.canvas,
        clampToGround: true,
      });

      viewer.dataSources.add(dataSource);
      this._activeDataSources.push(dataSource);
      viewer.zoomTo(dataSource);
      setTimeout(() => URL.revokeObjectURL(url), 5000);

      this._notifyJarvis(
        `🗺️ **KML PLOTTED**: Successfully parsed and rendered **${name}** onto the 3D globe.`,
      );
      return { ok: true, name };
    } catch (err) {
      this._notifyJarvis(
        `⚠️ Could not parse KML in **${name}**: ${err.message}`,
      );
      return { ok: false, error: err.message };
    }
  }

  clearAll() {
    const viewer = this.viewer;
    if (viewer && this._activeDataSources.length > 0) {
      for (const ds of this._activeDataSources) {
        viewer.dataSources.remove(ds, true);
      }
      this._activeDataSources = [];
      this._notifyJarvis(
        '🗺️ Cleared all custom plotted datasets from the 3D globe.',
      );
    }
  }

  _notifyJarvis(msg) {
    if (this._aiController) {
      this._aiController.appendMessage?.('assistant', msg);
    }
  }
}
