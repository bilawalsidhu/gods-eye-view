import { feedLatencyTests } from '../../testSupport/aircraftFeedLatency.mjs';
import { RENDER_DELAY_SEC } from './policy.js';

// A slow live feed, as measured: reports about 90 s old every poll, now and
// then a fresh fallback feed, a report that does not move on, or an outage.
feedLatencyTests('military', RENDER_DELAY_SEC);
