/**
 * VoicePanel — React wrapper for the OpenAI voice control system.
 *
 * The voice UI is built by createVoiceControl() and injected into #command-dock.
 * This React component reads status from __gevVoiceCommands and can trigger
 * start/stop — the vanilla UI handles all rendering.
 */
import React, { useState, useEffect } from 'react';
import { useVoiceCommands } from '../hooks/useVoiceCommands';

export function VoicePanel(): React.JSX.Element {
  const { voiceCommands } = useVoiceCommands();
  const [status, setStatus] = useState('idle');
  const [tier, setTier] = useState('STD');

  useEffect(() => {
    if (!voiceCommands) return;
    // Poll the voice controller status — it updates its own DOM on state changes
    const id = setInterval(() => {
      const vc = (window as any).__gevVoiceCommands;
      if (!vc) return;
      // Read current status from the DOM the vanilla system maintains
      const root = document.getElementById('gev-voice-control');
      if (root) setStatus(root.dataset.speaker ?? 'idle');
      const tierBtn = document.getElementById('gev-voice-tier');
      if (tierBtn) setTier(tierBtn.textContent ?? 'STD');
    }, 500);
    return () => clearInterval(id);
  }, [voiceCommands]);

  // The actual voice UI is rendered by the vanilla createVoiceControl().
  // This placeholder confirms React integration and shows live status.
  return (
    <div
      id="gev-voice-control"
      data-status={status}
      data-speaker={status}
      aria-label="Voice control status"
      style={{ display: 'none' }}
    >
      <div className="gev-voice-heading">
        <div className="gev-voice-kicker">AI AGENT</div>
        <div id="gev-voice-status">{status.toUpperCase()}</div>
        <div className="gev-voice-cost">
          <button id="gev-voice-tier" className="gev-voice-tier-btn" type="button">{tier}</button>
          <span id="gev-voice-cost-value" data-level="ok">~$0.00</span>
        </div>
      </div>
    </div>
  );
}
