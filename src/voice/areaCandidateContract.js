/** Shared producer/consumer contract for `resolve_area.candidateId`. */

/** Room for every currently emitted bundled candidate (observed maximum: 45). */
export const MAX_AREA_CANDIDATE_ID_LENGTH = 80;

/** JSON Schema-compatible grammar for bundled candidate handles. */
export const AREA_CANDIDATE_ID_PATTERN =
  '^ne:(?:country|state|county):[\\p{L}\\p{M}\\p{N}]+(?:-[\\p{L}\\p{M}\\p{N}]+)*$';

const AREA_CANDIDATE_ID_RE =
  /^ne:(?:country|state|county):[\p{L}\p{M}\p{N}]+(?:-[\p{L}\p{M}\p{N}]+)*$/u;

export function isAreaCandidateId(value) {
  const candidateId = String(value || '');
  return (
    candidateId.length > 0 &&
    candidateId.length <= MAX_AREA_CANDIDATE_ID_LENGTH &&
    AREA_CANDIDATE_ID_RE.test(candidateId)
  );
}
