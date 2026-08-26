/**
 * InstallBanner — dismissable PWA install prompt banner.
 *
 * Shown when the browser fires the `beforeinstallprompt` event and the user
 * has not previously dismissed it.
 *
 * Usage:
 *   const { canInstall, install, dismiss } = usePWAInstall();
 *   { canInstall && <InstallBanner onInstall={install} onDismiss={dismiss} /> }
 */
import React from 'react';

interface Props {
	onInstall: () => void;
	onDismiss: () => void;
}

export function InstallBanner({ onInstall, onDismiss }: Props): React.JSX.Element {
	return (
		<div
			role="region"
			aria-label="Install app"
			style={{
				position: 'fixed',
				bottom: '80px',
				left: '50%',
				transform: 'translateX(-50%)',
				background: 'rgba(10,10,10,0.95)',
				border: '1px solid rgba(255,255,255,0.15)',
				borderRadius: '8px',
				padding: '12px 20px',
				display: 'flex',
				alignItems: 'center',
				gap: '16px',
				zIndex: 9998,
				fontFamily: 'JetBrains Mono, monospace',
				fontSize: '12px',
				color: '#e0e0e0',
				boxShadow: '0 4px 24px rgba(0,0,0,0.5)',
				backdropFilter: 'blur(8px)',
				maxWidth: '480px',
				width: '90vw',
			}}
		>
			<span style={{ fontSize: '18px', flexShrink: 0 }} aria-hidden="true">📲</span>
			<div style={{ flex: 1 }}>
				<strong style={{ color: '#fff' }}>Install God's Eye View</strong>
				<p style={{ margin: '4px 0 0', color: '#888', fontSize: '11px' }}>
					Add to home screen for an app-like experience
				</p>
			</div>
			<div style={{ display: 'flex', gap: '8px', flexShrink: 0 }}>
				<button
					type="button"
					onClick={onInstall}
					style={{
						background: '#3b82f6',
						color: '#fff',
						border: 'none',
						borderRadius: '4px',
						padding: '6px 14px',
						fontSize: '11px',
						cursor: 'pointer',
						fontFamily: 'inherit',
					}}
				>
					Install
				</button>
				<button
					type="button"
					onClick={onDismiss}
					aria-label="Dismiss install prompt"
					style={{
						background: 'transparent',
						color: '#666',
						border: '1px solid #333',
						borderRadius: '4px',
						padding: '6px 10px',
						fontSize: '11px',
						cursor: 'pointer',
						fontFamily: 'inherit',
					}}
				>
					Not now
				</button>
			</div>
		</div>
	);
}
