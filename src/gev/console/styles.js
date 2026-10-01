/** Scoped styles for the Ops console; uses the app's foundation tokens. */
const CSS = `
.gev-ops { position: fixed; inset: 0; pointer-events: none; z-index: 40; font-family: var(--font-sans); color: var(--text-primary); }
.gev-ops button, .gev-ops input, .gev-ops select, .gev-ops textarea, .gev-ops a.gev-btn { pointer-events: auto; font: inherit; }
.gev-ops-chip { position: fixed; left: var(--left-stack-x, 52px); top: calc(var(--left-stack-top, 26vh) + 2 * var(--left-stack-gap, 72px));
  width: var(--left-collapsed-width, 176px); height: 50px; display: flex; gap: 8px; align-items: center; justify-content: space-between;
  padding: 0 18px; border-radius: var(--panel-radius); border: 1px solid var(--glass-border); background: var(--glass-bg);
  color: var(--text-secondary); font-family: var(--font-mono) !important; font-size: 9.5px; letter-spacing: .16em; white-space: nowrap; cursor: pointer;
  backdrop-filter: blur(14px); }
.gev-ops-chip:hover, .gev-ops-chip[aria-expanded="true"] { border-color: var(--accent); color: var(--accent); }
.gev-ops-badge { background: #ff5c5c; color: #fff; border-radius: 999px; padding: 0 6px; font-size: 10px; letter-spacing: 0; }
.gev-ops-panel { position: fixed; left: calc(var(--left-stack-x, 52px) + var(--left-collapsed-width, 176px) + 12px); top: 12vh; width: min(380px, calc(100vw - 28px)); max-height: 76vh;
  display: flex; flex-direction: column; pointer-events: auto; background: var(--glass-bg); border: 1px solid var(--glass-border);
  border-radius: var(--panel-radius); backdrop-filter: blur(18px); box-shadow: 0 12px 40px rgba(0,0,0,.45); font-size: 12.5px; }
.gev-ops-panel[hidden] { display: none; }
.gev-ops-panel header { display: flex; align-items: center; justify-content: space-between; padding: 8px 8px 0 8px; }
.gev-ops-panel nav { display: flex; gap: 2px; flex-wrap: wrap; }
.gev-ops-panel nav button { background: none; border: 0; color: var(--text-secondary); padding: 6px 8px; border-radius: 8px; cursor: pointer;
  font-family: var(--font-mono); font-size: 10.5px; letter-spacing: .1em; text-transform: uppercase; }
.gev-ops-panel nav button[aria-selected="true"] { color: var(--accent); background: var(--accent-dim); }
.gev-ops-close { background: none; border: 0; color: var(--text-secondary); font-size: 18px; cursor: pointer; padding: 2px 8px; }
.gev-ops-body { overflow: auto; padding: 8px 12px 12px; }
.gev-ops-panel footer { border-top: 1px solid var(--glass-border); padding: 6px 12px; font-family: var(--font-mono); font-size: 10px; color: var(--text-dim); }
.gev-ops h4 { font-size: 11px; letter-spacing: .08em; text-transform: uppercase; color: var(--text-secondary); margin: 14px 0 6px; font-weight: 600; }
.gev-ops details { border-bottom: 1px solid var(--glass-border); padding: 6px 0; }
.gev-ops summary { cursor: pointer; pointer-events: auto; font-weight: 600; padding: 4px 0; }
.gev-row { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; margin: 6px 0; }
.gev-ops .gev-form { display: flex; flex-direction: column; gap: 6px; margin: 6px 0; }
.gev-ops .gev-form.gev-row { flex-direction: row; }
.gev-ops label { display: flex; flex-direction: column; gap: 3px; color: var(--text-secondary); font-size: 11px; }
.gev-ops label.gev-check { flex-direction: row; align-items: center; gap: 6px; }
.gev-ops input:not([type="checkbox"]):not([type="range"]), .gev-ops select, .gev-ops textarea {
  background: rgba(255,255,255,.04); border: 1px solid var(--glass-border); color: var(--text-primary); border-radius: 8px; padding: 6px 8px; min-width: 0; }
.gev-ops select option { background: var(--menu-bg); }
.gev-ops .gev-form.gev-row input { flex: 1; }
.gev-ops input[type="range"] { width: 100%; accent-color: var(--accent); }
.gev-ops button:not(.gev-ops-chip):not(.gev-ops-close):not([role="tab"]), .gev-ops a.gev-btn {
  background: rgba(255,255,255,.06); border: 1px solid var(--glass-border); color: var(--text-primary); border-radius: 8px;
  padding: 5px 10px; cursor: pointer; text-decoration: none; font-size: 11.5px; }
.gev-ops button:hover:not(:disabled), .gev-ops a.gev-btn:hover { border-color: var(--accent); color: var(--accent); }
.gev-ops button:disabled { opacity: .4; cursor: default; }
.gev-list { list-style: none; display: flex; flex-direction: column; gap: 6px; margin: 6px 0; }
.gev-list li { border: 1px solid var(--glass-border); border-left: 3px solid var(--accent); border-radius: 8px; padding: 7px 9px; background: rgba(255,255,255,.02); }
.gev-list li.sev-warning { border-left-color: #f0a63c; }
.gev-list li.sev-critical { border-left-color: #ff5c5c; }
.gev-list li.acked { opacity: .55; }
.gev-list li.selected { background: var(--accent-dim); }
.gev-list.compact li { padding: 5px 8px; }
.gev-title { font-weight: 600; line-height: 1.3; }
.gev-meta { color: var(--text-secondary); font-family: var(--font-mono); font-size: 10.5px; margin-top: 2px; }
.gev-hint { color: var(--text-dim); font-size: 11px; line-height: 1.4; }
.gev-empty { color: var(--text-secondary); padding: 10px 0; }
.gev-actions { display: flex; gap: 6px; margin-top: 6px; }
.gev-tag { font-family: var(--font-mono); font-size: 9.5px; color: var(--text-dim); text-transform: uppercase; margin-left: 4px; }
.gev-clock { font-family: var(--font-mono); font-size: 13px; margin: 8px 0 4px; }
.gev-clock strong { font-size: 18px; color: var(--accent); }
.gev-legend { display: flex; gap: 8px; align-items: center; font-size: 11px; color: var(--text-secondary); flex-wrap: wrap; }
.gev-legend i { width: 12px; height: 12px; border-radius: 3px; display: inline-block; }
.gev-legend .c1 { background: rgba(0,212,255,.5); } .gev-legend .c2 { background: rgba(240,166,60,.6); }
.gev-legend .c3 { background: rgba(255,92,92,.65); } .gev-legend .cf { border: 1px solid #fff; }
.gev-spark { width: 100%; height: 32px; margin-top: 4px; }
.gev-spark path { fill: none; stroke: var(--accent); stroke-width: 1.5; vector-effect: non-scaling-stroke; }
.gev-ops-toasts { position: fixed; right: 16px; top: 16px; display: flex; flex-direction: column; gap: 8px; width: min(340px, calc(100vw - 32px)); }
.gev-ops-toast { pointer-events: auto; display: flex; gap: 10px; align-items: center; justify-content: space-between; background: var(--glass-bg);
  border: 1px solid var(--glass-border); border-left: 3px solid var(--accent); border-radius: 10px; padding: 9px 12px; backdrop-filter: blur(14px);
  font-size: 12.5px; box-shadow: 0 8px 24px rgba(0,0,0,.4); animation: gev-in .2s ease-out; }
.gev-ops-toast.sev-warning { border-left-color: #f0a63c; }
.gev-ops-toast.sev-critical { border-left-color: #ff5c5c; }
.gev-ops-replay-banner { position: fixed; top: 84px; left: 50%; transform: translateX(-50%); padding: 6px 14px; border-radius: 999px;
  background: rgba(240,166,60,.16); border: 1px solid rgba(240,166,60,.6); color: #f0a63c; font-family: var(--font-mono); font-size: 11px; letter-spacing: .08em; }
.gev-ops-replay-banner[hidden] { display: none; }
@keyframes gev-in { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: none; } }
@media (prefers-reduced-motion: reduce) { .gev-ops-toast { animation: none; } }
@media (max-width: 900px) { .gev-ops-chip { left: 12px; top: auto; bottom: 110px; width: auto; height: 36px; } .gev-ops-panel { left: 12px; top: auto; bottom: 156px; max-height: 60vh; } }
`;

export function injectOpsStyles(documentRef = document) {
  if (documentRef.getElementById('gev-ops-styles')) return;
  const style = documentRef.createElement('style');
  style.id = 'gev-ops-styles';
  style.textContent = CSS;
  documentRef.head.appendChild(style);
}
