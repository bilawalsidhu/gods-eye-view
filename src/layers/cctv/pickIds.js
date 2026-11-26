/**
 * Entity ids of a camera's coverage and projection geometry:
 * `cctv-<cameraId>-<role>`. The first group is the camera id.
 */
export const CCTV_HELPER_PICK_ID =
  /^cctv-(.+)-(?:ray-tl|ray-tr|ray-br|ray-bl|cap|plane|plane-label)$/;

export function ownsCctvPick(pickedId, recordsById, gizmoPrefix) {
  if (recordsById.has(pickedId)) return true;
  if (typeof pickedId === 'string' && pickedId.startsWith(gizmoPrefix))
    return true;
  const coverage = CCTV_HELPER_PICK_ID.exec(pickedId);
  return Boolean(coverage && recordsById.has(coverage[1]));
}
