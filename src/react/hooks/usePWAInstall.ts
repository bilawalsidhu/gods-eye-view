/**
 * usePWAInstall — hook for the PWA install prompt.
 *
 * Listens for the `beforeinstallprompt` event fired by the service worker,
 * exposes the deferred prompt, and provides an `install()` method.
 *
 * Usage:
 *   const { canInstall, install } = usePWAInstall();
 *   if (canInstall) <InstallBanner onInstall={install} />
 */
import { useState, useEffect, useCallback } from 'react';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type BeforeInstallPromptEvent = any;

export interface PWAInstallHook {
	canInstall: boolean;
	install: () => Promise<void>;
	dismissed: boolean;
	dismiss: () => void;
}

const DISMISSED_KEY = '__gev_install_dismissed';

export function usePWAInstall(): PWAInstallHook {
	const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);
	const [dismissed, setDismissed] = useState<boolean>(() => {
		try { return Boolean(localStorage.getItem(DISMISSED_KEY)); } catch { return false; }
	});

	useEffect(() => {
		function handler(e: BeforeInstallPromptEvent) {
			e.preventDefault();
			setDeferredPrompt(e);
		}
		window.addEventListener('beforeinstallprompt', handler as EventListener);
		return () => window.removeEventListener('beforeinstallprompt', handler as EventListener);
	}, []);

	const install = useCallback(async () => {
		if (!deferredPrompt) return;
		await deferredPrompt.prompt();
		const { outcome } = await deferredPrompt.userChoice;
		if (outcome === 'accepted') {
			setDeferredPrompt(null);
			setDismissed(true);
		}
	}, [deferredPrompt]);

	const dismiss = useCallback(() => {
		setDismissed(true);
		try { localStorage.setItem(DISMISSED_KEY, '1'); } catch { /* ignore */ }
	}, []);

	return {
		canInstall: Boolean(deferredPrompt) && !dismissed,
		install,
		dismissed,
		dismiss,
	};
}
