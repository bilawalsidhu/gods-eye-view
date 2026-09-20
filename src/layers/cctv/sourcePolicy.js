import { withBase } from '../../services/apiBase.js';

export const FRAME_ENDPOINT = withBase('/api/cctv/frame');

export const SOURCE_ENDPOINT = withBase('/api/cctv/sources');

export const HEALTH_ENDPOINT = withBase('/api/cctv/health');

export const MEDIA_ENDPOINT = withBase('/api/cctv/media');

export const ACTIVE_FRAME_REFRESH_MS = 10000;
