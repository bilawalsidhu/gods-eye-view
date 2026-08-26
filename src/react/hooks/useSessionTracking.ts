/**
 * useSessionTracking — lightweight anonymous session tracking.
 *
 * Generates or retrieves a session ID from sessionStorage (not localStorage — no persistence).
 * Sends pageview + layer events to the /api/analytics endpoint.
 *
 * Privacy: no cookies, no PII, no cross-site tracking.
 */
import { useEffect } from 'react';

const SESSION_ID_KEY = '__gev_sid';
const SESSION_START_KEY = '__gev_session_start';
const ANALYTICS_ENDPOINT = '/api/analytics';

function getOrCreateSession(): { id: string; start: number } {
	try {
		let id = sessionStorage.getItem(SESSION_ID_KEY);
		let start = parseInt(sessionStorage.getItem(SESSION_START_KEY) ?? '0', 10);
		if (!id || !start) {
			id = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
			start = Date.now();
			sessionStorage.setItem(SESSION_ID_KEY, id);
			sessionStorage.setItem(SESSION_START_KEY, String(start));
		}
		return { id, start };
	} catch {
		return { id: `${Date.now()}`, start: Date.now() };
	}
}

async function sendEvent(type: string, extra: Record<string, unknown> = {}): Promise<void> {
	try {
		await fetch(ANALYTICS_ENDPOINT, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ type, timestamp: Date.now(), ...extra }),
		});
	} catch {
		// analytics failures are silent — never crash the app
	}
}

export function useSessionTracking(): void {
	useEffect(() => {
		const { id, start } = getOrCreateSession();

		// Track pageview once per session
		sendEvent('pageview', { sessionId: id, sessionStart: start });

		// Track session duration on unload
		function onUnload(): void {
			const duration = Date.now() - start;
			sendEvent('session_end', { sessionId: id, durationMs: duration });
		}
		window.addEventListener('visibilitychange', () => {
			if (document.visibilityState === 'hidden') onUnload();
		});

		// Track data layer events via a global hook
		// Components can call window.__gevTrackEvent('layer_enabled', { layerId }) from React
		(window as any).__gevTrackEvent = (type: string, extra: Record<string, unknown> = {}) => {
			sendEvent(type, { sessionId: id, ...extra });
		};
	}, []);
}
