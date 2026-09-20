/**
 * Export Controls UI Widget.
 *
 * Provides a one-click button in the command dock to export the current
 * operational picture as a Markdown briefing dossier or JSON dump.
 */

import { generateMarkdownDossier, downloadFile } from '../export/missionDossier.js';
import { getTacticalAudio } from '../audio/tacticalAudio.js';

export class ExportControls {
  /**
   * @param {object} options
   * @param {HTMLElement} [options.container]
   * @param {() => object} options.getData
   * @param {TacticalAudioEngine} [options.audioEngine]
   */
  constructor({ container = null, getData, audioEngine = null } = {}) {
    this.container = container;
    this.getData = getData;
    this.audioEngine = audioEngine || getTacticalAudio();
    this.root = null;
    this._init();
  }

  _init() {
    if (typeof document === 'undefined') return;

    this.root = document.createElement('div');
    this.root.className = 'gev-export-controls-widget';
    this.root.innerHTML = `
      <button class="gev-export-btn" title="Export Tactical Mission Dossier" aria-label="Export Intel">
        <span>📋</span>
        <span class="gev-export-label">DOSSIER</span>
      </button>
    `;

    const btn = this.root.querySelector('.gev-export-btn');
    btn?.addEventListener('click', () => {
      this.exportDossier();
    });

    if (this.container) {
      this.container.appendChild(this.root);
    }
  }

  exportDossier() {
    this.audioEngine.playLock();
    const data = this.getData ? this.getData() : {};
    const md = generateMarkdownDossier(data);
    const dateStr = new Date().toISOString().slice(0, 10);
    downloadFile(`GEV-Mission-Dossier-${dateStr}.md`, md, 'text/markdown');
  }

  destroy() {
    this.root?.remove();
  }
}
