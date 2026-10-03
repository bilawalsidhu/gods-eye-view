export const ATTENTION_DISPOSITIONS = Object.freeze([
  'silent',
  'ambient',
  'activity',
  'suggest',
  'exception',
]);

/**
 * Resolve how strongly one typed application change should surface.
 *
 * This is presentation policy only. It must not change source truth,
 * application severity, layer state, or execution authority.
 *
 * @param {object} input
 * @param {boolean} [input.repeated=false] Same semantic update already surfaced.
 * @param {boolean} [input.blocking=false] Current task cannot continue.
 * @param {boolean} [input.affectsActiveTask=false] Change invalidates active work.
 * @param {'none'|'failed'|'recovered'} [input.freshnessTransition='none']
 * @param {boolean} [input.preparedActionReady=false]
 * @param {boolean} [input.explicitUserFocus=false]
 * @param {boolean} [input.quietMode=false]
 * @returns {{disposition:string, reasonCode:string}}
 */
export function resolveAttentionDisposition({
  repeated = false,
  blocking = false,
  affectsActiveTask = false,
  freshnessTransition = 'none',
  preparedActionReady = false,
  explicitUserFocus = false,
  quietMode = false,
} = {}) {
  if (blocking) {
    return { disposition: 'exception', reasonCode: 'blocking' };
  }

  if (affectsActiveTask && freshnessTransition === 'failed') {
    return {
      disposition: 'exception',
      reasonCode: 'active-task-source-failed',
    };
  }

  if (repeated) {
    return { disposition: 'silent', reasonCode: 'repeated-unchanged' };
  }

  if (freshnessTransition === 'failed') {
    return {
      disposition: explicitUserFocus ? 'activity' : 'ambient',
      reasonCode: 'source-failed',
    };
  }

  if (freshnessTransition === 'recovered') {
    return {
      disposition: quietMode || explicitUserFocus ? 'ambient' : 'activity',
      reasonCode: 'source-recovered',
    };
  }

  if (preparedActionReady) {
    if (quietMode || explicitUserFocus) {
      return {
        disposition: 'ambient',
        reasonCode: 'prepared-action-deferred',
      };
    }
    return {
      disposition: 'suggest',
      reasonCode: 'prepared-action-ready',
    };
  }

  return { disposition: 'silent', reasonCode: 'no-surface-needed' };
}
