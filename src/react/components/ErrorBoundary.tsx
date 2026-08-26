/**
 * ErrorBoundary — React error boundary component.
 *
 * Catches JavaScript errors in the React component tree and renders a fallback
 * UI instead of crashing the entire app. Used to wrap the Cesium viewer mount
 * point and any third-party integrations.
 *
 * Usage:
 *   <ErrorBoundary name="CesiumViewer" onError={(err) => reportError(err)}>
 *     <CesiumGlobe />
 *   </ErrorBoundary>
 */
import React, { Component, ReactNode } from 'react';

interface Props {
  name?: string;
  onError?: (error: Error, info: React.ErrorInfo) => void;
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

/**
 * A React error boundary that catches render errors and displays a fallback.
 */
export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    this.props.onError?.(error, info);
    console.error(`[ErrorBoundary:${this.props.name ?? 'unknown'}]`, error, info);
  }

  render(): ReactNode {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback;
      return (
        <div style={{
          position: 'fixed', inset: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'rgba(0,0,0,0.85)', color: '#ff4444',
          fontFamily: 'JetBrains Mono, monospace', fontSize: '13px',
          zIndex: 9999, flexDirection: 'column', gap: '12px',
        }}>
          <span style={{ fontSize: '24px' }}>⚠</span>
          <strong>{this.props.name ?? 'Component'} Error</strong>
          <span style={{ color: '#888', maxWidth: '400px', textAlign: 'center' }}>
            {this.state.error?.message ?? 'An unknown error occurred'}
          </span>
        </div>
      );
    }
    return this.props.children;
  }
}
