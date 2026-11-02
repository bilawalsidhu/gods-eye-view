import { readFileSync } from 'node:fs';

/** Read voice implementations alongside their compatibility/composition surface. */
export function readRealtimeSource() {
  return [
    'realtimeConnection',
    'realtimeCost',
    'realtimeDiagnostics',
    'realtimeInput',
    'realtimeInputPolicy',
    'realtimePreferences',
    'realtimeProtocol',
    'realtimeRadio',
    'realtimeTurns',
    'realtimeViewport',
    'realtimeFacade',
    'realtimeController',
  ]
    .map((name) =>
      readFileSync(new URL(`../voice/${name}.js`, import.meta.url), 'utf8'),
    )
    .join('\n');
}
